"""文件操作与回溯执行引擎（方案书 §12）。

铁律 3 落地点：
- 删除只走 Windows 回收站（SHFileOperationW + FOF_ALLOWUNDO，与
  IFileOperation 同一 Shell 语义），**绝不** ``os.remove``/``shutil.rmtree``；
- 删除前快照、删除后比对 ``$Recycle.Bin\\<SID>\\$I*`` 文件，解析新增
  $I 元数据（原始路径/大小/删除时间）获得**精确的 $R 映射**（方案书 §12.2），
  撤销时按 $R 物理文件名一步还原，无事后匹配误差；
- 一切操作经 UndoManager 落 SQLite 日志（先日志后执行）；
- 保护路径（用户偏好）直接拒绝。

非 Windows 平台删除/回收站功能不可用（抛错），其余操作可降级。
"""

from __future__ import annotations

import ctypes
import logging
import os
import shutil
import stat
import struct
import sys
import time
import uuid as uuidlib
import zipfile
from pathlib import Path
from typing import Any, Callable, Optional, Sequence

from .undo_manager import UndoManager

logger = logging.getLogger(__name__)


def datetime_now() -> str:
    from datetime import datetime

    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

# ---------------------------------------------------------------------------
# SHFileOperationW（ctypes）
# ---------------------------------------------------------------------------
FO_DELETE = 3
FO_MOVE = 1
FO_COPY = 2

FOF_SILENT = 0x4
FOF_NOCONFIRMATION = 0x10
FOF_ALLOWUNDO = 0x40
FOF_NOERRORUI = 0x400
_FO_FLAGS_DELETE = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI
_FO_FLAGS_MOVE = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI


class SHFILEOPSTRUCTW(ctypes.Structure):
    _fields_ = [
        ("hwnd", ctypes.c_void_p),
        ("wFunc", ctypes.c_uint),
        ("pFrom", ctypes.c_wchar_p),
        ("pTo", ctypes.c_wchar_p),
        ("fFlags", ctypes.c_ushort),
        ("fAnyOperationsAborted", ctypes.c_bool),
        ("hNameMappings", ctypes.c_void_p),
        ("lpszProgressTitle", ctypes.c_wchar_p),
    ]


class FileOperatorError(Exception):
    """文件操作失败。"""


class ProtectedPathError(FileOperatorError):
    """目标位于用户保护路径，已拒绝操作。"""


def _sh_file_operation(func: int, sources: Sequence[str], dest: Optional[str] = None) -> None:
    """执行一次 Shell 文件操作；失败抛 FileOperatorError。

    多路径要求 pFrom/pTo 为双 NUL 结尾的多字符串（"a\\0b\\0\\0"）。
    """
    if sys.platform != "win32":
        raise FileOperatorError("Shell 文件操作仅支持 Windows")
    p_from = "\0".join(sources) + "\0"
    p_to = (dest + "\0") if dest else None
    op = SHFILEOPSTRUCTW()
    op.hwnd = None
    op.wFunc = func
    op.pFrom = p_from
    op.pTo = p_to
    op.fFlags = _FO_FLAGS_DELETE if func == FO_DELETE else _FO_FLAGS_MOVE
    op.fAnyOperationsAborted = False
    res = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    if res != 0:
        raise FileOperatorError(f"Shell 操作失败，错误码 0x{res:X}（0x7C=用户取消/条件不满足）")
    if op.fAnyOperationsAborted:
        raise FileOperatorError("操作被系统或用户取消")


