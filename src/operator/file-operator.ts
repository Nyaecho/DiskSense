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
  status: "done" | "failed";
  dest?: string;
  recycle_bin_name?: string | null;
  /** 删除成功时：该条目释放的字节数（与 empty_recycle_bin 口径一致） */
  freed_bytes?: number;
  error?: string;
}

export interface OperationResult {
  op_uuid: string;
  status: "completed" | "failed";
  error?: string;
  results: OpResultEntry[];
  /** 全部成功条目累计释放字节数（delete 操作） */
  freed_bytes?: number;
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

  /** 删除到回收站并捕获精确 $R 映射。 */
  delete(sources: readonly string[]): OperationResult {
    sources = sources.filter(Boolean);
    this.checkProtection(sources);
    const missing = sources.filter((s) => !fs.existsSync(s));
    if (missing.length > 0) throw new FileOperatorError(`源路径不存在: ${missing[0]}`);

    const opUuid = randomUUID();
    const sizes = new Map<string, number>();
    const entries = sources.map((s) => {
      const [size, mtime] = FileOperator.statOf(s);
      if (size !== null) sizes.set(s, size);
      return this.entry(s, undefined, size, mtime);
    });
    const ids = this.undo.logBatch(opUuid, "DELETE", entries, this.sessionId);

    // 按盘符分组快照回收站（删除前）。键为盘根（带分隔符）。
    const snapshots = new Map<string, Map<string, string>>();
    for (const s of sources) {
      const parsed = path.parse(path.resolve(s));
      const driveRoot = `${parsed.root}`;
      if (driveRoot && !snapshots.has(driveRoot)) {
        snapshots.set(driveRoot, snapshotRecycleI(driveRoot));
      }
    }

    let results: OpResultEntry[] = [];
    try {
      shFileOperation(FO_DELETE, sources);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ids.forEach((id, i) =>
        this.undo.updateEntry(id, { status: "FAILED", error_msg: msg })
      );
      return {
        op_uuid: opUuid,
        status: "failed",
        error: msg,
        results: sources.map((s) => ({ source: s, status: "failed" as const })),
      };
    }

    // 比对快照 → 解析新增 $I → 按原始路径精确映射。
    // Shell 返回后 $I 可能尚未对目录枚举可见，轮询至收集齐或超时。
    let newItems = new Map<string, import("./recycle-bin.js").IFileInfo>();
    for (let attempt = 0; attempt < 8; attempt++) {
      newItems = new Map();
      for (const [root, before] of snapshots) {
        for (const m of diffNewI(root, before)) {
          newItems.set(normPath(m.original_path), m);
        }
      }
      if (newItems.size >= sources.length) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }

    ids.forEach((id, i) => {
      const s = sources[i]!;
      const m = newItems.get(normPath(s));
      if (fs.existsSync(s)) {
        this.undo.updateEntry(id, { status: "FAILED", error_msg: "删除后源路径仍存在" });
        results.push({ source: s, status: "failed", error: "删除未生效" });
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
          freed_bytes: sizes.get(s) ?? 0,
        });
      }
    });
    return {
      op_uuid: opUuid,
      status: "completed",
      freed_bytes: results.reduce((acc, r) => acc + (r.freed_bytes ?? 0), 0),
      results,
    };
  }

  /** move/copy 共用传输流程。 */
  private transfer(
    opType: "MOVE" | "COPY",
    sources: readonly string[],
    dest: string | null | undefined,
    fn: (src: string, destDir: string) => string
  ): OperationResult {
    sources = sources.filter(Boolean);
    this.checkProtection(sources);
    if (!dest || !fs.existsSync(dest) || !fs.statSync(dest).isDirectory()) {
      throw new FileOperatorError(`目标目录不存在: ${dest}`);
    }
    const opUuid = randomUUID();
    const results: OpResultEntry[] = [];

    for (const s of sources) {
      if (!fs.existsSync(s)) throw new FileOperatorError(`源路径不存在: ${s}`);
      const [size, mtime] = FileOperator.statOf(s);
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
    return { op_uuid: opUuid, status: "completed", results };
  }

  /** 移动（撤销 = 从 dest 移回原位）。 */
  move(sources: readonly string[], dest: string): OperationResult {
    return this.transfer("MOVE", sources, dest, moveInto);
  }

  /** 复制（撤销 = 副本送入回收站）。 */
  copy(sources: readonly string[], dest: string): OperationResult {
    return this.transfer("COPY", sources, dest, copyInto);
  }

  /** 压缩为 ZIP（DEFLATE）。destDir 缺省为第一个源所在目录。 */
  compress(sources: readonly string[], destDir?: string | null): OperationResult {
    sources = sources.filter(Boolean);
    this.checkProtection(sources);
    const missing = sources.filter((s) => !fs.existsSync(s));
    if (missing.length > 0) throw new FileOperatorError(`源路径不存在: ${missing[0]}`);
    destDir = destDir || path.dirname(path.resolve(sources[0]!));
    const base = path.basename(sources[0]!.replace(/[\\/]+$/, ""));
    const stem = base.includes(".") && !base.startsWith(".") ? base.slice(0, base.lastIndexOf(".")) : base;
    let zipPath = path.join(destDir, `${stem}.zip`);
    let n = 1;
    while (fs.existsSync(zipPath)) {
      zipPath = path.join(destDir, `${stem}_${n}.zip`);
      n++;
    }

    const opUuid = randomUUID();
    const entries: LogEntry[] = [];
    for (const s of sources) {
      const [size, mtime] = FileOperator.statOf(s);
      entries.push(this.entry(s, zipPath, size, mtime));
    }
    const ids = this.undo.logBatch(opUuid, "COMPRESS", entries, this.sessionId);
    try {
      const zip = new AdmZip();
      for (const s of sources) {
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
      return {
        op_uuid: opUuid,
        status: "completed",
        results: sources.map((s) => ({ source: s, dest: zipPath, status: "done" as const })),
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
