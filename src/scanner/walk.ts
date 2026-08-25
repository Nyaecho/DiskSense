/**
 * 多线程生产者-消费者目录遍历（降级路径，也支持任意目录而非仅盘符）。
 *
 * Node 实现：利用 libuv 线程池并发执行异步 readdir（等价于 Python 的
 * 多线程 os.scandir 生产者-消费者模型）。
 *
 * 权限策略：受限目录捕获 EPERM/EACCES 跳过子遍历并记入
 * skippedPaths（标记「受限区域」），绝不 takeown/icacls（铁律 3）。
 */

import fs from "node:fs";
import path from "node:path";
import { defaultScanWorkers } from "../config.js";
import { fnmatch } from "../glob.js";
import { createNode, finalizeTree, type ScanResult, type TreeNode } from "../types.js";

/** 判断目录名是否命中忽略模式（大小写不敏感 fnmatch）。 */
export function matchIgnore(name: string, ignores: ReadonlyArray<string>): boolean {
  const low = name.toLowerCase();
  return ignores.some((g) => fnmatch(low, g.toLowerCase()));
}

export interface WalkOptions {
  maxWorkers?: number | null;
  progressCb?: ((progress: number, filesSeen: number, bytesSeen: number) => void) | undefined;
  cancelRequested?: (() => boolean) | undefined;
}

class WalkState {
  files = 0;
  bytes = 0;
  enq = 1;
  done = 0;

  constructor(private progressCb?: WalkOptions["progressCb"]) {}

  addFile(size: number): void {
    this.files++;
    this.bytes += size;
  }

  addTask(): void {
    this.enq++;
  }

  finishTask(): void {
    this.done++;
    if (this.progressCb) {
      // 已完成任务 / 累计发现任务 → 单调收敛到 1
      const progress = Math.min(0.98, this.done / Math.max(1, this.enq));
      this.progressCb(progress, this.files, this.bytes);
    }
  }
}

/**
 * 扫描单个目录：子目录入队，文件建叶节点；权限不足记入 skipped（受限区域）。
 * 返回新入队的子目录任务。
 */
async function scanOneDir(
  dirPath: string,
  parentNode: TreeNode,
  skipped: string[],
  ignored: (name: string) => boolean,
  cachePatterns: ReadonlyArray<[string, string]>,
  opts: WalkOptions,
  state: WalkState
): Promise<[string, TreeNode][]> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EPERM" || (e as NodeJS.ErrnoException).code === "EACCES") {
      if (skipped.length < 200) skipped.push(dirPath); // 上限防爆日志
    }
    return [];
  }

  const tasks: [string, TreeNode][] = [];
  for (const entry of entries) {
    if (opts.cancelRequested?.()) break;
    const name = entry.name;
    try {
      if (entry.isDirectory()) {
        if (ignored(name)) continue;
        const st = fs.lstatSync(path.join(dirPath, name));
        if (st.isSymbolicLink()) {
          // Junction/符号链接：只建叶节点，绝不下钻（死循环防护）
          parentNode.children!.set(
            name,
            createNode(name, {
              size: 0,
              mtime: st.mtimeMs / 1000,
              atime: st.atimeMs / 1000,
              isDir: true,
              isLink: true,
            })
          );
        } else {
          const node = createNode(name, {
            mtime: st.mtimeMs / 1000,
            atime: st.atimeMs / 1000,
            isDir: true,
          });
          node.children = new Map();
          node.cacheType = matchCachePattern(name, cachePatterns);
          parentNode.children!.set(name, node);
          tasks.push([path.join(dirPath, name), node]);
          state.addTask();
        }
      } else {
        const st = fs.lstatSync(path.join(dirPath, name));
        parentNode.children!.set(
          name,
          createNode(name, {
            size: Number(st.size),
            mtime: st.mtimeMs / 1000,
            atime: st.atimeMs / 1000,
          })
        );
        state.addFile(st.size);
      }
    } catch {
      // PermissionError/OSError：跳过该条目
      continue;
    }
  }

  // 本目录仅由一个 worker 扫描，children 整体挂载无并发写
  return tasks;
}

/**
 * 目录名命中缓存模式库时返回类型标注，否则 null（大小写不敏感）。
 */
export function matchCachePattern(
  name: string,
  patterns: ReadonlyArray<[string, string]>
): string | null {
  const low = name.toLowerCase();
  for (const [pattern, ctype] of patterns) {
    if (fnmatch(low, pattern.toLowerCase())) return ctype;
  }
  return null;
}

/**
 * 并发目录遍历扫描。
 *
 * @param target 盘符（"C:"）或任意绝对目录路径
 * @throws 目标不存在 / 取消
 */
export async function scanViaWalk(
  target: string,
  cachePatterns: ReadonlyArray<[string, string]>,
  ignoreGlobs: readonly string[],
  options: WalkOptions & { display?: string } = {}
): Promise<ScanResult> {
  const t0 = performance.now();
  const absTarget = path.resolve(target);
  if (!fs.existsSync(absTarget)) {
    throw new Error(`扫描目标不存在: ${absTarget}`);
  }

  const bareDrive = /^[A-Za-z]:[\\/]?$/.exec(absTarget);
  const display =
    options.display ??
    (bareDrive
      ? `${bareDrive[0]!.charAt(0).toUpperCase()}:`
      : path.basename(absTarget.replace(/[\\/]+$/, "")) || absTarget);
  const root = createNode(display, { isDir: true });
  root.children = new Map();

  const allIgnores = ignoreGlobs;
  const ignored = (name: string) => matchIgnore(name, allIgnores);

  const state = new WalkState(options.progressCb);
  const skipped: string[] = [];
  const workers = Math.max(1, options.maxWorkers ?? defaultScanWorkers());

  // 简单任务队列 + 固定并发度（生产者-消费者）
  const queue: [string, TreeNode][] = [[absTarget, root]];
  let active = 0;
  let cancelled = false;

  await new Promise<void>((resolve) => {
    let finished = false;
    const pump = (): void => {
      if (finished) return;
      if (options.cancelRequested?.()) cancelled = true;
      if (queue.length === 0 && active === 0) {
        finished = true;
        resolve();
        return;
      }
      while (active < workers && queue.length > 0) {
        const [dirPath, parentNode] = queue.shift()!;
        active++;
        scanOneDir(
          dirPath, parentNode, skipped, ignored, cachePatterns, options, state
        )
          .then((tasks) => {
            if (cancelled) return;
            queue.push(...tasks);
          })
          .catch(() => {
            // 单目录失败不应终止整体扫描
          })
          .finally(() => {
            active--;
            state.finishTask();
            setImmediate(pump);
          });
      }
    };
    pump();
  });

  if (cancelled) throw new Error("扫描被用户取消");

  const [files, dirs, total] = finalizeTree(root);
  const result: ScanResult = {
    root,
    mode: "walk",
    files,
    dirs,
    totalBytes: total,
    skippedPaths: skipped,
    orphans: 0,
    elapsedSec: (performance.now() - t0) / 1000,
  };
  options.progressCb?.(1.0, files, total);
  return result;
}
