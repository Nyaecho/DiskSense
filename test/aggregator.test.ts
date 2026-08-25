/** aggregator.ts 分类与聚合测试（对应 Python test_aggregator.py 核心用例）。 */

import { describe, expect, it } from "vitest";
import { Aggregator } from "../src/aggregator.js";
import { createNode, finalizeTree, type ScanResult } from "../src/types.js";

const MB = 1024 * 1024;

/** 构造合成扫描树：paths 为 [相对路径段..., 字节数] 描述。 */
function makeResult(rootName: string, spec: Record<string, number>, now = 1_000_000.0): ScanResult {
  const root = createNode(rootName, { isDir: true });
  root.children = new Map();
  for (const [relPath, size] of Object.entries(spec)) {
    const segs = relPath.split("\\");
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i]!;
      let next = node.children!.get(seg);
      if (!next) {
        next = createNode(seg, { isDir: true });
        next.children = new Map();
        node.children!.set(seg, next);
      }
      node = next;
    }
    const name = segs.at(-1)!;
    node.children!.set(
      name,
      createNode(name, { size, mtime: now, atime: now })
    );
  }
  finalizeTree(root);
  return {
    root,
    mode: "walk",
    files: 0,
    dirs: 0,
    totalBytes: root.size,
    skippedPaths: [],
    orphans: 0,
    elapsedSec: 0.1,
  };
}

function aggregate(spec: Record<string, number>, opts: Parameters<Aggregator>[0] & { root?: string; now?: number } = {}) {
  const { root = "D:", now = 1_000_000_000, ...rest } = opts;
  void root;
  return new Aggregator({ ...rest, now });
}

describe("classifyPath（通过 aggregate 行为验证）", () => {
  it("Program Files 一级子目录 → program_base 实体 + has_exe 检测", () => {
    const result = makeResult("D:", {
      "Program Files\\WeChat\\WeChat.exe": 5 * MB,
      "Program Files\\WeChat\\data.bin": 10 * MB,
    });
    const agg = new Aggregator();
    const fp = agg.aggregate(result, "s") as Record<string, any>;
    const wechat = fp.entities.find((e: any) => e.id === "wechat");
    expect(wechat).toBeTruthy();
    expect(wechat.locations.program_base.size_mb).toBeCloseTo(15, 1);
    expect(wechat.locations.program_base.has_exe).toBe(true);
  });

  it("AppData\\Roaming 子目录 → user_data 角色", () => {
    const result = makeResult("C:", {
      "Users\\tom\\AppData\\Roaming\\WeChat\\Files\\a.dat": 100 * MB,
    });
    const agg = new Aggregator();
    const fp = agg.aggregate(result, "s") as Record<string, any>;
    const wechat = fp.entities.find((e: any) => e.id === "wechat");
    expect(wechat).toBeTruthy();
    expect(wechat.locations.user_data.size_mb).toBeCloseTo(100, 1);
    expect(wechat.locations.program_base.size_mb).toBe(0);
  });

  it("AppData\\Local\\Temp 归入系统临时伪实体", () => {
    const result = makeResult("C:", {
      "Users\\tom\\AppData\\Local\\Temp\\junk.tmp": 400 * MB,
    });
    const agg = new Aggregator();
    const fp = agg.aggregate(result, "s") as Record<string, any>;
    const sysTemp = fp.entities.find((e: any) => e.id === "system-temp");
    expect(sysTemp).toBeTruthy();
    expect(sysTemp.display).toBe("系统临时文件");
    expect(sysTemp.locations.cache.size_mb).toBeCloseTo(400, 1);
  });

  it("Windows\\Temp 也归系统临时伪实体", () => {
    const result = makeResult("C:", {
      "Windows\\Temp\\scratch.bin": 300 * MB,
    });
    const fp = new Aggregator().aggregate(result, "s") as Record<string, any>;
    expect(fp.entities.find((e: any) => e.id === "system-temp")).toBeTruthy();
  });

  it("关联扩展：标准区外含种子名 → location_anomaly", () => {
    const result = makeResult("D:", {
      "Program Files\\Adobe\\Adobe.exe": 20 * MB,
      "AdobeTemp\\chunk.pack": 500 * MB,
    });
    const fp = new Aggregator().aggregate(result, "s") as Record<string, any>;
    const adobe = fp.entities.find((e: any) => e.id === "adobe");
    expect(adobe).toBeTruthy();
    expect(adobe.location_anomaly).toBe(true);
  });

  it("基准目录根下的散文件不构成实体", () => {
    // 与 Python 版一致：直接验证分类函数（无种子污染）
    const agg = new Aggregator();
    const [seed] = agg["classifyPath"](["c:", "program files", "stray.dll"], false);
    expect(seed).toBeNull();
  });

  it("缓存目录整桶归 cache_dirs，不计入未归类", () => {
    const result = makeResult("D:", {
      ".pnpm-store\\v3\\files\\abc": 250 * MB,
    });
    // 手工给目录打 cacheType（模拟 scanner 命中模式库）
    const pnpmStore = [...result.root.children!.values()][0]!;
    pnpmStore.cacheType = "pnpm";
    const agg = new Aggregator();
    const fp = agg.aggregate(result, "s") as Record<string, any>;
    expect(fp.cache_dirs).toHaveLength(1);
    expect(fp.cache_dirs[0].cache_type).toBe("pnpm");
    expect(fp.cache_dirs[0].signal).toBe("CACHE_DOMINANT:pnpm");
    const unassigned = (fp.treemap.children as any[]).find((c) => c.id === "unassigned");
    expect(unassigned?.value ?? 0).toBe(0);
    expect(agg.entityTopFiles.size >= 0).toBe(true);
  });
});

