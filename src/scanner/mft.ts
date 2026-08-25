/**
 * NTFS MFT 直读扫描器（快速路径主路径）。
 *
 * 通过 koffi 打开 `\\.\X:` 卷句柄，FSCTL_GET_NTFS_VOLUME_DATA 定位
 * $MFT 后顺序解析 FILE 记录（应用 Fixup、解析 $FILE_NAME 属性），一次性获得
 * 全卷文件元数据，速度接近 Everything。
 *
 * 权限模型（第一层）：尝试启用 SeBackupPrivilege；失败或无管理员
 * 权限时抛出 MftUnavailableError，由 scanner 静默降级到 fs walk。
 * 本模块**只读取元数据**，绝不修改 ACL（禁用 takeown/icacls 铁律）。
 *
 * 解析器（parseRecord / parseVolumeData / buildTree）为纯函数，
 * 可用合成字节进行单元测试，无需真实卷与管理员权限。
 */

import koffi from "koffi";
import path from "node:path";
import { createNode, finalizeTree, type ScanResult, type TreeNode } from "../types.js";
import { fnmatch } from "../glob.js";

// NTFS 元数据记录号
export const ROOT_FILE_NUM = 5;

// 属性类型
const ATTR_ATTRIBUTE_LIST = 0x20;
const ATTR_FILE_NAME = 0x30;
const ATTR_REPARSE_POINT = 0xc0;

// 记录 flags
const RECORD_IN_USE = 0x0001;
const RECORD_IS_DIRECTORY = 0x0002;

// $FILE_NAME namespace
const NS_DOS = 2;

/** MFT 快速路径不可用（无权限/非 NTFS/读取失败），应降级 fs walk。 */
export class MftUnavailableError extends Error {}

export interface MftRecord {
  parent: number;
  name: string;
  size: number;
  mtime: number;
  atime: number;
  /** bit0 = 目录, bit1 = 重解析点(Junction/符号链接) */
  flags: number;
}

const EPOCH_DIFF = 116444736000000000n; // FILETIME(100ns) 与 Unix epoch 之差

/** FILETIME(自 1601 起 100ns) → Unix 时间戳；0 视为未知返回 0。 */
export function filetimeToUnix(ft: bigint): number {
  if (ft === 0n) return 0;
  return Number(ft - EPOCH_DIFF) / 1e7;
}

function u16(buf: Buffer, off: number): number {
  return buf.readUInt16LE(off);
}
function u32(buf: Buffer, off: number): number {
  return buf.readUInt32LE(off);
}
function u64(buf: Buffer, off: number): bigint {
  return buf.readBigUInt64LE(off);
}

export interface VolumeData {
  bytesPerCluster: number;
  bytesPerFrs: number;
  mftValidDataLength: number;
  mftStartLcn: number;
}

/** 解析 NTFS_VOLUME_DATA_BUFFER（FSCTL_GET_NTFS_VOLUME_DATA 输出）。 */
export function parseVolumeData(buf: Buffer): VolumeData {
  if (buf.length < 88) throw new MftUnavailableError("卷数据缓冲区不完整");
  const bytesPerCluster = Number(buf.readBigInt64LE(5 * 8));
  const bytesPerFrs = Number(buf.readBigInt64LE(7 * 8));
  const mftValidDataLength = buf.readBigInt64LE(9 * 8);
  const mftStartLcn = buf.readBigInt64LE(10 * 8);
  if (bytesPerCluster <= 0 || bytesPerFrs <= 0) {
    throw new MftUnavailableError("非 NTFS 卷或卷数据异常");
  }
  return {
    bytesPerCluster,
    bytesPerFrs,
    mftValidDataLength: Number(mftValidDataLength),
    mftStartLcn: Number(mftStartLcn),
  };
}

/** 应用 Update Sequence Array 修复，校验失败返回 null。 */
export function applyFixups(buf: Buffer): Buffer | null {
  if (buf.length < 0x30 || buf.subarray(0, 4).toString("latin1") !== "FILE") return null;
  const usaOff = u16(buf, 0x04);
  const usaCnt = u16(buf, 0x06);
  if (usaCnt < 2) return null;
  const nSectors = usaCnt - 1;
  if (nSectors <= 0 || buf.length % nSectors !== 0) return null;
  const sectorSize = buf.length / nSectors;
  if (usaOff + usaCnt * 2 > buf.length) return null;
  const arr = Buffer.from(buf); // 拷贝后再修
  const usaWord = (i: number) => arr.readUInt16LE(usaOff + i * 2);
  for (let i = 1; i <= nSectors; i++) {
    const tail = sectorSize * i - 2;
    if (arr.readUInt16LE(tail) !== usaWord(0)) return null; // 校验和不过 → 记录损坏
    arr.writeUInt16LE(usaWord(i), tail);
  }
  return arr;
}

