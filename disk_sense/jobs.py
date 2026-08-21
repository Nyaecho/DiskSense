"""异步操作任务管理器（async-jobs 能力）。

长耗时变更操作（如 17.8GB 删除）改为异步：/operation?async_mode=true
立即返回 job_id，操作在后台线程执行，客户端轮询 GET /job?job_id=。

设计（design.md D2）：
- 进程内内存字典 + 环形上限（默认 1000），不引入外部队列；
- 状态机 pending → running → succeeded/failed；
- 进度由操作函数按批次回调更新（已处理字节/条目）；
- 服务重启后内存丢失：未知 job_id 查询返回「任务已中断」类 failed
  （而非 404），避免客户端永久轮询。
"""

from __future__ import annotations

import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Optional


JOB_PENDING = "pending"
JOB_RUNNING = "running"
JOB_SUCCEEDED = "succeeded"
JOB_FAILED = "failed"
JOB_INTERRUPTED = "interrupted"  # 服务重启后无法追溯的运行中任务

_MAX_JOBS = 1000


@dataclass
class Job:
    """单个异步任务的运行时状态。"""

    job_id: str
    op_type: str
    sources: list[str]
    status: str = JOB_PENDING
    progress: float = 0.0
    processed_items: int = 0
    processed_bytes: int = 0
    total_items: int = 0
    error: Optional[str] = None
    result: Optional[dict] = None
    op_uuid: Optional[str] = None  # 操作审计批次 id（结果摘要关联）
    created_at: float = field(default_factory=time.time)
    finished_at: Optional[float] = None
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def to_dict(self) -> dict:
        with self.lock:
            d: dict[str, Any] = {
                "job_id": self.job_id,
                "op_type": self.op_type,
                "status": self.status,
                "progress": round(self.progress, 3),
                "processed_items": self.processed_items,
                "processed_bytes": self.processed_bytes,
                "created_at": self.created_at,
            }
            if self.error:
                d["error"] = self.error
            if self.result is not None:
                d["result"] = self.result
            if self.op_uuid:
                d["op_uuid"] = self.op_uuid
            if self.finished_at:
                d["finished_at"] = self.finished_at
            return d


class JobManager:
    """进程内任务注册表（线程安全，环形上限防内存膨胀）。"""

    def __init__(self, max_jobs: int = _MAX_JOBS):
        self._jobs: dict[str, Job] = {}
        self._order: deque[str] = deque()
        self._max_jobs = max_jobs
        self._lock = threading.Lock()

    def create(self, op_type: str, sources: list[str]) -> Job:
        job = Job(job_id=f"job-{uuid.uuid4().hex[:12]}", op_type=op_type, sources=list(sources))
        with self._lock:
            self._jobs[job.job_id] = job
            self._order.append(job.job_id)
            while len(self._order) > self._max_jobs:
                old = self._order.popleft()
                self._jobs.pop(old, None)
        return job

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def mark_running(self, job: Job) -> None:
        with job.lock:
            if job.status == JOB_PENDING:
                job.status = JOB_RUNNING

    def update_progress(self, job: Job, processed_items: int, processed_bytes: int,
                        total_items: int = 0) -> None:
        with job.lock:
            if job.status != JOB_RUNNING:
                return
            job.processed_items = processed_items
            job.processed_bytes = processed_bytes
            if total_items:
                job.total_items = total_items
                job.progress = min(0.99, processed_items / max(1, total_items))

    def finish(self, job: Job, result: Optional[dict] = None,
               error: Optional[str] = None) -> None:
        with job.lock:
            job.finished_at = time.time()
            if error is not None:
                job.status = JOB_FAILED
                job.error = error
            else:
                job.status = JOB_SUCCEEDED
                job.result = result
                job.progress = 1.0
                if isinstance(result, dict):
                    job.op_uuid = result.get("op_uuid")

    def interrupt_all_running(self) -> int:
        """服务关闭前调用：把运行中任务标记为中断（重启后不可追溯）。"""
        n = 0
        with self._lock:
            jobs = list(self._jobs.values())
        for job in jobs:
            with job.lock:
                if job.status in (JOB_PENDING, JOB_RUNNING):
                    job.status = JOB_INTERRUPTED
                    job.error = "服务重启，任务已中断（操作审计见 /history）"
                    job.finished_at = time.time()
                    n += 1
        return n
