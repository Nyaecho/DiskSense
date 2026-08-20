"""NTFS MFT 直读扫描器（快速路径，方案书 §6.1 主路径）。

通过 ``ctypes`` 打开 ``\\\\.\\X:`` 卷句柄，FSCTL_GET_NTFS_VOLUME_DATA 定位
$MFT 后顺序解析 FILE 记录（应用 Fixup、解析 $FILE_NAME 属性），一次性获得
全卷文件元数据，速度接近 Everything。

权限模型（方案书 §6.3 第一层）：尝试启用 SeBackupPrivilege；失败或无管理员
权限时抛出 :class:`MFTUnavailableError`，由 scanner 静默降级到 os.walk。
本模块**只读取元数据**，绝不修改 ACL（禁用 takeown/icacls 铁律）。

解析器（parse_record / parse_volume_data / build_tree）为纯函数，
可用合成字节进行单元测试，无需真实卷与管理员权限。
"""

from __future__ import annotations

import ctypes
import logging
import struct
import sys
import threading
import time
from collections import namedtuple
from fnmatch import fnmatch
from typing import Callable, Iterable, Optional

from .models import Node, ScanResult

logger = logging.getLogger(__name__)

# NTFS 元数据记录号
ROOT_FILE_NUM = 5

# 属性类型
ATTR_STANDARD_INFORMATION = 0x10
ATTR_ATTRIBUTE_LIST = 0x20
ATTR_FILE_NAME = 0x30
ATTR_REPARSE_POINT = 0xC0

# 记录 flags
RECORD_IN_USE = 0x0001
RECORD_IS_DIRECTORY = 0x0002

# $FILE_NAME namespace
NS_POSIX = 0
NS_WIN32 = 1
NS_DOS = 2


class MFTUnavailableError(Exception):
    """MFT 快速路径不可用（无权限/非 NTFS/读取失败），应降级 os.walk。"""


# ---------------------------------------------------------------------------
# 纯解析函数（可单测）
# ---------------------------------------------------------------------------
Record = namedtuple("Record", "parent name size mtime atime flags")
# flags: bit0 = 目录, bit1 = 重解析点(Junction/符号链接)

_EPOCH_DIFF = 116444736000000000  # FILETIME(100ns) 与 Unix epoch 之差


def _u16(buf, off: int) -> int:
    return struct.unpack_from("<H", buf, off)[0]


def _u32(buf, off: int) -> int:
    return struct.unpack_from("<I", buf, off)[0]


def _u64(buf, off: int) -> int:
    return struct.unpack_from("<Q", buf, off)[0]


def filetime_to_unix(ft: int) -> float:
    """FILETIME(自 1601 起 100ns) → Unix 时间戳；0 视为未知返回 0。"""
    if ft == 0:
        return 0.0
    return (ft - _EPOCH_DIFF) / 1e7


def parse_volume_data(buf: bytes) -> dict:
    """解析 NTFS_VOLUME_DATA_BUFFER（FSCTL_GET_NTFS_VOLUME_DATA 输出）。"""
    if len(buf) < 88:
        raise MFTUnavailableError("卷数据缓冲区不完整")
    (
        _serial,
        _sectors,
        _total_clusters,
        _free_clusters,
        _reserved,
        bytes_per_cluster,
        _bytes_per_sector,
        bytes_per_frs,
        _clusters_per_frs,
        mft_valid_data_length,
        mft_start_lcn,
    ) = struct.unpack_from("<11q", buf, 0)
    if bytes_per_cluster <= 0 or bytes_per_frs <= 0:
        raise MFTUnavailableError("非 NTFS 卷或卷数据异常")
    return {
        "bytes_per_cluster": bytes_per_cluster,
        "bytes_per_frs": bytes_per_frs,
        "mft_valid_data_length": mft_valid_data_length,
        "mft_start_lcn": mft_start_lcn,
    }


