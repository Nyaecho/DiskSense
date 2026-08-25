/**
 * 扫描会话持久化（无 daemon 架构的核心状态层）。
 *
 * 会话 = 一次扫描的完整快照（目录树 + 指纹元数据）+ 新鲜度账本：
 * - 会话级：op_count / recent_ops —— 快照之后执行了几次操作（Agent 判断
 *   「这份分析结论整体还可信吗」）；
 * - 节点级：stale / stale_since —— 受影响子树的过期标记；
 * - 执行时：预检（存在性/mtime 比对，见 file-operator）——硬防线。
 *
 * 每次 execute_operation / undo_operation 成功后 op_count++ 并写回磁盘；
 * rescan 成功后重置为 0。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { sessionsDir } from "../config.js";
import type { ScanResult, TreeNode } from "../types.js";
import { lockSync, unlockSync } from "proper-lockfile";

export interface RecentOp {
  seq: number;
  op_type: string;
  sources: string[];
  op_uuid?: string;
  at: number;
}

export interface StoredSession {
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

/** 会话文件路径：按扫描根路径的哈希定位。 */
export function sessionFileForRoot(rootPath: string): string {
  const h = crypto.createHash("sha1").update(path.resolve(rootPath).toLowerCase()).digest("hex").slice(0, 12);
  return path.join(sessionsDir(), `${h}.json`);
}

function atomicWriteJson(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj), "utf-8");
  fs.renameSync(tmp, file);
}

export function saveSession(
  result: ScanResult,
  rootPath: string,
  sessionId: string,
  extra: {
    fingerprint?: Record<string, unknown>;
    entityDetail?: Record<string, Record<string, unknown[]>>;
  } = {}
): StoredSession {
  const session: StoredSession = {
    session_id: sessionId,
    root_path: path.resolve(rootPath),
    mode: result.mode,
    scanned_at: Date.now() / 1000,
    op_count: 0,
    recent_ops: [],
    files: result.files,
    dirs: result.dirs,
    total_bytes: result.totalBytes,
    skipped_paths: result.skippedPaths,
    orphans: result.orphans,
    elapsed_sec: result.elapsedSec,
    tree: treeToJSON(result.root),
    ...(extra.fingerprint ? { fingerprint: extra.fingerprint } : {}),
    ...(extra.entityDetail ? { entity_detail: extra.entityDetail } : {}),
  };
  atomicWriteJson(sessionFileForRoot(rootPath), session);
  return session;
}

/** 最近一次扫描的会话（无参数查询命令的默认会话）。 */
export function loadLatestSession(): StoredSession | null {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return null;
  let latest: { mtime: number; s: StoredSession } | null = null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const full = path.join(dir, f);
    try {
      const st = fs.statSync(full);
      if (latest && st.mtimeMs <= latest.mtime) continue;
      const s = readSessionFile(full);
      if (s) latest = { mtime: st.mtimeMs, s };
    } catch {
      continue;
    }
  }
  return latest?.s ?? null;
}

export function loadSessionByRoot(rootPath: string): StoredSession | null {
  return readSessionFile(sessionFileForRoot(rootPath));
}

export function loadSessionById(sessionId: string): StoredSession | null {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const s = readSessionFile(path.join(dir, f));
    if (s?.session_id === sessionId) return s;
  }
  return null;
}

function readSessionFile(file: string): StoredSession | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as StoredSession;
  } catch {
    return null;
  }
}

/**
 * 记录一次变更操作：op_count++、recent_ops 追加、受影响子树标 stale，
 * 全程持锁读改写（防止并发 CLI 交叉污染）。返回更新后的会话与本次 seq。
 */
export function recordOperation(
  rootPath: string,
  opType: string,
  sources: readonly string[],
  opUuid?: string
): { session: StoredSession; seq: number } | null {
  const file = sessionFileForRoot(rootPath);
  let session = readSessionFile(file);
  if (!session) {
    // 尝试按 source 推断根（取最长已存会话前缀匹配）
    session = findSessionCovering(sources);
    if (!session) return null;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const release = lockSync(file, { realpath: false });
  try {
    session = readSessionFile(file) ?? session;
    if (!session) return null;

    session.op_count += 1;
    const seq = session.op_count;
    session.recent_ops.push({
      seq,
      op_type: opType,
      sources: [...sources],
      at: Date.now() / 1000,
      ...(opUuid ? { op_uuid: opUuid } : {}),
    });
    if (session.recent_ops.length > 50) session.recent_ops.shift();

    // 节点级 stale：沿每个 source 的路径链标记祖先
    const rootLow = session.root_path.toLowerCase();
    const tree = session.tree;
    for (const src of sources) {
      const rel = path.resolve(src).toLowerCase();
      if (!rel.startsWith(rootLow)) continue;
      const rest = rel.slice(rootLow.length).replace(/^\\+/, "");
      let node: TreeNodeJSON = tree;
      if (rest) {
        for (const seg of rest.split("\\")) {
          const next =
            node.children?.[seg] ??
            Object.entries(node.children ?? {}).find(([k]) => k.toLowerCase() === seg.toLowerCase())
              ?.[1];
          if (!next) break;
          node = next;
        }
      }
      // node 即最深命中节点；标记它及其全部祖先链
      let cur: TreeNodeJSON | undefined = node;
      cur.stale = true;
      cur.staleSince = Date.now() / 1000;
      // 祖先标记：重新从根走一遍路径
      if (rest) {
        let anc: TreeNodeJSON = tree;
        anc.stale = true;
        anc.staleSince = anc.staleSince || cur.staleSince;
        for (const seg of rest.split("\\")) {
          const next = Object.entries(anc.children ?? {}).find(([k]) => k.toLowerCase() === seg.toLowerCase())
            ?.[1];
          if (!next) break;
          next.stale = true;
          next.staleSince = next.staleSince || cur.staleSince;
          anc = next;
          if (anc === cur) break;
        }
      }
    }

    atomicWriteJson(file, session);
    return { session, seq };
  } finally {
    try {
      unlockSync(file, { realpath: false });
    } catch {
      /* 已释放 */
    }
  }
}

/** rescan 后重置新鲜度账本（保留 session_id 与 recent_ops 历史？——归零语义）。 */
export function resetFreshness(rootPath: string): void {
  const file = sessionFileForRoot(rootPath);
  const session = readSessionFile(file);
  if (!session) return;
  session.op_count = 0;
  session.recent_ops = [];
  clearStale(session.tree);
  atomicWriteJson(file, session);
}

function clearStale(node: TreeNodeJSON): void {
  delete node.stale;
  delete node.staleSince;
  for (const child of Object.values(node.children ?? {})) clearStale(child);
}

/** 按源路径自动定位所属会话并记账（CLI 层便捷入口）。 */
export function recordOperationForSources(
  opType: string,
  sources: readonly string[],
  opUuid?: string
): { session: StoredSession; seq: number } | null {
  const anchor = sources.find((s) => typeof s === "string" && s.length > 0);
  if (!anchor) return null;
  const covered = findSessionCovering([anchor]);
  if (!covered) return null;
  return recordOperation(covered.root_path, opType, sources, opUuid);
}

function findSessionCovering(sources: readonly string[]): StoredSession | null {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return null;
  for (const s of sources) {
    let cur = path.resolve(s);
    while (true) {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      const hit = loadSessionByRoot(parent);
      if (hit) return hit;
      cur = parent;
    }
  }
  return null;
}
