/**
 * 会话查询助手：subtree 钻取 / query_detail / session_meta 组装。
 */

import type { StoredSession, TreeNodeJSON } from "../state/session.js";
import { treeFromJSON } from "../state/session.js";

export interface SessionMeta {
  session_id: string;
  root_path: string;
  scanned_at: number;
  op_count: number;
  recent_ops: StoredSession["recent_ops"];
}

export function sessionMeta(session: StoredSession): SessionMeta {
  return {
    session_id: session.session_id,
    root_path: session.root_path,
    scanned_at: session.scanned_at,
    op_count: session.op_count,
    recent_ops: session.recent_ops.slice(-10),
  };
}

/** 在存储树中按绝对路径定位节点（大小写不敏感）。 */
export function findNode(session: StoredSession, targetPath: string): TreeNodeJSON | null {
  const rootLow = session.root_path.toLowerCase();
  const rel = path_norm(targetPath).toLowerCase();
  let node: TreeNodeJSON = session.tree;
  if (rel === rootLow) return node;
  if (!rel.startsWith(rootLow + "\\")) return null;
  const rest = rel.slice(rootLow.length + 1);
  for (const seg of rest.split("\\")) {
    const next =
      node.children?.[seg] ??
      Object.entries(node.children ?? {}).find(([k]) => k.toLowerCase() === seg.toLowerCase())?.[1];
    if (!next) return null;
    node = next;
  }
  return node;
}

function path_norm(p: string): string {
  return p.replace(/\//g, "\\");
}

export interface SubtreeOut {
  name: string;
  value: number;
  isDir?: boolean;
  stale?: boolean;
  staleSince?: number;
  children?: SubtreeOut[];
  omitted?: number;
}

/**
 * 返回已扫描路径下至多 depth 层（1–5）的子树聚合，纯内存计算；
 * 单层超 200 项按体积降序截断并附 omitted 计数；过期节点带 stale。
 */
export function buildSubtree(
  session: StoredSession,
  targetPath: string,
  depth: number
): { path: string; depth: number; subtree: SubtreeOut } | null {
  const node = findNode(session, targetPath);
  if (!node) return null;
  return {
    path: path_norm(targetPath),
    depth,
    subtree: toSubtree(node, Math.min(5, Math.max(1, depth))),
  };
}

function toSubtree(node: TreeNodeJSON, depth: number): SubtreeOut {
  const out: SubtreeOut = {
    name: node.name,
    value: node.size,
    is_dir: node.isDir,
    ...(node.stale ? { stale: true } : {}),
    ...(node.staleSince ? { stale_since: node.staleSince } : {}),
  } as SubtreeOut & Record<string, unknown>;
  if (depth > 0 && node.children) {
    const kids = Object.values(node.children).sort((a, b) => b.size - a.size);
    const capped = kids.slice(0, 200);
    out.children = capped.map((c) => toSubtree(c, depth - 1));
    if (kids.length > 200) out.omitted = kids.length - 200;
  }
  return out;
}

/** 实体某角色 Top5 文件明细。category 省略返回全部角色。 */
export function queryDetail(
  session: StoredSession,
  entityId: string,
  category?: string
): unknown[] | Record<string, unknown[]> | null {
  const detail = session.entity_detail?.[entityId];
  if (!detail) return null;
  if (category) {
    const hit = detail[category];
    return hit ? [...hit] : null;
  }
  return Object.fromEntries(Object.entries(detail).map(([k, v]) => [k, [...v]]));
}

/** 供需要真实 TreeNode 的场景（rescan 合并等）。 */
export function storedTreeToNode(json: TreeNodeJSON) {
  return treeFromJSON(json);
}
