"""FastAPI 本地核心服务（API 契约 / 并发模型）。

纯 Agent API 服务：Agent 经 scripts/api_client.py 调用；
高亮指令经 /viz 写入环形缓冲，Agent 轮询 /overlays 取回增量。

并发模型：扫描、文件操作等同步阻塞全部经
``asyncio.to_thread`` 委派线程池，事件循环永不阻塞。

生命周期：
- 启动即持有 filelock 单例锁（防双进程）；
- 空闲自毁：HTTP 与 WS 均超时无活动且无扫描进行时进程退出
  （扫描进行中计时器永不触发，防缓存损坏）。

本文件支持三种启动方式：
    python -m disk_sense.server          （推荐，launcher 使用）
    python disk_sense/server.py          （直接执行）
    uvicorn disk_sense.server:app        （开发调试）
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import sys
import threading
import time
from fnmatch import fnmatch
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import __version__, magic, scanner
from .aggregator import Aggregator
from .config import (
    Config,
    DATA_DIR,
    LOCK_FILE,
    RULES_FILE,
    ensure_data_dirs,
    load_config,
)
from .file_operator import (
    FileOperator,
    FileOperatorError,
    ProtectedPathError,
    empty_recycle_bin_for_op,
    execute_undo,
    recycle_bin_status,
)
from .jobs import JobManager
from .models import ScanResult
from .preferences import Preferences
from .rules_engine import RulesEngine
from .undo_manager import UndoManager

logger = logging.getLogger(__name__)

# 必须带捕获组且含冒号：scanned_roots/_source_in_scope 的范围键统一为 "C:" 形式
# （无组会使 m.group(1) 抛 IndexError → 所有 /operation 500；缺冒号则与
# _source_in_scope 的键格式不匹配 → 永远校验失败）
_DRIVE_RE = re.compile(r"^([A-Za-z]:)[\\/]*$")
VALID_VIZ_ACTIONS = {"highlight", "label", "group", "protect", "clear"}
VALID_OP_TYPES = {"move", "copy", "delete", "compress"}


# ---------------------------------------------------------------------------
# 运行时状态容器
# ---------------------------------------------------------------------------
@dataclass
class ScanSession:
    """一次扫描会话的进度与产物（读写以 _lock 串行化）。"""

    session_id: str
    target: str
    status: str = "scanning"  # scanning | completed | failed
    progress: float = 0.0
    files_seen: int = 0
    bytes_seen: int = 0
    fingerprint: Optional[dict] = None
    aggregator: Optional[Aggregator] = None
    scan_root: Optional[object] = None  # 扫描树根 Node（供 /subtree 钻取）
    error: Optional[str] = None
    started_at: float = field(default_factory=time.time)
    finished_at: Optional[float] = None
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)


class OverlayBuffer:
    """叠加层指令环形缓冲（viz 指令记录 + Agent 轮询取回）。"""

    def __init__(self) -> None:
        self.overlay_buffer: list[dict] = []
        self._seq = 0

    def publish_overlay(self, command: dict) -> int:
        """叠加层指令写入环形缓冲，返回递增 seq。"""
        self._seq += 1
        entry = {"seq": self._seq, **command}
        self.overlay_buffer.append(entry)
        if len(self.overlay_buffer) > 100:
            self.overlay_buffer = self.overlay_buffer[-100:]
        return self._seq

    def overlays_since(self, since_seq: int) -> list[dict]:
        return [e for e in self.overlay_buffer if e["seq"] > since_seq]


class AppState:
    """聚集于 app.state 的全部运行时依赖（便于测试注入）。"""

    def __init__(
        self,
        cfg: Config,
        data_dir: Path,
        prefs: Preferences,
        rules: RulesEngine,
        undo: UndoManager,
        exit_hook=None,
    ):
        self.cfg = cfg
        self.data_dir = data_dir
        self.prefs = prefs
        self.rules = rules
        self.undo = undo
        self.hub = OverlayBuffer()
        self.sessions: dict[str, ScanSession] = {}
        self.jobs = JobManager()  # 异步操作任务注册表（async-jobs）
        self.scan_thread: Optional[threading.Thread] = None
        self.scan_lock = threading.Lock()
        self.activity_lock = threading.Lock()
        self.last_activity = time.time()
        self.shutdown_event = asyncio.Event()
        # 进程退出钩子（默认 os._exit，测试注入 no-op）
        self.exit_hook = exit_hook or _default_exit_hook

    # -- 活动时间戳（空闲自毁依据） --
    def touch(self) -> None:
        with self.activity_lock:
            self.last_activity = time.time()

    def idle_seconds(self) -> float:
        with self.activity_lock:
            return time.time() - self.last_activity

    def scanning(self) -> bool:
        with self.scan_lock:
            return self.scan_thread is not None and self.scan_thread.is_alive()

    def latest_session(self) -> Optional[ScanSession]:
        if not self.sessions:
            return None
        return max(self.sessions.values(), key=lambda s: s.started_at)

    def latest_completed_session(self) -> Optional[ScanSession]:
        """最近一次已完成的会话（/detail 数据源）。

        取 started_at 最新而非字典序首个——旧空会话（如误扫技能目录）
        会永久挡住后续正确扫描的结果查询。
        """
        completed = [
            s
            for s in self.sessions.values()
            if s.status == "completed" and s.aggregator is not None
        ]
        return max(completed, key=lambda s: s.started_at, default=None)

    def scanned_roots(self) -> set[str]:
        """操作范围键集合：完整盘符扫描给盘根键，目录扫描给前缀键。"""
        roots: set[str] = set()
        for s in self.sessions.values():
            m = _DRIVE_RE.match(s.target)
            if m:
                roots.add(m.group(1).upper())
            else:
                roots.add(
                    str(Path(s.target).resolve()).replace("/", "\\").lower().rstrip("\\")
                )
        return roots

    def make_operator(self) -> FileOperator:
        latest = self.latest_session()
        return FileOperator(
            self.undo,
            protected_check=self.prefs.is_protected,
            session_id=latest.session_id if latest else None,
        )


def _default_exit_hook() -> None:
    os._exit(0)


def _new_session_id() -> str:
    return f"scan-{datetime.now():%Y%m%d-%H%M%S}"


def _source_scope_key(src: str) -> str:
    """源路径的操作范围键：盘符（大写）或绝对路径（小写）。"""
    m = re.match(r"^([A-Za-z]:)", src)
    return m.group(1).upper() if m else str(Path(src).resolve()).lower()


def _source_in_scope(allowed: set[str], src: str) -> bool:
    """操作范围校验。

    allowed 混合两种键：整盘根（"C:"，仅当扫描目标是完整盘符）与
    具体目录前缀（小写绝对路径）。源在任一范围内即放行。
    """
    m = re.match(r"^([A-Za-z]:)", src)
    if m and m.group(1).upper() in allowed:
        return True
    try:
        p = str(Path(src).resolve()).replace("/", "\\").lower().rstrip("\\")
    except OSError:
        return False
    for root in allowed:
        if re.fullmatch(r"[A-Za-z]:", root):
            continue  # 盘符键已在上面处理
        if p == root or p.startswith(root + "\\"):
            return True
    return False


async def _validate_operation(state: "AppState", req: "OperationRequest") -> None:
    """操作类型与范围校验（同步/异步共用）。"""
    if req.op_type not in VALID_OP_TYPES:
        raise HTTPException(400, f"无效操作: {req.op_type}（可选 {sorted(VALID_OP_TYPES)}）")
    if not req.sources:
        raise HTTPException(400, "sources 不能为空")

    # 操作范围校验：已有扫描记录时，源须位于已扫描范围内
    if state.sessions:
        allowed = state.scanned_roots()
        for src in req.sources:
            if not _source_in_scope(allowed, src):
                raise HTTPException(
                    400, f"源路径未经扫描（先扫描对应盘符或目录）: {src}"
                )


def _find_node_in_tree(root_node, path: str, with_chain: bool = False):
    """在扫描树中定位路径对应节点（大小写不敏感 + 后缀对齐）。

    绝对路径首段（盘符）与树根名不一致时，从每个起点尝试后缀匹配；
    返回节点或 None。with_chain=True 时返回 (node, chain)，chain 为从
    根到目标（含目标）的节点列表（供 _mark_stale 标记祖先）。
    """
    target = path.replace("/", "\\").strip("\\")
    segs = [s for s in target.split("\\") if s]

    def _try_from(start: int):
        node = root_node
        chain = [root_node]
        consumed = 0
        for seg in segs[start:]:
            if consumed == 0 and seg.lower() == str(root_node.name).lower().rstrip(":"):
                consumed = 1
                continue
            children = node.children or {}
            nxt = children.get(seg) or next(
                (c for k, c in children.items() if k.lower() == seg.lower()), None
            )
            if nxt is None:
                return None
            node = nxt
            chain.append(nxt)
            consumed += 1
        return (node, chain, consumed) if consumed > 0 else None

    for start in range(len(segs)):
        r = _try_from(start)
        if r is not None:
            return (r[0], r[1]) if with_chain else r[0]
    return (None, []) if with_chain else None


def _mark_stale(state: "AppState", sources: list[str]) -> None:
    """操作成功后把受影响路径在扫描树上标记过期（scan-invalidation）。"""
    latest = state.latest_completed_session()
    if latest is None or latest.scan_root is None:
        return
    root = latest.scan_root
    now = time.time()
    for src in sources:
        node, chain = _find_node_in_tree(root, src, with_chain=True)
        if node is not None:
            # 标记目标及其全部祖先（查询父目录也能看到过期状态）
            for n in chain:
                n.stale = True
                n.stale_since = now


def _run_operation_sync(state: "AppState", req: "OperationRequest") -> dict:
    """在线程池中同步执行操作（异步 job 后台路径与同步路径共用）。"""
    operator = state.make_operator()
    if req.op_type == "delete":
        return operator.delete(req.sources)
    if req.op_type == "move":
        return operator.move(req.sources, req.dest)
    if req.op_type == "copy":
        return operator.copy(req.sources, req.dest)
    return operator.compress(req.sources, req.dest)


async def _execute_operation(state: "AppState", req: "OperationRequest") -> dict:
    """/operation 与 WS 右键菜单共用的执行路径（线程池执行）。"""
    await _validate_operation(state, req)

    operator = state.make_operator()

    def run() -> dict:
        if req.op_type == "delete":
            return operator.delete(req.sources)
        if req.op_type == "move":
            return operator.move(req.sources, req.dest)
        if req.op_type == "copy":
            return operator.copy(req.sources, req.dest)
        return operator.compress(req.sources, req.dest)

    try:
        return await asyncio.to_thread(run)
    except ProtectedPathError as e:
        raise HTTPException(403, str(e)) from e
    except FileOperatorError as e:
        raise HTTPException(400, str(e)) from e


async def _execute_operation_with_invalidation(
    state: "AppState", req: "OperationRequest"
) -> dict:
    """执行操作；成功且状态为 completed 时标记受影响扫描区域过期。"""
    result = await _execute_operation(state, req)
    if isinstance(result, dict) and result.get("status") == "completed":
        _mark_stale(state, req.sources)
    return result


# ---------------------------------------------------------------------------
# 扫描流水线（在线程池执行，进度回写会话）
# ---------------------------------------------------------------------------
def _run_scan_pipeline(
    state: AppState, session: ScanSession, cancel_event: threading.Event
) -> None:
    """同步扫描 → 聚合 → 信号 → 报告落盘（整个函数跑在 worker 线程）。"""
    try:
        def on_progress(p: float, files: int, bytes_seen: int) -> None:
            with session.lock:
                session.progress = p
                session.files_seen = files
                session.bytes_seen = bytes_seen

        result: ScanResult = scanner.scan(
            session.target,
            cfg=state.cfg.scan,
            progress_cb=on_progress,
            cancel_event=cancel_event,
            ignore_globs=state.prefs.ignore_patterns,
        )
        aggregator = Aggregator(
            rules=state.rules,
            tags_by_prefix=state.prefs.tags_by_prefix,
            pseudo_entity_paths=state.prefs.pseudo_entity_paths,
        )
        fingerprint = aggregator.aggregate(result, session.session_id)

        with session.lock:
            session.fingerprint = fingerprint
            session.aggregator = aggregator
            session.scan_root = result.root
            session.status = "completed"
            session.progress = 1.0
            session.finished_at = time.time()
        logger.info(
            "扫描完成 %s：%d 实体，%.1fs",
            session.session_id,
            len(fingerprint["entities"]),
            result.elapsed_sec,
        )
    except Exception as e:  # noqa: BLE001 — 扫描失败必须反馈给会话而非崩溃服务
        logger.exception("扫描失败 %s", session.session_id)
        with session.lock:
            session.status = "failed"
            session.error = str(e)
            session.finished_at = time.time()
    finally:
        with state.scan_lock:
            state.scan_thread = None


# ---------------------------------------------------------------------------
# 请求/响应模型
# ---------------------------------------------------------------------------
class ScanRequest(BaseModel):
    drive: str


class ClassifyRequest(BaseModel):
    path: str


class VizRequest(BaseModel):
    action: str
    target: dict = {}
    payload: dict = {}


class OperationRequest(BaseModel):
    op_type: str
    sources: list[str]
    dest: Optional[str] = None
    async_mode: bool = False  # true：后台执行，立即返回 job_id（202）


class UndoRequest(BaseModel):
    op_id: int


class ProtectRequest(BaseModel):
    path: str
    add: bool = True


class TagRequest(BaseModel):
    path: str
    tag: str


class RecycleBinEmptyRequest(BaseModel):
    op_uuid: str  # 仅清空该操作批次产生的回收站条目


def _session_payload(s: ScanSession, with_result: bool = False) -> dict:
    with s.lock:
        payload: dict[str, Any] = {
            "session_id": s.session_id,
            "status": s.status,
            "progress": round(s.progress, 3),
            "files_seen": s.files_seen,
            "bytes_seen": s.bytes_seen,
        }
        if s.status == "failed":
            payload["error"] = s.error
        if with_result and s.status == "completed":
            payload["result"] = s.fingerprint
        return payload


# ---------------------------------------------------------------------------
# 应用工厂
# ---------------------------------------------------------------------------
def create_app(
    data_dir: Path | str | None = None,
    config_path: Path | str | None = None,
    exit_hook=None,
) -> FastAPI:
    """构建 FastAPI 应用。data_dir/config_path/exit_hook 供测试注入。"""
    cfg = load_config(config_path)
    data_dir = Path(data_dir) if data_dir else DATA_DIR
    data_dir.mkdir(parents=True, exist_ok=True)

    state = AppState(
        cfg=cfg,
        data_dir=data_dir,
        prefs=Preferences(data_dir / "user_preferences.json"),
        rules=RulesEngine.from_yaml(RULES_FILE),
        undo=UndoManager(data_dir / "op_log.db", cfg.history.retention_days),
        exit_hook=exit_hook,
    )

    app = FastAPI(title="DiskSense", version=__version__, docs_url=None, redoc_url=None)
    app.state.disk_sense = state

    # -- 活动时间戳中间件（空闲自毁依据）--
    @app.middleware("http")
    async def _touch_activity(request, call_next):
        state.touch()
        return await call_next(request)

    # ---------------- /health ----------------
    @app.get("/health")
    async def health():
        return {
            "status": "alive",
            "version": __version__,
            "scanning": state.scanning(),
            "sessions": len(state.sessions),
            "idle_sec": round(state.idle_seconds(), 1),
        }

    # ---------------- /scan ----------------
    @app.post("/scan")
    async def start_scan(req: ScanRequest):
        target = req.drive.strip()
        valid = _DRIVE_RE.match(target) or Path(target).exists()
        if not target or not valid:
            raise HTTPException(400, f"无效的扫描目标: {target}")

        # 已有扫描进行中 → 返回该会话（单扫描任务）
        with state.scan_lock:
            for s in state.sessions.values():
                with s.lock:
                    if s.status == "scanning":
                        return _session_payload(s)

            session = ScanSession(session_id=_new_session_id(), target=target)
            state.sessions[session.session_id] = session
            cancel_event = threading.Event()
            t = threading.Thread(
                target=_run_scan_pipeline,
                args=(state, session, cancel_event),
                daemon=True,
                name=f"scan-{session.session_id}",
            )
            state.scan_thread = t
        t.start()

        # 同步等待上限，超时返回 scanning 交给客户端轮询
        deadline = time.time() + state.cfg.scan_api.sync_timeout_sec
        while time.time() < deadline:
            if session.status != "scanning":
                break
            await asyncio.sleep(0.2)

        payload = _session_payload(session, with_result=True)
        if session.status == "scanning":
            payload["message"] = "扫描仍在进行中，请轮询 /result"
        return payload

    # ---------------- /result ----------------
    @app.get("/result")
    async def scan_result(session_id: str = Query(...)):
        s = state.sessions.get(session_id)
        if s is None:
            raise HTTPException(404, f"会话不存在: {session_id}")
        return _session_payload(s, with_result=True)

    # ---------------- /detail ----------------
    @app.get("/detail")
    async def detail(
        entity_id: str = Query(...), category: Optional[str] = Query(None)
    ):
        latest = state.latest_completed_session()
        if latest is None or latest.aggregator is None:
            raise HTTPException(404, "尚无已完成的扫描会话")
        top = latest.aggregator.entity_top_files.get(entity_id)
        if top is None:
            raise HTTPException(404, f"实体不存在: {entity_id}")
        if category:
            if category not in top:
                raise HTTPException(400, f"无效类别: {category}")
            return top[category]
        return top

    # ---------------- /classify ----------------
    @app.post("/classify")
    async def classify(req: ClassifyRequest):
        if not os.path.exists(req.path):
            raise HTTPException(404, f"文件不存在: {req.path}")
        return await asyncio.to_thread(magic.classify_magic_number, req.path)

    # ---------------- /dir_stat（只读元数据，无扫描范围校验）----------------
    @app.get("/dir_stat")
    async def dir_stat(path: str = Query(...)):
        """返回任意目录/文件的 mtime/atime/ctime 元数据（仅 stat，不读内容）。"""
        def _stat() -> dict:
            st = os.stat(path)
            return {
                "path": path,
                "is_dir": os.path.isdir(path),
                "mtime": st.st_mtime,
                "atime": st.st_atime,
                "ctime": st.st_ctime,
                "size": st.st_size if os.path.isfile(path) else None,
            }

        if not os.path.exists(path):
            raise HTTPException(404, f"路径不存在: {path}")
        try:
            return await asyncio.to_thread(_stat)
        except OSError as e:
            raise HTTPException(400, f"无法读取路径元数据: {e}") from e

    # ---------------- /search_dirs（只读，按名称模式搜目录与文件）----------------
    @app.get("/search_dirs")
    async def search_dirs(
        pattern: str = Query(...),
        root: str = Query(...),
        top: int = Query(50, ge=1, le=500),
    ):
        """fnmatch 递归匹配目录与文件名，分别返回，按大小降序取 Top N。"""
        if not os.path.exists(root):
            raise HTTPException(404, f"搜索根不存在: {root}")

        def _search() -> dict:
            ignores = list(state.cfg.scan.default_dir_ignores) + list(
                state.prefs.ignore_patterns
            )
            dirs: list[dict] = []
            files: list[dict] = []
            skipped = 0
            stack = [os.path.abspath(root)]
            while stack:
                cur = stack.pop()
                try:
                    entries = list(os.scandir(cur))
                except OSError:
                    skipped += 1
                    continue
                for entry in entries:
                    try:
                        if entry.is_symlink():
                            continue  # 链接不跟随，防环与重复计数
                        if entry.is_dir(follow_symlinks=False):
                            if scanner.match_ignore(entry.name, ignores):
                                continue  # 忽略目录：不匹配也不下钻
                            if fnmatch(entry.name.lower(), pattern.lower()):
                                st = entry.stat(follow_symlinks=False)
                                dirs.append({
                                    "path": entry.path.replace("\\", "/"),
                                    "size": st.st_size,
                                    "mtime": st.st_mtime,
                                })
                            stack.append(entry.path)
                        elif entry.is_file(follow_symlinks=False):
                            if fnmatch(entry.name.lower(), pattern.lower()):
                                st = entry.stat(follow_symlinks=False)
                                files.append({
                                    "path": entry.path.replace("\\", "/"),
                                    "size": st.st_size,
                                    "mtime": st.st_mtime,
                                })
                    except OSError:
                        skipped += 1
            dirs.sort(key=lambda d: d["size"], reverse=True)
            files.sort(key=lambda f: f["size"], reverse=True)
            return {
                "pattern": pattern,
                "root": root,
                "dirs": dirs[:top],
                "files": files[:top],
                "total_dirs_matched": len(dirs),
                "total_files_matched": len(files),
                "skipped_inaccessible": skipped,
            }

        return await asyncio.to_thread(_search)

    # ---------------- /path_size（只读，递归测体积）----------------
    @app.get("/path_size")
    async def path_size(path: str = Query(...)):
        """递归测量任意路径的 total_bytes/files/dirs（跳过链接）。"""
        if not os.path.exists(path):
            raise HTTPException(404, f"路径不存在: {path}")

        def _measure() -> dict:
            total = 0
            files = 0
            dirs = 0
            skipped = 0
            if os.path.isfile(path):
                st = os.stat(path)
                return {
                    "path": path,
                    "total_bytes": st.st_size,
                    "files": 1,
                    "dirs": 0,
                    "skipped_inaccessible": 0,
                }
            stack = [os.path.abspath(path)]
            while stack:
                cur = stack.pop()
                try:
                    entries = list(os.scandir(cur))
                except OSError:
                    skipped += 1
                    continue
                for entry in entries:
                    try:
                        if entry.is_symlink():
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            dirs += 1
                            stack.append(entry.path)
                        elif entry.is_file(follow_symlinks=False):
                            st = entry.stat(follow_symlinks=False)
                            total += st.st_size
                            files += 1
                    except OSError:
                        skipped += 1
            return {
                "path": path,
                "total_bytes": total,
                "files": files,
                "dirs": dirs,
                "skipped_inaccessible": skipped,
            }

        return await asyncio.to_thread(_measure)

    # ---------------- /subtree（treemap 钻取，基于扫描会话数据）----------------
    @app.get("/subtree")
    async def subtree(
        path: str = Query(...),
        depth: int = Query(1, ge=1, le=5),
    ):
        """返回已扫描路径下至多 depth 层的子树聚合（纯内存，不触盘）。"""
        latest = state.latest_completed_session()
        if latest is None or latest.fingerprint is None:
            raise HTTPException(404, "尚无已完成的扫描会话")

        root_node = latest.scan_root
        if root_node is None:
            raise HTTPException(404, "当前会话未保留扫描树")

        node = _find_node_in_tree(root_node, path)
        if node is None:
            raise HTTPException(404, f"路径不在已扫描范围内: {path}")

        MAX_SIBLINGS = 200

        def _build(n, d):
            if d == 0 or not n.is_dir or not n.children:
                out = {"name": n.name, "value": n.size, "is_dir": n.is_dir}
                if n.stale:
                    out["stale"] = True
                    out["stale_since"] = n.stale_since
                return out
            subs = sorted((n.children or {}).values(), key=lambda c: c.size, reverse=True)
            omitted = max(0, len(subs) - MAX_SIBLINGS)
            children = [_build(c, d - 1) for c in subs[:MAX_SIBLINGS] if c.size > 0]
            out = {"name": n.name, "value": n.size, "is_dir": True, "children": children}
            if n.stale:
                out["stale"] = True
                out["stale_since"] = n.stale_since
            if omitted:
                out["omitted"] = omitted
            return out

        return {"path": path, "depth": depth, "subtree": _build(node, depth)}

    # ---------------- /viz ----------------
    @app.post("/viz")
    async def viz(req: VizRequest):
        if req.action not in VALID_VIZ_ACTIONS:
            raise HTTPException(400, f"无效动作: {req.action}（可选 {sorted(VALID_VIZ_ACTIONS)}）")
        command = {"action": req.action, "target": req.target, "payload": req.payload}
        seq = state.hub.publish_overlay(command)
        return {"status": "ok", "seq": seq}

    # ---------------- /overlays（Agent 轮询叠加层指令增量）----------------
    @app.get("/overlays")
    async def overlays(since_seq: int = Query(0, ge=0)):
        return {"overlays": state.hub.overlays_since(since_seq)}

    # ---------------- /operation ----------------
    @app.post("/operation")
    async def operation(req: OperationRequest):
        if not req.async_mode:
            return await _execute_operation_with_invalidation(state, req)

        # 异步模式：校验后立即返回 job_id，操作后台执行（async-jobs）
        await _validate_operation(state, req)
        job = state.jobs.create(req.op_type, req.sources)

        def _run_job() -> None:
            state.jobs.mark_running(job)
            try:
                result = _run_operation_sync(state, req)
                if isinstance(result, dict) and result.get("status") == "completed":
                    _mark_stale(state, req.sources)
                state.jobs.finish(job, result=result)
            except (FileOperatorError, ProtectedPathError, OSError) as e:
                state.jobs.finish(job, error=str(e))
            except Exception as e:  # noqa: BLE001 — 后台任务异常不得拖垮服务
                state.jobs.finish(job, error=f"{type(e).__name__}: {e}")

        loop = asyncio.get_running_loop()
        loop.run_in_executor(None, _run_job)
        return JSONResponse(status_code=202, content={
            "status": "accepted",
            "job_id": job.job_id,
            "message": "操作已提交后台执行，轮询 GET /job?job_id= 查询进度",
        })

    # ---------------- /job（异步任务查询）----------------
    @app.get("/job")
    async def query_job(job_id: str = Query(...)):
        job = state.jobs.get(job_id)
        if job is None:
            raise HTTPException(404, f"任务不存在（可能已过期或服务重启丢失）: {job_id}")
        return job.to_dict()

    # ---------------- /rescan（增量重扫，scan-invalidation）----------------
    @app.post("/rescan")
    async def rescan(path: str = Query(...)):
        """对指定路径增量重扫：子树重建替换，范围外数据不变。"""
        latest = state.latest_completed_session()
        if latest is None or latest.scan_root is None:
            raise HTTPException(404, "尚无已完成的扫描会话")
        if not os.path.exists(path):
            raise HTTPException(404, f"路径不存在: {path}")

        # 定位扫描树内节点（与 /subtree 共用后缀对齐策略）
        root_node = latest.scan_root
        target_node = _find_node_in_tree(root_node, path)
        if target_node is None:
            raise HTTPException(404, f"路径不在已扫描范围内: {path}")

        def _do_rescan() -> dict:
            """重扫 path 并把新子树替换进会话树（持会话锁）。"""
            result = scanner.scan(
                path,
                cfg=state.cfg.scan,
                ignore_globs=state.prefs.ignore_patterns,
            )
            new_node = result.root
            with latest.lock:
                # 用新子树内容替换目标节点（保留树内位置）
                target_node.children = new_node.children
                target_node.size = new_node.size
                target_node.mtime = new_node.mtime
                target_node.stale = False
                target_node.stale_since = 0.0
                # 自底向上重算全树体积
                from .models import finalize_tree
                files, dirs, total = finalize_tree(root_node)
                latest.fingerprint["summary"]["files"] = files
                latest.fingerprint["summary"]["dirs"] = dirs
                latest.fingerprint["summary"]["total_scanned_mb"] = round(total / (1024 * 1024), 1)
            return {"status": "completed", "path": path,
                    "files": files, "dirs": dirs, "total_bytes": total}

        return await asyncio.to_thread(_do_rescan)

    # ---------------- /recycle_bin_status（只读，recycle-bin-control）----------------
    @app.get("/recycle_bin_status")
    async def get_recycle_bin_status():
        """回收站当前占用（条目数、总字节，按盘分解）。"""
        try:
            return await asyncio.to_thread(recycle_bin_status)
        except FileOperatorError as e:
            raise HTTPException(400, str(e)) from e

    # ---------------- /recycle_bin/empty（受控清空，仅指定 op_uuid）----------------
    @app.post("/recycle_bin/empty")
    async def empty_recycle_bin(req: RecycleBinEmptyRequest):
        """仅清空指定 op_uuid 产生的回收站条目；不提供全量清空。"""
        if not req.op_uuid:
            raise HTTPException(400, "必须指定 op_uuid（不提供全量清空）")
        try:
            result = await asyncio.to_thread(empty_recycle_bin_for_op, req.op_uuid, state.undo)
        except FileOperatorError as e:
            raise HTTPException(400, str(e)) from e
        if result.get("status") == "error":
            raise HTTPException(404, result["error"])
        # 审计：受控清空本身也落日志（RECYCLE_EMPTY 类型，无源路径副作用）
        state.undo.log_batch(
            f"recycle-empty-{req.op_uuid}",
            "RECYCLE_EMPTY",
            [{
                "source_path": f"recycle-bin:{req.op_uuid}",
                "dest_path": None,
                "file_size": result.get("freed_bytes", 0),
                "file_mtime": None,
            }],
            session_id=None,
        )
        for i in state.undo.list_ops(1):
            if i["op_uuid"] == f"recycle-empty-{req.op_uuid}" and i["status"] == "ACTIVE":
                state.undo.update_entry(i["id"], status="DONE")
                break
        result["warning"] = "已永久删除的条目不可再撤销"
        return result

    # ---------------- /history ----------------
    @app.get("/history")
    async def history(limit: int = Query(10, ge=1, le=200)):
        return state.undo.list_ops(limit)

    # ---------------- /undo ----------------
    @app.post("/undo")
    async def undo(req: UndoRequest):
        return await asyncio.to_thread(execute_undo, req.op_id, state.undo)

    # ---------------- /protect & /tag ----------------
    @app.post("/protect")
    async def protect(req: ProtectRequest):
        if req.add:
            return state.prefs.add_protection(req.path)
        return state.prefs.remove_protection(req.path)

    @app.post("/tag")
    async def tag(req: TagRequest):
        return state.prefs.set_tag(req.path, req.tag)

    # ---------------- /shutdown ----------------
    @app.get("/shutdown")
    async def shutdown():
        state.shutdown_event.set()
        asyncio.get_running_loop().call_later(0.3, state.exit_hook)
        return {"status": "shutting_down"}

    async def _idle_watchdog() -> None:
        """空闲自毁：扫描进行中永不触发。"""
        timeout = state.cfg.idle.shutdown_timeout_sec
        while not state.shutdown_event.is_set():
            await asyncio.sleep(min(10, max(1, timeout / 10)))
            if state.shutdown_event.is_set():
                break
            if not state.scanning() and state.idle_seconds() >= timeout:
                logger.info("空闲 %.0fs，进程自毁", state.idle_seconds())
                state.shutdown_event.set()
                state.exit_hook()
                return

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        ensure_data_dirs()
        tasks = [
            asyncio.create_task(_idle_watchdog()),
        ]
        yield
        for t in tasks:
            t.cancel()

    app.router.lifespan_context = lifespan
    return app


# ---------------------------------------------------------------------------
# 直跑入口：python disk_sense/server.py 或 python -m disk_sense.server
# ---------------------------------------------------------------------------
def _acquire_singleton_lock() -> Optional[Any]:
    """启动即持有单例锁；获取失败说明已有实例（退出，由既有实例服务）。

    带重试窗口：launcher 短暂持有同一把锁做启动协调，释放后这里立即接棒。
    """
    from filelock import FileLock, Timeout

    ensure_data_dirs()
    lock = FileLock(str(LOCK_FILE), timeout=1)
    for _ in range(12):  # 最长约 12s（launcher 正常在 0.5s 内释放）
        try:
            lock.acquire(timeout=1)
            return lock
        except Timeout:
            continue
    return None


def main(argv: Optional[list[str]] = None) -> None:
    import argparse

    parser = argparse.ArgumentParser(description="DiskSense 本地服务")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--log-level", default="info")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    # 资源治理：后台进程降低 CPU 优先级
    if sys.platform == "win32":
        try:
            import psutil

            psutil.Process().nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
        except Exception:  # noqa: BLE001 — 优先级调整失败不阻断启动
            pass

    lock = _acquire_singleton_lock()
    if lock is None:
        logger.warning("单例锁被占用：已有 DiskSense 服务实例在运行，本进程退出。")
        sys.exit(1)

    cfg = load_config()
    host = args.host or cfg.server.host
    port = args.port or cfg.server.port

    import uvicorn

    app = create_app()
    logger.info("DiskSense 服务启动: http://%s:%d（空闲 %ds 自毁）", host, port,
                cfg.idle.shutdown_timeout_sec)
    try:
        uvicorn.run(app, host=host, port=port, log_level=args.log_level)
    finally:
        try:
            lock.release()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    # 允许 python disk_sense/server.py 直接执行（包内相对导入需要 path 引导）
    if __package__ in (None, ""):
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    main()
