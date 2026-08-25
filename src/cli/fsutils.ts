/**
 * 只读元数据工具：path_size / dir_stat / search_dirs。
 * 仅接触路径、大小与时间戳（铁律 1 边界内）。
 */

import fs from "node:fs";
import path from "node:path";
import { fnmatch } from "../glob.js";
import { matchIgnore } from "../scanner/walk.js";

export interface PathSizeResult {
  path: string;
  total_bytes: number;
  files: number;
  dirs: number;
  skipped_inaccessible: number;
}

/** 递归测量任意路径体积（跳过链接）。 */
export function pathSize(target: string): PathSizeResult {
  const out: PathSizeResult = {
    path: path.resolve(target),
    total_bytes: 0,
    files: 0,
    dirs: 0,
    skipped_inaccessible: 0,
  };
  const st = fs.lstatSync(out.path);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    if (!st.isSymbolicLink()) out.total_bytes = Number(st.size);
    return out;
  }

  const stack = [out.path];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      out.skipped_inaccessible++;
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        out.dirs++;
        stack.push(full);
      } else {
        try {
          out.total_bytes += Number(fs.statSync(full).size);
          out.files++;
        } catch {
          out.skipped_inaccessible++;
        }
      }
    }
  }
  return out;
}

export interface DirStatResult {
  path: string;
  is_dir: boolean;
  mtime: number;
  atime: number;
  ctime: number;
  size: number | null;
}

/** 返回任意目录/文件的 mtime/atime/ctime。 */
export function dirStat(target: string): DirStatResult {
  const st = fs.statSync(target);
  return {
    path: path.resolve(target),
    is_dir: st.isDirectory(),
    mtime: st.mtimeMs / 1000,
    atime: st.atimeMs / 1000,
    ctime: st.birthtimeMs / 1000,
    size: st.isDirectory() ? null : Number(st.size),
  };
}

export interface SearchEntry {
  path: string;
  size: number;
  mtime: number;
}

export interface SearchResult {
  dirs: SearchEntry[];
  files: SearchEntry[];
  total_dirs_matched: number;
  total_files_matched: number;
  skipped_inaccessible: number;
}

/**
 * 已知「重目录」：其子树体量通常巨大且内容自包含（依赖/版本库/编译缓存）。
 * 命中后仍参与模式匹配（可被搜到），但默认不再向下遍历以加速全盘搜索。
 */
const HEAVY_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "__pycache__",
  "_cacache",
  ".pnpm-store",
  "$recycle.bin",
]);

/**
 * fnmatch 通配递归搜索目录**与**文件名（大小写不敏感）。
 * 命中用户忽略模式的目录不匹配也不下钻；各按大小降序 Top N。
 * @param skipHeavy 命中已知重目录时不再下钻（目录本身仍会被匹配统计）
 */
export function searchDirs(
  pattern: string,
  root: string,
  top = 50,
  ignorePatterns: readonly string[] = [],
  skipHeavy = false
): SearchResult {
  const result: SearchResult = {
    dirs: [],
    files: [],
    total_dirs_matched: 0,
    total_files_matched: 0,
    skipped_inaccessible: 0,
  };
  const absRoot = path.resolve(root);
  const ignored = (name: string) => matchIgnore(name, ignorePatterns);

  const stack = [absRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      result.skipped_inaccessible++;
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        const matched = fnmatch(e.name.toLowerCase(), pattern.toLowerCase());
        if (!ignored(e.name)) {
          if (matched) {
            result.total_dirs_matched++;
            try {
              const st = fs.statSync(path.join(dir, e.name));
              result.dirs.push({
                path: path.join(dir, e.name),
                size: dirSize(path.join(dir, e.name)),
                mtime: st.mtimeMs / 1000,
              });
            } catch {
              /* 忽略统计失败的条目 */
            }
          }
          // 重目录：自身可被搜到，但其子树不再下钻
          if (!(skipHeavy && HEAVY_DIR_NAMES.has(e.name.toLowerCase()))) {
            stack.push(path.join(dir, e.name));
          }
        }
      } else {
        if (fnmatch(e.name.toLowerCase(), pattern.toLowerCase())) {
          result.total_files_matched++;
          try {
            const st = fs.statSync(path.join(dir, e.name));
            result.files.push({
              path: path.join(dir, e.name),
              size: Number(st.size),
              mtime: st.mtimeMs / 1000,
            });
          } catch {
            /* 忽略 */
          }
        }
      }
    }
  }
  result.dirs.sort((a, b) => b.size - a.size);
  result.files.sort((a, b) => b.size - a.size);
  result.dirs = result.dirs.slice(0, top);
  result.files = result.files.slice(0, top);
  return result;
}

function dirSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else {
        try {
          total += Number(fs.statSync(full).size);
        } catch {
          /* 忽略 */
        }
      }
    }
  }
  return total;
}