# ---------------------------------------------------------------------------
# 回收站 $I 文件解析（Vista+ 二进制格式，公开已知布局）
# ---------------------------------------------------------------------------
def parse_i_file(data: bytes) -> Optional[dict]:
    """解析 $I 元数据文件：{size, deleted_at(FileTime), original_path}。

    兼容两种已知布局：
    - Windows 8+/10/11（v2 长度前缀）：头 24 字节 + u32 字符数 + UTF-16LE 路径
    - Vista/7（v2 固定缓冲）：头 24 字节 + NUL 终止的 UTF-16LE 路径
    """
    if len(data) < 24:
        return None
    version = struct.unpack_from("<Q", data, 0)[0]
    if version not in (1, 2):
        return None
    size = struct.unpack_from("<Q", data, 8)[0]
    del_ft = struct.unpack_from("<Q", data, 16)[0]

    path = None
    # 布局一：长度前缀（若数值合理且能完整容纳则优先）。
    # 注意长度含结尾 NUL（实测 Win11：plen = 字符数 + 1），故整段解码后
    # strip 尾部 NUL——绝不能按字节 split(b"\x00\x00")，会错位切出奇数字节。
    if len(data) >= 28:
        (path_len,) = struct.unpack_from("<I", data, 24)
        if 0 < path_len < 1024 and 28 + path_len * 2 <= len(data) + 2:
            try:
                path = data[28 : 28 + path_len * 2].decode("utf-16-le").strip("\x00")
            except UnicodeDecodeError:
                path = None
    # 布局二：NUL 终止（按 2 字节对齐查找终止符）
    if not path:
        raw = data[24:]
        for i in range(0, len(raw) - 1, 2):
            if raw[i : i + 2] == b"\x00\x00":
                raw = raw[:i]
                break
        try:
            path = raw.decode("utf-16-le")
        except UnicodeDecodeError:
            return None
    if not path:
        return None
    return {"size": size, "deleted_at_ft": del_ft, "original_path": path.strip("\x00")}


def _snapshot_recycle_i(drive_root: str) -> dict[str, str]:
    """快照指定盘 ``$Recycle.Bin`` 下可读的全部 $I 文件。

    Returns:
        {小写完整路径: 真实大小写完整路径}——键用于大小写不敏感比对，
        值保留磁盘真实命名（$Ixxxx → $Rxxxx 精确替换的前提）。
    """
    rb = Path(drive_root) / "$Recycle.Bin"
    found: dict[str, str] = {}
    if not rb.exists():
        return found
    for sid_dir in rb.iterdir():
        if not sid_dir.is_dir():
            continue
        try:
            for item in sid_dir.iterdir():
                if item.name[:2].upper() == "$I" and item.is_file():
                    found[str(item).lower()] = str(item)
        except (PermissionError, OSError):
            continue  # 其他用户 SID 不可读 → 静默跳过（权限铁律）
    return found


def _diff_new_i(drive_root: str, before: dict[str, str]) -> list[dict]:
    """对比删除前后快照，返回新增 $I 的解析结果。"""
    after = _snapshot_recycle_i(drive_root)
    mappings = []
    for low, real in after.items():
        if low in before:
            continue
        i_path = Path(real)
        i_name = i_path.name  # 真实大小写，形如 "$IABC123.ext"
        r_name = "$R" + i_name[2:]
        try:
            data = i_path.read_bytes()
        except OSError:
            continue
        info = parse_i_file(data)
        if info is None:
            continue
        info["i_path"] = str(i_path)
        info["r_path"] = str(i_path.with_name(r_name))
        mappings.append(info)
    return mappings


def _norm(path: str) -> str:
    return os.path.abspath(path).lower().replace("/", "\\")


def recycle_bin_status() -> dict:
    """统计各盘 $Recycle.Bin 的条目数与总字节（只读，recycle-bin-control）。

    遍历所有固定盘的 $Recycle.Bin/<SID>/$I* 文件，解析元数据取原始大小；
    不可读的 SID 目录静默跳过。非 Windows 抛 FileOperatorError。
    """
    if sys.platform != "win32":
        raise FileOperatorError("回收站功能仅支持 Windows")
    import string

    entries = 0
    total_bytes = 0
    per_drive: dict[str, dict] = {}
    for letter in string.ascii_uppercase:
        drive = f"{letter}:\\"
        if not os.path.isdir(drive):
            continue
        rb = Path(drive) / "$Recycle.Bin"
        if not rb.exists():
            continue
        d_entries = 0
        d_bytes = 0
        for sid_dir in _iter_safely(rb):
            for item in _iter_safely(sid_dir):
                if item.name[:2].upper() != "$I" or not item.is_file():
                    continue
                try:
                    info = parse_i_file(item.read_bytes())
                except OSError:
                    continue
                if info is None:
                    continue
                d_entries += 1
                d_bytes += info.get("size") or 0
        if d_entries:
            per_drive[f"{letter}:"] = {"entries": d_entries, "bytes": d_bytes}
            entries += d_entries
            total_bytes += d_bytes
    return {"entries": entries, "total_bytes": total_bytes, "per_drive": per_drive}


