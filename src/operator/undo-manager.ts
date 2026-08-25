/**
 * SQLite 操作日志与批量原子性。
 *
 * 每次文件操作先落日志（ACTIVE）再执行，随后更新 DONE/FAILED——
 * 先日志后执行保证进程中途崩溃也能追溯。批量操作共享一个 op_uuid，
 * 回滚时整批逐条执行、失败跳过并汇总。
 */

import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import Database from "better-sqlite3";

const SCHEMA = `
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
`;

export interface OpRow {
  id: number;
  op_uuid: string;
  session_id: string | null;
  op_type: string;
  source_path: string;
  dest_path: string | null;
  file_size: number | null;
  file_mtime: number | null;
  recycle_bin_name: string | null;
  recycle_info_name: string | null;
  recycle_path: string | null;
  status: string;
  created_at: string;
  undone_at: string | null;
  error_msg: string | null;
}

export interface LogEntry {
  source_path: string;
  dest_path?: string | null;
  file_size?: number | null;
  file_mtime?: number | null;
}

/** 操作日志持久化与查询。 */
export class UndoManager {
  private db: Database.Database;

  constructor(
    dbPath: string,
    public retentionDays = 30
  ) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** 插入一批操作日志（status=ACTIVE），返回自增 id 列表。 */
  logBatch(
    opUuid: string,
    opType: string,
    entries: LogEntry[],
    sessionId?: string | null
  ): number[] {
    const stmt = this.db.prepare(
      `INSERT INTO operation_log
       (op_uuid, session_id, op_type, source_path, dest_path, file_size, file_mtime)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const ids: number[] = [];
    const tx = this.db.transaction(() => {
      for (const e of entries) {
        const r = stmt.run(
          opUuid, sessionId ?? null, opType,
          e.source_path, e.dest_path ?? null,
          e.file_size ?? null, e.file_mtime ?? null
        );
        ids.push(Number(r.lastInsertRowid));
      }
    });
    tx();
    return ids;
  }

  /** 按列名更新记录（status / recycle_xxx / error_msg / undone_at 等）。 */
  updateEntry(opId: number, fields: Record<string, unknown>): void {
    if (!fields || Object.keys(fields).length === 0) return;
    const cols = Object.keys(fields)
      .map((k) => `${k} = ?`)
      .join(", ");
    this.db.prepare(`UPDATE operation_log SET ${cols} WHERE id = ?`).run(
      ...Object.values(fields), opId
    );
  }

  getEntry(opId: number): OpRow | null {
    return (
      (this.db.prepare("SELECT * FROM operation_log WHERE id = ?").get(opId) as
        | OpRow
        | undefined) ?? null
    );
  }

  getBatch(opUuid: string): OpRow[] {
    return this.db
      .prepare("SELECT * FROM operation_log WHERE op_uuid = ? ORDER BY id")
      .all(opUuid) as OpRow[];
  }

  /** 最近操作（倒序扁平记录，供 Agent 审计）。 */
  listOps(limit = 10): OpRow[] {
    return this.db
      .prepare("SELECT * FROM operation_log ORDER BY id DESC LIMIT ?")
      .all(limit) as OpRow[];
  }

  /** 超期日志转存 .json.gz 并删除。 */
  archiveExpired(archiveDir: string): number {
    // 与 SQLite datetime('now','localtime') 同一坐标系：本地时间
    const d = new Date(Date.now() - this.retentionDays * 86400_000);
    const p = (n: number) => String(n).padStart(2, "0");
    const cutoff = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    const rows = this.db
      .prepare("SELECT * FROM operation_log WHERE created_at < ?")
      .all(cutoff) as OpRow[];
    if (rows.length === 0) return 0;

    fs.mkdirSync(archiveDir, { recursive: true });
    const stamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, "")
      .slice(0, 14);
    const out = path.join(archiveDir, `op_log_${stamp}.json.gz`);
    fs.writeFileSync(out, gzipSync(Buffer.from(JSON.stringify(rows, null, 1), "utf-8")));

    const del = this.db.prepare("DELETE FROM operation_log WHERE id = ?");
    const tx = this.db.transaction(() => {
      for (const r of rows) del.run(r.id);
    });
    tx();
    return rows.length;
  }
}
