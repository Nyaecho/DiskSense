#!/usr/bin/env node
/**
 * DiskSense CLI 主入口（无 daemon 架构）。
 *
 * 所有工具命令把结果 JSON 打印到 stdout，供 Agent 读取后继续推理。
 * 命令与参数风格对齐 Python 版 api_client.py，Agent 契约不变；
 * 差异：无后台服务，「会话」持久化于磁盘并带 op_count 新鲜度账本。
 *
 * 首行 shebang（#!/usr/bin/env node）经 tsc 原样保留，npm 据此生成
 * 「node 调用」的 bin shim，而非直接执行 .js（否则会走 Windows 的
 * .js 文件关联，被 Electron 等应用劫持）。
 */

import { Command } from "commander";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

import { ensureDataDirs, loadConfig, dataHome, rulesFile } from "../config.js";
import { elevateAndWait, isAdmin, ElevateCancelled } from "../elevate.js";
import { Preferences } from "../preferences.js";
import { classifyMagicNumber } from "../magic.js";
import { scan, getDriveType } from "../scanner/index.js";
import { Aggregator } from "../aggregator.js";
import { RulesEngine } from "../rules-engine.js";
import { FileOperator, executeUndo } from "../operator/file-operator.js";
import {
  emptyRecycleBinForOp,
  recycleBinStatus,
} from "../operator/recycle-bin.js";
import { UndoManager } from "../operator/undo-manager.js";
import { JobStore, jobToDict, JOB_SUCCEEDED, JOB_FAILED } from "../operator/jobs.js";
import type { StoredSession, TreeNodeJSON } from "../state/session.js";
import {
  saveSession,
  loadSessionById,
  loadLatestSession,
  recordOperation,
  recordOperationForSources,
  resetFreshness,
  sessionFileForRoot,
  treeToJSON,
  treeFromJSON,
} from "../state/session.js";
import { appendOverlay, queryOverlays, clearOverlays } from "../state/overlays.js";
import { buildSubtree, findNode, queryDetail, sessionMeta } from "./session-query.js";
import { dirStat, pathSize, searchDirs } from "./fsutils.js";
import { registerWorkerCommand } from "./worker.js";

const program = new Command();
program
  .name("disk-sense")
  .description("DiskSense 便携式 AI 磁盘文件管理器")
  .version(cliVersion());

