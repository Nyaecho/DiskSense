"""扫描调度器（方案书 §6 极速扫描引擎）。

职责：
1. 主动探测盘符类型（GetDriveTypeW），本地硬盘优先 MFT 直读；
2. MFT 不可用时静默降级到多线程 os.scandir 生产者-消费者遍历；
3. Junction/符号链接防护（st_reparse_tag，不向下遍历）；
4. 主动节流（每 N 个文件 sleep 一次，让出 CPU）。

权限策略：受限目录捕获 PermissionError 跳过子遍历并记入
``skipped_paths``（标记"受限区域"），绝不 takeown/icacls（铁律 3）。
"""

from __future__ import annotations

import ctypes
import logging
import os
import queue
import re
import sys
import threading
import time
from fnmatch import fnmatch
from pathlib import Path
from typing import Optional, Sequence

from .config import RULES_FILE, ScanConfig, default_scan_workers
from .models import Node, ProgressCallback, ScanResult, finalize_tree
from .mft import MFTUnavailableError, scan_via_mft

logger = logging.getLogger(__name__)


def load_cache_dir_patterns(path: Path | str | None = None) -> list[tuple[str, str]]:
    """从 classification_rules.yaml 加载缓存目录模式库 [(pattern, type), ...]。

    文件缺失或段缺失时返回空列表（零配置可运行）；格式非法的条目跳过并告警。
    """
    import yaml

    p = Path(path) if path else RULES_FILE
    if not p.exists():
        return []
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
    except (OSError, yaml.YAMLError) as e:
        logger.warning("缓存模式库加载失败（忽略）: %s", e)
        return []
    patterns: list[tuple[str, str]] = []
    for raw in data.get("cache_dir_patterns", []) or []:
        if isinstance(raw, dict) and raw.get("pattern") and raw.get("type"):
            patterns.append((str(raw["pattern"]), str(raw["type"])))
        else:
            logger.warning("缓存模式条目格式非法，已跳过: %r", raw)
    return patterns


def match_cache_pattern(name: str, patterns: Sequence[tuple[str, str]]) -> Optional[str]:
    """目录名命中缓存模式库时返回类型标注，否则 None（大小写不敏感）。"""
    low = name.lower()
    for pattern, ctype in patterns:
        if fnmatch(low, pattern.lower()):
            return ctype
    return None

_DRIVE_FIXED = 3  # GetDriveTypeW: DRIVE_FIXED 本地硬盘
_DRIVE_RE = re.compile(r"^([A-Za-z]):[\\/]*$")

# Windows 重解析标记（st_reparse_tag）：挂载点与符号链接均不下钻，
# 防止 C:\Documents and Settings → C:\Users 一类的死循环（方案书 §6.4）
_IO_REPARSE_TAG_MOUNT_POINT = 0xA0000003
_IO_REPARSE_TAG_SYMLINK = 0xA000000C


def match_ignore(name: str, ignores: Sequence[str]) -> bool:
    """判断目录名是否命中忽略模式（大小写不敏感 fnmatch）。

    扫描遍历与元数据搜索共用，保证两者忽略行为一致。

    Args:
        name: 目录名（非完整路径）。
        ignores: 忽略模式列表（来自配置 default_dir_ignores 与用户偏好）。

    Returns:
        是否命中任一模式。
    """
    low = name.lower()
    return any(fnmatch(low, g.lower()) for g in ignores)


def get_drive_type(target: str) -> int:
    """返回 GetDriveTypeW 盘符类型：3=本地硬盘 4=网络盘 2=移动盘 5=CD-ROM；0=未知/非盘符。"""
    m = _DRIVE_RE.match(target.strip())
    if not m or sys.platform != "win32":
        return 0
    return int(ctypes.windll.kernel32.GetDriveTypeW(f"{m.group(1)}:\\"))


def _normalize_target(target: str) -> str:
    """裸盘符归一化："C:" / "c:/" → "C:\\"。

    Windows 下 ``os.path.abspath("C:")`` 解析为「C 盘的当前工作目录」
    （即服务启动目录）而非盘根——walk 降级模式下会把裸盘符扫成启动目录
    的一个小角落。归一化为带分隔符的盘根后 abspath 才指向真正的盘根。
    """
    m = _DRIVE_RE.match(target.strip())
    if m:
        return f"{m.group(1).upper()}:\\"
    return target


