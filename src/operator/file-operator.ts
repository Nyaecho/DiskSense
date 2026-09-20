/**
 * 文件操作门面：校验 → 日志 → 执行 → 回写日志。
 *
 * 铁律 3 落地点：
 * - 删除只走 Windows 回收站（见 recycle-bin.ts），绝不 unlink/rmSync；
 * - 一切操作经 UndoManager 落 SQLite 日志（先日志后执行）；
 * - 保护路径（用户偏好）直接拒绝。
 */

import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  FO_DELETE,
  FileOperatorError,
  ProtectedPathError,
  diffNewI,
  normPath,
  parseIFile,
  shFileOperation,
  snapshotRecycleI,
} from "./recycle-bin.js";
import type { LogEntry, OpRow, UndoManager } from "./undo-manager.js";

export { FileOperatorError, ProtectedPathError };

function datetimeNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// ---------------------------------------------------------------------------
// 批量分片（导出供单测）
// ---------------------------------------------------------------------------
/**
 * SHFileOperationW 的 pFrom/pTo 为双 NUL 结尾多字符串，受 MAX_PATH 级
 * 缓冲限制（实测超 32K 字符整批失败且无逐条错误）。内部按盘符分组后、
 * 在「30K 字符 + 400 条」双预算内切片，单片失败不影响其余片。
 */
export const CHUNK_CHAR_LIMIT = 30_000;
export const CHUNK_COUNT_LIMIT = 400;

export function chunkSources(sources: readonly string[]): string[][] {
  const byDrive = new Map<string, string[]>();
  for (const s of sources) {
    const root = path.parse(path.resolve(s)).root;
    const arr = byDrive.get(root) ?? [];
    arr.push(s);
    byDrive.set(root, arr);
  }
  const chunks: string[][] = [];
  for (const list of byDrive.values()) {
    let cur: string[] = [];
    let chars = 0;
    for (const s of list) {
      const need = s.length + 1;
      if (
        cur.length > 0 &&
        (chars + need > CHUNK_CHAR_LIMIT || cur.length >= CHUNK_COUNT_LIMIT)
      ) {
        chunks.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(s);
      chars += need;
    }
    if (cur.length > 0) chunks.push(cur);
  }
  return chunks;
}
// ---------------------------------------------------------------------------
// shutil.move / copy2 等价物
// ---------------------------------------------------------------------------
/** 复制文件并保留 mtime/atime（等价 shutil.copy2）。 */
function copyFilePreserving(src: string, destFile: string): void {
  fs.copyFileSync(src, destFile);
  try {
    const st = fs.lstatSync(src);
    fs.utimesSync(destFile, st.atime, st.mtime);
  } catch {
    /* 尽力而为 */
  }
}

/** 把 src（文件或目录树）复制到 destDir 下（等价 copytree/copy2 组合）。 */
function copyInto(src: string, destDir: string): string {
  const final = path.join(destDir, path.basename(src.replace(/[\\/]+$/, "")));
  const st = fs.lstatSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(final, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        // 复制子目录到「final 内」：构造父目录语义
        const sub = path.join(final, entry.name);
        fs.mkdirSync(sub, { recursive: true });
        copyChildren(s, sub);
      } else if (!entry.isSymbolicLink()) {
        copyFilePreserving(s, path.join(final, entry.name));
      }
    }
  } else {
    copyFilePreserving(src, final);
  }
  return final;
}

function copyChildren(srcDir: string, destDir: string): void {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      fs.mkdirSync(d, { recursive: true });
      copyChildren(s, d);
    } else if (!entry.isSymbolicLink()) {
      copyFilePreserving(s, d);
    }
  }
}

/** 移动到目录：同卷 rename，跨卷复制后删除。返回最终路径。 */
function moveInto(src: string, destDir: string): string {
  const final = path.join(destDir, path.basename(src.replace(/[\\/]+$/, "")));
  try {
    fs.renameSync(src, final);
    return final;
  } catch {
    // 跨卷
    copyInto(src, destDir);
    fs.rmSync(src, { recursive: true, force: false });
    return final;
  }
}

