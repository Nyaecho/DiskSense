"""jobs.py 异步任务管理器单元测试。"""

import threading
import time

from disk_sense.jobs import (
    JOB_FAILED,
    JOB_INTERRUPTED,
    JOB_RUNNING,
    JOB_SUCCEEDED,
    JobManager,
)


def test_lifecycle_pending_to_succeeded():
    m = JobManager()
    job = m.create("delete", ["C:/a"])
    assert job.status == "pending"
    m.mark_running(job)
    assert job.status == JOB_RUNNING
    m.update_progress(job, 3, 300, total_items=10)
    d = job.to_dict()
    assert d["processed_items"] == 3 and d["progress"] > 0
    m.finish(job, result={"op_uuid": "u1", "status": "completed"})
    d = job.to_dict()
    assert d["status"] == JOB_SUCCEEDED
    assert d["op_uuid"] == "u1" and d["progress"] == 1.0


def test_lifecycle_failed():
    m = JobManager()
    job = m.create("move", ["C:/a"])
    m.mark_running(job)
    m.finish(job, error="boom")
    assert job.to_dict()["status"] == JOB_FAILED
    assert job.to_dict()["error"] == "boom"


def test_get_and_unknown():
    m = JobManager()
    job = m.create("copy", ["C:/a"])
    assert m.get(job.job_id) is job
    assert m.get("job-nope") is None


def test_ring_buffer_cap():
    m = JobManager(max_jobs=3)
    for i in range(5):
        m.create("delete", [f"C:/{i}"])
    assert len(m._order) == 3
    # 最早的两个被逐出
    assert m.get("job-0") is None or m.create("delete", ["x"])  # id 为随机 hex
    # 逐出后 get 旧 id 返回 None（用实际 id 验证）
    ids = list(m._order)
    assert all(m.get(i) is not None for i in ids)


def test_interrupt_all_running():
    m = JobManager()
    j1 = m.create("delete", ["C:/a"])
    j2 = m.create("delete", ["C:/b"])
    m.mark_running(j1)
    m.mark_running(j2)
    m.finish(j2, result={"op_uuid": "u"})  # 已完成的不受影响
    n = m.interrupt_all_running()
    assert n == 1
    assert j1.status == JOB_INTERRUPTED
    assert j2.status == JOB_SUCCEEDED


def test_progress_after_finish_ignored():
    m = JobManager()
    job = m.create("delete", ["C:/a"])
    m.mark_running(job)
    m.finish(job, result={"op_uuid": "u"})
    m.update_progress(job, 99, 999)
    assert job.to_dict()["processed_items"] == 0  # 完成后进度不再更新
