/**
 * 扫描会话持久化（无 daemon 架构的核心状态层，SQLite 版）。
 *
 * 会话 = 一次扫描的完整快照 + 新鲜度账本：
 * - 会话级：op_count / recent_ops —— 快照之后执行了几次操作（Agent 判断
 *   「这份分析结论整体还可信吗」）；
 * - 节点级：stale / stale_since —— 受影响子树的过期标记；
 * - 执行时：预检（存在性/mtime 比对，见 file-operator）——硬防线。
 *
 * 存储布局（混合行式 + 压缩归档，兼顾更新效率与体积）：
 * - live 会话：nodes 表逐节点行（rel_low 主键 —— recordOperation 前缀标
 *   stale、rescan 子树替换都是随机更新，需要行式存储）；
 * - 归档会话：节点行打包为按 rel_low 排序的 NDJSON → gzip blob 存
 *   sessions.archive_blob（约 25MB/百万节点，裁剪=删一行，diff 流式解压）；
 * - 显示路径不落库：父路径必为子路径前缀 ⇒ rel_low 有序遍历父先于子，
 *   树重建与显示路径均可单趟推导。
 *
 * 快照版本化：同根路径新扫描时，旧 live 会话在事务内转档（行→blob，
 * 零数据丢失），每根路径保留最近 sessions.archiveKeep 份归档（默认 5），
 * 供 diff_sessions 对比；export_session 可导出任意会话为 .json.gz。
 *
 * 目录（%DISK_SENSE_HOME%）：
 * - sessions.db：sessions + nodes 表
 * - sessions/：旧版单文件 JSON，首次运行自动导入后改名 *.migrated 留底
 *
 * 并发：better-sqlite3 同步 API + WAL；写操作走 BEGIN IMMEDIATE 事务，
 * 多 CLI 进程交叉执行由 SQLite 串行化（替代旧版 proper-lockfile）。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import {
  loadConfig,
  normalizeTarget,
  sessionsDbFile,
  sessionsDir,
  exportDir,
} from "../config.js";
import type { ScanResult, TreeNode } from "../types.js";

export interface RecentOp {
  seq: number;
  op_type: string;
  sources: string[];
  op_uuid?: string;
  at: number;
}

/** 会话元数据（不含树；list_sessions / recordOperation 返回）。 */
export interface SessionMetaRow {
  session_id: string;
  root_path: string;
  mode: "mft" | "walk";
  scanned_at: number;
  /** 本次快照之后已执行的变更操作数（单调递增；rescan 归零） */
  op_count: number;
  /** 最近操作摘要环（最多 50 条） */
  recent_ops: RecentOp[];
  files: number;
  dirs: number;
  total_bytes: number;
  skipped_paths: string[];
  orphans: number;
  elapsed_sec: number;
  archived: boolean;
  archived_at: number | null;
}

export interface StoredSession extends SessionMetaRow {
  /** 目录树（序列化格式见 TreeNodeJSON） */
  tree: TreeNodeJSON;
  /** 指纹档案 JSON（start_scan 返回的 result，含 entities/treemap/summary 等） */
  fingerprint?: Record<string, unknown>;
  /** 实体明细：entity_id → role → Top5 文件（query_detail 用，不进指纹） */
  entity_detail?: Record<string, Record<string, unknown[]>>;
}

// ---------------------------------------------------------------------------
// 树序列化（Map children → plain object）
// ---------------------------------------------------------------------------
export interface TreeNodeJSON {
  name: string;
  size: number;
  mtime: number;
  atime: number;
  /** 创建时间（秒）；旧版会话/迁移数据可能缺失 */
  ctime?: number;
  isDir: boolean;
  isLink: boolean;
  cacheType: string | null;
  stale?: boolean;
  staleSince?: number;
  children?: Record<string, TreeNodeJSON>;
}

export function treeToJSON(node: TreeNode): TreeNodeJSON {
  const out: TreeNodeJSON = {
    name: node.name,
    size: node.size,
    mtime: node.mtime,
    atime: node.atime,
    isDir: node.isDir,
    isLink: node.isLink,
    cacheType: node.cacheType ?? null,
  };
  if (node.ctime) out.ctime = node.ctime;
  if (node.stale) out.stale = true;
  if (node.staleSince) out.staleSince = node.staleSince;
  if (node.children && node.children.size > 0) {
    const kids: Record<string, TreeNodeJSON> = {};
    for (const [k, c] of node.children) kids[k] = treeToJSON(c);
    out.children = kids;
  }
  return out;
}

export function treeFromJSON(json: TreeNodeJSON): TreeNode {
  const node: TreeNode = {
    name: json.name,
    size: json.size,
    mtime: json.mtime,
    atime: json.atime,
    isDir: json.isDir,
    isLink: json.isLink,
    cacheType: json.cacheType ?? null,
  };
  if (json.ctime) node.ctime = json.ctime;
  if (json.stale) node.stale = true;
  if (json.staleSince) node.staleSince = json.staleSince;
  if (json.children) {
    node.children = new Map();
    for (const [k, v] of Object.entries(json.children)) {
      node.children.set(k, treeFromJSON(v));
    }
  }
  return node;
}

