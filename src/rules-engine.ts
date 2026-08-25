/**
 * 结构化规则引擎（语义信号生成）。
 *
 * 设计哲学：代码中绝不出现 `if (path.includes("微信"))` 一类的硬编码判断；
 * 所有信号来自 config/classification_rules.yaml 的**结构化条件树**，
 * 由 SafeEvaluator 用受限算子白名单安全评估——不使用 eval，不执行任意代码。
 *
 * 条件节点文法（详见 YAML 头注释）：
 *     字面量   数字 / 布尔 / {"value": 字符串}
 *     路径引用 点号路径，如 locations.cache.size_mb
 *     比较     {op: gt|lt|gte|lte|eq|ne, left, right}
 *     算术     {op: add|sub|mul|truediv, left, right, multiplier?}
 *     逻辑     {and: [节点...]} / {or: [节点...]} / {not: 节点}
 *
 * 评估失败（路径缺失、类型不匹配、除零、未知算子）一律返回 false 并记录
 * 告警——规则引擎绝不让单个坏规则打断整体扫描分析。
 */

import fs from "node:fs";
import { load as yamlLoad } from "js-yaml";

type NodeValue = number | boolean | string | null | undefined;
type ConditionNode = unknown;

export interface Rule {
  signal: string;
  condition: Record<string, unknown>;
  description: string;
}

const CMP_OPS: Record<string, (a: never, b: never) => boolean> = {};
const cmpFn = (f: (a: any, b: any) => boolean) => f as any;
CMP_OPS["gt"] = cmpFn((a: any, b: any) => a > b);
CMP_OPS["lt"] = cmpFn((a: any, b: any) => a < b);
CMP_OPS["gte"] = cmpFn((a: any, b: any) => a >= b);
CMP_OPS["lte"] = cmpFn((a: any, b: any) => a <= b);
CMP_OPS["eq"] = cmpFn((a: any, b: any) => a === b);
CMP_OPS["ne"] = cmpFn((a: any, b: any) => a !== b);

const ARITH_OPS: Record<string, (a: number, b: number) => number> = {
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  // 对齐 Python：除零必须抛错（由 evaluate 安全失败捕获），而非返回 Infinity
  truediv: (a, b) => {
    if (b === 0) throw new Error("除零");
    return a / b;
  },
};

function warn(msg: string): void {
  console.error(`[rules_engine] ${msg}`);
}

/** 安全的条件树评估器（无 eval，算子白名单）。 */
export class SafeEvaluator {
  constructor(private entity: Record<string, unknown>) {}

  /** 按点号路径从实体字典取值；任一层缺失返回 null。 */
  getPath(path: string): NodeValue {
    let value: unknown = this.entity;
    for (const part of path.split(".")) {
      if (value === null || value === undefined) return null;
      if (typeof value === "object") {
        value = (value as Record<string, unknown>)[part];
      } else if (Array.isArray(value)) {
        value = undefined;
      } else {
        value = undefined;
      }
    }
    return value as NodeValue;
  }

  /** 评估节点，任何错误返回 false（安全失败）。 */
  evaluate(node: ConditionNode): unknown {
    try {
      return this.evalNode(node);
    } catch (e) {
      warn(`规则节点评估失败（按 false 处理）: ${e}`);
      return false;
    }
  }

  private evalNode(node: ConditionNode): unknown {
    // 字面量
    if (typeof node === "boolean" || typeof node === "number") return node;
    if (node === null || node === undefined) return null;
    if (typeof node === "string") return this.getPath(node);
    if (typeof node !== "object" || Array.isArray(node)) {
      throw new Error(`无法评估的节点: ${JSON.stringify(node)}`);
    }

    const dict = node as Record<string, unknown>;

    // {"value": ...} 字符串字面量转义
    if ("value" in dict) return dict["value"];

    // 逻辑组合
    if ("and" in dict) {
      const branches = Array.isArray(dict["and"]) ? dict["and"] : [dict["and"]];
      if (branches.length === 0) throw new Error("and 分支为空");
      return branches.every((b) => Boolean(this.evaluate(b)));
    }
    if ("or" in dict) {
      const branches = Array.isArray(dict["or"]) ? dict["or"] : [dict["or"]];
      if (branches.length === 0) throw new Error("or 分支为空");
      return branches.some((b) => Boolean(this.evaluate(b)));
    }
    if ("not" in dict) {
      return !this.evaluate(dict["not"]);
    }

    const op = dict["op"] as string | undefined;
    if (op !== undefined && op in ARITH_OPS) {
      const left = numeric(this.evalNode(dict["left"]), op);
      const right = numeric(this.evalNode(dict["right"]), op);
      let result = ARITH_OPS[op]!(left, right);
      const multiplier = dict["multiplier"];
      if (multiplier !== undefined && multiplier !== 1) result *= Number(multiplier);
      return result;
    }
    if (op !== undefined && op in CMP_OPS) {
      const left = this.evalNode(dict["left"]);
      const right = this.evalNode(dict["right"]);
      if (["gt", "lt", "gte", "lte"].includes(op) && (left == null || right == null)) {
        return false; // 有序比较遇缺失值 → 不触发
      }
      try {
        return Boolean(CMP_OPS[op]!(left as never, right as never));
      } catch {
        return false; // str 与 int 等类型不匹配 → 不触发
      }
    }
    throw new Error(`未知算子: ${JSON.stringify(op)}`);
  }
}

function numeric(value: unknown, op: string): number {
  if (typeof value === "boolean" || typeof value !== "number") {
    throw new Error(`算术节点 ${op} 的操作数不是数字: ${JSON.stringify(value)}`);
  }
  return value;
}

/** 规则集合加载与批量评估。 */
export class RulesEngine {
  constructor(public rules: Rule[] = []) {}

  /** 从 YAML 文件加载规则；文件缺失时返回空引擎（不抛异常）。 */
  static fromYaml(filePath: string): RulesEngine {
    if (!fs.existsSync(filePath)) {
      warn(`规则文件不存在: ${filePath}（将无信号产出）`);
      return new RulesEngine();
    }
    let data: Record<string, unknown>;
    try {
      data = (yamlLoad(fs.readFileSync(filePath, "utf-8")) ?? {}) as Record<string, unknown>;
    } catch {
      warn(`规则文件解析失败: ${filePath}`);
      return new RulesEngine();
    }
    const rules: Rule[] = [];
    for (const raw of (data["rules"] as unknown[]) ?? []) {
      try {
        const r = raw as Record<string, unknown>;
        rules.push({
          signal: String(r["signal"]),
          condition: r["condition"] as Record<string, unknown>,
          description: String(r["description"] ?? ""),
        });
      } catch {
        warn(`规则格式非法，已跳过: ${JSON.stringify(raw).slice(0, 100)}`);
      }
    }
    return new RulesEngine(rules);
  }

  /** 评估实体的全部规则，返回命中的信号列表（按规则文件顺序）。 */
  evaluateSignals(entity: Record<string, unknown>): string[] {
    const ev = new SafeEvaluator(entity);
    return this.rules.filter((r) => Boolean(ev.evaluate(r.condition))).map((r) => r.signal);
  }

  /** 返回信号的人类可读描述（供 Agent 引用）。 */
  describe(signal: string): string {
    return this.rules.find((r) => r.signal === signal)?.description ?? "";
  }
}
