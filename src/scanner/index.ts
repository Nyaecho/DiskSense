/**
 * 扫描调度器（极速扫描引擎）。
 *
 * 1. 主动探测盘符类型（GetDriveTypeW），本地硬盘优先 MFT 直读；
 * 2. MFT 不可用时静默降级到 libuv 线程池并发 readdir 遍历；
 * 3. Junction/符号链接防护（不向下遍历）。
 */

import fs from "node:fs";
import path from "node:path";
import koffi from "koffi";
import { load as yamlLoad } from "js-yaml";
import { normalizeTarget, rulesFile, type ScanConfig } from "../config.js";
import type { ProgressCallback, ScanResult, TreeNode } from "../types.js";
import { extractDriveLetter, MftUnavailableError, scanViaMft } from "./mft.js";
import { scanViaWalk, matchCachePattern } from "./walk.js";

/** GetDriveTypeW: DRIVE_FIXED 本地硬盘 */
const DRIVE_FIXED = 3;

export {
  matchCachePattern,
  matchIgnore,
  scanViaWalk,
} from "./walk.js";
export { parseRecord, parseVolumeData, applyFixups, buildTree, filetimeToUnix } from "./mft.js";

/**
 * 从 classification_rules.yaml 加载缓存目录模式库 [[pattern, type], ...]。
 * 文件缺失或段缺失时返回空列表（零配置可运行）；格式非法的条目跳过。
 */
export function loadCacheDirPatterns(
  filePath?: string
): [string, string][] {
  const p = filePath ?? rulesFile();
  if (!fs.existsSync(p)) return [];
  try {
    const data = (yamlLoad(fs.readFileSync(p, "utf-8")) ?? {}) as Record<string, unknown>;
    const patterns: [string, string][] = [];
    for (const raw of (data["cache_dir_patterns"] as unknown[]) ?? []) {
      if (
        raw &&
        typeof raw === "object" &&
        (raw as Record<string, unknown>)["pattern"] &&
        (raw as Record<string, unknown>)["type"]
      ) {
        patterns.push([
          String((raw as Record<string, unknown>)["pattern"]),
          String((raw as Record<string, unknown>)["type"]),
        ]);
      }
    }
    return patterns;
  } catch {
    return [];
  }
}

const kernel32 = koffi.load("kernel32.dll");
const GetDriveTypeW = kernel32.func("__stdcall", "GetDriveTypeW", "uint32", ["str16"]);

/** 返回盘符类型：3=本地硬盘 4=网络盘 2=移动盘 5=CD-ROM；0=未知/非盘符。 */
export function getDriveType(target: string): number {
  const letter = extractDriveLetter(target);
  if (!letter || process.platform !== "win32") return 0;
  return GetDriveTypeW(`${letter}:\\`);
}

/**
 * 扫描入口：本地 NTFS 硬盘走 MFT 快速路径，否则并发 walk。
 * 主动探测盘符类型，避免「先报错再降级」。
 */
export async function scan(
  target: string,
  options: {
    cfg?: ScanConfig;
    progressCb?: ProgressCallback;
    cancelRequested?: () => boolean;
    ignoreGlobs?: readonly string[];
    cachePatterns?: ReadonlyArray<[string, string]>;
  } = {}
): Promise<ScanResult> {
  const cfg = options.cfg;
  const cachePatterns = options.cachePatterns ?? loadCacheDirPatterns();
  target = normalizeTarget(target);
  const driveLetter = extractDriveLetter(target);
  const isBareDrive = /^[A-Za-z]:\\?$/.test(target);

  if (
    isBareDrive &&
    process.platform === "win32" &&
    (!cfg || cfg.useMft) &&
    getDriveType(target) === DRIVE_FIXED
  ) {
    try {
      const result = await Promise.resolve(
        scanViaMft(driveLetter!, {
          progressCb: options.progressCb,
          cancelRequested: options.cancelRequested,
          ignoreGlobs: [...(cfg?.defaultDirIgnores ?? []), ...(options.ignoreGlobs ?? [])],
        })
      );      // MFT 模式下缓存目录模式需后处理标注
      annotateCacheDirs(result.root, cachePatterns);
      return result;
    } catch (e) {
      if (!(e instanceof MftUnavailableError)) throw e;
      // MFT 不可用，静默降级 walk
    }
  }

  return scanViaWalk(target, cachePatterns, [
    ...(cfg?.defaultDirIgnores ?? []),
    ...(options.ignoreGlobs ?? []),
  ], {
    maxWorkers: cfg?.maxWorkers ?? null,
    progressCb: options.progressCb,
    cancelRequested: options.cancelRequested,
  });
}

/** MFT 扫描无逐目录遍历过程，构建树后统一补打缓存类型标注。 */
function annotateCacheDirs(
  node: TreeNode,
  patterns: ReadonlyArray<[string, string]>
): void {
  if (node.isDir && !node.isLink) {
    const hit = matchCachePattern(node.name, patterns);
    if (hit) node.cacheType = hit;
    for (const child of node.children?.values() ?? []) annotateCacheDirs(child, patterns);
  }
}