def _iter_safely(path: Path):
    """迭代目录，权限不足静默跳过（权限铁律）。"""
    try:
        return list(path.iterdir())
    except (PermissionError, OSError):
        return []


def empty_recycle_bin_for_op(op_uuid: str, undo) -> dict:
    """受控清空：仅永久删除指定 op_uuid 产生的回收站条目。

    安全策略（design.md D5）：
    - 从审计日志取该 op_uuid 的全部 DONE 且带 recycle_path 的条目；
    - 逐条校验 $I 文件仍存在且解析出的原始路径/大小与日志匹配；
    - 匹配则删除 $I/$R 对；不匹配则跳过并计入 mismatch（宁可不删也不误删）；
    - 清空后条目不可撤销：把日志条目标记 EMPTIED。
    """
    if sys.platform != "win32":
        raise FileOperatorError("回收站功能仅支持 Windows")
    rows = undo.get_batch(op_uuid)
    if not rows:
        return {"status": "error", "error": f"操作不存在: {op_uuid}", "freed_bytes": 0,
                "emptied": 0, "mismatch": 0}

    freed = 0
    emptied = 0
    mismatch = 0
    for row in rows:
        r_path = row["recycle_path"] if "recycle_path" in row.keys() else None
        i_path = row["recycle_info_name"] if "recycle_info_name" in row.keys() else None
        status = row["status"]
        if not r_path or status not in ("DONE",):
            continue
        # 定位同目录下的 $I 文件（$Rxxx → $Ixxx）
        rp = Path(r_path)
        i_file = rp.parent / ("$I" + rp.name[2:])
        if not i_file.exists():
            mismatch += 1
            continue
        try:
            info = parse_i_file(i_file.read_bytes())
        except OSError:
            mismatch += 1
            continue
        # 校验：$I 记录的原始路径与日志 source_path 一致（大小写不敏感）
        if info is None or _norm(info["original_path"]) != _norm(row["source_path"]):
            mismatch += 1
            continue
        # 永久删除 $R 与 $I（$R 可能是文件或目录，且可能带只读属性）
        try:
            size = rp.stat().st_size if rp.exists() else (row["file_size"] or 0)
            if rp.is_dir():
                # 目录型条目：清空只读属性后整树删除
                def _onchmod(fn, _path, _err):
                    try:
                        os.chmod(_path, stat.S_IWRITE)
                        os.remove(_path)
                    except OSError:
                        pass
                shutil.rmtree(rp, onerror=_onchmod)
            elif rp.exists():
                try:
                    os.chmod(rp, stat.S_IWRITE)
                except OSError:
                    pass
                os.remove(rp)
            try:
                os.chmod(i_file, stat.S_IWRITE)
            except OSError:
                pass
            os.remove(i_file)
            freed += size
            emptied += 1
            undo.update_entry(row["id"], status="EMPTIED")
        except OSError as e:
            logger.warning("回收站条目删除失败: %s: %s", r_path, e)
            mismatch += 1
    return {"status": "completed", "op_uuid": op_uuid, "freed_bytes": freed,
            "emptied": emptied, "mismatch": mismatch,
            "message": "已永久删除的条目不可撤销"}