/**
 * 解析单个 MFT FILE 记录（须先应用 Fixup）。
 * 记录未使用 / 损坏 / 含 $ATTRIBUTE_LIST（信息不完整）时返回 null。
 */
export function parseRecord(buf: Buffer): MftRecord | null {
  const flags = u16(buf, 0x16);
  if (!(flags & RECORD_IN_USE)) return null;
  if (u64(buf, 0x20) !== 0n) return null; // 扩展记录（base_record != 0）

  const attrsOff = u16(buf, 0x14);
  const used = u32(buf, 0x18);
  const end = Math.min(used, buf.length);
  if (attrsOff < 0x30 || attrsOff >= end) return null;

  // (ns, parent, name, mtime, atime)
  interface NameEntry {
    ns: number;
    parent: number;
    name: string;
    mtime: number;
    atime: number;
  }
  const names: NameEntry[] = [];
  let size = 0;
  let isReparse = false;

  let off = attrsOff;
  while (off + 16 <= end) {
    const aType = u32(buf, off);
    if (aType === 0xffffffff) break;
    const aLen = u32(buf, off + 4);
    if (aLen === 0 || off + aLen > end) break;
    if (aType === ATTR_ATTRIBUTE_LIST) return null; // 属性外置，本记录信息不完整
    if (aType === ATTR_REPARSE_POINT) {
      isReparse = true;
    } else if (aType === ATTR_FILE_NAME && buf[off + 8] === 0) {
      // resident
      const vLen = u32(buf, off + 0x10);
      const vOff = u16(buf, off + 0x14);
      const v = off + vOff;
      if (vLen >= 0x42 && v + vLen <= off + aLen) {
        const parent = Number(u64(buf, v) & 0xffffffffffffn); // 低 48 位 = 记录号
        const mtime = filetimeToUnix(u64(buf, v + 0x10));
        const atime = filetimeToUnix(u64(buf, v + 0x20));
        size = Number(u64(buf, v + 0x30));
        const nameLen = buf[v + 0x40]!;
        const ns = buf[v + 0x41]!;
        const raw = buf.subarray(v + 0x42, v + 0x42 + nameLen * 2);
        let name = "";
        try {
          name = raw.toString("utf16le");
        } catch {
          name = "";
        }
        if (name && parent > 0) {
          names.push({ ns, parent, name, mtime, atime });
        }
      }
    }
    off += aLen;
  }

  if (names.length === 0) return null;
  // 优先 Win32/POSIX 长名，其次 DOS 8.3 短名
  const chosen = names.find((n) => n.ns !== NS_DOS) ?? names[0]!;

  let recFlags = 0;
  if (flags & RECORD_IS_DIRECTORY) recFlags |= 1;
  if (isReparse) recFlags |= 2;
  return {
    parent: chosen.parent,
    name: chosen.name,
    size,
    mtime: chosen.mtime,
    atime: chosen.atime,
    flags: recFlags,
  };
}

/**
 * 解析一段 $MFT 缓冲，写入 records 字典（键为起始记录号偏移）。
 */
export function parseMftBuffer(
  chunk: Buffer,
  recordSize: number,
  records: Map<number, MftRecord>,
  startRec: number
): [number, number] {
  let ok = 0;
  let totalSize = 0;
  for (let i = 0; i + recordSize <= chunk.length; i += recordSize) {
    const raw = chunk.subarray(i, i + recordSize);
    const fixed = applyFixups(raw);
    if (fixed === null) continue;
    const rec = parseRecord(fixed);
    if (rec !== null) {
      records.set(startRec + i / recordSize, rec);
      ok++;
      totalSize += rec.size;
    }
  }
  return [ok, totalSize];
}

/**
 * 由记录表构建目录树，返回 [root, 孤儿记录数]。
 * 从根目录（记录 5）出发沿 parent 链 DFS；父链断裂的文件计为孤儿。
 */