export interface OpResultEntry {
  source: string;
  status: "done" | "failed" | "skipped";
  dest?: string;
  recycle_bin_name?: string | null;
  /** 删除成功时：该条目移入回收站的字节数（目录为递归实测内容总量） */
  moved_bytes?: number;
  /** @deprecated 1.1.x 兼容别名 = moved_bytes；真正释放只发生在 empty_recycle_bin */
  freed_bytes?: number;
  /** failed/skipped 的原因（逐条必带，绝不静默失败） */
  error?: string;
}

export interface OperationResult {
  op_uuid: string;
  status: "completed" | "partial" | "failed";
  error?: string;
  results: OpResultEntry[];
  /** 删除操作：成功条目移入回收站的总字节（磁盘占用未变，需清空回收站才释放） */
  moved_bytes?: number;
  /** @deprecated 1.1.x 兼容别名 = moved_bytes；真正释放用 empty_recycle_bin 的 freed_bytes */
  freed_bytes?: number;
  /** 语义说明（delete 返回） */
  note?: string;
  /** 批量结果汇总（total/done/failed/skipped） */
  summary?: { total: number; done: number; failed: number; skipped: number };
}

export class FileOperator {
  constructor(
    private undo: UndoManager,
    private protectedCheck: (p: string) => boolean = () => false,
    private sessionId: string | null = null
  ) {}

  private checkProtection(sources: readonly string[]): void {
    const blocked = sources.filter((s) => this.protectedCheck(s));
    if (blocked.length > 0) {
      throw new ProtectedPathError(
        `路径处于保护列表，已拒绝操作: ${blocked[0]} 等 ${blocked.length} 项`
      );
    }
  }

  private entry(
    src: string,
    dest?: string | null,
    size?: number | null,
    mtime?: number | null
  ): LogEntry {
    return {
      source_path: src,
      dest_path: dest ?? null,
      file_size: size ?? null,
      file_mtime: mtime ?? null,
    };
  }

  private static statOf(p: string): [number | null, number | null] {
    try {
      const st = fs.statSync(p);
      return [Number(st.size), st.mtimeMs / 1000];
    } catch {
      return [null, null];
    }
  }