class FileOperator:
    """面向 server 的文件操作门面：校验 → 日志 → 执行 → 回写日志。"""

    def __init__(
        self,
        undo: UndoManager,
        protected_check: Optional[Callable[[str], bool]] = None,
        session_id: Optional[str] = None,
    ):
        self.undo = undo
        self.protected_check = protected_check or (lambda p: False)
        self.session_id = session_id

    # ------------------------------------------------------------------
    def _check_protection(self, sources: Sequence[str]) -> None:
        blocked = [s for s in sources if self.protected_check(s)]
        if blocked:
            raise ProtectedPathError(f"路径处于保护列表，已拒绝操作: {blocked[0]} 等 {len(blocked)} 项")

    def _entry(self, src: str, dest: Optional[str] = None, size: Optional[int] = None,
               mtime: Optional[float] = None) -> dict:
        return {"source_path": src, "dest_path": dest, "file_size": size, "file_mtime": mtime}

    @staticmethod
    def _stat_of(path: str) -> tuple[Optional[int], Optional[float]]:
        try:
            st = os.stat(path)
            return st.st_size, st.st_mtime
        except OSError:
            return None, None

    # ------------------------------------------------------------------
    def delete(self, sources: Sequence[str]) -> dict:
        """删除到回收站并捕获精确 $R 映射（方案书 §12.1/§12.2）。"""
        sources = [s for s in sources if s]
        self._check_protection(sources)
        missing = [s for s in sources if not os.path.exists(s)]
        if missing:
            raise FileOperatorError(f"源路径不存在: {missing[0]}")

        op_uuid = str(uuidlib.uuid4())
        entries = []
        for s in sources:
            size, mtime = self._stat_of(s)
            entries.append(self._entry(s, size=size, mtime=mtime))
        ids = self.undo.log_batch(op_uuid, "DELETE", entries, self.session_id)

        # 按盘符分组快照回收站（删除前）。
        # 注意 diff/snapshot 均以「盘根」（带分隔符，如 C:\）为键——
        # Path("C:") 是盘相对路径，与 "$Recycle.Bin" 拼接会得到
        # "C:$Recycle.Bin"（丢失分隔符）。
        snapshots: dict[str, dict] = {}
        for s in sources:
            drive = os.path.splitdrive(os.path.abspath(s))[0]
            if drive and drive + os.sep not in snapshots:
                root = drive + os.sep
                snapshots[root] = _snapshot_recycle_i(root)

        results = []
        try:
            _sh_file_operation(FO_DELETE, sources)
        except FileOperatorError as e:
            for i, s in zip(ids, sources):
                self.undo.update_entry(i, status="FAILED", error_msg=str(e))
            return {
                "op_uuid": op_uuid,
                "status": "failed",
                "error": str(e),
                "results": [{"source": s, "status": "failed"} for s in sources],
            }

        # 比对快照 → 解析新增 $I → 按原始路径精确映射。
        # Shell 返回后 $I 可能尚未对目录枚举可见，轮询至收集齐或超时。
        new_items: dict[str, dict] = {}
        for _attempt in range(8):
            new_items = {}
            for root, before in snapshots.items():
                for m in _diff_new_i(root, before):
                    new_items[_norm(m["original_path"])] = m
            if len(new_items) >= len(sources):
                break
            time.sleep(0.25)

        for i, s in zip(ids, sources):
            m = new_items.get(_norm(s))
            if os.path.exists(s):
                self.undo.update_entry(i, status="FAILED", error_msg="删除后源路径仍存在")
                results.append({"source": s, "status": "failed", "error": "删除未生效"})
            else:
                fields = {"status": "DONE"}
                if m:
                    fields.update(
                        recycle_bin_name=Path(m["r_path"]).name,
                        recycle_info_name=Path(m["i_path"]).name,
                        recycle_path=m["r_path"],
                    )
                self.undo.update_entry(i, **fields)
                results.append(
                    {
                        "source": s,
                        "status": "done",
                        "recycle_bin_name": fields.get("recycle_bin_name"),
                    }
                )
        return {"op_uuid": op_uuid, "status": "completed", "results": results}

    # ------------------------------------------------------------------
    def _transfer(self, op_type: str, sources: Sequence[str], dest: Optional[str],
                  copy_fn) -> dict:
        sources = [s for s in sources if s]
        self._check_protection(sources)
        if not dest or not os.path.isdir(dest):
            raise FileOperatorError(f"目标目录不存在: {dest}")
        op_uuid = str(uuidlib.uuid4())
        results = []

        for s in sources:
            if not os.path.exists(s):
                raise FileOperatorError(f"源路径不存在: {s}")
            size, mtime = self._stat_of(s)
            final = os.path.join(dest, os.path.basename(s.rstrip("\\/")))
            entries = [self._entry(s, dest=final, size=size, mtime=mtime)]
            (entry_id,) = self.undo.log_batch(op_uuid, op_type, entries, self.session_id)
            try:
                copy_fn(s, dest)
                self.undo.update_entry(entry_id, status="DONE")
                results.append({"source": s, "dest": final, "status": "done"})
            except (OSError, shutil.Error) as e:
                self.undo.update_entry(entry_id, status="FAILED", error_msg=str(e))
                results.append({"source": s, "status": "failed", "error": str(e)})

        return {"op_uuid": op_uuid, "status": "completed", "results": results}

    def move(self, sources: Sequence[str], dest: str) -> dict:
        """移动（撤销 = 从 dest 移回原位）。"""
        return self._transfer("MOVE", sources, dest, shutil.move)

    def copy(self, sources: Sequence[str], dest: str) -> dict:
        """复制（撤销 = 副本送入回收站）。"""
        return self._transfer("COPY", sources, dest, shutil.copy2)

    # ------------------------------------------------------------------
    def compress(self, sources: Sequence[str], dest_dir: Optional[str] = None) -> dict:
        """压缩为 ZIP（ZIP_DEFLATED）。dest_dir 缺省为第一个源所在目录。"""
        sources = [s for s in sources if s]
        self._check_protection(sources)
        existing = [s for s in sources if not os.path.exists(s)]
        if existing:
            raise FileOperatorError(f"源路径不存在: {existing[0]}")
        dest_dir = dest_dir or os.path.dirname(os.path.abspath(sources[0]))
        base = os.path.basename(sources[0].rstrip("\\/"))
        zip_path = os.path.join(dest_dir, os.path.splitext(base)[0] + ".zip")
        n = 1
        while os.path.exists(zip_path):
            zip_path = os.path.join(dest_dir, f"{os.path.splitext(base)[0]}_{n}.zip")
            n += 1

        op_uuid = str(uuidlib.uuid4())
        entries = []
        for s in sources:
            size, mtime = self._stat_of(s)
            entries.append(self._entry(s, dest=zip_path, size=size, mtime=mtime))
        ids = self.undo.log_batch(op_uuid, "COMPRESS", entries, self.session_id)
        try:
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                for s in sources:
                    if os.path.isdir(s):
                        for root, _dirs, files in os.walk(s):
                            for fn in files:
                                fp = os.path.join(root, fn)
                                zf.write(fp, os.path.relpath(fp, os.path.dirname(s.rstrip("\\/"))))
                    else:
                        zf.write(s, os.path.basename(s))
            total = os.path.getsize(zip_path)
            for i in ids:
                self.undo.update_entry(i, status="DONE", file_size=total)
            return {
                "op_uuid": op_uuid,
                "status": "completed",
                "results": [{"source": s, "dest": zip_path, "status": "done"} for s in sources],
            }
        except (OSError, zipfile.BadZipFile) as e:
            for i in ids:
                self.undo.update_entry(i, status="FAILED", error_msg=str(e))
            raise FileOperatorError(f"压缩失败: {e}") from e

    # ------------------------------------------------------------------
    @staticmethod
    def open_in_explorer(path: str) -> None:
        """在资源管理器中定位文件（explorer /select）。"""
        if sys.platform != "win32":
            raise FileOperatorError("仅支持 Windows")
        import subprocess

        subprocess.Popen(["explorer", "/select,", os.path.abspath(path)])