export function buildTree(
  records: Map<number, MftRecord>,
  rootName: string,
  ignoreGlobs: Iterable<string>
): [TreeNode, number] {
  const globs = [...ignoreGlobs].map((g) => g.toLowerCase());
  const ignored = (name: string) => globs.some((g) => fnmatch(name.toLowerCase(), g));

  const children = new Map<number, [number, MftRecord][]>();
  for (const [num, rec] of records) {
    if (num === ROOT_FILE_NUM || rec.parent === num) continue;
    const list = children.get(rec.parent);
    if (list) list.push([num, rec]);
    else children.set(rec.parent, [[num, rec]]);
  }

  const root = createNode(rootName, { isDir: true, children: new Map() });
  const visited = new Set<number>([ROOT_FILE_NUM]);

  const stack: [TreeNode, number][] = [[root, ROOT_FILE_NUM]];
  while (stack.length > 0) {
    const [parentNode, recNum] = stack.pop()!;
    for (const [cnum, crec] of children.get(recNum) ?? []) {
      if (visited.has(cnum)) continue;
      visited.add(cnum);
      if (crec.name === "." || crec.name === ".." || ignored(crec.name)) continue;
      const isDir = (crec.flags & 1) !== 0;
      const isLink = (crec.flags & 2) !== 0;
      const node = createNode(crec.name, {
        size: isDir && !isLink ? 0 : crec.size,
        mtime: crec.mtime,
        atime: crec.atime,
        isDir,
        isLink,
      });
      if (isDir && !isLink) node.children = new Map();
      parentNode.children!.set(node.name, node);
      if (isDir && !isLink) stack.push([node, cnum]);
    }
  }

  // 孤儿 = 无法从根目录沿父链到达的记录（含父记录缺失/损坏者）
  return [root, records.size - visited.size];
}

// ---------------------------------------------------------------------------
// Windows 卷读取（不可单测，失败即降级）
// ---------------------------------------------------------------------------
const GENERIC_READ = 0x80000000;
const SHARE_ALL = 0x01 | 0x02 | 0x04;
const OPEN_EXISTING = 3;
const FSCTL_GET_NTFS_VOLUME_DATA = 0x00090064;

const kernel32 = koffi.load("kernel32.dll");
const advapi32 = koffi.load("advapi32.dll");

const CreateFileW = kernel32.func("__stdcall", "CreateFileW", "int64", [
  "str16", "uint32", "uint32", "void *", "uint32", "uint32", "void *",
]);
const CloseHandle = kernel32.func("__stdcall", "CloseHandle", "int32", ["int64"]);
const DeviceIoControl = kernel32.func("__stdcall", "DeviceIoControl", "int32", [
  "int64", "uint32", "void *", "uint32",
  koffi.out(koffi.pointer("uint8")), "uint32",
  koffi.out(koffi.pointer("uint32")), "void *",
]);
const SetFilePointerEx = kernel32.func("__stdcall", "SetFilePointerEx", "int32", [
  "int64", "int64", "void *", "uint32",
]);
const ReadFile = kernel32.func("__stdcall", "ReadFile", "int32", [
  "int64", koffi.out(koffi.pointer("uint8")), "uint32",
  koffi.out(koffi.pointer("uint32")), "void *",
]);
const IsUserAnAdmin = koffi.load("shell32.dll").func(
  "__stdcall", "IsUserAnAdmin", "int32", []
);

// SeBackupPrivilege 提权（advapi32）
const GetCurrentProcess = kernel32.func("__stdcall", "GetCurrentProcess", "int64", []);
const OpenProcessToken = advapi32.func("__stdcall", "OpenProcessToken", "int32", [
  "int64", "uint32", koffi.out(koffi.pointer("int64")),
]);
const LookupPrivilegeValueW = advapi32.func("__stdcall", "LookupPrivilegeValueW", "int32", [
  "void *", "str16", koffi.out(koffi.pointer("uint32")), koffi.out(koffi.pointer("int32")),
]);
const AdjustTokenPrivileges = advapi32.func("__stdcall", "AdjustTokenPrivileges", "int32", [
  "int64", "int32",
  koffi.pointer("uint32"), "uint32", "void *", "void *",
]);

const TOKEN_ADJUST_PRIVILEGES = 0x0020;
const TOKEN_QUERY = 0x0008;
const SE_PRIVILEGE_ENABLED = 0x0002;

function isAdmin(): boolean {
  try {
    return IsUserAnAdmin() !== 0;
  } catch {
    return false;
  }
}

/** 尽力启用 SeBackupPrivilege（第一层提权）。 */
function enableBackupPrivilege(): boolean {
  try {
    const tokenOut = [0n];
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, tokenOut)) {
      return false;
    }
    const token = tokenOut[0]!;
    try {
      // LUID = { uint32 LowPart; int32 HighPart; }；TP = { uint32 Count; LUID; uint32 Attr; }
      const luidLowOut = [0];
      const luidHighOut = [0];
      if (!LookupPrivilegeValueW(null, "SeBackupPrivilege", luidLowOut, luidHighOut)) {
        return false;
      }
      const tp = Buffer.alloc(16);
      tp.writeUInt32LE(1, 0); // PrivilegeCount
      tp.writeUInt32LE(luidLowOut[0]!, 4);
      tp.writeInt32LE(luidHighOut[0]!, 8);
      tp.writeUInt32LE(SE_PRIVILEGE_ENABLED, 12);
      AdjustTokenPrivileges(token, 0, tp, 0, null, null);
      return true; // 尽力而为：ERROR_NOT_ALL_ASSIGNED 也继续尝试
    } finally {
      CloseHandle(token);
    }
  } catch {
    return false;
  }
}

