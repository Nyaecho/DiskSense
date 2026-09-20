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
import { gzipSync } from "node:zlib";

import {
  ensureDataDirs,
  loadConfig,
  dataHome,
  normalizeTarget,
  rulesFile,
  exportDir,
} from "../config.js";
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
import type { StoredSession } from "../state/session.js";
import {
  saveSession,
  loadSessionById,
  loadLatestSession,
  listSessions,
  exportSessionToFile,
  mergeRescanSubtree,
  recordOperation,
  recordOperationForSources,
} from "../state/session.js";
import { appendOverlay, queryOverlays, clearOverlays } from "../state/overlays.js";
import { buildSubtree, findNode, queryDetail, sessionMeta } from "./session-query.js";
import {
  diffSessions,
  growthReport,
  parseTimestampArg,
  resolveCurrentSession,
} from "./session-diff.js";
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

/** 同步等待（仅异步任务轮询用）。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------------------------------------------------------------------------
// 扫描与查询
// ---------------------------------------------------------------------------
/** 把扫描结果聚合并落盘，返回响应 JSON（start_scan 与提权子进程共用）。
 *
 * stdout 默认只输出摘要（summary + 实体 Top10 + result_file 落盘路径），
 * 完整指纹档案 gzip 写入 export 目录，需要全量时加 --full 或直接读文件。
 */
function finishScan(
  drive: string,
  result: Awaited<ReturnType<typeof scan>>,
  full = false
): Record<string, unknown> {
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
  const { archived } = saveSession(result, drive, sessionId, {
    fingerprint,
    entityDetail: Object.fromEntries(agg.entityTopFiles),
  });
  // 完整指纹 gzip 落盘：避免 100KB+ JSON 直接刷屏（Agent 可按需读文件）
  const resultFile = path.join(exportDir(), `${sessionId}.fingerprint.json.gz`);
  fs.mkdirSync(exportDir(), { recursive: true });
  fs.writeFileSync(resultFile, gzipSync(JSON.stringify(fingerprint), { level: 6 }));
  const entities = Array.isArray(fingerprint["entities"])
    ? (fingerprint["entities"] as Record<string, unknown>[])
    : [];
  return {
    status: "completed",
    session_id: sessionId,
    result_file: resultFile,
    ...(full
      ? { result: fingerprint }
      : {
          summary: fingerprint["summary"],
          entities_top: entities.slice(0, 10).map((e) => ({
            id: e["id"],
            display: e["display"],
            total_size_mb: e["total_size_mb"],
          })),
          note: "摘要模式：完整指纹已落盘 result_file（gzip JSON）；加 --full 可直接输出全量",
        }),
    // 覆盖预警：旧 live 会话已自动归档（零拷贝），可作 diff_sessions 基线
    ...(archived ? { old_session_archived: archived.session_id } : {}),
  };
}

/** 是否值得为该扫描目标请求 UAC 提权（本地固定盘 + 当前非管理员）。 */
export function shouldElevateFor(drivePath: string): boolean {
  if (process.platform !== "win32") return false;
  const bareDrive = /^[A-Za-z]:[\\/]?$/.exec(normalizeTarget(drivePath));
  if (!bareDrive) return false;
  try {
    if (getDriveType(drivePath) !== 3) return false; // 仅 DRIVE_FIXED
  } catch {
    return false;
  }
  return !isAdmin();
}

/** 非交互上下文探测：无 TTY 或命中常见 CI 环境变量（UAC 弹窗无人应答会挂死）。 */
export function isNonInteractive(): boolean {
  if (!process.stdout.isTTY) return true;
  const ciVars = ["CI", "GITHUB_ACTIONS", "TF_BUILD", "JENKINS_URL", "GITLAB_CI", "AGENT_ID"];
  return ciVars.some((k) => process.env[k] !== undefined);
}

/** 归一化提权策略参数（auto：仅交互式 TTY 且非 CI 时弹 UAC）。 */
export function resolveElevateMode(v: string | boolean | undefined): "auto" | "never" | "always" {
  if (v === undefined) return "auto";
  if (typeof v === "boolean") return v ? "always" : "never";
  const s = String(v).toLowerCase();
  if (s === "auto" || s === "never" || "always") return s as "auto" | "never" | "always";
  fail(`非法 --elevate 值: ${v}（可选 auto|never|always）`);
}