def _apply_fixups(buf: bytes) -> Optional[bytes]:
    """应用 Update Sequence Array 修复，校验失败返回 None。"""
    if len(buf) < 0x30 or buf[0:4] != b"FILE":
        return None
    usa_off = _u16(buf, 0x04)
    usa_cnt = _u16(buf, 0x06)
    if usa_cnt < 2:
        return None
    n_sectors = usa_cnt - 1
    if len(buf) % n_sectors != 0:
        return None
    sector_size = len(buf) // n_sectors
    if usa_off + usa_cnt * 2 > len(buf):
        return None
    usa = struct.unpack_from(f"<{usa_cnt}H", buf, usa_off)
    arr = bytearray(buf)
    for i in range(1, n_sectors + 1):
        tail = sector_size * i - 2
        if _u16(arr, tail) != usa[0]:
            return None  # 校验和不过 → 记录损坏
        struct.pack_into("<H", arr, tail, usa[i])
    return bytes(arr)


def parse_record(buf: bytes) -> Optional[Record]:
    """解析单个 MFT FILE 记录（须先应用 Fixup）。

    Returns:
        Record；记录未使用 / 损坏 / 含 $ATTRIBUTE_LIST（信息不完整）时返回 None。
    """

    def u16(off):
        return _u16(buf, off)

    def u32(off):
        return _u32(buf, off)

    def u64(off):
        return _u64(buf, off)

    flags = u16(0x16)
    if not (flags & RECORD_IN_USE):
        return None
    if u64(0x20) != 0:
        return None  # 扩展记录（base_record != 0），主记录已包含名称

    attrs_off = u16(0x14)
    used = u32(0x18)
    end = min(used, len(buf))
    if attrs_off < 0x30 or attrs_off >= end:
        return None

    names: list[tuple[int, int, str, float, float]] = []  # (ns, parent, name, mtime, atime)
    size = 0
    is_reparse = False

    off = attrs_off
    while off + 16 <= end:
        a_type = u32(off)
        if a_type == 0xFFFFFFFF:
            break
        a_len = u32(off + 4)
        if a_len == 0 or off + a_len > end:
            break
        if a_type == ATTR_ATTRIBUTE_LIST:
            return None  # 属性外置，本记录信息不完整
        if a_type == ATTR_REPARSE_POINT:
            is_reparse = True
        elif a_type == ATTR_FILE_NAME and buf[off + 8] == 0:  # resident
            v_len, v_off = u32(off + 0x10), u16(off + 0x14)
            v = off + v_off
            if v_len >= 0x42 and v + v_len <= off + a_len:
                parent = u64(v) & 0xFFFFFFFFFFFF  # 低 48 位 = 记录号
                mtime = filetime_to_unix(u64(v + 0x10))
                atime = filetime_to_unix(u64(v + 0x20))
                real_size = u64(v + 0x30)
                name_len = buf[v + 0x40]
                ns = buf[v + 0x41]
                raw = buf[v + 0x42 : v + 0x42 + name_len * 2]
                try:
                    name = raw.decode("utf-16-le")
                except UnicodeDecodeError:
                    name = ""
                if name and parent > 0:
                    names.append((ns, parent, name, mtime, atime))
                    size = real_size
        off += a_len

    if not names:
        return None
    # 优先 Win32/POSIX 长名，其次 DOS 8.3 短名
    chosen = next((n for n in names if n[0] != NS_DOS), names[0])
    _, parent, name, mtime, atime = chosen

    rec_flags = 0
    if flags & RECORD_IS_DIRECTORY:
        rec_flags |= 1
    if is_reparse:
        rec_flags |= 2
    return Record(parent, name, size, mtime, atime, rec_flags)