function openVolume(driveLetter: string): number {
  const handle = Number(
    CreateFileW(`\\\\.\\${driveLetter}:`, GENERIC_READ, SHARE_ALL, null, OPEN_EXISTING, 0, null)
  );
  if (handle === -1 || handle === 0) {
    throw new MftUnavailableError(
      `打开卷句柄失败（通常需要管理员权限），GLE=${koffi.errno()}`
    );
  }
  return handle;
}

function getVolumeData(handle: number): VolumeData {
  const out = Buffer.alloc(512);
  const returnedOut = [0];
  const ok = DeviceIoControl(
    handle, FSCTL_GET_NTFS_VOLUME_DATA, null, 0, out, out.length, returnedOut, null
  );
  if (!ok) {
    throw new MftUnavailableError(`FSCTL_GET_NTFS_VOLUME_DATA 失败，GLE=${koffi.errno()}`);
  }
  return parseVolumeData(out.subarray(0, returnedOut[0]!));
}

function readAt(handle: number, offset: number, size: number): Buffer {
  if (!SetFilePointerEx(handle, BigInt(offset), null, 0)) {
    throw new MftUnavailableError("SetFilePointerEx 失败");
  }
  const buf = Buffer.alloc(size);
  let got = 0;
  while (got < size) {
    const nreadOut = [0];
    const ok = ReadFile(handle, buf.subarray(got), size - got, nreadOut, null);
    if (!ok || nreadOut[0] === 0) break;
    got += nreadOut[0]!;
  }
  return buf.subarray(0, got);
}

export type ProgressCallback = (
  progress: number,
  filesSeen: number,
  bytesSeen: number
) => void;

/**
 * MFT 直读全卷扫描。
 *
 * @param driveLetter 盘符（不带冒号，如 "C"）
 * @throws MftUnavailableError 无管理员权限 / 非 NTFS / 读取失败
 */
export function scanViaMft(
  driveLetter: string,
  options: {
    progressCb?: ProgressCallback | undefined;
    cancelRequested?: (() => boolean) | undefined;
    ignoreGlobs?: Iterable<string> | undefined;
  } = {}
): ScanResult {
  const t0 = performance.now();
  if (!isAdmin()) throw new MftUnavailableError("当前进程非管理员，无法直读 MFT");
  enableBackupPrivilege();

  const handle = openVolume(driveLetter);
  const records = new Map<number, MftRecord>();
  try {
    const vol = getVolumeData(handle);
    const recordSize = vol.bytesPerFrs;
    const totalLen = Math.max(vol.mftValidDataLength, recordSize);
    const mftOffset = vol.mftStartLcn * vol.bytesPerCluster;

    const chunkRecords = Math.max(1, Math.floor((1 << 20) / recordSize));
    const chunkSize = chunkRecords * recordSize;
    let filesSeen = 0;
    let bytesSeen = 0;
    let read = 0;
    while (read < totalLen) {
      if (options.cancelRequested?.()) {
        throw new MftUnavailableError("扫描被取消");
      }
      const toRead = Math.min(chunkSize, totalLen - read);
      const data = readAt(handle, mftOffset + read, toRead);
      if (data.length === 0) break;
      const [n, sz] = parseMftBuffer(data, recordSize, records, Math.floor(read / recordSize));
      filesSeen += n;
      bytesSeen += sz;
      options.progressCb?.(
        Math.min(0.99, (read + data.length) / totalLen), filesSeen, bytesSeen
      );
      read += data.length;
    }
  } finally {
    CloseHandle(handle);
  }

  options.progressCb?.(0.99, filesSeenTotal(records), bytesSeenTotal(records));

  const [root, orphans] = buildTree(
    records,
    `${driveLetter.toUpperCase()}:`,
    options.ignoreGlobs ?? []
  );
  const [files, dirs, total] = finalizeTree(root);
  const result: ScanResult = {
    root,
    mode: "mft",
    files,
    dirs,
    totalBytes: total,
    skippedPaths: [],
    orphans,
    elapsedSec: (performance.now() - t0) / 1000,
  };
  options.progressCb?.(1.0, files, total);
  return result;
}

function filesSeenTotal(records: Map<number, MftRecord>): number {
  let n = 0;
  for (const r of records.values()) if (!(r.flags & 1)) n++;
  return n;
}
function bytesSeenTotal(records: Map<number, MftRecord>): number {
  let s = 0;
  for (const r of records.values()) s += r.size;
  return s;
}

/** 从盘符路径提取盘符字母（如 "D:\\x" → "D"；非盘符路径返回 null） */
export function extractDriveLetter(p: string): string | null {
  const m = /^[a-zA-Z]:/.exec(path.resolve(p));
  return m ? m[0][0]!.toUpperCase() : null;
}