  /**
   * 操作时刻的真实体积：目录递归实测内容总量（st.size 对目录只是
   * 目录条目自身大小，通常 0~64KB，合账/审计均不可用）；文件取
   * st.size；不可访问时返回 null。跳过符号链接防死循环。
   */
  private static contentSizeOf(p: string): number | null {
    try {
      const st = fs.lstatSync(p);
      if (!st.isDirectory() || st.isSymbolicLink()) return Number(st.size);
    } catch {
      return null;
    }
    let total = 0;
    const stack: string[] = [p];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // 子目录不可访问：计入已测得部分
      }
      for (const e of entries) {
        if (e.isSymbolicLink()) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          stack.push(full);
        } else {
          try {
            total += Number(fs.lstatSync(full).size);
          } catch {
            /* 单文件不可统计：忽略 */
          }
        }
      }
    }
    return total;
  }

  /** 删除到回收站并捕获精确 $R 映射。
   *
   * 批量语义：
   * - 缺失源**不中止全批**：逐条标 skipped 并带原因（可选 opts.skipReasons
   *   注入调用方已知的原因，如 CLI 预检判定的幂等重跑）；
   * - 内部按盘符自动分片（SHFileOperationW 的 pFrom 多字符串有 32,767 字符
   *   上限，大批量一次调用必超限失败），单片失败只影响该片，其余片继续；
   * - 每片独立「快照→删除→比对」，错误逐条带 error 字段，绝不静默失败。
   */
  delete(
    sources: readonly string[],
    opts?: { skipReasons?: Record<string, string> }
  ): OperationResult {
    const batch = sources.filter(Boolean);
    this.checkProtection(batch);
    const opUuid = randomUUID();

    // 日志先落（含 skipped 条目，审计完整），sizes 记录操作时刻真实体积
    const sizes = new Map<string, number>();
    const entries: LogEntry[] = [];
    const skipped: { src: string; reason: string }[] = [];
    for (const s of batch) {
      const size = FileOperator.contentSizeOf(s);
      const mtime = FileOperator.statOf(s)[1];
      if (size !== null) sizes.set(s, size);
      entries.push(this.entry(s, undefined, size, mtime));
      if (!fs.existsSync(s)) {
        const reason = opts?.skipReasons?.[s] ?? "源路径不存在（可能已被移动/删除）";
        skipped.push({ src: s, reason });
      }
    }
    const ids = this.undo.logBatch(opUuid, "DELETE", entries, this.sessionId);
    const skipSet = new Set(skipped.map((k) => k.src));
    const pending = batch.filter((s) => !skipSet.has(s));

    const results: OpResultEntry[] = [];
    // skipped 条目：日志标 SKIPPED，结果逐条披露
    batch.forEach((s, i) => {
      const hit = skipped.find((k) => k.src === s);
      if (!hit) return;
      this.undo.updateEntry(ids[i]!, { status: "SKIPPED", error_msg: hit.reason });
      results.push({ source: s, status: "skipped", error: hit.reason });
    });

    // 按盘符分组 → 预算内切片（pFrom 30K 字符 + 单片 400 条双限制）
    const chunks = chunkSources(pending);

    // 每片独立：快照回收站 → SHFileOperation → 比对新增 $I → 精确映射
    const idOf = new Map(batch.map((s, i) => [s, ids[i]!]));
    for (const chunk of chunks) {
      // 分组快照（删除前，按片内涉及的盘）
      const snapshots = new Map<string, Map<string, string>>();
      for (const s of chunk) {
        const driveRoot = path.parse(path.resolve(s)).root;
        if (!snapshots.has(driveRoot)) {
          snapshots.set(driveRoot, snapshotRecycleI(driveRoot));
        }
      }

      let shellErrorMsg: string | null = null;
      try {
        shFileOperation(FO_DELETE, chunk);
      } catch (e) {
        shellErrorMsg = e instanceof Error ? e.message : String(e);
      }

      // 比对快照 → 解析新增 $I → 按原始路径精确映射。
      // Shell 返回后 $I 可能尚未对目录枚举可见，轮询至收集齐或超时。
      let newItems = new Map<string, import("./recycle-bin.js").IFileInfo>();
      if (shellErrorMsg === null) {
        for (let attempt = 0; attempt < 8; attempt++) {
          newItems = new Map();
          for (const [root, before] of snapshots) {
            for (const m of diffNewI(root, before)) {
              newItems.set(normPath(m.original_path), m);
            }
          }
          if (newItems.size >= chunk.length) break;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
        }
      }

      for (const s of chunk) {
        const id = idOf.get(s)!;
        const m = newItems.get(normPath(s));
        // 存在性判定带 50ms×6 有界复检：SHFileOperation 返回后高磁盘负载下
        // 元数据结算可能滞后，单次 existsSync 会把已成功的删除误判为失败
        let gone = false;
        for (let i = 0; i < 6; i++) {
          if (!fs.existsSync(s)) {
            gone = true;
            break;
          }
          if (i < 5) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
        if (!gone) {
          const reason = shellErrorMsg ?? "删除后源路径仍存在";
          this.undo.updateEntry(id, { status: "FAILED", error_msg: reason });
          results.push({ source: s, status: "failed", error: reason });
        } else {
          const fields: Record<string, unknown> = { status: "DONE" };
          if (m) {
            fields.recycle_bin_name = path.basename(m.r_path!);
            fields.recycle_info_name = path.basename(m.i_path!);
            fields.recycle_path = m.r_path;
          }
          this.undo.updateEntry(id, fields);
          results.push({
            source: s,
            status: "done",
            recycle_bin_name: (fields.recycle_bin_name as string) ?? null,
            moved_bytes: sizes.get(s) ?? 0,
            freed_bytes: 0, // 进回收站不释放磁盘占用；真正释放在 empty_recycle_bin
          });
        }
      }
    }

    const doneCount = results.filter((r) => r.status === "done").length;
    const failedCount = results.filter((r) => r.status === "failed").length;
    const skippedCount = results.filter((r) => r.status === "skipped").length;
    return {
      op_uuid: opUuid,
      status: failedCount > 0 ? "partial" : "completed",
      moved_bytes: results.reduce((acc, r) => acc + (r.moved_bytes ?? 0), 0),
      freed_bytes: 0,
      results,
      summary: { total: batch.length, done: doneCount, failed: failedCount, skipped: skippedCount },
      note:
        `共 ${batch.length} 项：成功 ${doneCount}、失败 ${failedCount}、跳过 ${skippedCount}。` +
        "已移入回收站（可撤销）；磁盘占用未释放，empty_recycle_bin 后才真正释放",
    };
  }

  /** move/copy 共用传输流程（缺失源逐条跳过披露，不中止全批）。 */
  private transfer(
    opType: "MOVE" | "COPY",
    sources: readonly string[],
    dest: string | null | undefined,
    fn: (src: string, destDir: string) => string,
    skipReasons?: Record<string, string>
  ): OperationResult {
    const batch = sources.filter(Boolean);
    this.checkProtection(batch);
    if (!dest || !fs.existsSync(dest) || !fs.statSync(dest).isDirectory()) {
      throw new FileOperatorError(`目标目录不存在: ${dest}`);
    }
    const opUuid = randomUUID();
    const results: OpResultEntry[] = [];

    for (const s of batch) {
      if (!fs.existsSync(s)) {
        // 单源缺失不中止全批：逐条标 skipped 并披露原因（优先调用方注入）
        const reason =
          skipReasons?.[s] ?? "源路径不存在（可能已被移动/删除）";
        const [skipId] = this.undo.logBatch(
          opUuid, opType, [this.entry(s, null, null, null)], this.sessionId
        );
        this.undo.updateEntry(skipId!, { status: "SKIPPED", error_msg: reason });
        results.push({ source: s, status: "skipped", error: reason });
        continue;
      }
      const size = FileOperator.contentSizeOf(s);
      const mtime = FileOperator.statOf(s)[1];
      const final = path.join(dest, path.basename(s.replace(/[\\/]+$/, "")));
      const [entryId] = this.undo.logBatch(
        opUuid, opType, [this.entry(s, final, size, mtime)], this.sessionId
      );
      const id = entryId!;
      try {
        const actual = fn(s, dest);
        this.undo.updateEntry(id, { status: "DONE", dest_path: actual });
        results.push({ source: s, dest: actual, status: "done" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.undo.updateEntry(id, { status: "FAILED", error_msg: msg });
        results.push({ source: s, status: "failed", error: msg });
      }
    }
    const done = results.filter((r) => r.status === "done").length;
    const failed = results.filter((r) => r.status === "failed").length;
    const skippedN = results.filter((r) => r.status === "skipped").length;
    return {
      op_uuid: opUuid,
      status: failed > 0 ? "partial" : "completed",
      results,
      summary: { total: batch.length, done, failed, skipped: skippedN },
    };
  }

  /** 移动（撤销 = 从 dest 移回原位）。 */
  move(
    sources: readonly string[],
    dest: string,
    opts?: { skipReasons?: Record<string, string> }
  ): OperationResult {
    return this.transfer("MOVE", sources, dest, moveInto, opts?.skipReasons);
  }

  /** 复制（撤销 = 副本送入回收站）。 */
  copy(
    sources: readonly string[],
    dest: string,
    opts?: { skipReasons?: Record<string, string> }
  ): OperationResult {
    return this.transfer("COPY", sources, dest, copyInto, opts?.skipReasons);
  }

  /** 压缩为 ZIP（DEFLATE）。destDir 缺省为第一个存在源所在目录；缺失源跳过披露。 */
  compress(sources: readonly string[], destDir?: string | null): OperationResult {
    const batch = sources.filter(Boolean);
    this.checkProtection(batch);
    const missing = batch.filter((s) => !fs.existsSync(s));
    const present = batch.filter((s) => fs.existsSync(s));
    const skipReason = "源路径不存在（可能已被移动/删除），未参与压缩";
    if (present.length === 0) {
      // 全部缺失：无法定位输出目录，整批披露后返回
      const opUuid = randomUUID();
      const entries = batch.map((s) => this.entry(s, null, null, null));
      const ids = this.undo.logBatch(opUuid, "COMPRESS", entries, this.sessionId);
      ids.forEach((id) => this.undo.updateEntry(id, { status: "SKIPPED", error_msg: skipReason }));
      return {
        op_uuid: opUuid,
        status: "failed",
        error: `全部源路径不存在，无法压缩（首个: ${batch[0] ?? ""}）`,
        results: batch.map((s) => ({ source: s, status: "skipped" as const, error: skipReason })),
        summary: { total: batch.length, done: 0, failed: 0, skipped: batch.length },
      };
    }
    destDir = destDir || path.dirname(path.resolve(present[0]!));
    const base = path.basename(present[0]!.replace(/[\\/]+$/, ""));
    const stem = base.includes(".") && !base.startsWith(".") ? base.slice(0, base.lastIndexOf(".")) : base;
    let zipPath = path.join(destDir, `${stem}.zip`);
    let n = 1;
    while (fs.existsSync(zipPath)) {
      zipPath = path.join(destDir, `${stem}_${n}.zip`);
      n++;
    }

    const opUuid = randomUUID();
    const entries: LogEntry[] = [];
    for (const s of present) {
      const size = FileOperator.contentSizeOf(s);
      const mtime = FileOperator.statOf(s)[1];
      entries.push(this.entry(s, zipPath, size, mtime));
    }
    const ids = this.undo.logBatch(opUuid, "COMPRESS", entries, this.sessionId);
    // 缺失源日志补录（SKIPPED，审计完整）
    for (const s of missing) {
      const [id] = this.undo.logBatch(opUuid, "COMPRESS", [this.entry(s, null, null, null)], this.sessionId);
      this.undo.updateEntry(id!, { status: "SKIPPED", error_msg: skipReason });
    }
    try {
      const zip = new AdmZip();
      for (const s of present) {
        const abs = path.resolve(s);
        if (fs.statSync(abs).isDirectory()) {
          const parentOfSrc = path.dirname(abs.replace(/[\\/]+$/, ""));
          addTreeToZip(zip, abs, parentOfSrc);
        } else {
          zip.addLocalFile(abs, "");
        }
      }
      zip.writeZip(zipPath);
      const total = fs.statSync(zipPath).size;
      for (const id of ids) this.undo.updateEntry(id, { status: "DONE", file_size: total });
      const results: OpResultEntry[] = [
        ...present.map((s) => ({ source: s, dest: zipPath, status: "done" as const })),
        ...missing.map((s) => ({ source: s, status: "skipped" as const, error: skipReason })),
      ];
      return {
        op_uuid: opUuid,
        status: "completed",
        results,
        summary: { total: batch.length, done: present.length, failed: 0, skipped: missing.length },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      for (const id of ids) this.undo.updateEntry(id, { status: "FAILED", error_msg: msg });
      throw new FileOperatorError(`压缩失败: ${msg}`);
    }
  }

  /** 在资源管理器中定位文件（explorer /select）。 */
  static openInExplorer(target: string): void {
    if (process.platform !== "win32") throw new FileOperatorError("仅支持 Windows");
    // explorer /select 立即返回，无需 detached
    spawnSync("explorer", ["/select,", path.resolve(target)], { stdio: "ignore" });
  }
}

function addTreeToZip(zip: AdmZip, dir: string, relRoot: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(relRoot, full);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      addTreeToZip(zip, full, relRoot);
    } else if (!entry.isSymbolicLink()) {
      zip.addLocalFile(full, path.dirname(rel) === "." ? "" : path.dirname(rel).replace(/\\/g, "/"));
    }
  }
}

// ---------------------------------------------------------------------------
// 五步回滚
// ---------------------------------------------------------------------------
/** 防覆盖：目标已存在时改为 base_restored_N.ext。 */
function conflictFreeTarget(target: string): string {
  if (!fs.existsSync(target)) return target;
  const ext = path.extname(target);
  const base = target.slice(0, target.length - ext.length);
  let counter = 1;
  while (fs.existsSync(`${base}_restored_${counter}${ext}`)) counter++;
  return `${base}_restored_${counter}${ext}`;
}

/** 把 $R 物理文件还原到 target（同盘 rename，跨盘复制兜底）。 */
export function restoreFromRecycleBin(rPath: string, target: string): string {
  if (!fs.existsSync(rPath)) {
    throw new FileOperatorError(`回收站物理文件不存在: ${rPath}`);
  }
  try {
    fs.renameSync(rPath, target);
  } catch {
    const st = fs.lstatSync(rPath);
    if (st.isDirectory()) {
      fs.cpSync(rPath, target, { recursive: true });
    } else {
      fs.copyFileSync(rPath, target);
    }
    fs.rmSync(rPath, { recursive: true });
  }
  // 清理对应 $I 元数据（best-effort，失败不影响还原结果）
  const rp = path.parse(rPath);
  const iPath = path.join(rp.dir, `$I${rp.name.slice(2)}${rp.ext}`);
  try {
    if (fs.existsSync(iPath)) fs.unlinkSync(iPath);
  } catch {
    /* 尽力而为 */
  }
  return target;
}

/** 降级路径：按原始路径扫描全盘回收站 $I 匹配（无精确映射时）。 */
function findRecycleItemBySource(source: string): string | null {
  const root = path.parse(path.resolve(source)).root;
  const rb = path.join(root, "$Recycle.Bin");
  if (!fs.existsSync(rb)) return null;
  const want = normPath(source);
  for (const sid of iterDirs(rb)) {
    const sidPath = path.join(rb, sid);
    for (const item of iterDirs(sidPath)) {
      if (!item.toUpperCase().startsWith("$I")) continue;
      const itemPath = path.join(sidPath, item);
      try {
        if (!fs.statSync(itemPath).isFile()) continue;
        const info = parseIFile(fs.readFileSync(itemPath));
        if (info && normPath(info.original_path) === want) {
          const ip = path.parse(itemPath);
          const r = path.join(ip.dir, `$R${ip.name.slice(2)}${ip.ext}`);
          if (fs.existsSync(r)) return r;
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}

function iterDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

export interface UndoResult {
  status: "success" | "partial" | "failed";
  op_uuid?: string;
  restored?: Record<string, unknown>[];
  failed?: Record<string, unknown>[];
  skipped?: Record<string, unknown>[];
  error?: string;
}

/**
 * 五步预检回滚：状态锁定 → 父目录存活 → 冲突重命名 → 权限 → 物理还原。
 * 按 op_uuid 整批回滚，单条失败不阻断其余。
 */
export function executeUndo(opId: number, undo: UndoManager): UndoResult {
  const entry = undo.getEntry(opId);
  if (entry === null) {
    return { status: "failed", error: `操作记录 ${opId} 不存在` };
  }

  const batch = undo.getBatch(entry.op_uuid);
  const restored: Record<string, unknown>[] = [];
  const failed: Record<string, unknown>[] = [];
  const skipped: Record<string, unknown>[] = [];

  for (const row of batch as OpRow[]) {
    // 步骤 1：状态锁定
    if (row.status === "UNDONE") {
      skipped.push({ id: row.id, source: row.source_path, reason: "此操作已撤销过" });
      continue;
    }
    if (row.status === "SKIPPED") {
      skipped.push({ id: row.id, source: row.source_path, reason: "原操作被跳过（源缺失），无可回滚内容" });
      continue;
    }
    if (row.status === "FAILED") {
      failed.push({ id: row.id, source: row.source_path, error: "原操作未成功，无可回滚内容" });
      continue;
    }

    try {
      const target = conflictFreeTarget(row.source_path);

      // COPY/COMPRESS 的撤销 = 把产物送回回收站（保持可逆）
      if (row.op_type === "COPY" || row.op_type === "COMPRESS") {
        const dest = row.dest_path;
        if (dest && fs.existsSync(dest)) {
          shFileOperation(FO_DELETE, [dest]);
        }
        undo.updateEntry(row.id, { status: "UNDONE", undone_at: datetimeNow() });
        restored.push({ id: row.id, restored_to: dest, note: "副本已移入回收站" });
        continue;
      }

      // 步骤 2：父目录存活检测
      const parent = path.dirname(row.source_path);
      if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
        undo.updateEntry(row.id, {
          status: "FAILED",
          error_msg: `父目录 '${parent}' 不存在`,
        });
        failed.push({ id: row.id, source: row.source_path, error: `父目录 '${parent}' 不存在` });
        continue;
      }

      // 步骤 4：权限预检
      try {
        fs.accessSync(parent, fs.constants.W_OK);
      } catch {
        undo.updateEntry(row.id, { status: "FAILED", error_msg: "无写入权限" });
        failed.push({ id: row.id, source: row.source_path, error: `无权限写入 '${parent}'` });
        continue;
      }

      // 步骤 5：物理回滚
      if (row.op_type === "DELETE") {
        const rPath =
          row.recycle_path ||
          findRecycleItemBySource(row.source_path);
        if (!rPath) {
          undo.updateEntry(row.id, { status: "FAILED", error_msg: "回收站中未找到对应文件" });
          failed.push({
            id: row.id,
            source: row.source_path,
            error: "回收站中未找到（可能已被清空）",
          });
          continue;
        }
        restoreFromRecycleBin(rPath, target);
      } else if (row.op_type === "MOVE" || row.op_type === "RENAME") {
        if (!(row.dest_path && fs.existsSync(row.dest_path))) {
          undo.updateEntry(row.id, { status: "FAILED", error_msg: "移动产物不存在" });
          failed.push({
            id: row.id,
            source: row.source_path,
            error: `目标 '${row.dest_path}' 不存在`,
          });
          continue;
        }
        moveBack(row.dest_path, target);
      } else {
        failed.push({
          id: row.id,
          source: row.source_path,
          error: `不支持回滚的操作类型 ${row.op_type}`,
        });
        continue;
      }

      undo.updateEntry(row.id, { status: "UNDONE", undone_at: datetimeNow() });
      restored.push({ id: row.id, restored_to: target });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      undo.updateEntry(row.id, { status: "FAILED", error_msg: msg });
      failed.push({ id: row.id, source: row.source_path, error: msg });
    }
  }

  const status: UndoResult["status"] =
    failed.length > 0 && restored.length === 0
      ? "failed"
      : failed.length > 0
        ? "partial"
        : "success";
  return {
    status,
    op_uuid: entry.op_uuid,
    restored,
    failed,
    skipped,
  };
}

/** 把产物从 dest 移回 target（文件或目录树）。 */
function moveBack(dest: string, target: string): void {
  const st = fs.lstatSync(dest);
  if (st.isDirectory()) {
    fs.cpSync(dest, target, { recursive: true });
    fs.rmSync(dest, { recursive: true });
  } else {
    fs.renameSync(dest, target);
  }
}