program
  .command("start_scan")
  .description("启动磁盘/目录扫描，同步等待完成；默认输出摘要，完整指纹见 result_file（--full 输出全量）")
  .option("--drive <path>", "扫描目标：盘符（如 C:）或任意目录绝对路径")
  .option("--path <path>", "--drive 别名（传目录路径时语义更自然）")
  .option("--elevate <mode>", "提权策略 auto|never|always（默认 auto：非交互/CI 自动跳过 UAC）", "auto")
  .option("--full", "stdout 输出完整指纹档案（默认仅摘要 + result_file 落盘路径）")
  .action(async (opts) => {
    ensureDataDirs();
    const drive: string = opts.drive ?? opts.path;
    if (!drive) fail("--drive（或别名 --path）必填");
    const elevateMode = resolveElevateMode(opts.elevate);
    const elevWarnings: string[] = [];
    // 自动提权：auto 模式下仅「本地固定盘 + 非管理员 + 交互式 TTY 非 CI」才弹 UAC；
    // 非交互上下文（Agent/CI）弹 UAC 无人应答会挂死整个流程，静默走 walk 降级
    const wantElevate =
      elevateMode === "always"
        ? !isAdmin()
        : elevateMode === "auto" && !isNonInteractive() && shouldElevateFor(drive);
    if (wantElevate) {
      const outFile = path.join(os.tmpdir(), `disk-sense-elevated-${process.pid}-${Date.now()}.json`);
      let exitCode = 0;
      try {
        exitCode = elevateAndWait([
          "_elevated-scan",
          "--drive",
          String(drive),
          "--out",
          outFile,
          ...(opts.full ? ["--full"] : []),
        ]);
      } catch (e) {
        elevWarnings.push(
          e instanceof ElevateCancelled
            ? `UAC 提权未成功：${e.message}；已降级遍历扫描`
            : `提权执行出错：${e instanceof Error ? e.message : String(e)}；已降级遍历扫描`
        );
      }
      if (fs.existsSync(outFile)) {
        process.stdout.write(fs.readFileSync(outFile, "utf-8"));
        try {
          fs.unlinkSync(outFile);
        } catch {
          /* 忽略 */
        }
        return;
      }
      if (elevWarnings.length === 0) {
        elevWarnings.push(`提权子进程异常退出（code=${exitCode}）且未产出结果，已降级遍历扫描`);
      }
    }
    try {
      const cfg = loadConfig();
      const prefs = prefsInstance();
      const result = await scan(drive, {
        cfg: cfg.scan,
        ignoreGlobs: prefs.ignorePatterns,
      });
      const payload = finishScan(drive, result, Boolean(opts.full));
      if (elevWarnings.length > 0) payload["warnings"] = elevWarnings;
      out(payload);
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
  .option("--full", "输出完整指纹（与父进程 --full 对应）")
  .action(async (opts) => {
    ensureDataDirs();
    try {
      const cfg = loadConfig();
      const prefs = prefsInstance();
      const result = await scan(opts.drive, {
        cfg: cfg.scan,
        ignoreGlobs: prefs.ignorePatterns,
      });
      const payload = JSON.stringify(finishScan(opts.drive, result, Boolean(opts.full)));
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
    // 统一信封：{status, data}（与其他命令一致，便于调用方解析）
    out({ status: "ok", data: detail });
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
  .option("--skip-heavy", "命中 node_modules/.git 等已知重目录时不再向下遍历（加速全盘搜索）")
  .action((opts) => {
    try {
      out(
        searchDirs(
          opts.pattern,
          opts.root,
          Number(opts.top),
          prefsInstance().ignorePatterns,
          Boolean(opts.skipHeavy)
        )
      );
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
    const abs = path.resolve(normalizeTarget(opts.path));
    try {
      // 重扫该子树（walk 模式），SQLite 事务内替换子树行并重算祖先体积
      const subResult = await scan(abs, { ignoreGlobs: [] });
      mergeRescanSubtree(s, abs, subResult);
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
// 跨会话时间维度（版本化基线 / diff / 增长报告）
// ---------------------------------------------------------------------------
program
  .command("list_sessions")
  .description("列出扫描会话（默认仅 live，--all 含归档；diff_sessions 基线发现入口）")
  .option("--root <path>", "按根路径前缀过滤")
  .option("--all", "包含已归档会话")
  .action((opts) => {
    out(listSessions(opts.root, Boolean(opts.all)));
  });

program
  .command("diff_sessions")
  .description("两次会话对比：新增/消失/变更文件 + 目录聚合 Top N（对比上次扫描）")
  .requiredOption("--baseline <session_id>", "基线会话（通常为归档会话 id）")
  .option("--current <session_id>", "当前会话（默认取基线同根的 live 会话）")
  .option("--top <n>", "各榜单条数", "20")
  .option("--depth <n>", "目录聚合深度（1-10）", "3")
  .action((opts) => {
    try {
      const current = opts.current ?? resolveCurrentSession(opts.baseline);
      out(
        diffSessions(opts.baseline, current, {
          top: Number(opts.top),
          depth: Math.min(10, Math.max(1, Number(opts.depth))),
        })
      );
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  });

program
  .command("growth_report")
  .description("按 mtime/ctime 时间窗聚合增长（无基线时的降级方案）")
  .requiredOption("--since <ts>", "起始时刻（Unix 秒或 ISO 8601）")
  .option("--until <ts>", "结束时刻（Unix 秒或 ISO 8601）")
  .option("--by <field>", "过滤字段 mtime|ctime", "mtime")
  .option("--depth <n>", "目录聚合深度（1-10）", "3")
  .option("--top <n>", "各榜单条数", "20")
  .option("--session <id>", "目标会话（默认最近 live 会话）")
  .action((opts) => {
    ensureDataDirs();
    const s = opts.session ? loadSessionById(opts.session) : loadLatestSession();
    if (!s) fail("无可用扫描会话，请先执行 start_scan");
    if (opts.by !== "mtime" && opts.by !== "ctime") {
      fail(`--by 仅支持 mtime|ctime: ${opts.by}`);
    }
    try {
      const since = parseTimestampArg(opts.since, "--since");
      const until = opts.until ? parseTimestampArg(opts.until, "--until") : undefined;
      out(
        growthReport(s.session_id, {
          since,
          until,
          by: opts.by,
          depth: Math.min(10, Math.max(1, Number(opts.depth))),
          top: Number(opts.top),
        })
      );
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  });

program
  .command("export_session")
  .description("导出任意会话（含归档）为 .json.gz 单文件（备份/外部分析）")
  .requiredOption("--session <id>")
  .option("--out <file>", "输出路径（默认 <数据目录>/export/<id>.json.gz）")
  .action((opts) => {
    try {
      out(exportSessionToFile(opts.session, opts.out));
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  });

// ---------------------------------------------------------------------------
// 高亮指令
// ---------------------------------------------------------------------------
/**
 * JSON 参数读取：值以 `@` 开头时从文件读取（如 --payload @payload.json），
 * 避免 PowerShell 下内联 JSON 的转义地狱；否则原样返回。
 */
export function readJsonArg(v: string, name: string): string {
  if (!v.startsWith("@")) return v;
  const file = v.slice(1);
  try {
    return fs.readFileSync(file, "utf-8");
  } catch (e) {
    throw new Error(`${name} 读取文件失败 (${file}): ${e instanceof Error ? e.message : e}`);
  }
}

program
  .command("viz_command")
  .description("记录高亮/标注指令（服务端留存，供审计/回放）")
  .requiredOption("--action <action>")
  .option("--target <json>", '目标 JSON，如 \'{"id":"wechat"}\' 或 @target.json')
  .option("--payload <json>", "payload JSON，支持 @file.json 从文件读取")
  .action((opts) => {
    const validActions = ["highlight", "label", "group", "protect", "clear"];
    if (!validActions.includes(opts.action)) {
      fail(`非法 action: ${opts.action}（可选 ${validActions.join("|")}）`);
    }
    const parseJson = (v: unknown, name: string): unknown => {
      if (v === undefined) return undefined;
      try {
        return JSON.parse(readJsonArg(String(v), name));
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
  /** commander 将 --async 映射为 camelCase 的 async */
  async?: boolean;
  wait?: boolean;
  strict?: boolean;
  /** commander 将 --dry-run 映射为 camelCase 的 dryRun */
  dryRun?: boolean;
  /** commander 将 --allow-stale 映射为 camelCase 的 allowStale */
  allowStale?: boolean;
  session?: string;
}

async function executeOperationHandler(opts: ExecOpts): Promise<void> {
  ensureDataDirs();
  const validTypes = ["move", "copy", "delete", "compress"];
  if (!validTypes.includes(opts.op_type)) fail(`非法 op_type: ${opts.op_type}`);

  let sources: string[];
  try {
    const parsed = JSON.parse(readJsonArg(opts.sources, "--sources"));
    if (!Array.isArray(parsed)) throw new Error("sources 必须是 JSON 数组");
    sources = parsed.map(String).filter(Boolean);
  } catch (e) {
    fail(`--sources 解析失败: ${e instanceof Error ? e.message : e}`);
  }

  // ---- 预检（执行时防线）：存在性 + 快照一致性（目录比子项清单，文件比 mtime）----
  const warnings: string[] = [];
  /** 磁盘存在但不在快照内（或无会话）的源：放行执行，但显式披露未经快照校验 */
  const unverified: string[] = [];
  /** 本工具已处理过、幂等重跑无害的源（节点带 stale 标记 = 有操作历史） */
  const staleIdempotent: string[] = [];
  /** 快照中已知、但无本工具操作历史、磁盘已消失的源（疑似外部变更） */
  const staleConflicts: string[] = [];
  const session = opts.session ? loadSessionById(opts.session) : loadLatestSession();
  if (session) {
    for (const src of sources) {
      const node = findNode(session, src);
      const exists = fs.existsSync(src);
      if (!exists) {
        if (node && node.stale) {
          // 本工具已处理过该路径（删除/移动成功后标 stale）：幂等重跑，放行并披露
          staleIdempotent.push(src);
          warnings.push(
            `${src}: 本工具已处理过该路径（快照标 stale），幂等重跑放行，将由执行层标 skipped`
          );
        } else if (node) {
          // 快照中存在但磁盘上已消失，且无本工具操作历史：外部变更，默认硬冲突
          staleConflicts.push(src);
          warnings.push(
            `${src}: 快照中存在但当前不存在且无本工具操作史（可能被外部移动/删除），标记 stale_conflict`
          );
        } else {
          warnings.push(`${src}: 当前不存在`);
        }
        continue;
      }
      if (!node) {
        unverified.push(src);
        continue;
      }
      if (node.stale) continue; // 子树已标 stale，存在性已确认即可
      if (node.isDir) {
        // 目录 mtime 任何直接子项变动都会刷新，直接比对必然误报；
        // 改比「直接子项名清单」：增/删子项才是与本操作相关的真信号
        const snapKids = new Set(
          Object.keys(node.children ?? {}).map((k) => k.toLowerCase())
        );
        let actualKids: string[] = [];
        try {
          actualKids = fs.readdirSync(src).map((n) => n.toLowerCase());
        } catch {
          /* 不可读目录：交由操作自身报错 */
        }
        const actualSet = new Set(actualKids);
        const added = actualKids.filter((k) => !snapKids.has(k));
        const removed = [...snapKids].filter((k) => !actualSet.has(k));
        if (added.length > 0 || removed.length > 0) {
          const fmt = (xs: string[]) =>
            xs.length <= 5
              ? `[${xs.join(", ")}]`
              : `[${xs.slice(0, 5).join(", ")} 等 ${xs.length} 项]`;
          warnings.push(
            `${src}: 子项清单与快照不一致（新增 ${fmt(added)}；消失 ${fmt(removed)}），目录内容在扫描后已变化`
          );
        }
      } else if (node.mtime > 0) {
        const actualMtime = fs.statSync(src).mtimeMs / 1000;
        const delta = actualMtime - node.mtime;
        if (Math.abs(delta) > 2) {
          warnings.push(
            `${src}: mtime 与快照不一致（快照 ${Math.round(node.mtime)} → 当前 ${Math.round(
              actualMtime
            )}，${delta > 0 ? `+${Math.round(delta)}s` : `${Math.round(delta)}s`}），文件内容在扫描后已被修改`
          );
        }
      }
    }
    // stale_conflict 分类：外部变更默认整批拒绝（铁律 4 误操作防线）；
    // --allow-stale 显式降级为逐条 skipped（用户确认「这些就是我要重跑的残留」）；
    // dry-run 不拒绝——预演的意义就是提前看到冲突与降级后果
    if (staleConflicts.length > 0 && !opts.allowStale && !opts.dryRun) {
      fail(
        `预检发现 ${staleConflicts.length} 个源在快照后消失且无本工具操作史（stale_conflict），` +
          "请先 rescan，或确认外部变更后用 --allow-stale 降级为逐条跳过",
        { warnings, stale_conflicts: staleConflicts }
      );
    }
    if (opts.strict && warnings.length > 0 && !opts.dryRun) {
      fail("严格模式：预检发现不一致，已拒绝操作", { warnings });
    }
  } else {
    // 无会话：所有源均未经快照校验（小批量清理可直接执行，返回中如实披露）
    for (const src of sources) {
      if (fs.existsSync(src)) unverified.push(src);
    }
  }

  // ---- 预演模式：预检 + 体积预估 + 回收站落位/目标冲突，不执行任何操作 ----
  if (opts.dryRun) {
    const items = sources.map((s) => {
      let bytes = 0;
      let isDir = false;
      let recycleDrive: string | null = null;
      let destConflict: boolean | null = null;
      const ok = fs.existsSync(s);
      if (ok) {
        const st = fs.statSync(s);
        isDir = st.isDirectory();
        bytes = isDir ? pathSize(s).total_bytes : Number(st.size);
        if (opts.op_type === "delete") {
          recycleDrive = path.parse(path.resolve(s)).root;
        }
        if ((opts.op_type === "move" || opts.op_type === "copy") && opts.dest) {
          const target = path.join(opts.dest, path.basename(s.replace(/[\\/]+$/, "")));
          destConflict = fs.existsSync(target);
        }
      }
      return {
        source: s,
        exists: ok,
        is_dir: isDir,
        bytes,
        ...(recycleDrive !== null ? { recycle_drive: recycleDrive } : {}),
        ...(destConflict === null ? {} : { dest_conflict: destConflict }),
      };
    });
    out({
      status: "dry_run",
      op_type: opts.op_type,
      dest: opts.dest ?? null,
      items,
      total_bytes: items.reduce((acc, it) => acc + it.bytes, 0),
      ...(unverified.length > 0 ? { unverified } : {}),
      ...(staleIdempotent.length > 0 ? { stale_idempotent: staleIdempotent } : {}),
      ...(staleConflicts.length > 0
        ? {
            stale_conflicts: staleConflicts,
            stale_hint: opts.allowStale
              ? "--allow-stale 已指定：正式执行时这些源将降级为逐条 skipped"
              : "未指定 --allow-stale：正式执行将整批拒绝（stale_conflict），需先 rescan 或加 --allow-stale",
          }
        : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      note:
        "预演模式：未执行任何操作。delete 的 total_bytes 为预计移入回收站的体积" +
        "（落位盘符见 recycle_drive；磁盘占用需 empty_recycle_bin 后才真正释放）；" +
        "move/copy 的 dest_conflict=true 表示目标位置已有同名项。",
    });
    return;
  }

  const runOp = (): Record<string, unknown> => {
    const undo = undoInstance();
    try {
      const prefs = prefsInstance();
      const op = new FileOperator(undo, (p) => prefs.isProtected(p), session?.session_id ?? null);

      // 幂等重跑的跳过原因注入：让逐条 error 精确说明「已处理过」而非通用文案
      const skipReasons = Object.fromEntries(
        staleIdempotent.map((p) => [
          p,
          "本工具已处理过该路径（快照标 stale，幂等重跑），无需重复操作",
        ])
      );

      let result;
      if (opts.op_type === "delete") result = op.delete(sources, { skipReasons });
      else if (opts.op_type === "move")
        result = op.move(sources, opts.dest ?? "", { skipReasons });
      else if (opts.op_type === "copy")
        result = op.copy(sources, opts.dest ?? "", { skipReasons });
      else result = op.compress(sources, opts.dest);

      // 新鲜度记账（成功或部分成功时）：op_count++ / recent_ops / 子树 stale 标记
      if (result.status === "completed" || result.status === "partial") {
        const doneSources =
          result.results?.filter((r) => r.status === "done").map((r) => r.source) ?? sources;
        recordOperationForSources(
          opts.op_type.toUpperCase(),
          doneSources.length > 0 ? doneSources : sources,
          result.op_uuid
        );
        if ((opts.op_type === "move" || opts.op_type === "copy") && opts.dest) {
          recordOperationForSources(`${opts.op_type.toUpperCase()}_DEST`, [opts.dest], result.op_uuid);
        }
      }
      return {
        ...(result as object),
        ...(unverified.length > 0 ? { unverified } : {}),
        ...(staleIdempotent.length > 0
          ? {
              stale_idempotent: staleIdempotent,
              stale_idempotent_note:
                "这些源已被本工具处理过（幂等重跑），执行层已标 skipped，非错误",
            }
          : {}),
        ...(warnings.length ? { warnings } : {}),
      } as Record<string, unknown>;
    } finally {
      undo.close();
    }
  };

  // ---- 异步模式：spawn detached worker ----
  if (opts.async) {
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
  .requiredOption("--sources <json>", 'JSON 数组，支持 @file.json 从文件读取')
  .option("--dest <dir>")
  .option("--async", "大体积操作异步模式（立即返回 job_id）")
  .option("--wait", "配合 --async：轮询直到结束")
  .option("--strict", "严格预检：任何不一致即拒绝")
  .option("--dry-run", "预演：只做预检与体积预估，不执行任何操作")
  .option("--allow-stale", "stale_conflict 降级：快照内消失的源改为逐条 skipped（默认整批拒绝）")
  .option("--session <id>")
  .action(async (opts) => {
    if (opts.async && opts.wait) {
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
      // 统一信封：{status, data}（与其他命令一致，便于调用方解析）
      out({ status: "ok", data: undo.listOps(Number(opts.limit)) });
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
