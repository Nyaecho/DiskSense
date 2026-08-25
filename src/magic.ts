/**
 * 文件头魔数识别（铁律 1 的唯一豁免点）。
 *
 * 本模块是全仓库**唯一**允许打开文件读取字节的地方，且只读文件头
 * 16 字节（及 ISO/TAR 等格式的固定小偏移），用于格式判定：
 * - 绝不解析内容；
 * - 绝不记录读取到的字节；
 * - 读取前先判断实际占用大小，避免稀疏文件副作用。
 */

import fs from "node:fs";
import path from "node:path";
import koffi from "koffi";

interface Sig {
  offset: number;
  hex: string;
  label: string;
  mime: string;
}

// (偏移, 十六进制前缀, 类型标签, MIME)；同一偏移按前缀长度降序匹配
const SIGNATURES: Sig[] = [
  { offset: 0x00, hex: "89504E470D0A1A0A", label: "PNG 图片", mime: "image/png" },
  { offset: 0x00, hex: "FFD8FF", label: "JPEG 图片", mime: "image/jpeg" },
  { offset: 0x00, hex: "474946383761", label: "GIF 图片", mime: "image/gif" },
  { offset: 0x00, hex: "474946383961", label: "GIF 图片", mime: "image/gif" },
  { offset: 0x00, hex: "424D", label: "BMP 图片", mime: "image/bmp" },
  { offset: 0x00, hex: "255044462D", label: "PDF 文档", mime: "application/pdf" },
  { offset: 0x00, hex: "504B0304", label: "ZIP 容器(zip/docx/xlsx/apk)", mime: "application/zip" },
  { offset: 0x00, hex: "504B0506", label: "ZIP 空存档", mime: "application/zip" },
  { offset: 0x00, hex: "504B0708", label: "ZIP 分卷", mime: "application/zip" },
  { offset: 0x00, hex: "526172211A07010000", label: "RAR5 压缩包", mime: "application/vnd.rar" },
  { offset: 0x00, hex: "526172211A0700", label: "RAR4 压缩包", mime: "application/vnd.rar" },
  { offset: 0x00, hex: "377ABCAF271C", label: "7z 压缩包", mime: "application/x-7z-compressed" },
  { offset: 0x00, hex: "1F8B", label: "GZIP 压缩", mime: "application/gzip" },
  { offset: 0x00, hex: "425A68", label: "BZIP2 压缩", mime: "application/x-bzip2" },
  { offset: 0x00, hex: "FD377A585A00", label: "XZ 压缩", mime: "application/x-xz" },
  { offset: 0x00, hex: "28B52FFD", label: "ZSTD 压缩", mime: "application/zstd" },
  { offset: 0x00, hex: "D0CF11E0A1B11AE1", label: "OLE 容器(doc/xls/msi)", mime: "application/x-ole-storage" },
  { offset: 0x00, hex: "4D534346", label: "CAB 安装包", mime: "application/vnd.ms-cab-compressed" },
  { offset: 0x00, hex: "4D5357494D", label: "WIM 系统镜像", mime: "application/x-ms-wim" },
  { offset: 0x00, hex: "7668647866696C65", label: "VHDX 虚拟硬盘", mime: "application/x-vhdx" },
  { offset: 0x00, hex: "636F6E6563746978", label: "VHD 虚拟硬盘", mime: "application/x-vhd" },
  { offset: 0x00, hex: "1A45DFA3", label: "MKV/WebM 视频", mime: "video/x-matroska" },
  { offset: 0x00, hex: "664C6143", label: "FLAC 音频", mime: "audio/flac" },
  { offset: 0x00, hex: "4D5A", label: "PE 可执行(exe/dll)", mime: "application/x-msdownload" },
  { offset: 0x00, hex: "7F454C46", label: "ELF 可执行", mime: "application/x-elf" },
  { offset: 0x00, hex: "53514C697465", label: "SQLite 数据库", mime: "application/x-sqlite3" },
  { offset: 0x00, hex: "FFFB", label: "MP3 音频", mime: "audio/mpeg" },
  { offset: 0x00, hex: "FFF3", label: "MP3 音频", mime: "audio/mpeg" },
  { offset: 0x00, hex: "494433", label: "MP3 音频(ID3)", mime: "audio/mpeg" },
  { offset: 0x00, hex: "4F676753", label: "OGG 音频", mime: "audio/ogg" },
  // 偏移不为 0 的签名
  { offset: 0x04, hex: "66747970", label: "MP4/MOV 视频", mime: "video/mp4" },
  { offset: 0x8001, hex: "4344303031", label: "ISO 9660 光盘镜像", mime: "application/x-iso9660-image" },
  { offset: 0x8000, hex: "4245413031", label: "UDF/ISO 镜像", mime: "application/x-iso9660-image" },
  { offset: 0x8000, hex: "4E53523032", label: "UDF 镜像", mime: "application/x-iso9660-image" },
  { offset: 0x8000, hex: "4E53523033", label: "UDF 镜像", mime: "application/x-iso9660-image" },
  { offset: 0x101, hex: "7573746172", label: "TAR 归档", mime: "application/x-tar" },
];

