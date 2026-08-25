/** rules-engine 安全评估器与规则加载测试。 */

import { describe, expect, it } from "vitest";
import path from "node:path";
import { RulesEngine, SafeEvaluator } from "../src/rules-engine.js";
import { rulesFile } from "../src/config.js";

const E = {
  id: "wechat",
  total_size_mb: 4250,
  last_access_days: 45,
  location_anomaly: false,
  locations: {
    program_base: { size_mb: 120, file_count: 180, has_exe: true },
    user_data: { size_mb: 1800, file_count: 3200, has_exe: false },
    cache: { size_mb: 2330, file_count: 450, has_exe: false },
    logs: { size_mb: 10, file_count: 5, has_exe: false },
  },
};

function entity(over: Record<string, number | boolean> = {}): Record<string, unknown> {
  const e: Record<string, unknown> = {
    id: "x",
    total_size_mb: 0,
    last_access_days: 1,
    location_anomaly: false,
    locations: {
      program_base: { size_mb: 0, file_count: 0, has_exe: false },
      user_data: { size_mb: 0, file_count: 0, has_exe: false },
      cache: { size_mb: 0, file_count: 0, has_exe: false },
      logs: { size_mb: 0, file_count: 0, has_exe: false },
    },
  };
  const locs = e.locations as Record<string, { size_mb: number; file_count: number; has_exe: boolean }>;
  for (const [role, val] of Object.entries(over)) {
    if (role in locs) {
      locs[role] = { size_mb: Number(val), file_count: 1, has_exe: false };
    } else {
      e[role] = val;
    }
  }
  e.total_size_mb = Object.values(locs).reduce((s, v) => s + v.size_mb, 0);
  return e;
}

function ev(node: unknown, ent: Record<string, unknown> = E): unknown {
  return new SafeEvaluator(ent).evaluate(node);
}

describe("SafeEvaluator 比较", () => {
  it("gt 真/假", () => {
    expect(ev({ op: "gt", left: "total_size_mb", right: 1000 })).toBe(true);
    expect(ev({ op: "gt", left: "total_size_mb", right: 99999 })).toBe(false);
  });

  it("gte/lte/lt", () => {
    expect(ev({ op: "gte", left: "total_size_mb", right: 4250 })).toBe(true);
    expect(ev({ op: "lte", left: "total_size_mb", right: 4250 })).toBe(true);
    expect(ev({ op: "lt", left: "total_size_mb", right: 4250 })).toBe(false);
  });

  it("eq 布尔", () => {
    expect(ev({ op: "eq", left: "location_anomaly", right: true })).toBe(false);
    expect(ev({ op: "eq", left: "locations.cache.has_exe", right: false })).toBe(true);
  });

  it("ne 字符串字面量", () => {
    expect(ev({ op: "ne", left: "id", right: { value: "qq" } })).toBe(true);
  });

  it("缺失路径有序比较安全失败", () => {
    expect(ev({ op: "gt", left: "no.such.path", right: 1 })).toBe(false);
  });

  it("类型不匹配安全失败", () => {
    expect(ev({ op: "gt", left: "id", right: 5 })).toBe(false);
  });
});

describe("SafeEvaluator 算术", () => {
  const nested = {
    op: "mul",
    left: {
      op: "add",
      left: "locations.program_base.size_mb",
      right: "locations.user_data.size_mb",
    },
    right: 1.5,
  };

  it("嵌套算术 (pb+ud)*1.5=2880；cache 2330 不触发", () => {
    expect(ev(nested)).toBeCloseTo(2880);
    expect(ev({ op: "gt", left: "locations.cache.size_mb", right: nested })).toBe(false);
  });

  it("multiplier 倍率", () => {
    expect(ev({ op: "add", left: 10, right: 20, multiplier: 2 })).toBe(60);
  });

  it("除零安全失败", () => {
    expect(ev({ op: "truediv", left: 10, right: 0 })).toBe(false);
  });

  it("非数字操作数安全失败", () => {
    expect(ev({ op: "add", left: "id", right: 1 })).toBe(false);
  });
});

describe("SafeEvaluator 逻辑", () => {
  it("and 数组", () => {
    const node = {
      and: [
        { op: "gt", left: "total_size_mb", right: 1000 },
        { op: "gt", left: "last_access_days", right: 10 },
      ],
    };
    expect(ev(node)).toBe(true);
    (node.and as unknown[])[1] = { op: "gt", left: "last_access_days", right: 9999 };
    expect(ev(node)).toBe(false);
  });

  it("and 单字典形式", () => {
    expect(ev({ and: { op: "gt", left: "total_size_mb", right: 1 } })).toBe(true);
  });

  it("or", () => {
    expect(
      ev({
        or: [
          { op: "gt", left: "total_size_mb", right: 99999 },
          { op: "gt", left: "total_size_mb", right: 1 },
        ],
      })
    ).toBe(true);
  });

  it("not", () => {
    expect(ev({ not: { op: "gt", left: "total_size_mb", right: 1 } })).toBe(false);
  });
});

describe("RulesEngine", () => {
  it("从仓库规则 YAML 加载并命中典型实体信号", () => {
    const engine = RulesEngine.fromYaml(rulesFile());
    expect(engine.rules.length).toBeGreaterThan(0);

    const signals = engine.evaluateSignals(entity({ cache: 5000 }));
    expect(signals).toContain("CACHE_DOMINANT");

    // 卸载残留：program_base >10MB 但无 exe
    const residue = entity({ program_base: 50 }) as Record<string, unknown>;
    (residue.locations as Record<string, { has_exe: boolean }>).program_base.has_exe = false;
    expect(engine.evaluateSignals(residue)).toContain("EXE_MISSING");

    // 孤儿用户数据：program_base=0 且 user_data>300
    expect(engine.evaluateSignals(entity({ user_data: 400 }))).toContain("ORPHAN_USER_DATA");

    // 古老数据
    expect(engine.evaluateSignals(entity({ last_access_days: 200, user_data: 1500 }))).toContain(
      "ANCIENT_DATA"
    );
  });

  it("文件缺失返回空引擎", () => {
    const engine = RulesEngine.fromYaml(path.join("Z:", "nonexistent.yaml"));
    expect(engine.rules).toHaveLength(0);
    expect(engine.evaluateSignals(E)).toEqual([]);
  });

  it("describe 返回描述", () => {
    const engine = RulesEngine.fromYaml(rulesFile());
    expect(engine.describe("EXE_MISSING")).toContain("卸载残留");
    expect(engine.describe("NO_SUCH")).toBe("");
  });
});