/** 从随包分发的 package.json 读取版本（避免与 npm 版本脱节）。 */
function cliVersion(): string {
  try {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ---------------------------------------------------------------------------
// 输出约定
// ---------------------------------------------------------------------------
function out(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function fail(msg: string, extra: Record<string, unknown> = {}): never {
  out({ status: "error", error: msg, ...extra });
  process.exit(1);
}

function prefsInstance(): Preferences {
  return new Preferences(path.join(dataHome(), "user_preferences.json"));
}

function undoInstance(): UndoManager {
  const cfg = loadConfig();
  return new UndoManager(path.join(dataHome(), "op_log.db"), cfg.history.retentionDays);
}

function requireSession(opts: { session?: string }): StoredSession {
  ensureDataDirs();
  const s = opts.session ? loadSessionById(opts.session) : loadLatestSession();
  if (!s) fail("无可用扫描会话，请先执行 start_scan");
  return s;
}

/** 在存储树中按小写段序列定位节点。 */
function findChild(parent: TreeNodeJSON, seg: string): TreeNodeJSON | null {
  return (
    parent.children?.[seg] ??
    Object.entries(parent.children ?? {}).find(([k]) => k.toLowerCase() === seg.toLowerCase())?.[1] ??
    null
  );
}

function recomputeSize(n: TreeNodeJSON): number {
  if (!n.children || n.isLink) return n.size;
  let total = 0;
  for (const c of Object.values(n.children)) total += c.isDir ? recomputeSize(c) : c.size;
  n.size = total;
  return total;
}

function clearStaleDeep(n: TreeNodeJSON): void {
  delete n.stale;
  delete n.staleSince;
  for (const c of Object.values(n.children ?? {})) clearStaleDeep(c);
}

function atomicRewrite(sess: StoredSession): void {
  const f = sessionFileForRoot(sess.root_path);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sess), "utf-8");
  fs.renameSync(tmp, f);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------------------------------------------------------------------------
// 扫描与查询
// ---------------------------------------------------------------------------
/** 把扫描结果聚合并落盘，返回响应 JSON（start_scan 与提权子进程共用）。 */
function finishScan(drive: string, result: Awaited<ReturnType<typeof scan>>): Record<string, unknown> {
  const cfg = loadConfig();
  void cfg;
  const prefs = prefsInstance();
  const sessionId = `sess-${crypto.randomBytes(6).toString("hex")}`;
  const rules = RulesEngine.fromYaml(rulesFile());
  const agg = new Aggregator({
    rules,
    tagsByPrefix: prefs.tagsByPrefix,
    pseudoEntityPaths: prefs.pseudoEntityPaths,
  });
  const fingerprint = agg.aggregate(result, sessionId);
  saveSession(result, drive, sessionId, {
    fingerprint,
    entityDetail: Object.fromEntries(agg.entityTopFiles),
  });
  return { status: "completed", session_id: sessionId, result: fingerprint };
}

/** 是否值得为该扫描目标请求 UAC 提权（本地固定盘 + 当前非管理员）。 */
export function shouldElevateFor(drivePath: string): boolean {
  if (process.platform !== "win32") return false;
  const bareDrive = /^[A-Za-z]:[\\/]?$/.exec(path.resolve(drivePath));
  if (!bareDrive) return false;
  try {
    if (getDriveType(drivePath) !== 3) return false; // 仅 DRIVE_FIXED
  } catch {
    return false;
  }
  return !isAdmin();
}

program
  .command("start_scan")
  .description("启动磁盘/目录扫描，同步等待完成并返回指纹档案 JSON")
  .requiredOption("--drive <path>")
  .option("--no-elevate", "禁用自动 UAC 提权（非管理员时静默降级 walk 扫描）")
  .action(async (opts) => {
    ensureDataDirs();
    // 自动提权：本地固定盘 + 非管理员 → UAC 拉起提权子进程走 MFT 快速路径
    if (opts.elevate && shouldElevateFor(opts.drive)) {
      const outFile = path.join(os.tmpdir(), `disk-sense-elevated-${process.pid}-${Date.now()}.json`);
      let elevatedFailed = false;
      try {
        elevateAndWait(["_elevated-scan", "--drive", String(opts.drive), "--out", outFile]);
      } catch (e) {
        if (!(e instanceof ElevateCancelled)) elevatedFailed = true; // 提权执行出错
        // 用户取消 UAC → 静默降级普通扫描
        void e;
      }
      if (elevatedFailed || fs.existsSync(outFile)) {
        if (!fs.existsSync(outFile)) fail("提权扫描失败：子进程未产出结果");
        process.stdout.write(fs.readFileSync(outFile, "utf-8"));
        try {
          fs.unlinkSync(outFile);
        } catch {
          /* 忽略 */
        }
        return;
      }
    }
    try {
      const cfg = loadConfig();
      const prefs = prefsInstance();
      const result = await scan(opts.drive, {
        cfg: cfg.scan,
        ignoreGlobs: prefs.ignorePatterns,
      });
      out(finishScan(opts.drive, result));
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  });

program
  .command("is-admin")
  .description("诊断：当前进程是否持有管理员令牌（决定 MFT 直读可用性）")
  .action(() => {
    out({ admin: isAdmin(), platform: process.platform });
  });

// 提权子进程入口：管理员权限下执行扫描，结果写 --out 文件
program
  .command("_elevated-scan", { hidden: true })
  .requiredOption("--drive <path>")
  .requiredOption("--out <file>")
  .action(async (opts) => {
    ensureDataDirs();
    try {
      const cfg = loadConfig();
      const prefs = prefsInstance();
      const result = await scan(opts.drive, {
        cfg: cfg.scan,
        ignoreGlobs: prefs.ignorePatterns,
      });
      const payload = JSON.stringify(finishScan(opts.drive, result));
      fs.writeFileSync(opts.out, payload.endsWith("\n") ? payload : `${payload}\n`, "utf-8");
    } catch (e) {
      // 失败也写错误 JSON，父进程可透传
      fs.writeFileSync(
        opts.out,
        `${JSON.stringify({ status: "error", error: e instanceof Error ? e.message : String(e) })}\n`,
        "utf-8"
      );
      process.exitCode = 1;
    }
  });

program
  .command("query_detail")
  .description("查询实体某角色 Top5 文件明细")
  .requiredOption("--entity_id <id>")
  .option("--category <category>")
  .option("--session <id>")
  .action((opts) => {
    const s = requireSession(opts);
    const detail = queryDetail(s, opts.entity_id, opts.category);
    if (detail === null) fail(`实体不存在或无明细: ${opts.entity_id}`);
    out(Array.isArray(detail) ? detail : detail);
  });

program
  .command("classify_unknown")
  .description("读文件头 16 字节魔数，返回真实格式")
  .requiredOption("--path <path>")
  .action((opts) => {
    out(classifyMagicNumber(opts.path));
  });

program
  .command("dir_stat")
  .description("返回任意目录/文件的 mtime/atime/ctime（只读，无需先扫描）")
  .requiredOption("--path <path>")
  .action((opts) => {
    try {
      out(dirStat(opts.path));
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  });

program
  .command("search_dirs")
  .description("fnmatch 通配递归搜索目录与文件名（大小写不敏感）")
  .requiredOption("--pattern <pattern>")
  .requiredOption("--root <path>")
  .option("--top <n>", "按大小降序取前 N", "50")
  .action((opts) => {
    try {
      out(searchDirs(opts.pattern, opts.root, Number(opts.top), prefsInstance().ignorePatterns));
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  });

program
  .command("path_size")
  .description("递归测量任意路径体积（跳过链接，只读）")
  .requiredOption("--path <path>")
  .action((opts) => {
    try {
      out(pathSize(opts.path));
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  });

program
  .command("subtree")
  .description("已扫描路径下至多 depth 层的子树聚合（treemap 钻取，纯内存）")
  .requiredOption("--path <path>")
  .option("--depth <n>", "层级 1–5", "1")
  .option("--session <id>")
  .action((opts) => {
    const s = requireSession(opts);
    const hit = buildSubtree(s, opts.path, Number(opts.depth));
    if (!hit) fail(`路径不在已扫描范围内: ${opts.path}`);
    out({ ...hit, stale_hint: s.op_count > 0 ? `快照后已有 ${s.op_count} 次操作` : undefined });
  });

program
  .command("rescan")
  .description("增量重扫指定路径并合并进会话（操作后数据过期时使用）")
  .requiredOption("--path <path>")
  .option("--session <id>")
  .action(async (opts) => {
    ensureDataDirs();
    const s = opts.session ? loadSessionById(opts.session) : loadLatestSession();
    if (!s) fail("无可用扫描会话，请先执行 start_scan");
    const abs = path.resolve(opts.path);
    const rootLow = s.root_path.toLowerCase();
    if (!abs.toLowerCase().startsWith(rootLow)) {
      fail(`路径不在会话扫描根 ${s.root_path} 之内`);
    }
    try {
      // 重扫该子树（walk 模式），合并回存储树
      const subResult = await scan(abs, { ignoreGlobs: [] });
      const newNode: TreeNodeJSON = treeToJSON(subResult.root);
      // 定位存储树中的父链并替换子树
      let parent = s.tree;
      const relSegments = abs
        .toLowerCase()
        .slice(rootLow.length)
        .replace(/^\\+/, "")
        .split("\\")
        .filter(Boolean);
      for (let i = 0; i < relSegments.length - 1; i++) {
        const next = findChild(parent, relSegments[i]!);
        if (!next) fail(`路径父链在快照中不存在: ${relSegments[i]}`);
        parent = next;
      }
      const leafName = relSegments.at(-1);
      if (!leafName || !parent.children) fail("无法定位替换位置");
      const key =
        leafName in parent.children
          ? leafName
          : Object.keys(parent.children).find((k) => k.toLowerCase() === leafName.toLowerCase());
      if (!key) fail(`路径不在快照中: ${abs}`);
      parent.children[key] = newNode;

      // 沿祖先链重算体积；新子树内清除过期标记；重置新鲜度账本
      recomputeSize(s.tree);
      clearStaleDeep(newNode);
      clearStaleDeep(s.tree);
      s.op_count = 0;
      s.recent_ops = [];
      atomicRewrite(s);
      out({
        status: "completed",
        path: abs,
        subtree_bytes: subResult.totalBytes,
        files: subResult.files,
        dirs: subResult.dirs,
        note: "会话新鲜度账本已重置",
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  });

// ---------------------------------------------------------------------------
// 高亮指令
// ---------------------------------------------------------------------------
program
  .command("viz_command")
  .description("记录高亮/标注指令（服务端留存，供审计/回放）")
  .requiredOption("--action <action>")
  .option("--target <json>", '目标 JSON，如 \'{"id":"wechat"}\'')
  .option("--payload <json>")
  .action((opts) => {
    const validActions = ["highlight", "label", "group", "protect", "clear"];
    if (!validActions.includes(opts.action)) {
      fail(`非法 action: ${opts.action}（可选 ${validActions.join("|")}）`);
    }
    const parseJson = (v: unknown, name: string): unknown => {
      if (v === undefined) return undefined;
      try {
        return JSON.parse(String(v));
      } catch {
        return fail(`${name} 不是合法 JSON`);
      }
    };
    const target = parseJson(opts.target, "--target");
    if (target === undefined && opts.action !== "clear") fail("--target 必填（clear 除外）");
    const payload = parseJson(opts.payload, "--payload");
    if (opts.action === "clear") {
      clearOverlays();
    }
    out(appendOverlay(opts.action, target ?? null, payload));
  });

program
  .command("query_overlays")
  .description("取回 seq 之后的高亮指令增量")
  .option("--since_seq <n>", "起始 seq", "0")
  .action((opts) => {
    out(queryOverlays(Number(opts.since_seq)));
  });

// ---------------------------------------------------------------------------
// 文件操作
// ---------------------------------------------------------------------------
interface ExecOpts {
  op_type: string;
  sources: string;
  dest?: string;
  async_mode?: boolean;
  wait?: boolean;
  strict?: boolean;
  session?: string;
}

async function executeOperationHandler(opts: ExecOpts): Promise<void> {
  ensureDataDirs();
  const validTypes = ["move", "copy", "delete", "compress"];
  if (!validTypes.includes(opts.op_type)) fail(`非法 op_type: ${opts.op_type}`);

  let sources: string[];
  try {
    const parsed = JSON.parse(opts.sources);
    if (!Array.isArray(parsed)) throw new Error("sources 必须是 JSON 数组");
    sources = parsed.map(String).filter(Boolean);
  } catch (e) {
    fail(`--sources 解析失败: ${e instanceof Error ? e.message : e}`);
  }

  // ---- 预检（执行时防线）：存在性 + mtime 与快照比对 ----
  const warnings: string[] = [];
  const session = opts.session ? loadSessionById(opts.session) : loadLatestSession();
  if (session) {
    for (const src of sources) {
      const node = findNode(session, src);
      const exists = fs.existsSync(src);
      if (!exists) {
        if (node) {
          // 快照中存在但磁盘上已消失：无论是否有操作历史都是硬冲突
          warnings.push(`${src}: 快照中存在但当前不存在（可能已被移动/删除），标记 stale_conflict`);
        } else {
          warnings.push(`${src}: 当前不存在`);
        }
        continue;
      }
      if (node && node.mtime > 0 && !node.stale) {
        const actualMtime = fs.statSync(src).mtimeMs / 1000;
        if (Math.abs(actualMtime - node.mtime) > 2) {
          warnings.push(`${src}: mtime 与快照不一致（快照后已被修改）`);
        }
      }
    }
    if (warnings.some((w) => w.includes("stale_conflict"))) {
      fail("预检发现源路径已在快照后消失（stale_conflict），请先 rescan 再操作", {
        warnings,
      });
    }
    if (opts.strict && warnings.length > 0) {
      fail("严格模式：预检发现不一致，已拒绝操作", { warnings });
    }
  }

  const runOp = (): Record<string, unknown> => {
    const undo = undoInstance();
    try {
      const prefs = prefsInstance();
      const op = new FileOperator(undo, (p) => prefs.isProtected(p), session?.session_id ?? null);

      let result;
      if (opts.op_type === "delete") result = op.delete(sources);
      else if (opts.op_type === "move") result = op.move(sources, opts.dest ?? "");
      else if (opts.op_type === "copy") result = op.copy(sources, opts.dest ?? "");
      else result = op.compress(sources, opts.dest);

      // 新鲜度记账（成功时）：op_count++ / recent_ops / 子树 stale 标记
      if (result.status === "completed") {
        recordOperationForSources(opts.op_type.toUpperCase(), sources, result.op_uuid);
        if ((opts.op_type === "move" || opts.op_type === "copy") && opts.dest) {
          recordOperationForSources(`${opts.op_type.toUpperCase()}_DEST`, [opts.dest], result.op_uuid);
        }
      }
      return { ...(result as object), ...(warnings.length ? { warnings } : {}) } as Record<string, unknown>;
    } finally {
      undo.close();
    }
  };

  // ---- 异步模式：spawn detached worker ----
  if (opts.async_mode) {
    const store = new JobStore();
    const job = store.create(
      opts.op_type,
      sources,
      opts.op_type === "move" || opts.op_type === "copy" ? opts.dest : null
    );
    const entry = process.argv[1]!;
    const child = spawn(process.execPath, [entry, "_job-worker", "--job_id", job.job_id], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    out({
      status: "accepted",
      job_id: job.job_id,
      message: "任务已提交后台执行；用 query_job --job_id 轮询状态",
    });
    return;
  }

  out(runOp());
}

program
  .command("execute_operation")
  .description("执行 move/copy/delete/compress 操作（删除自动走回收站，可撤销）")
  .requiredOption("--op_type <type>")
  .requiredOption("--sources <json>")
  .option("--dest <dir>")
  .option("--async", "大体积操作异步模式（立即返回 job_id）")
  .option("--wait", "配合 --async：轮询直到结束")
  .option("--strict", "严格预检：mtime 不一致即拒绝")
  .option("--session <id>")
  .action(async (opts) => {
    if (opts.async_mode && opts.wait) {
      const store = new JobStore();
      const job = store.create(opts.op_type, JSON.parse(opts.sources), opts.dest);
      const entry = process.argv[1]!;
      const child = spawn(process.execPath, [entry, "_job-worker", "--job_id", job.job_id], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      // 轮询到结束
      const deadline = Date.now() + 30 * 60_000;
      while (Date.now() < deadline) {
        const cur = store.get(job.job_id)!;
        if (cur.status === JOB_SUCCEEDED || cur.status === JOB_FAILED) {
          out(jobToDict(cur));
          return;
        }
        sleepSync(500);
      }
      out(jobToDict(store.get(job.job_id)!));
      return;
    }
    await executeOperationHandler(opts);
  });

program
  .command("query_job")
  .description("查询异步任务状态与进度")
  .requiredOption("--job_id <id>")
  .option("--wait", "轮询直到结束")
  .action(async (opts) => {
    const store = new JobStore();
    let job = store.get(opts.job_id);
    if (!job) fail(`任务不存在: ${opts.job_id}`);
    if (opts.wait) {
      const deadline = Date.now() + 30 * 60_000;
      while (
        Date.now() < deadline &&
        job.status !== JOB_SUCCEEDED &&
        job.status !== JOB_FAILED
      ) {
        sleepSync(500);
        job = store.get(opts.job_id) ?? job;
      }
    }
    out(jobToDict(job));
  });

// ---------------------------------------------------------------------------
// 回滚与审计
// ---------------------------------------------------------------------------
program
  .command("list_recent_ops")
  .description("最近操作记录（供 Agent 审计与撤销定位）")
  .option("--limit <n>", "条数", "10")
  .action((opts) => {
    const undo = undoInstance();
    try {
      out(undo.listOps(Number(opts.limit)));
    } finally {
      undo.close();
    }
  });

program
  .command("undo_operation")
  .description("按 op_id 五步预检回滚整批操作")
  .requiredOption("--op_id <n>")
  .action((opts) => {
    const undo = undoInstance();
    try {
      const result = executeUndo(Number(opts.op_id), undo);
      if (result.status !== "failed") {
        // 撤销也计入新鲜度账本（undo 后树只是「接近」快照态）
        if (result.restored && result.restored.length > 0) {
          const restoredTo = result.restored[0]?.["restored_to"];
          if (typeof restoredTo === "string") {
            recordOperation(restoredTo, "UNDO", [restoredTo]);
          }
        }
      }
      out(result);
    } finally {
      undo.close();
    }
  });

program
  .command("recycle_bin_status")
  .description("回收站当前占用（条目数、总字节，按盘分解）")
  .action(() => {
    out(recycleBinStatus());
  });

program
  .command("empty_recycle_bin")
  .description("仅永久删除指定 op_uuid 产生的回收站条目（不可撤销！）")
  .requiredOption("--op_uuid <uuid>")
  .action((opts) => {
    const undo = undoInstance();
    try {
      out(emptyRecycleBinForOp(opts.op_uuid, undo));
    } finally {
      undo.close();
    }
  });

// ---------------------------------------------------------------------------
// 用户偏好
// ---------------------------------------------------------------------------
program
  .command("add_protection")
  .description("添加保护路径（其下一切操作被拒绝）")
  .requiredOption("--path <path>")
  .action((opts) => {
    out(prefsInstance().addProtection(opts.path));
  });

program
  .command("remove_protection")
  .description("移除保护路径")
  .requiredOption("--path <path>")
  .action((opts) => {
    out(prefsInstance().removeProtection(opts.path));
  });

program
  .command("apply_tag")
  .description("路径前缀打标签，扫描时自动合并进实体 tags")
  .requiredOption("--path <path>")
  .requiredOption("--tag <tag>")
  .action((opts) => {
    out(prefsInstance().setTag(opts.path, opts.tag));
  });

registerWorkerCommand(program);

// 仅作为主模块运行时才解析 argv（允许测试/工具安全导入本模块）
import { fileURLToPath } from "node:url";
function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    // realpath 解析 Junction/符号链接：全局安装的 bin 可能经 Junction 指向源码目录，
    // 直接 path.resolve 无法解析 Junction，会导致 import.meta.url 与 argv[1] 不相等。
    return (
      fs.realpathSync(fileURLToPath(import.meta.url)) ===
      fs.realpathSync(process.argv[1])
    );
  } catch {
    return false;
  }
}
const invokedDirectly = isMainModule();
if (invokedDirectly) {
  program.parseAsync(process.argv).catch((e) => {
    fail(e instanceof Error ? e.message : String(e));
  });
}