def parse_mft_buffer(
    chunk: bytes,
    record_size: int,
    records: dict[int, Record],
    start_rec: int,
) -> tuple[int, int]:
    """解析一段 $MFT 缓冲，写入 records 字典。

    Returns:
        (成功解析的记录数, 这些记录的 size 之和)——增量返回，避免重复求和。
    """
    ok = total_size = 0
    for i in range(0, len(chunk) - record_size + 1, record_size):
        raw = chunk[i : i + record_size]
        fixed = _apply_fixups(raw)
        if fixed is None:
            continue
        rec = parse_record(fixed)
        if rec is not None:
            records[start_rec + i // record_size] = rec
            ok += 1
            total_size += rec.size
    return ok, total_size


def build_tree(
    records: dict[int, Record],
    root_name: str,
    ignore_globs: Iterable[str],
) -> tuple[Node, int]:
    """由记录表构建目录树，返回 (root, 孤儿记录数)。

    从根目录（记录 5）出发沿 parent 链 DFS；父链断裂（如 $ATTRIBUTE_LIST
    记录被跳过）的文件计为孤儿，不影响主树。
    """

    def ignored(name: str) -> bool:
        low = name.lower()
        return any(fnmatch(low, g.lower()) for g in ignore_globs)

    children: dict[int, list[tuple[int, Record]]] = {}
    for num, rec in records.items():
        if num == ROOT_FILE_NUM or rec.parent == num:
            continue
        children.setdefault(rec.parent, []).append((num, rec))

    root = Node(name=root_name, is_dir=True, children={})
    visited = {ROOT_FILE_NUM}

    stack: list[tuple[Node, int]] = [(root, ROOT_FILE_NUM)]
    while stack:
        parent_node, rec_num = stack.pop()
        for cnum, crec in children.get(rec_num, []):
            if cnum in visited:
                continue
            visited.add(cnum)
            if crec.name in (".", "..") or ignored(crec.name):
                continue
            is_dir = bool(crec.flags & 1)
            is_link = bool(crec.flags & 2)
            node = Node(
                name=crec.name,
                size=0 if (is_dir and not is_link) else crec.size,
                mtime=crec.mtime,
                atime=crec.atime,
                is_dir=is_dir,
                is_link=is_link,
                children={} if (is_dir and not is_link) else None,
            )
            parent_node.add_child(node)
            if is_dir and not is_link:
                stack.append((node, cnum))

    # 孤儿 = 无法从根目录沿父链到达的记录（含父记录缺失/损坏者）
    return root, len(records) - len(visited)


# ---------------------------------------------------------------------------
# Windows 卷读取（不可单测，失败即降级）
# ---------------------------------------------------------------------------
_GENERIC_READ = 0x80000000
_SHARE_ALL = 0x1 | 0x2 | 0x4
_OPEN_EXISTING = 3
_INVALID = ctypes.c_void_p(-1).value
_FSCTL_GET_NTFS_VOLUME_DATA = 0x00090064


def _is_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def _enable_backup_privilege() -> bool:
    """尽力启用 SeBackupPrivilege（方案书 §6.3 第一层提权）。"""
    try:
        import pywintypes  # noqa: F401
        import win32api
        import win32security

        privilege = win32security.LookupPrivilegeValue(None, "SeBackupPrivilege")
        token = win32security.OpenProcessToken(
            win32api.GetCurrentProcess(),
            win32security.TOKEN_ADJUST_PRIVILEGES | win32security.TOKEN_QUERY,
        )
        win32security.AdjustTokenPrivileges(
            token, False, [(privilege, win32security.SE_PRIVILEGE_ENABLED)]
        )
        return True
    except Exception:
        return False


def _open_volume(drive_letter: str) -> int:
    if sys.platform != "win32":
        raise MFTUnavailableError("非 Windows 平台")
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.CreateFileW(
        f"\\\\.\\{drive_letter}:",
        _GENERIC_READ,
        _SHARE_ALL,
        None,
        _OPEN_EXISTING,
        0,
        None,
    )
    if handle == _INVALID or handle == 0:
        raise MFTUnavailableError(f"打开卷句柄失败（通常需要管理员权限），GLE={ctypes.GetLastError()}")
    return handle


def _get_volume_data(handle: int) -> dict:
    kernel32 = ctypes.windll.kernel32
    out = ctypes.create_string_buffer(512)
    returned = ctypes.c_ulong(0)
    ok = kernel32.DeviceIoControl(
        handle,
        _FSCTL_GET_NTFS_VOLUME_DATA,
        None,
        0,
        out,
        len(out),
        ctypes.byref(returned),
        None,
    )
    if not ok:
        raise MFTUnavailableError(f"FSCTL_GET_NTFS_VOLUME_DATA 失败，GLE={ctypes.GetLastError()}")
    return parse_volume_data(out.raw[: returned.value])


def _read_at(handle: int, offset: int, size: int) -> bytes:
    kernel32 = ctypes.windll.kernel32
    pointer = ctypes.c_longlong(offset)
    if not kernel32.SetFilePointerEx(handle, pointer, None, 0):
        raise MFTUnavailableError("SetFilePointerEx 失败")
    buf = ctypes.create_string_buffer(size)
    nread = ctypes.c_ulong(0)
    got = 0
    while got < size:
        ok = kernel32.ReadFile(
            handle, buf, size - got, ctypes.byref(nread), None
        )
        if not ok or nread.value == 0:
            break
        got += nread.value
    return buf.raw[:got]


def scan_via_mft(
    drive_letter: str,
    progress_cb: Optional[Callable[[float, int, int], None]] = None,
    cancel_event: Optional[threading.Event] = None,
    ignore_globs: Iterable[str] = (),
) -> ScanResult:
    """MFT 直读全卷扫描。

    Args:
        drive_letter: 盘符（不带冒号，如 "C"）。
        progress_cb: 进度回调 (progress, files_seen, bytes_seen)。
        cancel_event: 取消事件。
        ignore_globs: 目录名忽略模式。

    Raises:
        MFTUnavailableError: 无管理员权限 / 非 NTFS / 读取失败。
    """
    from .models import finalize_tree  # 延迟导入避免环

    t0 = time.perf_counter()
    if not _is_admin():
        raise MFTUnavailableError("当前进程非管理员，无法直读 MFT")
    _enable_backup_privilege()

    handle = _open_volume(drive_letter)
    try:
        vol = _get_volume_data(handle)
        record_size = vol["bytes_per_frs"]
        total_len = max(vol["mft_valid_data_length"], record_size)
        mft_offset = vol["mft_start_lcn"] * vol["bytes_per_cluster"]

        chunk_records = max(1, (1 << 20) // record_size)
        chunk_size = chunk_records * record_size
        records: dict[int, Record] = {}
        files_seen = bytes_seen = 0
        read = 0
        while read < total_len:
            if cancel_event is not None and cancel_event.is_set():
                raise MFTUnavailableError("扫描被取消")
            to_read = min(chunk_size, total_len - read)
            data = _read_at(handle, mft_offset + read, to_read)
            if not data:
                break
            n, sz = parse_mft_buffer(data, record_size, records, read // record_size)
            files_seen += n
            bytes_seen += sz
            if progress_cb:
                progress_cb(
                    min(0.99, (read + len(data)) / total_len), files_seen, bytes_seen
                )
            read += len(data)
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)

    if progress_cb:
        progress_cb(0.99, files_seen, bytes_seen)

    root, orphans = build_tree(records, f"{drive_letter.upper()}:", ignore_globs)
    files, dirs, total = finalize_tree(root)
    result = ScanResult(
        root=root,
        mode="mft",
        files=files,
        dirs=dirs,
        total_bytes=total,
        orphans=orphans,
        elapsed_sec=time.perf_counter() - t0,
    )
    if progress_cb:
        progress_cb(1.0, files, total)
    return result