describe("aggregate 整体行为", () => {
  function bigFixture(): ScanResult {
    return makeResult("D:", {
      "Program Files\\WeChat\\WeChat.exe": 120 * MB,
      "Users\\tom\\AppData\\Roaming\\WeChat\\msg\\a.db": 1800 * MB,
      "Users\\tom\\AppData\\Roaming\\WeChat\\Cache\\f.dat": 2330 * MB,
      "Users\\tom\\AppData\\Local\\Google\\Chrome\\chrome.exe": 80 * MB,
      "bigunknown.bin": 900 * MB,
    });
  }

  it("实体/信号/汇总/treemap 结构完整", () => {
    const fp = new Aggregator().aggregate(bigFixture(), "sess-1") as Record<string, any>;
    const ids = fp.entities.map((e: any) => e.id);
    expect(ids).toContain("wechat");

    const wechat = fp.entities.find((e: any) => e.id === "wechat");
    // cache 2330 > (120+1800)*1.5=2880? 否 → 不触发 CACHE_DOMINANT
    expect(wechat.signals).not.toContain("CACHE_DOMINANT");

    // global_anomalies：未归类 900MB ≥ 200MB 门槛 → 批量魔数
    expect(fp.global_anomalies.length).toBeGreaterThanOrEqual(1);
    expect(fp.global_anomalies[0]).toHaveProperty("magic_type");

    expect(fp.summary.scan_mode).toBe("walk");
    expect(fp.summary.entities_count).toBe(fp.entities.length);
    // 空规则引擎 → 图例只含内置的开发者产物信号
    expect(Object.keys(fp.signals_legend).sort()).toEqual([
      "ORPHAN_NODE_MODULES",
      "STALE_DEV_CACHE",
    ]);

    expect(fp.treemap.id).toBe("root");
    expect(fp.treemap.children.some((c: any) => c.id === "unassigned")).toBe(true);

    // 明细不进指纹 JSON
    expect(JSON.stringify(fp)).not.toContain('"top"');
  });

  it("detail 留存在聚合器实例上", () => {
    const agg = new Aggregator();
    agg.aggregate(bigFixture(), "sess-1");
    const detail = agg.entityTopFiles.get("wechat");
    expect(detail).toBeTruthy();
    expect(detail!["program_base"]![0]!.name).toBe("WeChat.exe");
  });

  it("无已知实体时生成伪实体；有实体时不生成", () => {
    const pure = makeResult("E:", { "Movies\\a.mkv": 700 * MB, "Backup\\b.zip": 300 * MB });
    const fpPure = new Aggregator().aggregate(pure, "s2") as Record<string, any>;
    expect(fpPure.pseudo_entities).toBe(true);
    expect(fpPure.entities.length).toBe(2);
    expect(fpPure.entities.every((e: any) => e.kind === "pseudo")).toBe(true);

    const fpBig = new Aggregator().aggregate(bigFixture(), "s3") as Record<string, any>;
    expect(fpBig.pseudo_entities).toBeUndefined();
  });

  it("用户标记伪实体路径优先", () => {
    const pure = makeResult("E:", {
      "Models\\sd\\a.safetensors": 800 * MB,
      "Models\\xl\\b.safetensors": 600 * MB,
      "Other\\c.txt": 100 * MB,
    });
    const fp = new Aggregator({
      pseudoEntityPaths: ["E:\\Models"],
    }).aggregate(pure, "s4") as Record<string, any>;
    expect(fp.pseudo_entities).toBe(true);
    expect(fp.entities.map((e: any) => e.id)).toEqual(["pseudo:e:\\models"]);
    expect(fp.entities[0].total_size_mb).toBeCloseTo(1400, 0);
  });

  it("用户标签前缀匹配进实体 tags", () => {
    const result = makeResult("D:", {
      "Program Files\\WeChat\\WeChat.exe": 30 * MB,
    });
    const fp = new Aggregator({
      tagsByPrefix: { "d:\\program files\\wechat": "keep" },
    }).aggregate(result, "s5") as Record<string, any>;
    expect(fp.entities[0].tags).toContain("keep");
  });

  it("maxEntities 截断计数", () => {
    const spec: Record<string, number> = {};
    for (let i = 0; i < 15; i++) {
      spec[`Program Files\\App${i}\\app${i}.exe`] = (i + 1) * MB;
    }
    const result = makeResult("D:", spec);
    const fp = new Aggregator({ cfg: { maxEntities: 5 } }).aggregate(result, "s6") as Record<
      string,
      any
    >;
    expect(fp.entities.length).toBe(5);
    expect(fp.summary.entities_truncated).toBe(10);
  });
});