def _is_link(entry: os.DirEntry) -> bool:
    """判断目录项是否为 Junction/符号链接（基于 st_reparse_tag，无需管理员）。"""
    try:
        if entry.is_symlink():
            return True
        st = entry.stat(follow_symlinks=False)
        tag = getattr(st, "st_reparse_tag", 0)
        return tag in (_IO_REPARSE_TAG_MOUNT_POINT, _IO_REPARSE_TAG_SYMLINK)
    except OSError:
        return False


class _WalkState:
    """walk 扫描的共享计数与节流状态（全部操作持锁）。"""

    def __init__(self, cfg: ScanConfig, progress_cb: Optional[ProgressCallback]):
        self.lock = threading.Lock()
        self.files = 0
        self.bytes = 0
        self.enq = 1
        self.done = 0
        self._cfg = cfg
        self._cb = progress_cb
        self._since_throttle = 0

    def add_file(self, size: int) -> None:
        with self.lock:
            self.files += 1
            self.bytes += size

    def add_task(self) -> None:
        with self.lock:
            self.enq += 1

    def finish_task(self) -> None:
        with self.lock:
            self.done += 1
            if self._cb:
                # 已完成任务 / 累计发现任务 → 单调收敛到 1
                progress = min(0.98, self.done / max(1, self.enq))
                self._cb(progress, self.files, self.bytes)

    def throttle(self) -> None:
        """方案书 §14.4：每处理 throttle_every 个文件主动让出 CPU 时间片。"""
        with self.lock:
            self._since_throttle += 1
            due = self._since_throttle >= self._cfg.throttle_every
            if due:
                self._since_throttle = 0
        if due and self._cfg.throttle_sleep_sec:
            time.sleep(self._cfg.throttle_sleep_sec)


def scan_via_walk(
    target: str,
    progress_cb: Optional[ProgressCallback] = None,
    cancel_event: Optional[threading.Event] = None,
    cfg: Optional[ScanConfig] = None,
    ignore_globs: Sequence[str] = (),
) -> ScanResult:
    """多线程生产者-消费者目录遍历（降级路径，也支持任意目录而非仅盘符）。

    Args:
        target: 盘符（"C:"）或任意绝对目录路径。
        progress_cb: 进度回调 (progress, files_seen, bytes_seen)。
        cancel_event: 取消事件，置位后尽快收敛退出。
        cfg: 扫描配置（线程数/节流/默认忽略目录）。
        ignore_globs: 额外目录名忽略模式（来自用户偏好）。

    Raises:
        FileNotFoundError: 目标路径不存在。
        InterruptedError: 扫描被取消。
    """
    cfg = cfg or ScanConfig()
    t0 = time.perf_counter()
    target = os.path.abspath(target)
    if not os.path.exists(target):
        raise FileNotFoundError(f"扫描目标不存在: {target}")

    cache_patterns = load_cache_dir_patterns()

    m = _DRIVE_RE.match(target + "\\")
    display = f"{m.group(1).upper()}:" if m else os.path.basename(target.rstrip("\\/"))
    root = Node(name=display, is_dir=True, children={})

    all_ignores = list(cfg.default_dir_ignores) + list(ignore_globs)

    def ignored(name: str) -> bool:
        return match_ignore(name, all_ignores)

    state = _WalkState(cfg, progress_cb)
    skipped: list[str] = []
    errors: list[Exception] = []
    task_q: "queue.Queue[tuple[str, Node] | None]" = queue.Queue()
    workers = cfg.max_workers if cfg.max_workers else default_scan_workers()

    def worker() -> None:
        while True:
            item = task_q.get()
            if item is None:
                task_q.task_done()
                return
            if cancel_event is not None and cancel_event.is_set():
                task_q.task_done()
                continue
            dir_path, parent_node = item
            try:
                _scan_one_dir(dir_path, parent_node, task_q, state, skipped, ignored, cancel_event, cache_patterns)
            except Exception as e:  # noqa: BLE001 — 单目录失败不应终止整体扫描
                errors.append(e)
            finally:
                state.finish_task()
                task_q.task_done()

    threads = [
        threading.Thread(target=worker, daemon=True) for _ in range(max(1, workers))
    ]
    for t in threads:
        t.start()

    task_q.put((target, root))
    task_q.join()
    for _ in threads:
        task_q.put(None)  # 收尾哨兵
    for t in threads:
        t.join(timeout=5)

    if errors:
        raise errors[0]
    if cancel_event is not None and cancel_event.is_set():
        raise InterruptedError("扫描被用户取消")

    files, dirs, total = finalize_tree(root)
    result = ScanResult(
        root=root,
        mode="walk",
        files=files,
        dirs=dirs,
        total_bytes=total,
        skipped_paths=skipped,
        elapsed_sec=time.perf_counter() - t0,
    )
    if progress_cb:
        progress_cb(1.0, files, total)
    return result


