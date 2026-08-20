"""FastAPI 本地核心服务（方案书 §11 API 契约 / §14 并发模型）。

同时服务两条通道：
- HTTP API（Agent 经 scripts/api_client.py 调用）；
- WebSocket（仪表盘实时进度与 Agent 叠加层指令推送，不可用时前端降级 /poll）。

并发模型（方案书 §14.3）：扫描、文件操作等同步阻塞全部经
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
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
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
    execute_undo,
)
from .models import ScanResult
from .preferences import Preferences
from .report import render_dashboard_html, save_report
from .rules_engine import RulesEngine
from .undo_manager import UndoManager

logger = logging.getLogger(__name__)

_DRIVE_RE = re.compile(r"^[A-Za-z]:[\\/]*$")
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
    error: Optional[str] = None
    report_path: Optional[str] = None
    started_at: float = field(default_factory=time.time)
    finished_at: Optional[float] = None
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)


class WSHub:
    """WebSocket 连接管理与广播 + 叠加层指令环形缓冲（供 /poll 降级）。"""

    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self.overlay_buffer: list[dict] = []
        self._seq = 0

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.clients.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self.clients.discard(ws)

    async def broadcast(self, message: dict) -> None:
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_json(message)
            except Exception:  # noqa: BLE001 — 断连客户端静默剔除
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

    def publish_overlay(self, command: dict) -> int:
        """叠加层指令：广播给在线客户端 + 写入环形缓冲。"""
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
        self.hub = WSHub()
        self.sessions: dict[str, ScanSession] = {}
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

    def scanned_roots(self) -> set[str]:
        """操作范围键集合（方案书 §15）：完整盘符扫描给盘根键，目录扫描给前缀键。"""
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
    """操作范围校验（方案书 §15）。

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


async def _execute_operation(state: "AppState", req: "OperationRequest") -> dict:
    """/operation 与 WS 右键菜单共用的执行路径（线程池执行）。"""
    if req.op_type not in VALID_OP_TYPES:
        raise HTTPException(400, f"无效操作: {req.op_type}（可选 {sorted(VALID_OP_TYPES)}）")
    if not req.sources:
        raise HTTPException(400, "sources 不能为空")

    # 操作范围校验（方案书 §15）：已有扫描记录时，源须位于已扫描范围内
    if state.sessions:
        allowed = state.scanned_roots()
        for src in req.sources:
            if not _source_in_scope(allowed, src):
                raise HTTPException(
                    400, f"源路径未经扫描（先扫描对应盘符或目录）: {src}"
                )

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
            cfg=state.cfg.report,
            rules=state.rules,
            tags_by_prefix=state.prefs.tags_by_prefix,
        )
        fingerprint = aggregator.aggregate(result, session.session_id)

        report_dir = state.data_dir / "reports"
        report_path = save_report(fingerprint, report_dir)

        with session.lock:
            session.fingerprint = fingerprint
            session.aggregator = aggregator
            session.report_path = str(report_path)
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


class UndoRequest(BaseModel):
    op_id: int


class ProtectRequest(BaseModel):
    path: str
    add: bool = True


class TagRequest(BaseModel):
    path: str
    tag: str


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
            payload["report_path"] = s.report_path
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

        # 已有扫描进行中 → 返回该会话（方案书：单扫描任务）
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

        # 同步等待上限（方案书 §11.2），超时返回 scanning 交给客户端轮询
        deadline = time.time() + state.cfg.scan_api.sync_timeout_sec
        while time.time() < deadline:
            if session.status != "scanning":
                break
            await asyncio.sleep(0.2)

        if session.status == "completed":
            await state.hub.broadcast(
                {"type": "scan_complete", **_session_payload(session, with_result=True)}
            )
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
        latest = next(
            (s for s in state.sessions.values() if s.status == "completed"), None
        )
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

    # ---------------- /viz ----------------
    @app.post("/viz")
    async def viz(req: VizRequest):
        if req.action not in VALID_VIZ_ACTIONS:
            raise HTTPException(400, f"无效动作: {req.action}（可选 {sorted(VALID_VIZ_ACTIONS)}）")
        command = {"action": req.action, "target": req.target, "payload": req.payload}
        seq = state.hub.publish_overlay(command)
        await state.hub.broadcast({"type": "overlay", **command})
        return {"status": "ok", "seq": seq}

    # ---------------- /operation ----------------
    @app.post("/operation")
    async def operation(req: OperationRequest):
        return await _execute_operation(state, req)

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

    # ---------------- /poll（WS 降级轮询，方案书 §9.2）----------------
    @app.get("/poll")
    async def poll(since: int = Query(0, ge=0)):
        latest = state.latest_session()
        payload: dict[str, Any] = {"overlays": state.hub.overlays_since(since)}
        if latest:
            payload.update(_session_payload(latest))
        else:
            payload.update({"status": "idle", "progress": 0})
        return payload

    # ---------------- / （仪表盘）----------------
    @app.get("/", response_class=HTMLResponse)
    async def dashboard():
        latest = next(
            (s for s in state.sessions.values() if s.status == "completed"), None
        )
        data = latest.fingerprint if latest else None
        return HTMLResponse(render_dashboard_html(data))

    # ---------------- /ws ----------------
    @app.websocket("/ws")
    async def websocket_endpoint(ws: WebSocket):
        await state.hub.connect(ws)
        state.touch()
        try:
            latest = state.latest_session()
            if latest:
                await ws.send_json(
                    {"type": "snapshot", **_session_payload(latest, with_result=True)}
                )
            while True:
                msg = await ws.receive_json()
                state.touch()
                kind = msg.get("type")
                if kind == "ping":
                    await ws.send_json({"type": "pong"})
                elif kind == "operation":
                    try:
                        req = OperationRequest(
                            op_type=msg.get("op_type", ""),
                            sources=msg.get("sources", []),
                            dest=msg.get("dest"),
                        )
                        result = await _execute_operation(state, req)
                        await ws.send_json({"type": "operation_result", **result})
                    except HTTPException as e:
                        await ws.send_json(
                            {"type": "operation_result", "status": "failed", "error": e.detail}
                        )
                elif kind == "open_in_explorer":
                    await asyncio.to_thread(FileOperator.open_in_explorer, msg.get("path", ""))
                else:
                    await ws.send_json({"type": "error", "error": f"未知消息类型: {kind}"})
        except WebSocketDisconnect:
            state.hub.disconnect(ws)
        except Exception:  # noqa: BLE001 — 单客户端异常不拖垮服务
            state.hub.disconnect(ws)

    # ---------------- /shutdown ----------------
    @app.get("/shutdown")
    async def shutdown():
        state.shutdown_event.set()
        asyncio.get_running_loop().call_later(0.3, state.exit_hook)
        return {"status": "shutting_down"}

    async def _idle_watchdog() -> None:
        """空闲自毁（方案书 §5.3）：扫描进行中永不触发。"""
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

    async def _progress_broadcaster() -> None:
        """扫描期间每秒推送进度到仪表盘。"""
        while not state.shutdown_event.is_set():
            await asyncio.sleep(1.0)
            if state.hub.clients and state.scanning():
                latest = state.latest_session()
                if latest and latest.status == "scanning":
                    await state.hub.broadcast(
                        {"type": "progress", **_session_payload(latest)}
                    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        ensure_data_dirs()
        tasks = [
            asyncio.create_task(_idle_watchdog()),
            asyncio.create_task(_progress_broadcaster()),
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

    # 资源治理（方案书 §14.1）：后台进程降低 CPU 优先级
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
