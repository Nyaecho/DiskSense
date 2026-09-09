/**
 * 跨会话时间维度分析：diff_sessions（两会话对比）与 growth_report
 * （按 mtime/ctime 时间窗聚合）。
 *
 * 对比基于 rel_low（小写相对路径）归并联接 —— 两个有序迭代器流式推进，
 * 不做全量物化；目录聚合按深度截断（如 depth=3 时 a\b\c\d.txt 聚入
 * a\b\c），回答「全盘哪些目录增长最多」这类全局问题。
 *
 * 显示路径不落库：rel_low 有序遍历父先于子，由 dirRows 单趟推导
 * 原始大小写路径。
 */

import {
  loadSessionByRoot,
  loadSessionMetaById,
  sessionStore,
  type FileNodeRow,
  type SessionMetaRow,
} from "../state/session.js";

export interface DiffOptions {
  top: number;
  depth: number;
}

export interface GrowthOptions {
  since: number;
  until?: number | undefined;
  by: "mtime" | "ctime";
  depth: number;
  top: number;
}

interface DirAgg {
  delta: number;
  addedBytes: number;
  removedBytes: number;
  addedFiles: number;
  removedFiles: number;
}

function parentLowOf(relLow: string): string {
  const i = relLow.lastIndexOf("\\");
  return i === -1 ? "" : relLow.slice(0, i);
}

/** 文件相对路径 → 深度截断后的目录键（小写）。 */
export function dirKeyOf(relLow: string, depth: number): string {
  const noFile = parentLowOf(relLow);
  if (!noFile) return "";
  const segs = noFile.split("\\");
  return segs.slice(0, Math.max(1, depth)).join("\\");
}