def _scan_one_dir(
    dir_path: str,
    parent_node: Node,
    task_q: "queue.Queue",
    state: _WalkState,
    skipped: list,
    ignored,
    cancel_event: Optional[threading.Event],
    cache_patterns: Sequence[tuple[str, str]] = (),
) -> None:
    """扫描单个目录：子目录入队，文件建叶节点；权限不足记入 skipped（受限区域）。"""
    try:
        entries = list(os.scandir(dir_path))
    except PermissionError:
        if len(skipped) < 200:  # 上限防爆日志
            skipped.append(dir_path)
        return
    except OSError:
        return

    children: dict[str, Node] = {}
    for entry in entries:
        if cancel_event is not None and cancel_event.is_set():
            break
        name = entry.name
        try:
            if entry.is_dir(follow_symlinks=False):
                if ignored(name):
                    continue
                st = entry.stat(follow_symlinks=False)
                if _is_link(entry):
                    # Junction/符号链接：只建叶节点，绝不下钻（死循环防护）
                    children[name] = Node(
                        name, st.st_size, st.st_mtime, st.st_atime,
                        is_dir=True, is_link=True,
                    )
                else:
                    node = Node(name, mtime=st.st_mtime, atime=st.st_atime, is_dir=True, children={})
                    node.cache_type = match_cache_pattern(name, cache_patterns)
                    children[name] = node
                    task_q.put((entry.path, node))
                    state.add_task()
            else:
                st = entry.stat(follow_symlinks=False)
                children[name] = Node(name, st.st_size, st.st_mtime, st.st_atime)
                state.add_file(st.st_size)
                state.throttle()
        except (PermissionError, OSError):
            continue

    # 本目录仅由一个 worker 扫描，children 整体挂载无并发写
    parent_node.children.update(children)


def scan(
    target: str,
    cfg: Optional[ScanConfig] = None,
    progress_cb: Optional[ProgressCallback] = None,
    cancel_event: Optional[threading.Event] = None,
    ignore_globs: Sequence[str] = (),
) -> ScanResult:
    """扫描入口：本地 NTFS 硬盘走 MFT 快速路径，否则多线程 walk。

    主动探测盘符类型（方案书 §6.2），避免"先报错再降级"。
    """
    cfg = cfg or ScanConfig()
    target = _normalize_target(target)
    m = _DRIVE_RE.match(target)

    if (
        m
        and sys.platform == "win32"
        and cfg.use_mft
        and get_drive_type(target) == _DRIVE_FIXED
    ):
        try:
            result = scan_via_mft(
                m.group(1),
                progress_cb=progress_cb,
                cancel_event=cancel_event,
                ignore_globs=tuple(cfg.default_dir_ignores) + tuple(ignore_globs),
            )
            logger.info(
                "MFT 扫描完成：%d 文件 / %d 目录，%.1fs",
                result.files, result.dirs, result.elapsed_sec,
            )
            return result
        except MFTUnavailableError as e:
            logger.info("MFT 不可用，静默降级 os.walk：%s", e)

    return scan_via_walk(
        target,
        progress_cb=progress_cb,
        cancel_event=cancel_event,
        cfg=cfg,
        ignore_globs=ignore_globs,
    )
