/**
 * Windows 回收站底层能力。
 *
 * 铁律 3 落地点：
 * - 删除只走 Windows 回收站（SHFileOperationW + FOF_ALLOWUNDO，与
 *   IFileOperation 同一 Shell 语义），**绝不** unlink/rmSync；
 * - 删除前快照、删除后比对 `$Recycle.Bin\<SID>\$I*` 文件，解析新增
 *   $I 元数据（原始路径/大小/删除时间）获得**精确的 $R 映射**，
 *   撤销时按 $R 物理文件名一步还原，无事后匹配误差；
 * - 其他用户 SID 的回收站目录不可读时静默跳过（权限铁律）。
 */

import fs from "node:fs";
import path from "node:path";
import koffi from "koffi";

export class FileOperatorError extends Error {}

/** 目标位于用户保护路径，已拒绝操作。 */
export class ProtectedPathError extends FileOperatorError {}

// ---------------------------------------------------------------------------
// SHFileOperationW（手工布局 x64 结构体，已实测验证）
// ---------------------------------------------------------------------------
const FO_MOVE = 1;
const FO_COPY = 2;
export const FO_DELETE = 3;

const FOF_SILENT = 0x4;
const FOF_NOCONFIRMATION = 0x10;
const FOF_ALLOWUNDO = 0x40;
const FOF_NOERRORUI = 0x400;
const FO_FLAGS_DELETE = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI;
const FO_FLAGS_TRANSFER = FO_FLAGS_DELETE;

const shell32 = koffi.load("shell32.dll");
const SHFileOperationW = shell32.func("__stdcall", "SHFileOperationW", "int32", ["void *"]);

/** 多路径要求 pFrom/pTo 为双 NUL 结尾的多字符串（"a\0b\0\0"）。 */
function doubleNulBuf(s: string): Buffer {
  return Buffer.concat([Buffer.from(s, "utf16le"), Buffer.alloc(4)]);
}

function buildOp(wFunc: number, flags: number, pFrom: Buffer, pTo: Buffer | null): Buffer {
  const fromAddr = koffi.address(pFrom);
  const toAddr = pTo ? koffi.address(pTo) : 0n;
  const op = Buffer.alloc(56);
  op.writeBigUInt64LE(0n, 0); // hwnd
  op.writeUInt32LE(wFunc, 8); // wFunc
  op.writeBigUInt64LE(fromAddr, 16); // pFrom
  op.writeBigUInt64LE(toAddr, 24); // pTo
  op.writeUInt16LE(flags, 32); // fFlags
  op.writeUInt32LE(0, 36); // fAnyOperationsAborted（出参）
  return op; // hNameMappings/lpszProgressTitle 保持 0
}

/**
 * 执行一次 Shell 文件操作；失败抛 FileOperatorError。
 */
export function shFileOperation(
  func: number,
  sources: readonly string[],
  dest?: string | null
): void {
  if (process.platform !== "win32") {
    throw new FileOperatorError("Shell 文件操作仅支持 Windows");
  }
  const pFrom = doubleNulBuf(sources.join("\0"));
  const pTo = dest ? doubleNulBuf(dest) : null;
  const flags = func === FO_DELETE ? FO_FLAGS_DELETE : FO_FLAGS_TRANSFER;
  const op = buildOp(func, flags, pFrom, pTo);
  const res = SHFileOperationW(op);
  if (res !== 0) {
    throw new FileOperatorError(`Shell 操作失败，错误码 0x${res.toString(16).toUpperCase()}（0x7C=用户取消/条件不满足）`);
  }
  if (op.readUInt32LE(36) !== 0) {
    throw new FileOperatorError("操作被系统或用户取消");
  }
}

// ---------------------------------------------------------------------------
// 回收站 $I 文件解析（Vista+ 二进制格式，公开已知布局）
// ---------------------------------------------------------------------------
export interface IFileInfo {
  size: bigint;
  deleted_at_ft: bigint;
  original_path: string;
  i_path?: string;
  r_path?: string;
}

/**
 * 解析 $I 元数据文件：{size, deleted_at_ft(FileTime), original_path}。
 *
 * 兼容两种已知布局：
 * - Windows 8+/10/11（v2 长度前缀）：头 24 字节 + u32 字符数 + UTF-16LE 路径
 * - Vista/7（v2 固定缓冲）：头 24 字节 + NUL 终止的 UTF-16LE 路径
 */