/** --since/--until 参数解析：纯数字 = Unix 秒，否则 ISO 8601。 */
export function parseTimestampArg(v: string, name: string): number {
  if (/^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  const t = Date.parse(v);
  if (Number.isNaN(t)) {
    throw new Error(
      `${name} 无法解析: ${v}（支持 Unix 秒或 ISO 8601，如 2026-09-01T00:00:00+08:00）`
    );
  }
  return t / 1000;
}

function requireMeta(sessionId: string): SessionMetaRow {
  const meta = loadSessionMetaById(sessionId);
  if (!meta) throw new Error(`会话不存在: ${sessionId}（用 list_sessions 查看）`);
  return meta;
}

function assertSameRoot(baseline: SessionMetaRow, current: SessionMetaRow): void {
  const a = baseline.root_path.toLowerCase().replace(/[\\/]+$/, "");
  const b = current.root_path.toLowerCase().replace(/[\\/]+$/, "");
  if (a !== b) {
    throw new Error(
      `两会话根路径不一致（baseline=${baseline.root_path}，current=${current.root_path}），逐文件 diff 无意义`
    );
  }
}

/**
 * 目录小写路径 → 原始大小写路径映射（有序遍历父先于子，单趟推导）。
 */
function displayMapOf(sessionId: string): Map<string, string> {
  const m = new Map<string, string>([["", ""]]);
  for (const d of sessionStore().iterateDirNodes(sessionId)) {
    const parentDisp = m.get(parentLowOf(d.rel_low)) ?? "";
    m.set(d.rel_low, parentDisp ? `${parentDisp}\\${d.name}` : d.name);
  }
  return m;
}

/** 文件显示路径 = 父目录显示路径 + 原始大小写文件名。 */
function displayOf(row: FileNodeRow, disp: Map<string, string>): string {
  const p = disp.get(parentLowOf(row.rel_low)) ?? "";
  return p ? `${p}\\${row.name}` : row.name;
}

/** 深度截断后的目录显示路径（优先当前会话，目录已消失时回退基线映射）。 */
function dirDisplayOfKey(
  dirLow: string,
  dispCur: Map<string, string>,
  dispBase?: Map<string, string>
): string {
  const hit = dispCur.get(dirLow) ?? dispBase?.get(dirLow);
  if (hit !== undefined) return hit;
  return dirLow || "(root)";
}

interface FileDelta {
  path: string;
  size: number;
  delta: number;
  mtime: number;
}

/**
 * 两次会话对比：新增/消失/变更文件 + 目录聚合 Top N。
 * 输入：baseline（通常为归档会话）、current（通常为 live 会话）。
 */
export function diffSessions(
  baselineId: string,
  currentId: string,
  opts: DiffOptions
): Record<string, unknown> {
  const baseline = requireMeta(baselineId);
  const current = requireMeta(currentId);
  assertSameRoot(baseline, current);
  const store = sessionStore();
  const dispBase = displayMapOf(baselineId);
  const dispCur = displayMapOf(currentId);

  const dirs = new Map<string, DirAgg>();
  const bump = (low: string): DirAgg => {
    let agg = dirs.get(low);
    if (!agg) {
      agg = {
        delta: 0,
        addedBytes: 0,
        removedBytes: 0,
        addedFiles: 0,
        removedFiles: 0,
      };
      dirs.set(low, agg);
    }
    return agg;
  };

  const added: FileDelta[] = [];
  const removed: FileDelta[] = [];
  const changed: FileDelta[] = [];
  let bytesAdded = 0;
  let bytesRemoved = 0;

  // 归并联接（两迭代器均按 rel_low 有序）
  const itA = store.iterateFileNodes(baselineId);
  const itB = store.iterateFileNodes(currentId);
  let a = itA.next();
  let b = itB.next();
  while (!a.done || !b.done) {
    const av = a.done ? undefined : a.value;
    const bv = b.done ? undefined : b.value;
    let cmp: number;
    if (av === undefined) cmp = 1;
    else if (bv === undefined) cmp = -1;
    else cmp = av.rel_low < bv.rel_low ? -1 : av.rel_low > bv.rel_low ? 1 : 0;

    if (cmp < 0) {
      // baseline 独有 → 消失
      const agg = bump(dirKeyOf(av!.rel_low, opts.depth));
      agg.delta -= av!.size;
      agg.removedBytes += av!.size;
      agg.removedFiles += 1;
      bytesRemoved += av!.size;
      removed.push({
        path: displayOf(av!, dispBase),
        size: av!.size,
        delta: -av!.size,
        mtime: av!.mtime,
      });
      a = itA.next();
    } else if (cmp > 0) {
      // current 独有 → 新增
      const agg = bump(dirKeyOf(bv!.rel_low, opts.depth));
      agg.delta += bv!.size;
      agg.addedBytes += bv!.size;
      agg.addedFiles += 1;
      bytesAdded += bv!.size;
      added.push({
        path: displayOf(bv!, dispCur),
        size: bv!.size,
        delta: bv!.size,
        mtime: bv!.mtime,
      });
      b = itB.next();
    } else {
      const d = bv!.size - av!.size;
      if (d !== 0) {
        const agg = bump(dirKeyOf(av!.rel_low, opts.depth));
        agg.delta += d;
        if (d > 0) {
          agg.addedBytes += d;
          bytesAdded += d;
        } else {
          agg.removedBytes += -d;
          bytesRemoved += -d;
        }
        changed.push({
          path: displayOf(bv!, dispCur),
          size: bv!.size,
          delta: d,
          mtime: bv!.mtime,
        });
      }
      a = itA.next();
      b = itB.next();
    }
  }

  // 目录数（新增/消失的空目录也计入 summary）
  let dirsAdded = 0;
  let dirsRemoved = 0;
  const itDA = store.iterateDirNodes(baselineId);
  const itDB = store.iterateDirNodes(currentId);
  let da = itDA.next();
  let db = itDB.next();
  while (!da.done || !db.done) {
    const x = da.done ? undefined : da.value;
    const y = db.done ? undefined : db.value;
    let cmp: number;
    if (x === undefined) cmp = 1;
    else if (y === undefined) cmp = -1;
    else cmp = x.rel_low < y.rel_low ? -1 : x.rel_low > y.rel_low ? 1 : 0;
    if (cmp < 0) {
      dirsRemoved += 1;
      da = itDA.next();
    } else if (cmp > 0) {
      dirsAdded += 1;
      db = itDB.next();
    } else {
      da = itDA.next();
      db = itDB.next();
    }
  }

  const topDirs = [...dirs.entries()]
    .map(([low, agg]) => ({
      dir: dirDisplayOfKey(low, dispCur, dispBase),
      delta_bytes: agg.delta,
      added_bytes: agg.addedBytes,
      removed_bytes: agg.removedBytes,
      added_files: agg.addedFiles,
      removed_files: agg.removedFiles,
    }))
    .sort((x, y) =>
      Math.abs(y.delta_bytes) === Math.abs(x.delta_bytes)
        ? y.delta_bytes - x.delta_bytes
        : Math.abs(y.delta_bytes) - Math.abs(x.delta_bytes)
    )
    .slice(0, opts.top);

  const bySizeDesc = (x: FileDelta, y: FileDelta) =>
    Math.abs(y.delta) - Math.abs(x.delta);

  return {
    status: "completed",
    baseline: {
      session_id: baseline.session_id,
      scanned_at: baseline.scanned_at,
      archived: baseline.archived,
    },
    current: {
      session_id: current.session_id,
      scanned_at: current.scanned_at,
      op_count: current.op_count,
    },
    summary: {
      files_added: added.length,
      files_removed: removed.length,
      files_changed: changed.length,
      bytes_added: bytesAdded,
      bytes_removed: bytesRemoved,
      net_delta_bytes: bytesAdded - bytesRemoved,
      dirs_added: dirsAdded,
      dirs_removed: dirsRemoved,
    },
    top_dirs_by_delta: topDirs,
    top_new_files: [...added].sort(bySizeDesc).slice(0, opts.top),
    top_removed_files: [...removed].sort(bySizeDesc).slice(0, opts.top),
    top_changed_files: [...changed].sort(bySizeDesc).slice(0, opts.top),
  };
}

/**
 * 无基线时的降级方案：当前会话内按 mtime/ctime 时间窗过滤文件，
 * 按目录深度聚合 —— 回答「最近 N 天哪些目录写入最多」。
 */
export function growthReport(
  sessionId: string,
  opts: GrowthOptions
): Record<string, unknown> {
  const meta = requireMeta(sessionId);
  const store = sessionStore();
  const col = opts.by === "ctime" ? "ctime" : "mtime";

  const rows: FileNodeRow[] = [];
  for (const r of store.iterateFileNodesByTime(sessionId, col, opts.since, opts.until)) {
    rows.push(r);
  }

  if (opts.by === "ctime" && rows.length === 0 && !store.hasCtimeData(sessionId)) {
    throw new Error(
      "该会话无 ctime 数据（旧版本扫描），请改用 --by mtime 或重新 start_scan"
    );
  }

  const disp = displayMapOf(sessionId);
  const dirs = new Map<string, { bytes: number; files: number }>();
  let total = 0;
  for (const r of rows) {
    total += r.size;
    const key = dirKeyOf(r.rel_low, opts.depth);
    let agg = dirs.get(key);
    if (!agg) {
      agg = { bytes: 0, files: 0 };
      dirs.set(key, agg);
    }
    agg.bytes += r.size;
    agg.files += 1;
  }

  const topDirs = [...dirs.entries()]
    .map(([low, agg]) => ({
      dir: dirDisplayOfKey(low, disp),
      bytes: agg.bytes,
      files: agg.files,
    }))
    .sort((x, y) => y.bytes - x.bytes)
    .slice(0, opts.top);

  const topFiles = [...rows]
    .sort((x, y) => y.size - x.size)
    .slice(0, opts.top)
    .map((r) => ({ path: displayOf(r, disp), size: r.size, mtime: r.mtime }));

  return {
    status: "completed",
    session_id: sessionId,
    root_path: meta.root_path,
    by: col,
    since: opts.since,
    until: opts.until ?? null,
    total_bytes: total,
    total_files: rows.length,
    top_dirs: topDirs,
    top_files: topFiles,
    stale_hint:
      meta.op_count > 0 ? `快照后已有 ${meta.op_count} 次操作` : undefined,
  };
}

/** diff_sessions 的 --current 省略时：取 baseline 同根的 live 会话。 */
export function resolveCurrentSession(baselineId: string): string {
  const baseline = requireMeta(baselineId);
  const live = loadSessionByRoot(baseline.root_path);
  if (!live) {
    throw new Error(`根路径 ${baseline.root_path} 无 live 会话，请先 start_scan`);
  }
  return live.session_id;
}