// RIFF 子格式（RIFF 头在 0，格式标识在 8）
const RIFF_FORMS: Record<string, [string, string]> = {
  "57454250": ["WebP 图片", "image/webp"],
  "41564920": ["AVI 视频", "video/x-msvideo"],
  "57415645": ["WAV 音频", "audio/wav"],
};

// 需要二次寻位判定的扩展名 → 签名表条目
const EXT_PROBES: Record<string, Sig[]> = {
  ".iso": SIGNATURES.filter((s) => s.offset >= 0x8000),
  ".img": SIGNATURES.filter((s) => s.offset === 0x8001 || s.offset === 0x8000),
  ".tar": SIGNATURES.filter((s) => s.offset === 0x101),
};

const SIG_BY_OFFSET = new Map<number, Sig[]>();
for (const sig of SIGNATURES) {
  const list = SIG_BY_OFFSET.get(sig.offset) ?? [];
  list.push(sig);
  SIG_BY_OFFSET.set(sig.offset, list);
}
for (const list of SIG_BY_OFFSET.values()) {
  list.sort((a, b) => b.hex.length - a.hex.length);
}

const HEADER_LEN = 16;

const kernel32 = koffi.load("kernel32.dll");
const GetCompressedFileSizeW = kernel32.func(
  "__stdcall", "GetCompressedFileSizeW", "uint32", ["str16", koffi.pointer("uint32")]
);

/** 返回磁盘实际占用大小（用于稀疏检测）；不可得时返回 null。 */
function allocatedSize(filePath: string): number | null {
  try {
    const highOut = [0];
    const low = GetCompressedFileSizeW(filePath, highOut) >>> 0;
    if (low !== 0xffffffff) {
      return (highOut[0]! * 2 ** 32) | low;
    }
    // low == INVALID_FILE_SIZE：区分错误与真 4GB 边界
    if ((koffi as any).errno() === 0 && highOut[0] !== undefined) {
      return highOut[0]! * 2 ** 32;
    }
    return null;
  } catch {
    return null;
  }
}

function readAt(filePath: string, offset: number, size: number): Buffer {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(size);
    const read = fs.readSync(fd, buf, 0, size, offset);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function match(offset: number, data: Buffer): [string, string] | null {
  const candidates = SIG_BY_OFFSET.get(offset);
  if (!candidates) return null;
  for (const sig of candidates) {
    const expected = Buffer.from(sig.hex, "hex");
    if (data.subarray(0, expected.length).equals(expected)) {
      return [sig.label, sig.mime];
    }
  }
  return null;
}

export interface MagicResult {
  magic_type: string;
  mime: string;
  confidence: "high" | "low";
  error?: string;
}

/** 识别文件头魔数，返回真实格式。绝不读取超过文件头必要字节。 */
export function classifyMagicNumber(filePath: string): MagicResult {
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch (e) {
    return { magic_type: "UNKNOWN", mime: "", confidence: "low", error: String(e) };
  }

  if (st.size < HEADER_LEN) {
    return { magic_type: "EMPTY_OR_SPARSE", mime: "", confidence: "low" };
  }

  // 稀疏/压缩文件：实际占用明显小于逻辑大小 → 不触发读取
  const allocated = allocatedSize(filePath);
  if (allocated !== null && allocated > 0 && allocated < st.size) {
    return { magic_type: "SPARSE", mime: "", confidence: "low" };
  }

  let header: Buffer;
  try {
    header = readAt(filePath, 0, HEADER_LEN);
  } catch (e) {
    return { magic_type: "UNKNOWN", mime: "", confidence: "low", error: String(e) };
  }

  // RIFF 容器细分
  if (header.length >= 12 && header.subarray(0, 4).toString("latin1") === "RIFF") {
    const form = header.subarray(8, 12).toString("hex").toUpperCase();
    const riffHit = RIFF_FORMS[form];
    if (riffHit) {
      return { magic_type: riffHit[0], mime: riffHit[1], confidence: "high" };
    }
  }

  const hit0 = match(0, header);
  if (hit0) return { magic_type: hit0[0], mime: hit0[1], confidence: "high" };

  const hit4 = match(4, header.subarray(4));
  if (hit4) return { magic_type: hit4[0], mime: hit4[1], confidence: "high" };

  // 扩展名引导的二次寻位（ISO 的 "CD001" 固定在 0x8001 扇区等）
  const ext = path.extname(filePath).toLowerCase();
  for (const probe of EXT_PROBES[ext] ?? []) {
    let data: Buffer;
    try {
      data = readAt(filePath, probe.offset, 8);
    } catch {
      break;
    }
    const expected = Buffer.from(probe.hex, "hex");
    if (data.subarray(0, expected.length).equals(expected)) {
      return { magic_type: probe.label, mime: probe.mime, confidence: "high" };
    }
  }

  return { magic_type: "UNKNOWN", mime: "", confidence: "low" };
}