export function parseIFile(data: Buffer): IFileInfo | null {
  if (data.length < 24) return null;
  const version = Number(data.readBigUInt64LE(0));
  if (version !== 1 && version !== 2) return null;
  const size = data.readBigUInt64LE(8);
  const delFt = data.readBigUInt64LE(16);

  let decoded: string | null = null;
  // 布局一：长度前缀。长度含结尾 NUL（实测 Win11），解码后 strip 尾部 NUL。
  if (data.length >= 28) {
    const pathLen = data.readUInt32LE(24);
    if (pathLen > 0 && pathLen < 1024 && 28 + pathLen * 2 <= data.length + 2) {
      try {
        decoded = stripNul(data.toString("utf16le", 28, Math.min(28 + pathLen * 2, data.length)));
      } catch {
        decoded = null;
      }
    }
  }
  // 布局二：NUL 终止（按 2 字节对齐查找终止符）
  if (!decoded) {
    let end = data.length;
    for (let i = 24; i < data.length - 1; i += 2) {
      if (data[i] === 0 && data[i + 1] === 0) {
        end = i;
        break;
      }
    }
    try {
      decoded = stripNul(data.toString("utf16le", 24, end));
    } catch {
      return null;
    }
  }
  if (!decoded) return null;
  return { size, deleted_at_ft: delFt, original_path: decoded };
}

function stripNul(s: string): string {
  return s.replace(/\0+$/g, "");
}

