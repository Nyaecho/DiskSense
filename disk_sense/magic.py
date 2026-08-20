"""文件头魔数识别（方案书铁律 1 的唯一豁免点）。

本模块是全仓库**唯一**允许打开文件读取字节的地方，且只读文件头
16 字节（及 ISO/TAR 等格式的固定小偏移），用于格式判定：
- 绝不解析内容；
- 绝不记录读取到的字节；
- 读取前先判断实际占用大小，避免稀疏文件副作用（方案书 §6.5）。
"""

from __future__ import annotations

import ctypes
import os
import sys

# (偏移, 十六进制前缀, 类型标签, MIME)
# 同一偏移按前缀长度降序匹配
_SIGNATURES: list[tuple[int, str, str, str]] = [
    (0x00, "89504E470D0A1A0A", "PNG 图片", "image/png"),
    (0x00, "FFD8FF", "JPEG 图片", "image/jpeg"),
    (0x00, "474946383761", "GIF 图片", "image/gif"),
    (0x00, "474946383961", "GIF 图片", "image/gif"),
    (0x00, "424D", "BMP 图片", "image/bmp"),
    (0x00, "255044462D", "PDF 文档", "application/pdf"),
    (0x00, "504B0304", "ZIP 容器(zip/docx/xlsx/apk)", "application/zip"),
    (0x00, "504B0506", "ZIP 空存档", "application/zip"),
    (0x00, "504B0708", "ZIP 分卷", "application/zip"),
    (0x00, "526172211A07010000", "RAR5 压缩包", "application/vnd.rar"),
    (0x00, "526172211A0700", "RAR4 压缩包", "application/vnd.rar"),
    (0x00, "377ABCAF271C", "7z 压缩包", "application/x-7z-compressed"),
    (0x00, "1F8B", "GZIP 压缩", "application/gzip"),
    (0x00, "425A68", "BZIP2 压缩", "application/x-bzip2"),
    (0x00, "FD377A585A00", "XZ 压缩", "application/x-xz"),
    (0x00, "28B52FFD", "ZSTD 压缩", "application/zstd"),
    (0x00, "D0CF11E0A1B11AE1", "OLE 容器(doc/xls/msi)", "application/x-ole-storage"),
    (0x00, "4D534346", "CAB 安装包", "application/vnd.ms-cab-compressed"),
    (0x00, "4D5357494D", "WIM 系统镜像", "application/x-ms-wim"),
    (0x00, "7668647866696C65", "VHDX 虚拟硬盘", "application/x-vhdx"),
    (0x00, "636F6E6563746978", "VHD 虚拟硬盘", "application/x-vhd"),
    (0x00, "1A45DFA3", "MKV/WebM 视频", "video/x-matroska"),
    (0x00, "664C6143", "FLAC 音频", "audio/flac"),
    (0x00, "4D5A", "PE 可执行(exe/dll)", "application/x-msdownload"),
    (0x00, "7F454C46", "ELF 可执行", "application/x-elf"),
    (0x00, "53514C697465", "SQLite 数据库", "application/x-sqlite3"),
    (0x00, "FFFB", "MP3 音频", "audio/mpeg"),
    (0x00, "FFF3", "MP3 音频", "audio/mpeg"),
    (0x00, "494433", "MP3 音频(ID3)", "audio/mpeg"),
    (0x00, "4F676753", "OGG 音频", "audio/ogg"),
    # 偏移不为 0 的签名
    (0x04, "66747970", "MP4/MOV 视频", "video/mp4"),
    (0x8001, "4344303031", "ISO 9660 光盘镜像", "application/x-iso9660-image"),
    (0x8000, "4245413031", "UDF/ISO 镜像", "application/x-iso9660-image"),
    (0x8000, "4E53523032", "UDF 镜像", "application/x-iso9660-image"),
    (0x8000, "4E53523033", "UDF 镜像", "application/x-iso9660-image"),
    (0x101, "7573746172", "TAR 归档", "application/x-tar"),
]

# RIFF 子格式（RIFF 头在 0，格式标识在 8）
_RIFF_FORMS = {
    "57454250": ("WebP 图片", "image/webp"),
    "41564920": ("AVI 视频", "video/x-msvideo"),
    "57415645": ("WAV 音频", "audio/wav"),
}