// ---------------------------------------------------------------------------
// SQLite 会话库
// ---------------------------------------------------------------------------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    root_path TEXT NOT NULL,
    root_hash TEXT NOT NULL,
    mode TEXT NOT NULL,
    scanned_at REAL NOT NULL,
    op_count INTEGER NOT NULL DEFAULT 0,
    recent_ops TEXT NOT NULL DEFAULT '[]',
    files INTEGER NOT NULL DEFAULT 0,
    dirs INTEGER NOT NULL DEFAULT 0,
    total_bytes INTEGER NOT NULL DEFAULT 0,
    skipped_paths TEXT NOT NULL DEFAULT '[]',
    orphans INTEGER NOT NULL DEFAULT 0,
    elapsed_sec REAL NOT NULL DEFAULT 0,
    fingerprint TEXT,
    entity_detail TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    archived_at REAL,
    archive_blob BLOB
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_live_root
    ON sessions (root_hash) WHERE archived = 0;
CREATE INDEX IF NOT EXISTS idx_sessions_root
    ON sessions (root_hash, archived, scanned_at);
CREATE TABLE IF NOT EXISTS nodes (
    session_id TEXT NOT NULL,
    rel_low TEXT NOT NULL,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime REAL NOT NULL DEFAULT 0,
    atime REAL NOT NULL DEFAULT 0,
    ctime REAL,
    is_dir INTEGER NOT NULL DEFAULT 0,
    is_link INTEGER NOT NULL DEFAULT 0,
    cache_type TEXT,
    stale INTEGER NOT NULL DEFAULT 0,
    stale_since REAL,
    PRIMARY KEY (session_id, rel_low)
) WITHOUT ROWID;
`;

/** 归档 blob 的 NDJSON 行（定长数组，紧凑键位）。 */
type ArchiveLine = [
  rel_low: string,
  name: string,
  size: number,
  mtime: number,
  atime: number,
  ctime: number | null,
  is_dir: 0 | 1,
  is_link: 0 | 1,
  cache_type: string | null,
  stale: 0 | 1,
  stale_since: number | null,
];

interface NodeRow {
  rel_low: string;
  name: string;
  size: number;
  mtime: number;
  atime: number;
  ctime: number | null;
  is_dir: number;
  is_link: number;
  cache_type: string | null;
  stale: number;
  stale_since: number | null;
}

const NODE_COLS =
  "rel_low, name, size, mtime, atime, ctime, is_dir, is_link, cache_type, stale, stale_since";

/** 扫描根路径 → 12 位十六进制哈希（归档分组/迁移映射键）。 */
export function rootHashOf(rootPath: string): string {
  // 先归一化裸盘符再 resolve：path.resolve("D:") 会锚到 D 盘当前工作目录
  const key = path.resolve(normalizeTarget(rootPath)).toLowerCase();
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 12);
}

/** LIKE 模式转义（\ % _），配合 ESCAPE '\' 使用。 */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** 源路径是否落在会话根之下（大小写不敏感，目录边界安全）。 */
function isUnderRoot(srcLow: string, rootLow: string): boolean {
  if (rootLow.endsWith("\\")) return srcLow.startsWith(rootLow);
  return srcLow === rootLow || srcLow.startsWith(rootLow + "\\");
}

/** 源路径相对根的小写相对路径（不在根下返回 null）。 */
function relLowUnderRoot(srcLow: string, rootLow: string): string | null {
  if (!isUnderRoot(srcLow, rootLow)) return null;
  if (rootLow.endsWith("\\")) return srcLow.slice(rootLow.length);
  return srcLow === rootLow ? "" : srcLow.slice(rootLow.length + 1);
}

/** 相对路径的全部前缀（含自身与根 ""），自浅到深。 */
function pathPrefixes(relLow: string): string[] {
  if (!relLow) return [""];
  const out = [""];
  let acc = "";
  for (const seg of relLow.split("\\")) {
    acc = acc ? `${acc}\\${seg}` : seg;
    out.push(acc);
  }
  return out;
}

function parentLowOf(relLow: string): string {
  const i = relLow.lastIndexOf("\\");
  return i === -1 ? "" : relLow.slice(0, i);
}

/**
 * 树 → 节点行（只留 rel_low/name，显示路径由前缀关系推导）。
 * 迭代遍历，深路径安全。
 */
function flattenTreeToRows(root: TreeNodeJSON): NodeRow[] {
  const rows: NodeRow[] = [];
  const stack: Array<{ node: TreeNodeJSON; relLow: string }> = [
    { node: root, relLow: "" },
  ];
  while (stack.length > 0) {
    const { node, relLow } = stack.pop()!;
    rows.push({
      rel_low: relLow,
      name: node.name,
      size: node.size,
      mtime: node.mtime,
      atime: node.atime,
      ctime: node.ctime ?? null,
      is_dir: node.isDir ? 1 : 0,
      is_link: node.isLink ? 1 : 0,
      cache_type: node.cacheType ?? null,
      stale: node.stale ? 1 : 0,
      stale_since: node.staleSince ?? null,
    });
    for (const [k, c] of Object.entries(node.children ?? {})) {
      stack.push({ node: c, relLow: relLow ? `${relLow}\\${k.toLowerCase()}` : k.toLowerCase() });
    }
  }
  return rows;
}

/**
 * 节点行（rel_low 有序）→ 树。父路径必为子路径前缀，有序遍历父先于子，
 * 单趟挂接即可；父行缺失（数据损坏）时防御性挂回根。
 */
function rowsToTree(rows: NodeRow[], rootName = ""): TreeNodeJSON {
  const byLow = new Map<string, TreeNodeJSON>();
  let root: TreeNodeJSON | null = null;
  for (const r of rows) {
    const node: TreeNodeJSON = {
      name: r.name,
      size: r.size,
      mtime: r.mtime,
      atime: r.atime,
      isDir: r.is_dir === 1,
      isLink: r.is_link === 1,
      cacheType: r.cache_type ?? null,
    };
    if (r.ctime !== null && r.ctime !== undefined) node.ctime = r.ctime;
    if (r.stale === 1) node.stale = true;
    if (r.stale_since !== null && r.stale_since !== undefined) {
      node.staleSince = r.stale_since;
    }
    if (r.is_dir === 1 && r.is_link === 0) node.children = {};
    byLow.set(r.rel_low, node);
    if (r.rel_low === "") {
      root = node;
      continue;
    }
    const parent = byLow.get(parentLowOf(r.rel_low));
    if (parent?.children) {
      parent.children[r.name] = node;
    } else if (root?.children) {
      root.children[r.name] = node; // 防御：父行缺失挂回根
    }
  }
  if (!root) throw new Error("会话节点表缺少根行");
  if (rootName) root.name = rootName;
  return root;
}

interface SessionDBRow {
  session_id: string;
  root_path: string;
  root_hash: string;
  mode: string;
  scanned_at: number;
  op_count: number;
  recent_ops: string;
  files: number;
  dirs: number;
  total_bytes: number;
  skipped_paths: string;
  orphans: number;
  elapsed_sec: number;
  fingerprint: string | null;
  entity_detail: string | null;
  archived: number;
  archived_at: number | null;
  archive_blob: Buffer | null;
}

function rowToMeta(row: SessionDBRow): SessionMetaRow {
  return {
    session_id: row.session_id,
    root_path: row.root_path,
    mode: row.mode === "mft" ? "mft" : "walk",
    scanned_at: row.scanned_at,
    op_count: row.op_count,
    recent_ops: safeParseArray<RecentOp>(row.recent_ops),
    files: row.files,
    dirs: row.dirs,
    total_bytes: row.total_bytes,
    skipped_paths: safeParseArray<string>(row.skipped_paths),
    orphans: row.orphans,
    elapsed_sec: row.elapsed_sec,
    archived: row.archived === 1,
    archived_at: row.archived_at,
  };
}

function safeParseArray<T>(text: string): T[] {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

/** diff/growth 用的文件行（只读流式迭代）。 */
export interface FileNodeRow {
  rel_low: string;
  name: string;
  size: number;
  mtime: number;
  ctime: number | null;
}

class SessionStore {
  private db: Database.Database;
  private readonly archiveKeep: number;

  private stmtInsertNode: Database.Statement;
  private stmtMetaById: Database.Statement;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    const fresh =
      (
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('sessions','nodes')"
          )
          .get() as { n: number }
      ).n === 0;
    // 注意：auto_vacuum 必须在 journal_mode=WAL 之前设置，否则被静默忽略
    if (fresh) this.db.pragma("auto_vacuum = INCREMENTAL");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 15000");
    this.db.exec(SCHEMA);
    this.upgradeSchema();
    this.archiveKeep = loadConfig().sessions.archiveKeep;

    this.stmtInsertNode = this.db.prepare(`
      INSERT INTO nodes (session_id, rel_low, name, size, mtime, atime, ctime,
                         is_dir, is_link, cache_type, stale, stale_since)
      VALUES (@session_id, @rel_low, @name, @size, @mtime, @atime, @ctime,
              @is_dir, @is_link, @cache_type, @stale, @stale_since)
    `);
    this.stmtMetaById = this.db.prepare(
      "SELECT session_id, root_path, root_hash, mode, scanned_at, op_count, recent_ops, files, dirs, total_bytes, skipped_paths, orphans, elapsed_sec, fingerprint, entity_detail, archived, archived_at FROM sessions WHERE session_id = ?"
    );

    this.migrateLegacyJsonSessions();
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* 已关闭 */
    }
  }

  /** 历史结构升级（v1 行宽版本：nodes 含 rel/parent_low 冗余列、sessions 缺 blob 列）。 */
  private upgradeSchema(): void {
    const sessCols = (
      this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    if (!sessCols.includes("archive_blob")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN archive_blob BLOB");
    }
    const cols = (
      this.db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    if (cols.includes("rel")) {
      this.db.exec("ALTER TABLE nodes RENAME TO nodes_v1");
      this.db.exec(
        `CREATE TABLE nodes (
            session_id TEXT NOT NULL,
            rel_low TEXT NOT NULL,
            name TEXT NOT NULL,
            size INTEGER NOT NULL,
            mtime REAL NOT NULL DEFAULT 0,
            atime REAL NOT NULL DEFAULT 0,
            ctime REAL,
            is_dir INTEGER NOT NULL DEFAULT 0,
            is_link INTEGER NOT NULL DEFAULT 0,
            cache_type TEXT,
            stale INTEGER NOT NULL DEFAULT 0,
            stale_since REAL,
            PRIMARY KEY (session_id, rel_low)
        ) WITHOUT ROWID`
      );
      this.db.exec(
        `INSERT INTO nodes (session_id, ${NODE_COLS})
         SELECT session_id, ${NODE_COLS} FROM nodes_v1`
      );
      this.db.exec("DROP TABLE nodes_v1");
      // 表重建后旧页全部进 freelist：借 VACUUM 一次性回收，
      // 同时把 auto_vacuum 升到 INCREMENTAL（VACUUM 按 pragma 当前值重建）
      this.db.pragma("auto_vacuum = INCREMENTAL");
      this.db.exec("VACUUM");
    }
  }

  // ----- 元数据查询 -----

  metaById(sessionId: string): SessionMetaRow | null {
    const row = this.stmtMetaById.get(sessionId) as SessionDBRow | undefined;
    return row ? rowToMeta(row) : null;
  }

  liveMetaByRoot(rootPath: string): SessionMetaRow | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE root_hash = ? AND archived = 0")
      .get(rootHashOf(rootPath)) as SessionDBRow | undefined;
    return row ? rowToMeta(row) : null;
  }

  latestLiveMeta(): SessionMetaRow | null {
    const row = this.db
      .prepare(
        "SELECT * FROM sessions WHERE archived = 0 ORDER BY scanned_at DESC LIMIT 1"
      )
      .get() as SessionDBRow | undefined;
    return row ? rowToMeta(row) : null;
  }

  liveMetas(): SessionMetaRow[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE archived = 0")
      .all() as SessionDBRow[];
    return rows.map(rowToMeta);
  }

  listMetas(rootPath?: string, includeArchived = false): SessionMetaRow[] {
    let rows = this.db
      .prepare(`SELECT * FROM sessions ${includeArchived ? "" : "WHERE archived = 0"}`)
      .all() as SessionDBRow[];
    if (rootPath) {
      const rootLow = path
        .resolve(normalizeTarget(rootPath))
        .toLowerCase()
        .replace(/[\\/]+$/, "");
      rows = rows.filter((r) => {
        const p = r.root_path.toLowerCase().replace(/[\\/]+$/, "");
        return p === rootLow || p.startsWith(rootLow + "\\");
      });
    }
    return rows
      .map(rowToMeta)
      .sort((a, b) => {
        if (a.root_path !== b.root_path) {
          return a.root_path < b.root_path ? -1 : 1;
        }
        if (a.archived !== b.archived) return a.archived ? 1 : -1; // live 优先
        return b.scanned_at - a.scanned_at;
      });
  }

  // ----- 树加载 -----

  private liveNodeRows(sessionId: string): NodeRow[] {
    return this.db
      .prepare(`SELECT ${NODE_COLS} FROM nodes WHERE session_id = ? ORDER BY rel_low`)
      .all(sessionId) as NodeRow[];
  }

  /** 归档 blob 行迭代（按 rel_low 有序，惰性逐行解析）。 */
  private archiveLines(sessionId: string): NodeRow[] {
    const row = this.db
      .prepare("SELECT archive_blob FROM sessions WHERE session_id = ?")
      .get(sessionId) as { archive_blob: Buffer | null } | undefined;
    if (!row?.archive_blob) throw new Error(`归档会话缺少数据 blob: ${sessionId}`);
    const text = gunzipSync(row.archive_blob).toString("utf-8");
    const out: NodeRow[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const a = JSON.parse(line) as ArchiveLine;
      out.push({
        rel_low: a[0],
        name: a[1],
        size: a[2],
        mtime: a[3],
        atime: a[4],
        ctime: a[5],
        is_dir: a[6],
        is_link: a[7],
        cache_type: a[8],
        stale: a[9],
        stale_since: a[10],
      });
    }
    return out;
  }

  private nodeRows(meta: SessionMetaRow): NodeRow[] {
    return meta.archived
      ? this.archiveLines(meta.session_id)
      : this.liveNodeRows(meta.session_id);
  }

  fullSession(meta: SessionMetaRow): StoredSession {
    const row = this.db
      .prepare(
        "SELECT fingerprint, entity_detail FROM sessions WHERE session_id = ?"
      )
      .get(meta.session_id) as
      | { fingerprint: string | null; entity_detail: string | null }
      | undefined;
    const tree = rowsToTree(this.nodeRows(meta));
    const out: StoredSession = { ...meta, tree };
    if (row?.fingerprint) {
      out.fingerprint = JSON.parse(row.fingerprint) as Record<string, unknown>;
    }
    if (row?.entity_detail) {
      out.entity_detail = JSON.parse(
        row.entity_detail
      ) as Record<string, Record<string, unknown[]>>;
    }
    return out;
  }

  // ----- diff/growth 只读迭代（按 rel_low 有序，归并联接友好） -----

  private *fileRows(sessionId: string): Generator<FileNodeRow> {
    const meta = this.metaById(sessionId);
    if (!meta) throw new Error(`会话不存在: ${sessionId}`);
    if (!meta.archived) {
      const it = this.db
        .prepare(
          `SELECT rel_low, name, size, mtime, ctime FROM nodes
           WHERE session_id = ? AND is_dir = 0 ORDER BY rel_low`
        )
        .iterate(sessionId) as IterableIterator<FileNodeRow>;
      yield* it;
      return;
    }
    for (const r of this.archiveLines(sessionId)) {
      if (r.is_dir === 0) {
        yield { rel_low: r.rel_low, name: r.name, size: r.size, mtime: r.mtime, ctime: r.ctime };
      }
    }
  }

  private *dirRows(sessionId: string): Generator<{ rel_low: string; name: string }> {
    const meta = this.metaById(sessionId);
    if (!meta) throw new Error(`会话不存在: ${sessionId}`);
    if (!meta.archived) {
      yield* this.db
        .prepare(
          `SELECT rel_low, name FROM nodes
           WHERE session_id = ? AND is_dir = 1 ORDER BY rel_low`
        )
        .iterate(sessionId) as IterableIterator<{ rel_low: string; name: string }>;
      return;
    }
    for (const r of this.archiveLines(sessionId)) {
      if (r.is_dir === 1) yield { rel_low: r.rel_low, name: r.name };
    }
  }

  iterateFileNodes(sessionId: string): IterableIterator<FileNodeRow> {
    return this.fileRows(sessionId);
  }

  iterateDirNodes(sessionId: string): IterableIterator<{ rel_low: string; name: string }> {
    return this.dirRows(sessionId);
  }

  hasCtimeData(sessionId: string): boolean {
    const meta = this.metaById(sessionId);
    if (!meta) return false;
    if (!meta.archived) {
      const row = this.db
        .prepare(
          "SELECT EXISTS(SELECT 1 FROM nodes WHERE session_id = ? AND ctime IS NOT NULL) AS hit"
        )
        .get(sessionId) as { hit: number };
      return row.hit === 1;
    }
    return this.archiveLines(sessionId).some((r) => r.ctime !== null);
  }

  /** 时间窗过滤的文件迭代（growth_report 用；列名白名单内联）。 */
  iterateFileNodesByTime(
    sessionId: string,
    col: "mtime" | "ctime",
    since: number,
    until?: number
  ): IterableIterator<FileNodeRow> {
    const self = this;
    // live 会话：谓词下推 SQL（全表扫描在 SQLite C 层完成，只回传命中行）
    const meta = this.metaById(sessionId);
    if (meta && !meta.archived) {
      const colExpr = col === "ctime" ? "ctime" : "mtime";
      const sql = `SELECT rel_low, name, size, mtime, ctime FROM nodes
                   WHERE session_id = ? AND is_dir = 0
                     AND ${colExpr} >= ? ${
                      until !== undefined ? `AND ${colExpr} < ?` : ""
                    }`;
      const params: unknown[] =
        until !== undefined ? [sessionId, since, until] : [sessionId, since];
      return this.db.prepare(sql).iterate(...params) as IterableIterator<FileNodeRow>;
    }
    return (function* (): Generator<FileNodeRow> {
      for (const r of self.fileRows(sessionId)) {
        const t = col === "ctime" ? r.ctime : r.mtime;
        if (t === null || t < since) continue;
        if (until !== undefined && t >= until) continue;
        yield r;
      }
    })();
  }

  // ----- 保存（旧 live 转档 → 插入 → 裁剪） -----

  save(
    result: ScanResult,
    rootPath: string,
    sessionId: string,
    extra: {
      fingerprint?: Record<string, unknown>;
      entityDetail?: Record<string, Record<string, unknown[]>>;
    }
  ): {
    session: StoredSession;
    archived: { session_id: string; archived_at: number } | null;
  } {
    const rootResolved = path.resolve(normalizeTarget(rootPath));
    const rootHash = rootHashOf(rootPath);
    const tree = treeToJSON(result.root);
    const rows = flattenTreeToRows(tree);
    const insertMeta = this.db.prepare(`
      INSERT INTO sessions (session_id, root_path, root_hash, mode, scanned_at,
                            op_count, recent_ops, files, dirs, total_bytes,
                            skipped_paths, orphans, elapsed_sec,
                            fingerprint, entity_detail, archived, archived_at)
      VALUES (?, ?, ?, ?, ?, 0, '[]', ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
    `);

    const tx = this.db.transaction(() => {
      const old = this.db
        .prepare("SELECT session_id FROM sessions WHERE root_hash = ? AND archived = 0")
        .get(rootHash) as { session_id: string } | undefined;
      let archived: { session_id: string; archived_at: number } | null = null;
      if (old) {
        archived = this.archiveLiveWithinTx(old.session_id);
      }
      insertMeta.run(
        sessionId,
        rootResolved,
        rootHash,
        result.mode,
        Date.now() / 1000,
        result.files,
        result.dirs,
        result.totalBytes,
        JSON.stringify(result.skippedPaths),
        result.orphans,
        result.elapsedSec,
        extra.fingerprint ? JSON.stringify(extra.fingerprint) : null,
        extra.entityDetail ? JSON.stringify(extra.entityDetail) : null
      );
      const sess = { session_id: sessionId };
      for (const r of rows) this.stmtInsertNode.run({ ...sess, ...r });
      this.pruneArchived(rootHash);
      return archived;
    });

    const archived = tx() as {
      session_id: string;
      archived_at: number;
    } | null;
    const meta = this.metaById(sessionId)!;
    const session: StoredSession = {
      ...meta,
      tree,
      ...(extra.fingerprint ? { fingerprint: extra.fingerprint } : {}),
      ...(extra.entityDetail ? { entity_detail: extra.entityDetail } : {}),
    };
    return { session, archived };
  }

  /**
   * live 会话转档：节点行 → NDJSON（rel_low 有序）→ gzip blob，
   * 随后删除节点行。须在写事务内调用。
   */
  private archiveLiveWithinTx(
    sessionId: string,
    archivedAt = Date.now() / 1000
  ): { session_id: string; archived_at: number } {
    const rows = this.liveNodeRows(sessionId);
    const lines = rows.map(
      (r) =>
        JSON.stringify([
          r.rel_low, r.name, r.size, r.mtime, r.atime, r.ctime,
          r.is_dir, r.is_link, r.cache_type, r.stale, r.stale_since,
        ] as ArchiveLine)
    );
    const blob = gzipSync(Buffer.from(`${lines.join("\n")}\n`, "utf-8"), { level: 6 });
    this.db
      .prepare(
        "UPDATE sessions SET archived = 1, archived_at = ?, archive_blob = ? WHERE session_id = ?"
      )
      .run(archivedAt, blob, sessionId);
    this.db.prepare("DELETE FROM nodes WHERE session_id = ?").run(sessionId);
    return { session_id: sessionId, archived_at: archivedAt };
  }

  /** 每根路径只保留最近 archiveKeep 份归档（blob 单行，删除即回收）。 */
  private pruneArchived(rootHash: string): void {
    // rowid 决胜：同毫秒多次扫描时保持「后插入者更新」的确定性
    this.db
      .prepare(
        `DELETE FROM sessions WHERE root_hash = ? AND archived = 1 AND session_id IN (
           SELECT session_id FROM sessions
           WHERE root_hash = ? AND archived = 1
           ORDER BY archived_at DESC, scanned_at DESC, rowid DESC LIMIT -1 OFFSET ?
         )`
      )
      .run(rootHash, rootHash, this.archiveKeep);
    this.db.pragma("incremental_vacuum(64)");
  }

  // ----- 新鲜度账本 -----

  applyOperation(
    sessionId: string,
    opType: string,
    sources: readonly string[],
    opUuid?: string
  ): { session: SessionMetaRow; seq: number } | null {
    const now = Date.now() / 1000;
    const tx = this.db.transaction(():
      | { session: SessionMetaRow; seq: number }
      | null => {
      const row = this.stmtMetaById.get(sessionId) as SessionDBRow | undefined;
      if (!row || row.archived === 1) return null;
      const ops = safeParseArray<RecentOp>(row.recent_ops);
      const seq = row.op_count + 1;
      const entry: RecentOp = {
        seq,
        op_type: opType,
        sources: [...sources],
        at: now,
        ...(opUuid ? { op_uuid: opUuid } : {}),
      };
      ops.push(entry);
      while (ops.length > 50) ops.shift();
      this.db
        .prepare(
          "UPDATE sessions SET op_count = ?, recent_ops = ? WHERE session_id = ?"
        )
        .run(seq, JSON.stringify(ops), sessionId);

      // 节点级 stale：沿每个 source 的路径链标记（自身 + 祖先）
      const rootLow = row.root_path.toLowerCase();
      const markStale = this.db.prepare(
        "UPDATE nodes SET stale = 1, stale_since = COALESCE(stale_since, ?) WHERE session_id = ? AND rel_low = ?"
      );
      for (const src of sources) {
        const abs = path.resolve(src).toLowerCase();
        const relLow = relLowUnderRoot(abs, rootLow);
        if (relLow === null) continue;
        for (const p of pathPrefixes(relLow)) markStale.run(now, sessionId, p);
      }
      const updated = this.stmtMetaById.get(sessionId) as SessionDBRow;
      return { session: rowToMeta(updated), seq };
    });
    return tx();
  }

  resetFreshness(sessionId: string): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE sessions SET op_count = 0, recent_ops = '[]' WHERE session_id = ?"
        )
        .run(sessionId);
      this.db
        .prepare(
          "UPDATE nodes SET stale = 0, stale_since = NULL WHERE session_id = ?"
        )
        .run(sessionId);
    });
    tx();
  }

  // ----- rescan 子树合并（仅 live 会话） -----

  mergeRescan(
    meta: SessionMetaRow,
    absPath: string,
    sub: { root: TreeNode; files: number; dirs: number; totalBytes: number }
  ): void {
    if (meta.archived) throw new Error("归档会话不可变更（只读基线）");
    const abs = path.resolve(normalizeTarget(absPath));
    const rootLow = meta.root_path.toLowerCase();
    const relLow = relLowUnderRoot(abs.toLowerCase(), rootLow);
    if (relLow === null) {
      throw new Error(`路径不在会话扫描根 ${meta.root_path} 之内`);
    }
    if (
      relLow !== "" &&
      !this.db
        .prepare("SELECT 1 FROM nodes WHERE session_id = ? AND rel_low = ?")
        .get(meta.session_id, relLow)
    ) {
      throw new Error(`路径不在快照中: ${abs}`);
    }

    const subTree = treeToJSON(sub.root);
    subTree.name = relLow.split("\\").at(-1) || subTree.name;
    const rows: NodeRow[] = [];
    const stack: Array<{ node: TreeNodeJSON; relLow: string }> = [
      { node: subTree, relLow },
    ];
    while (stack.length > 0) {
      const { node, relLow: curLow } = stack.pop()!;
      rows.push({
        rel_low: curLow,
        name: node.name,
        size: node.size,
        mtime: node.mtime,
        atime: node.atime,
        ctime: node.ctime ?? null,
        is_dir: node.isDir ? 1 : 0,
        is_link: node.isLink ? 1 : 0,
        cache_type: node.cacheType ?? null,
        stale: 0,
        stale_since: null,
      });
      for (const [k, c] of Object.entries(node.children ?? {})) {
        const childLow = curLow ? `${curLow}\\${k.toLowerCase()}` : k.toLowerCase();
        stack.push({ node: c, relLow: childLow });
      }
    }

    const tx = this.db.transaction(() => {
      if (relLow === "") {
        this.db
          .prepare("DELETE FROM nodes WHERE session_id = ?")
          .run(meta.session_id);
      } else {
        this.db
          .prepare(
            `DELETE FROM nodes WHERE session_id = ? AND
             (rel_low = ? OR rel_low LIKE ? ESCAPE '\\')`
          )
          .run(meta.session_id, relLow, `${likeEscape(relLow)}\\\\%`);
      }
      const sess = { session_id: meta.session_id };
      for (const r of rows) this.stmtInsertNode.run({ ...sess, ...r });

      // 沿祖先链（含子树根、全树根）重算目录体积 = 直接子节点 size 之和。
      // 直接子节点 = 子树前缀范围内且不含更深分隔符（PK 范围扫描）。
      const recompute = this.db.prepare(
        `UPDATE nodes SET size =
           (SELECT COALESCE(SUM(size), 0) FROM nodes
            WHERE session_id = @sid AND rel_low > @lo AND rel_low < @hi
              AND instr(substr(rel_low, @from), '\\') = 0)
         WHERE session_id = @sid AND rel_low = @target`
      );
      const prefixes = pathPrefixes(relLow).reverse(); // 深 → 浅，含 ""
      for (const p of prefixes) {
        recompute.run({
          sid: meta.session_id,
          lo: p ? `${p}\\` : "",
          hi: p ? `${p}]` : "\uFFFF",
          from: p.length + 2,
          target: p,
        });
      }

      // 重扫后重置新鲜度账本（清空全树 stale，与旧版语义一致）
      this.resetFreshnessWithinTx(meta.session_id);
    });
    tx();
  }

  private resetFreshnessWithinTx(sessionId: string): void {
    this.db
      .prepare(
        "UPDATE sessions SET op_count = 0, recent_ops = '[]' WHERE session_id = ?"
      )
      .run(sessionId);
    this.db
      .prepare(
        "UPDATE nodes SET stale = 0, stale_since = NULL WHERE session_id = ?"
      )
      .run(sessionId);
  }

  // ----- 旧版单文件 JSON 懒迁移 -----

  private migrateLegacyJsonSessions(): void {
    const dir = sessionsDir();
    if (!fs.existsSync(dir)) return;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".migrated"));
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const legacy = JSON.parse(fs.readFileSync(full, "utf-8")) as StoredSession & {
          tree: TreeNodeJSON;
        };
        if (!legacy?.session_id || !legacy?.root_path || !legacy?.tree) {
          throw new Error("字段缺失");
        }
        const rootHash = rootHashOf(legacy.root_path);
        const liveExists = this.db
          .prepare("SELECT 1 FROM sessions WHERE root_hash = ? AND archived = 0")
          .get(rootHash);
        const now = Date.now() / 1000;
        const rows = flattenTreeToRows(legacy.tree);
        const tx = this.db.transaction(() => {
          this.db
            .prepare(
              `INSERT OR IGNORE INTO sessions
               (session_id, root_path, root_hash, mode, scanned_at, op_count,
                recent_ops, files, dirs, total_bytes, skipped_paths, orphans,
                elapsed_sec, fingerprint, entity_detail, archived, archived_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`
            )
            .run(
              legacy.session_id,
              legacy.root_path,
              rootHash,
              legacy.mode === "mft" ? "mft" : "walk",
              legacy.scanned_at ?? 0,
              legacy.op_count ?? 0,
              JSON.stringify(legacy.recent_ops ?? []),
              legacy.files ?? 0,
              legacy.dirs ?? 0,
              legacy.total_bytes ?? 0,
              JSON.stringify(legacy.skipped_paths ?? []),
              legacy.orphans ?? 0,
              legacy.elapsed_sec ?? 0,
              legacy.fingerprint ? JSON.stringify(legacy.fingerprint) : null,
              legacy.entity_detail ? JSON.stringify(legacy.entity_detail) : null
            );
          const sess = { session_id: legacy.session_id };
          for (const r of rows) this.stmtInsertNode.run({ ...sess, ...r });
          // 该根已有 live（更新的扫描）→ 旧文件导入即转档
          if (liveExists) this.archiveLiveWithinTx(legacy.session_id, now);
        });
        tx();
        fs.renameSync(full, `${full}.migrated`);
      } catch {
        // 单个损坏文件不阻塞迁移，保留原文件以便人工排查
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 进程级单例（DISK_SENSE_HOME 变化时自动重开；测试隔离依赖此行为）
// ---------------------------------------------------------------------------
let store: SessionStore | null = null;
let storeHome: string | null = null;

export function sessionStore(): SessionStore {
  const home = path.resolve(
    process.env["DISK_SENSE_HOME"] ?? process.env["LOCALAPPDATA"] ?? ""
  );
  if (store && storeHome === home) return store;
  if (store) store.close();
  store = new SessionStore(sessionsDbFile());
  storeHome = home;
  return store;
}

export function closeSessionStore(): void {
  if (store) store.close();
  store = null;
  storeHome = null;
}

// ---------------------------------------------------------------------------
// 兼容门面（保持旧导出签名，消费方无需感知 SQLite）
// ---------------------------------------------------------------------------

export function saveSession(
  result: ScanResult,
  rootPath: string,
  sessionId: string,
  extra: {
    fingerprint?: Record<string, unknown>;
    entityDetail?: Record<string, Record<string, unknown[]>>;
  } = {}
): {
  session: StoredSession;
  archived: { session_id: string; archived_at: number } | null;
} {
  return sessionStore().save(result, rootPath, sessionId, extra);
}

/** 最近一次扫描的 live 会话（无参数查询命令的默认会话）。 */
export function loadLatestSession(): StoredSession | null {
  const meta = sessionStore().latestLiveMeta();
  return meta ? sessionStore().fullSession(meta) : null;
}

export function loadSessionByRoot(rootPath: string): StoredSession | null {
  const meta = sessionStore().liveMetaByRoot(rootPath);
  return meta ? sessionStore().fullSession(meta) : null;
}

/** 按 id 加载（含归档会话 —— diff_sessions 的 baseline 也走这里）。 */
export function loadSessionById(sessionId: string): StoredSession | null {
  const meta = sessionStore().metaById(sessionId);
  return meta ? sessionStore().fullSession(meta) : null;
}

/** 按 id 加载元数据（不构建树，轻量）。 */
export function loadSessionMetaById(sessionId: string): SessionMetaRow | null {
  return sessionStore().metaById(sessionId);
}

/**
 * 记录一次变更操作：op_count++、recent_ops 追加、受影响路径链标 stale，
 * 全程事务（防并发 CLI 交叉污染）。返回更新后的会话元数据与本次 seq。
 */
export function recordOperation(
  rootPath: string,
  opType: string,
  sources: readonly string[],
  opUuid?: string
): { session: SessionMetaRow; seq: number } | null {
  const st = sessionStore();
  let meta = st.liveMetaByRoot(rootPath);
  if (!meta) meta = findLiveMetaCovering(sources);
  if (!meta) return null;
  return st.applyOperation(meta.session_id, opType, sources, opUuid);
}

/** rescan 后重置新鲜度账本（op_count 归零、清空全树 stale）。 */
export function resetFreshness(rootPath: string): void {
  const st = sessionStore();
  const meta = st.liveMetaByRoot(rootPath);
  if (meta) st.resetFreshness(meta.session_id);
}

/** 按源路径自动定位所属 live 会话并记账（CLI 层便捷入口）。 */
export function recordOperationForSources(
  opType: string,
  sources: readonly string[],
  opUuid?: string
): { session: SessionMetaRow; seq: number } | null {
  const anchor = sources.find((s) => typeof s === "string" && s.length > 0);
  if (!anchor) return null;
  const covered = findLiveMetaCovering([anchor]);
  if (!covered) return null;
  return sessionStore().applyOperation(
    covered.session_id,
    opType,
    sources,
    opUuid
  );
}

function findLiveMetaCovering(sources: readonly string[]): SessionMetaRow | null {
  const metas = sessionStore().liveMetas();
  let best: SessionMetaRow | null = null;
  let bestLen = -1;
  for (const s of sources) {
    const srcLow = path.resolve(s).toLowerCase();
    for (const m of metas) {
      const rootLow = m.root_path.toLowerCase();
      if (!isUnderRoot(srcLow, rootLow)) continue;
      if (rootLow.length > bestLen) {
        best = m;
        bestLen = rootLow.length;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 版本化 / 发现 / 导出
// ---------------------------------------------------------------------------

/** 列出会话（默认仅 live；--all 含归档），按根路径与扫描时间排序。 */
export function listSessions(
  rootPath?: string,
  includeArchived = false
): { sessions: SessionMetaRow[] } {
  return { sessions: sessionStore().listMetas(rootPath, includeArchived) };
}

/** 导出任意会话（含归档）为 .json.gz 单文件（备份 / 外部分析用）。 */
export function exportSessionToFile(
  sessionId: string,
  outPath?: string
): { status: "ok"; out: string; bytes: number; session_id: string } {
  const st = sessionStore();
  const meta = st.metaById(sessionId);
  if (!meta) throw new Error(`会话不存在: ${sessionId}`);
  const full = st.fullSession(meta);
  const out = outPath ?? path.join(exportDir(), `${sessionId}.json.gz`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const gz = gzipSync(JSON.stringify(full), { level: 6 });
  fs.writeFileSync(out, gz);
  return { status: "ok", out, bytes: gz.length, session_id: sessionId };
}

/** rescan 子树合并（供 CLI 调用）。 */
export function mergeRescanSubtree(
  meta: SessionMetaRow,
  absPath: string,
  sub: { root: TreeNode; files: number; dirs: number; totalBytes: number }
): void {
  sessionStore().mergeRescan(meta, absPath, sub);
}