/** 快照指定盘 `$Recycle.Bin` 下可读的全部 $I 文件。 */
export function snapshotRecycleI(driveRoot: string): Map<string, string> {
  const rb = path.join(driveRoot, "$Recycle.Bin");
  const found = new Map<string, string>();
  if (!fs.existsSync(rb)) return found;
  for (const sid of iterSafely(rb)) {
    const sidPath = path.join(rb, sid);
    let st: fs.Stats;
    try {
      st = fs.statSync(sidPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const item of iterSafely(sidPath)) {
      const itemPath = path.join(sidPath, item);
      if (item.slice(0, 2).toUpperCase() !== "$I") continue;
      try {
        if (!fs.statSync(itemPath).isFile()) continue;
        found.set(itemPath.toLowerCase(), itemPath);
      } catch {
        continue;
      }
    }
  }
  return found;
}

function iterSafely(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** 对比删除前后快照，返回新增 $I 的解析结果。 */
export function diffNewI(driveRoot: string, before: Map<string, string>): IFileInfo[] {
  const after = snapshotRecycleI(driveRoot);
  const mappings: IFileInfo[] = [];
  for (const [low, real] of after) {
    if (before.has(low)) continue;
    const dir = path.dirname(real);
    const name = path.basename(real); // 真实大小写，形如 "$IABC123.ext"
    const rName = `$R${name.slice(2)}`;
    let data: Buffer;
    try {
      data = fs.readFileSync(real);
    } catch {
      continue;
    }
    const info = parseIFile(data);
    if (info === null) continue;
    info.i_path = path.join(dir, name);
    info.r_path = path.join(dir, rName);
    mappings.push(info);
  }
  return mappings;
}

/** 路径归一化：绝对 + 小写 + 反斜杠。 */
export function normPath(p: string): string {
  return path.resolve(p).toLowerCase().replace(/\//g, "\\");
}

/** 回收站占用统计（只读）：遍历所有固定盘的 $I 条目并解析元数据。 */
export function recycleBinStatus(): {
  entries: number;
  total_bytes: number;
  per_drive: Record<string, { entries: number; bytes: number }>;
} {
  if (process.platform !== "win32") {
    throw new FileOperatorError("回收站功能仅支持 Windows");
  }
  let entries = 0;
  let totalBytes = 0;
  const perDrive: Record<string, { entries: number; bytes: number }> = {};
  for (let i = 65; i <= 90; i++) {
    const letter = String.fromCharCode(i);
    const drive = `${letter}:\\`;
    if (!fs.existsSync(drive)) continue;
    const rb = path.join(drive, "$Recycle.Bin");
    if (!fs.existsSync(rb)) continue;
    let dEntries = 0;
    let dBytes = 0;
    for (const sid of iterSafely(rb)) {
      const sidPath = path.join(rb, sid);
      for (const item of iterSafely(sidPath)) {
        if (item.slice(0, 2).toUpperCase() !== "$I") continue;
        try {
          if (!fs.statSync(path.join(sidPath, item)).isFile()) continue;
          const info = parseIFile(fs.readFileSync(path.join(sidPath, item)));
          if (info === null) continue;
          dEntries++;
          dBytes += Number(info.size);
        } catch {
          continue;
        }
      }
    }
    if (dEntries > 0) {
      perDrive[`${letter}:`] = { entries: dEntries, bytes: dBytes };
      entries += dEntries;
      totalBytes += dBytes;
    }
  }
  return { entries, total_bytes: totalBytes, per_drive: perDrive };
}

/**
 * 受控清空：仅永久删除指定 op_uuid 产生的回收站条目。
 *
 * 安全策略：
 * - 从审计日志取该 op_uuid 的全部 DONE 且带 recycle_path 的条目；
 * - 逐条校验 $I 文件仍存在且解析出的原始路径与日志匹配；
 * - 匹配则删除 $I/$R 对；不匹配则跳过并计入 mismatch（宁可不删也不误删）；
 * - 清空后条目标记 EMPTIED（不可撤销）。
 */
export function emptyRecycleBinForOp(
  opUuid: string,
  undo: import("./undo-manager.js").UndoManager
): Record<string, unknown> {
  if (process.platform !== "win32") {
    throw new FileOperatorError("回收站功能仅支持 Windows");
  }
  const rows = undo.getBatch(opUuid);
  if (rows.length === 0) {
    return { status: "error", error: `操作不存在: ${opUuid}`, freed_bytes: 0, emptied: 0, mismatch: 0 };
  }

  let freed = 0;
  let emptied = 0;
  let mismatch = 0;
  for (const row of rows) {
    const rPath = row.recycle_path;
    if (!rPath || row.status !== "DONE") continue;
    // 定位同目录下的 $I 文件（$Rxxx → $Ixxx）
    const rp = path.parse(rPath);
    const iFile = path.join(rp.dir, `$I${rp.name.slice(2)}${rp.ext}`);
    if (!fs.existsSync(iFile)) {
      mismatch++;
      continue;
    }
    let info: IFileInfo | null;
    try {
      info = parseIFile(fs.readFileSync(iFile));
    } catch {
      mismatch++;
      continue;
    }
    // 校验：$I 记录的原始路径与日志 source_path 一致（大小写不敏感）
    if (info === null || normPath(info.original_path) !== normPath(row.source_path)) {
      mismatch++;
      continue;
    }
    // 永久删除 $R 与 $I（$R 可能是文件或目录，且可能带只读属性）
    try {
      const size = fs.existsSync(rPath) ? rmSizeOf(rPath) : row.file_size ?? 0;
      rmForced(rPath);
      rmForced(iFile);
      freed += size;
      emptied++;
      undo.updateEntry(row.id, { status: "EMPTIED" });
    } catch {
      mismatch++;
    }
  }
  return {
    status: "completed",
    op_uuid: opUuid,
    freed_bytes: freed,
    emptied,
    mismatch,
    message: "已永久删除的条目不可撤销",
  };
}

/** 强制删除文件或整树（清只读属性后删；用于回收站物理条目）。 */
function rmForced(target: string): void {
  if (!fs.existsSync(target)) return;
  const st = fs.lstatSync(target);
  if (st.isDirectory()) {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      rmForced(path.join(target, entry.name));
    }
    try {
      fs.chmodSync(target, 0o666);
    } catch {
      /* 尽力而为 */
    }
    fs.rmdirSync(target);
  } else {
    try {
      fs.chmodSync(target, 0o666);
    } catch {
      /* 尽力而为 */
    }
    fs.unlinkSync(target);
  }
}

function rmSizeOf(target: string): number {
  try {
    const st = fs.statSync(target, { throwIfNoEntry: false });
    if (!st) return 0;
    if (st.isFile()) return st.size;
    let total = 0;
    for (const entry of fs.readdirSync(target)) {
      total += rmSizeOf(path.join(target, entry));
    }
    return total;
  } catch {
    return 0;
  }
}
