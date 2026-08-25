/**
 * viz 高亮指令持久化（环形语义：JSONL 追加，查询端按 seq 增量取回）。
 *
 * Python 版为服务内存环形缓冲（最近 100 条）；无 daemon 版改为
 * 追加写 JSONL 文件，seq 全局单调递增。
 */

import fs from "node:fs";
import path from "node:path";
import { dataHome } from "../config.js";

export interface OverlayEntry {
  seq: number;
  action: string;
  target: unknown;
  payload?: unknown;
  at: number;
}

const MAX_ENTRIES = 100;

function overlayFile(): string {
  return path.join(dataHome(), "overlays.jsonl");
}

let cachedSeq = 0;

/** 追加一条指令，返回分配的 seq。 */
export function appendOverlay(
  action: string,
  target: unknown,
  payload?: unknown
): { status: "ok"; seq: number } {
  const file = overlayFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lastSeq = readAll().at(-1)?.seq ?? 0;
  const seq = Math.max(lastSeq, cachedSeq) + 1;
  cachedSeq = seq;
  const entry: OverlayEntry = {
    seq,
    action,
    target,
    ...(payload !== undefined ? { payload } : {}),
    at: Date.now() / 1000,
  };
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf-8");
  // 环形上限：超过时重写保留最近 MAX_ENTRIES 条
  const all = readAll();
  if (all.length > MAX_ENTRIES) {
    const keep = all.slice(-MAX_ENTRIES);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, keep.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    fs.renameSync(tmp, file);
  }
  return { status: "ok", seq };
}

/** 取回 seq 之后（不含）的全部指令。 */
export function queryOverlays(sinceSeq = 0): { overlays: OverlayEntry[] } {
  return { overlays: readAll().filter((e) => e.seq > sinceSeq) };
}

function readAll(): OverlayEntry[] {
  const file = overlayFile();
  if (!fs.existsSync(file)) return [];
  const out: OverlayEntry[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as OverlayEntry);
    } catch {
      /* 跳过损坏行 */
    }
  }
  return out;
}

/** 清空全部叠加指令。 */
export function clearOverlays(): void {
  const file = overlayFile();
  try {
    fs.unlinkSync(file);
  } catch {
    /* 不存在即已清空 */
  }
}
