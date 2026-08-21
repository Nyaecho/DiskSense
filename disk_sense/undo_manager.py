"""SQLite 操作日志与批量原子性。

每次文件操作先落日志（ACTIVE）再执行，随后更新 DONE/FAILED——
先日志后执行保证进程中途崩溃也能追溯。批量操作共享一个 op_uuid，
回滚时整批逐条执行、失败跳过并汇总。

线程模型：FastAPI 的 to_thread 会从不同线程调用，连接以
check_same_thread=False 创建并全程持锁串行化。
"""

from __future__ import annotations

import gzip
import json
import logging
import sqlite3
import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS operation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    op_uuid TEXT NOT NULL,
    session_id TEXT,
    op_type TEXT NOT NULL,
    source_path TEXT NOT NULL,
    dest_path TEXT,
    file_size INTEGER,
    file_mtime REAL,
    recycle_bin_name TEXT,
    recycle_info_name TEXT,
    recycle_path TEXT,
    status TEXT DEFAULT 'ACTIVE',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    undone_at TEXT,
    error_msg TEXT
);
CREATE INDEX IF NOT EXISTS idx_op_created ON operation_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_op_uuid ON operation_log (op_uuid);
"""

# 可回滚状态：执行成功（DONE）或尚未执行（ACTIVE）的记录
_UNDOABLE = ("ACTIVE", "DONE")


class UndoManager:
    """操作日志持久化与查询。"""

    def __init__(self, db_path: Path | str, retention_days: int = 30):
        self.db_path = Path(db_path)
        self.retention_days = retention_days
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock, self._conn:
            self._conn.executescript(_SCHEMA)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ------------------------------------------------------------------
    def log_batch(
        self,
        op_uuid: str,
        op_type: str,
        entries: list[dict[str, Any]],
        session_id: Optional[str] = None,
    ) -> list[int]:
        """插入一批操作日志（status=ACTIVE），返回自增 id 列表。"""
        ids: list[int] = []
        with self._lock, self._conn:
            for e in entries:
                cur = self._conn.execute(
                    """INSERT INTO operation_log
                       (op_uuid, session_id, op_type, source_path, dest_path, file_size, file_mtime)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (
                        op_uuid,
                        session_id,
                        op_type,
                        e["source_path"],
                        e.get("dest_path"),
                        e.get("file_size"),
                        e.get("file_mtime"),
                    ),
                )
                ids.append(cur.lastrowid)
        return ids

    def update_entry(self, op_id: int, **fields: Any) -> None:
        """按列名更新记录（status/recycle_*/error_msg/undone_at...）。"""
        if not fields:
            return
        cols = ", ".join(f"{k} = ?" for k in fields)
        with self._lock, self._conn:
            self._conn.execute(
                f"UPDATE operation_log SET {cols} WHERE id = ?", (*fields.values(), op_id)
            )

    # ------------------------------------------------------------------
    def get_entry(self, op_id: int) -> Optional[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(
                "SELECT * FROM operation_log WHERE id = ?", (op_id,)
            ).fetchone()

    def get_batch(self, op_uuid: str) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(
                "SELECT * FROM operation_log WHERE op_uuid = ? ORDER BY id", (op_uuid,)
            ).fetchall()

    def list_ops(self, limit: int = 10) -> list[dict]:
        """最近操作（倒序扁平记录，供 Agent 审计）。"""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM operation_log ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]

    # ------------------------------------------------------------------
    def archive_expired(self, archive_dir: Path) -> int:
        """超期日志转存 JSON.gz 并删除（服务空闲时调用）。"""
        cutoff = (datetime.now() - timedelta(days=self.retention_days)).strftime(
            "%Y-%m-%d %H:%M:%S"
        )
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM operation_log WHERE created_at < ?", (cutoff,)
            ).fetchall()
            if not rows:
                return 0
            archive_dir.mkdir(parents=True, exist_ok=True)
            out = archive_dir / f"op_log_{datetime.now():%Y%m%d_%H%M%S}.json.gz"
            payload = [dict(r) for r in rows]
            with gzip.open(out, "wt", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=1)
            ids = [r["id"] for r in rows]
            self._conn.executemany(
                f"DELETE FROM operation_log WHERE id = ?", [(i,) for i in ids]
            )
            self._conn.commit()
        logger.info("归档 %d 条超期操作日志 → %s", len(ids), out)
        return len(ids)
