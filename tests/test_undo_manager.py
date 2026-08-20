"""undo_manager.py SQLite 日志层测试。"""

import gzip
import json
from datetime import datetime, timedelta

from disk_sense.undo_manager import UndoManager


def test_log_batch_and_list(tmp_path):
    m = UndoManager(tmp_path / "op_log.db")
    ids = m.log_batch(
        "uuid-1",
        "DELETE",
        [
            {"source_path": "C:\\a.txt", "file_size": 10, "file_mtime": 1.0},
            {"source_path": "C:\\b.txt", "dest_path": None, "file_size": 20},
        ],
        session_id="s1",
    )
    assert ids == [1, 2]
    ops = m.list_ops(10)
    assert len(ops) == 2
    assert ops[0]["source_path"] == "C:\\b.txt"  # id 倒序
    assert ops[0]["op_uuid"] == "uuid-1"
    assert ops[0]["status"] == "ACTIVE"


def test_update_entry_fields(tmp_path):
    m = UndoManager(tmp_path / "op_log.db")
    (i,) = m.log_batch("u", "DELETE", [{"source_path": "C:\\x"}])
    m.update_entry(
        i,
        status="DONE",
        recycle_bin_name="$RABC123",
        recycle_info_name="$IABC123",
        recycle_path="C:\\$Recycle.Bin\\S-1-5\\$RABC123",
    )
    row = m.get_entry(i)
    assert row["status"] == "DONE"
    assert row["recycle_bin_name"] == "$RABC123"
    assert row["recycle_path"].endswith("$RABC123")


def test_get_batch(tmp_path):
    m = UndoManager(tmp_path / "op_log.db")
    m.log_batch("u1", "DELETE", [{"source_path": f"C:\\f{i}"} for i in range(3)])
    m.log_batch("u2", "MOVE", [{"source_path": "C:\\g", "dest_path": "D:\\g"}])
    batch = m.get_batch("u1")
    assert len(batch) == 3
    assert {r["op_type"] for r in batch} == {"DELETE"}


def test_missing_entry(tmp_path):
    m = UndoManager(tmp_path / "op_log.db")
    assert m.get_entry(999) is None


def test_archive_expired(tmp_path):
    import sqlite3

    m = UndoManager(tmp_path / "op_log.db", retention_days=30)
    m.log_batch("old", "DELETE", [{"source_path": "C:\\old"}])
    m.log_batch("new", "DELETE", [{"source_path": "C:\\new"}])
    # 把第一条改成 40 天前
    old_time = (datetime.now() - timedelta(days=40)).strftime("%Y-%m-%d %H:%M:%S")
    with m._lock, m._conn:
        m._conn.execute("UPDATE operation_log SET created_at = ? WHERE source_path = ?", (old_time, "C:\\old"))

    archived = m.archive_expired(tmp_path / "archive")
    assert archived == 1
    remaining = [r["source_path"] for r in m.list_ops(10)]
    assert remaining == ["C:\\new"]

    gz_files = list((tmp_path / "archive").glob("*.json.gz"))
    assert len(gz_files) == 1
    with gzip.open(gz_files[0], "rt", encoding="utf-8") as f:
        payload = json.load(f)
    assert payload[0]["source_path"] == "C:\\old"


def test_thread_safety_smoke(tmp_path):
    """多线程写入不应损坏数据库（check_same_thread=False + 锁）。"""
    import threading

    m = UndoManager(tmp_path / "op_log.db")

    def worker(n):
        for i in range(20):
            m.log_batch(f"u{n}-{i}", "COPY", [{"source_path": f"C:\\t{n}_{i}"}])
            m.list_ops(5)

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(m.list_ops(1000)) == 80