# ---------------------------------------------------------------------------
# 五步回滚（方案书 §12.4）
# ---------------------------------------------------------------------------
def _conflict_free_target(target: str) -> str:
    """防覆盖：目标已存在时改为 base_restored_N.ext。"""
    if not os.path.exists(target):
        return target
    base, ext = os.path.splitext(target)
    counter = 1
    while os.path.exists(f"{base}_restored_{counter}{ext}"):
        counter += 1
    return f"{base}_restored_{counter}{ext}"


def restore_from_recycle_bin(r_path: str, target: str) -> str:
    """把 $R 物理文件还原到 target（同盘 rename，跨盘 shutil.move 兜底）。"""
    if not os.path.exists(r_path):
        raise FileOperatorError(f"回收站物理文件不存在: {r_path}")
    try:
        os.rename(r_path, target)
    except OSError:
        shutil.move(r_path, target)
    # 清理对应 $I 元数据（best-effort，失败不影响还原结果）
    i_path = Path(r_path).with_name(Path(r_path).name.replace("$R", "$I", 1))
    try:
        i_path.unlink(missing_ok=True)
    except OSError:
        pass
    return target


def _find_recycle_item_by_source(source: str) -> Optional[str]:
    """降级路径：按原始路径扫描全盘回收站 $I 匹配（无精确映射时）。"""
    drive = os.path.splitdrive(os.path.abspath(source))[0]
    rb = Path(drive + os.sep) / "$Recycle.Bin"
    if not rb.exists():
        return None
    want = _norm(source)
    for sid_dir in rb.iterdir():
        if not sid_dir.is_dir():
            continue
        try:
            for item in sid_dir.iterdir():
                if not (item.name.startswith("$I") and item.is_file()):
                    continue
                info = parse_i_file(item.read_bytes())
                if info and _norm(info["original_path"]) == want:
                    r = item.with_name(item.name.replace("$I", "$R", 1))
                    if r.exists():
                        return str(r)
        except (PermissionError, OSError):
            continue
    return None


