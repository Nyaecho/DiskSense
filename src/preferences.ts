/**
 * 用户偏好与长期记忆系统。
 *
 * 持久化于 `<dataHome>/user_preferences.json`：
 * - 保护路径（protected_paths）：任何文件操作直接拒绝；
 * - 标签（tags）：路径前缀 → 标签，聚合时合并进实体 tags；
 * - 忽略模式（ignore_patterns）：扫描时跳过匹配的目录名；
 * - 自动清理规则（auto_clean_rules）：供 Agent 生成建议时参考。
 *
 * 写入策略：proper-lockfile 互斥 + 临时文件 + rename 原子替换，
 * 进程在任何时刻崩溃都不会留下半截 JSON。
 */

import fs from "node:fs";
import path from "node:path";
import { lockSync, unlockSync } from "proper-lockfile";

const DEFAULT_PREFS = {
  protected_paths: [] as string[],
  tags: {} as Record<string, string>,
  ignore_patterns: [] as string[],
  pseudo_entity_paths: [] as string[],
  auto_clean_rules: {
    temp: { max_age_days: 30, enabled: true },
    logs: { max_age_days: 90, enabled: false },
  } as Record<string, { max_age_days: number; enabled: boolean }>,
};

/** 路径归一化（小写 + 反斜杠 + 去尾分隔符），用于大小写不敏感前缀比较 */
export function normPath(p: string): string {
  const abs = path.resolve(p);
  return abs.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

type PrefsData = typeof DEFAULT_PREFS;

function deepCopy<T>(v: T): T {
  return structuredClone(v);
}

export class Preferences {
  readonly filepath: string;
  private data_: PrefsData;

  constructor(filepath: string) {
    this.filepath = filepath;
    this.data_ = deepCopy(DEFAULT_PREFS);
    this.load();
  }

  /** 从磁盘加载；损坏或缺失时回退默认值（绝不抛异常阻断流程）。 */
  load(): void {
    if (!fs.existsSync(this.filepath)) {
      this.data_ = deepCopy(DEFAULT_PREFS);
      return;
    }
    try {
      const loaded = JSON.parse(fs.readFileSync(this.filepath, "utf-8"));
      if (typeof loaded !== "object" || loaded === null || Array.isArray(loaded)) {
        throw new Error("偏好文件顶层必须是对象");
      }
      // 与默认结构合并，保证新增键向后兼容
      this.data_ = { ...deepCopy(DEFAULT_PREFS), ...loaded };
    } catch {
      this.data_ = deepCopy(DEFAULT_PREFS);
    }
  }

  /** 原子写入磁盘（lockfile + 临时文件 + rename）。 */
  save(): void {
    fs.mkdirSync(path.dirname(this.filepath), { recursive: true });
    const release = lockSync(this.filepath, { realpath: false });
    const tmp = `${this.filepath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data_, null, 2), "utf-8");
      fs.renameSync(tmp, this.filepath);
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 忽略清理失败 */
      }
      throw e;
    } finally {
      try {
        unlockSync(this.filepath, { realpath: false });
      } catch {
        release();
      }
    }
  }

  get data(): PrefsData {
    return deepCopy(this.data_);
  }

  // ------------------------------------------------------------------
  // 保护路径
  // ------------------------------------------------------------------
  /** 路径是否位于任一保护路径之下（含自身）。 */
  isProtected(target: string): boolean {
    const targets = this.data_.protected_paths.map(normPath);
    const p = normPath(target);
    return targets.some((t) => p === t || p.startsWith(`${t}\\`));
  }

  addProtection(target: string): { status: string; path: string } {
    if (!this.data_.protected_paths.includes(target)) {
      this.data_.protected_paths.push(target);
      this.save();
    }
    return { status: "added", path: target };
  }

  removeProtection(target: string): { status: string; path: string } {
    const want = normPath(target);
    this.data_.protected_paths = this.data_.protected_paths.filter(
      (p) => normPath(p) !== want
    );
    this.save();
    return { status: "removed", path: target };
  }

  // ------------------------------------------------------------------
  // 标签
  // ------------------------------------------------------------------
  setTag(target: string, tag: string): { status: string; path: string; tag: string } {
    this.data_.tags[target] = tag;
    this.save();
    return { status: "tagged", path: target, tag };
  }

  removeTag(target: string): { status: string; path: string } {
    const want = normPath(target);
    for (const k of Object.keys(this.data_.tags)) {
      if (normPath(k) === want) delete this.data_.tags[k];
    }
    this.save();
    return { status: "untagged", path: target };
  }

  /** {归一化前缀: 标签}，供聚合器做最长前缀匹配。 */
  get tagsByPrefix(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.data_.tags)) out[normPath(k)] = v;
    return out;
  }

  // ------------------------------------------------------------------
  // 忽略模式 / 自动清理规则
  // ------------------------------------------------------------------
  get ignorePatterns(): string[] {
    return [...this.data_.ignore_patterns];
  }

  addIgnorePattern(pattern: string): { status: string; pattern: string } {
    if (!this.data_.ignore_patterns.includes(pattern)) {
      this.data_.ignore_patterns.push(pattern);
      this.save();
    }
    return { status: "added", pattern };
  }

  getAutoCleanRule(kind: string): { max_age_days: number; enabled: boolean } | null {
    const rule = this.data_.auto_clean_rules[kind];
    return rule ? { ...rule } : null;
  }

  // ------------------------------------------------------------------
  // 伪实体标记路径（pseudo-entities）
  // ------------------------------------------------------------------
  get pseudoEntityPaths(): string[] {
    return [...this.data_.pseudo_entity_paths];
  }

  addPseudoEntityPath(target: string): { status: string; path: string } {
    const want = normPath(target);
    if (!this.data_.pseudo_entity_paths.some((p) => normPath(p) === want)) {
      this.data_.pseudo_entity_paths.push(target);
      this.save();
    }
    return { status: "added", path: target };
  }

  removePseudoEntityPath(target: string): { status: string; path: string } {
    const want = normPath(target);
    this.data_.pseudo_entity_paths = this.data_.pseudo_entity_paths.filter(
      (p) => normPath(p) !== want
    );
    this.save();
    return { status: "removed", path: target };
  }
}