# 需要二次寻位判定的扩展名 → 签名表条目 (偏移, 前缀, 标签, MIME)
_EXT_PROBES: dict[str, list[tuple[int, str, str, str]]] = {
    ".iso": [
        (0x8001, "4344303031", "ISO 9660 光盘镜像", "application/x-iso9660-image"),
        (0x8000, "4245413031", "UDF/ISO 镜像", "application/x-iso9660-image"),
        (0x8000, "4E53523032", "UDF 镜像", "application/x-iso9660-image"),
        (0x8000, "4E53523033", "UDF 镜像", "application/x-iso9660-image"),
    ],
    ".img": [
        (0x8001, "4344303031", "ISO 9660 光盘镜像", "application/x-iso9660-image"),
        (0x8000, "4245413031", "UDF/ISO 镜像", "application/x-iso9660-image"),
    ],
    ".tar": [(0x101, "7573746172", "TAR 归档", "application/x-tar")],
}

_SIG_BY_OFFSET: dict[int, list[tuple[str, str, str]]] = {}
for _off, _hex, _label, _mime in _SIGNATURES:
    _SIG_BY_OFFSET.setdefault(_off, []).append((_hex, _label, _mime))
for _off in _SIG_BY_OFFSET:
    _SIG_BY_OFFSET[_off].sort(key=lambda t: len(t[0]), reverse=True)

_HEADER_LEN = 16


def _allocated_size(path: str, logical_size: int) -> int | None:
    """返回磁盘实际占用大小（用于稀疏检测）；不可得时返回 None。"""
    if sys.platform == "win32":
        try:
            high = ctypes.c_ulong(0)
            low = ctypes.windll.kernel32.GetCompressedFileSizeW(path, ctypes.byref(high))
            if low != 0xFFFFFFFF:
                return (high.value << 32) | low
        except Exception:
            return None
        return None
    st = os.stat(path)
    return getattr(st, "st_blocks", None) and st.st_blocks * 512


def _read_at(path: str, offset: int, size: int) -> bytes:
    """读取文件指定偏移处的少量字节（仅限文件头魔数判定用途）。"""
    with open(path, "rb") as f:
        f.seek(offset)
        return f.read(size)


def _match(offset: int, data: bytes) -> tuple[str, str] | None:
    for hex_prefix, label, mime in _SIG_BY_OFFSET.get(offset, ()):
        expected = bytes.fromhex(hex_prefix)
        if data[: len(expected)] == expected:
            return label, mime
    return None


def classify_magic_number(path: str) -> dict:
    """识别文件头魔数，返回真实格式。

    Returns:
        {"magic_type": str, "mime": str, "confidence": "high"|"low"}
        无法识别时 magic_type 为 "UNKNOWN"；空/稀疏文件为 "EMPTY_OR_SPARSE"
        或 "SPARSE"，confidence 为 low。绝不读取超过文件头必要字节。
    """
    try:
        st = os.stat(path)
    except OSError as e:
        return {"magic_type": "UNKNOWN", "mime": "", "confidence": "low", "error": str(e)}

    if st.st_size < _HEADER_LEN:
        return {"magic_type": "EMPTY_OR_SPARSE", "mime": "", "confidence": "low"}

    # 稀疏/压缩文件：实际占用明显小于逻辑大小 → 不触发读取（方案书 §6.5）
    allocated = _allocated_size(path, st.st_size)
    if allocated is not None and 0 < allocated < st.st_size:
        return {"magic_type": "SPARSE", "mime": "", "confidence": "low"}

    try:
        header = _read_at(path, 0, _HEADER_LEN)
    except OSError as e:
        return {"magic_type": "UNKNOWN", "mime": "", "confidence": "low", "error": str(e)}

    # RIFF 容器细分
    if header[:4] == b"RIFF" and len(header) >= 12:
        form = header[8:12].hex().upper()
        if form in _RIFF_FORMS:
            label, mime = _RIFF_FORMS[form]
            return {"magic_type": label, "mime": mime, "confidence": "high"}

    hit = _match(0, header)
    if hit:
        return {"magic_type": hit[0], "mime": hit[1], "confidence": "high"}

    hit = _match(4, header[4:])
    if hit:
        return {"magic_type": hit[0], "mime": hit[1], "confidence": "high"}

    # 扩展名引导的二次寻位（ISO 的 "CD001" 固定在 0x8001 扇区等）
    ext = os.path.splitext(path)[1].lower()
    for offset, hex_prefix, label, mime in _EXT_PROBES.get(ext, ()):
        try:
            probe = _read_at(path, offset, 8)
        except OSError:
            break
        expected = bytes.fromhex(hex_prefix)
        if probe[: len(expected)] == expected:
            return {"magic_type": label, "mime": mime, "confidence": "high"}

    return {"magic_type": "UNKNOWN", "mime": "", "confidence": "low"}