def execute_undo(op_id: int, undo: UndoManager) -> dict:
    """五步预检回滚：状态锁定 → 父目录存活 → 冲突重命名 → 权限 → 物理还原。

    按 op_uuid 整批回滚，单条失败不阻断其余（方案书 §12.5）。
    """
    entry = undo.get_entry(op_id)
    if entry is None:
        return {"status": "failed", "error": f"操作记录 {op_id} 不存在"}

    batch = undo.get_batch(entry["op_uuid"])
    restored, failed, skipped = [], [], []

    for row in batch:
        # 步骤 1：状态锁定
        if row["status"] == "UNDONE":
            skipped.append({"id": row["id"], "source": row["source_path"],
                            "reason": "此操作已撤销过"})
            continue
        if row["status"] == "FAILED":
            failed.append({"id": row["id"], "source": row["source_path"],
                           "error": "原操作未成功，无可回滚内容"})
            continue

        try:
            target = _conflict_free_target(row["source_path"])

            # COPY/COMPRESS 的撤销 = 把产物送回回收站（保持可逆）
            if row["op_type"] in ("COPY", "COMPRESS"):
                dest = row["dest_path"]
                if dest and os.path.exists(dest):
                    _sh_file_operation(FO_DELETE, [dest])
                undo.update_entry(row["id"], status="UNDONE",
                                  undone_at=datetime_now())
                restored.append({"id": row["id"], "restored_to": dest,
                                 "note": "副本已移入回收站"})
                continue

            # 步骤 2：父目录存活检测
            parent = os.path.dirname(row["source_path"])
            if not os.path.isdir(parent):
                undo.update_entry(row["id"], status="FAILED",
                                  error_msg=f"父目录 '{parent}' 不存在")
                failed.append({"id": row["id"], "source": row["source_path"],
                               "error": f"父目录 '{parent}' 不存在"})
                continue

            # 步骤 4：权限预检
            if not os.access(parent, os.W_OK):
                undo.update_entry(row["id"], status="FAILED", error_msg="无写入权限")
                failed.append({"id": row["id"], "source": row["source_path"],
                               "error": f"无权限写入 '{parent}'"})
                continue

            # 步骤 5：物理回滚
            if row["op_type"] == "DELETE":
                r_path = row["recycle_path"] or _find_recycle_item_by_source(row["source_path"])
                if not r_path:
                    undo.update_entry(row["id"], status="FAILED",
                                      error_msg="回收站中未找到对应文件")
                    failed.append({"id": row["id"], "source": row["source_path"],
                                   "error": "回收站中未找到（可能已被清空）"})
                    continue
                restore_from_recycle_bin(r_path, target)
            elif row["op_type"] in ("MOVE", "RENAME"):
                if not (row["dest_path"] and os.path.exists(row["dest_path"])):
                    undo.update_entry(row["id"], status="FAILED", error_msg="移动产物不存在")
                    failed.append({"id": row["id"], "source": row["source_path"],
                                   "error": f"目标 '{row['dest_path']}' 不存在"})
                    continue
                shutil.move(row["dest_path"], target)
            else:
                failed.append({"id": row["id"], "source": row["source_path"],
                               "error": f"不支持回滚的操作类型 {row['op_type']}"})
                continue

            undo.update_entry(row["id"], status="UNDONE", undone_at=datetime_now())
            restored.append({"id": row["id"], "restored_to": target})
        except (OSError, shutil.Error, FileOperatorError) as e:
            undo.update_entry(row["id"], status="FAILED", error_msg=str(e))
            failed.append({"id": row["id"], "source": row["source_path"], "error": str(e)})

    if failed and not restored:
        status = "failed"
    elif failed:
        status = "partial"
    else:
        status = "success"
    return {
        "status": status,
        "op_uuid": entry["op_uuid"],
        "restored": restored,
        "failed": failed,
        "skipped": skipped,
    }
