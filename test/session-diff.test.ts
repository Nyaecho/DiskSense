/** 跨会话时间维度测试：diff_sessions / growth_report / 时间窗解析。 */

import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveSession, closeSessionStore } from "../src/state/session.js";
import {
  diffSessions,
  growthReport,
  parseTimestampArg,
  dirKeyOf,
} from "../src/cli/session-diff.js";
import { scanViaWalk } from "../src/scanner/walk.js";
import type { ScanResult, TreeNode } from "../src/types.js";

beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ds-diff-"));
  process.env["DISK_SENSE_HOME"] = home;
  closeSessionStore();
});

function mkNode(name: string, init: Partial<TreeNode> = {}): TreeNode {
  return {
    name,
    size: 0,
    mtime: 0,
    atime: 0,
    isDir: false,
    isLink: false,
    cacheType: null,
    ...init,
  };
}

function mkDir(name: string, children: TreeNode[] = []): TreeNode {
  const d = mkNode(name, { isDir: true, children: new Map<string, TreeNode>() });
  for (const c of children) d.children!.set(c.name, c);
  return d;
}

function mkFile(name: string, size: number, mtime: number, ctime?: number): TreeNode {
  return mkNode(name, { size, mtime, atime: mtime, ...(ctime !== undefined ? { ctime } : {}) });
}

function resultOf(root: TreeNode, files: number, dirs: number, bytes: number): ScanResult {
  return {
    root,
    mode: "walk",
    files,
    dirs,
    totalBytes: bytes,
    skippedPaths: [],
    orphans: 0,
    elapsedSec: 0,
  };
}

/** 基线：docs/a.txt(500) docs/b.log(300) tmp/c.bin(1000)；当前：变化后版本。 */
function baseline(): ScanResult {
  const root = mkDir("D:\\proj", [
    mkDir("docs", [mkFile("a.txt", 500, 100), mkFile("b.log", 300, 100)]),
    mkDir("tmp", [mkFile("c.bin", 1000, 100)]),
  ]);
  return resultOf(root, 3, 3, 1800);
}

describe("parseTimestampArg", () => {
  it("纯数字按 Unix 秒", () => {
    expect(parseTimestampArg("1756684800", "--since")).toBe(1756684800);
  });
  it("ISO 8601 字符串", () => {
    const t = parseTimestampArg("2026-09-02T00:00:00Z", "--since");
    expect(t).toBe(Date.UTC(2026, 8, 2) / 1000);
  });
  it("非法值抛错", () => {
    expect(() => parseTimestampArg("yesterday", "--since")).toThrow();
  });
});

describe("dirKeyOf（深度截断目录键）", () => {
  it("文件落在深度截断后的父目录", () => {
    expect(dirKeyOf("a\\b\\c\\d.txt", 3)).toBe("a\\b\\c");
    expect(dirKeyOf("a\\b\\c\\d\\e.txt", 3)).toBe("a\\b\\c");
    expect(dirKeyOf("d.txt", 3)).toBe("");
  });
});

describe("diff_sessions", () => {
  it("新增/消失/变更 + 目录聚合 + 汇总", () => {
    saveSession(baseline(), "D:\\proj", "sess-base");
    // 当前：a.txt 增到 900(+400)；b.log 消失(-300)；新增 docs/new.dat 700；
    // 新增 logs/x.log 200；c.bin 不变；新增空目录 cache
    const cur = mkDir("D:\\proj", [
      mkDir("docs", [mkFile("a.txt", 900, 200), mkFile("new.dat", 700, 200)]),
      mkDir("tmp", [mkFile("c.bin", 1000, 100)]),
      mkDir("logs", [mkFile("x.log", 200, 200)]),
      mkDir("cache", []),
    ]);
    saveSession(resultOf(cur, 4, 4, 2800), "D:\\proj", "sess-cur");

    const r = diffSessions("sess-base", "sess-cur", { top: 10, depth: 3 }) as Record<string, any>;
    expect(r.status).toBe("completed");
    const sum = r.summary;
    expect(sum.files_added).toBe(2); // new.dat + x.log
    expect(sum.files_removed).toBe(1);
    expect(sum.files_changed).toBe(1);
    expect(sum.bytes_added).toBe(700 + 200 + 400); // 新文件 + a.txt 增量
    expect(sum.bytes_removed).toBe(300);
    expect(sum.net_delta_bytes).toBe(1000);
    expect(sum.dirs_added).toBe(2); // logs + cache
    // 目录聚合：docs = +400(a.txt) +700(new.dat) -300(b.log) = +800
    const docs = r.top_dirs_by_delta.find((d: any) => d.dir.endsWith("docs"));
    expect(docs.delta_bytes).toBe(800);
    const logs = r.top_dirs_by_delta.find((d: any) => d.dir.endsWith("logs"));
    expect(logs.delta_bytes).toBe(200);
    // 榜单按 |delta| 降序，docs 应居首
    expect(r.top_dirs_by_delta[0].dir.endsWith("docs")).toBe(true);
    expect(r.top_new_files[0].path.endsWith("new.dat")).toBe(true);
  });

  it("大小写不敏感匹配（相对路径联接走 rel_low）", () => {
    saveSession(baseline(), "D:\\proj", "sess-b");
    const cur = mkDir("D:\\proj", [
      mkDir("Docs", [mkFile("A.TXT", 500, 100), mkFile("b.log", 300, 100)]),
      mkDir("tmp", [mkFile("c.bin", 1000, 100)]),
    ]);
    saveSession(resultOf(cur, 3, 3, 1800), "D:\\proj", "sess-c");
    const r = diffSessions("sess-b", "sess-c", { top: 5, depth: 3 }) as Record<string, any>;
    expect(r.summary.files_added).toBe(0);
    expect(r.summary.files_removed).toBe(0);
    expect(r.summary.files_changed).toBe(0);
  });

  it("根路径不一致拒绝", () => {
    saveSession(baseline(), "D:\\proj", "sess-b");
    const other = mkDir("E:\\data", [mkFile("x", 1, 1)]);
    saveSession(resultOf(other, 1, 1, 1), "E:\\data", "sess-e");
    expect(() => diffSessions("sess-b", "sess-e", { top: 5, depth: 3 })).toThrow(
      /根路径不一致/
    );
  });

  it("基线不存在报错（提示 list_sessions）", () => {
    saveSession(baseline(), "D:\\proj", "sess-b");
    expect(() => diffSessions("nope", "sess-b", { top: 5, depth: 3 })).toThrow(/list_sessions/);
  });
});

describe("growth_report", () => {
  function session(): ScanResult {
    const root = mkDir("D:\\proj", [
      mkDir("docs", [
        mkFile("new.txt", 400, 2000, 2000),
        mkFile("old.txt", 100, 100),
      ]),
      mkDir("cache\\deep", [mkFile("hit.dat", 600, 2100, 2100)]),
    ]);
    return resultOf(root, 3, 3, 1100);
  }

  it("mtime 时间窗过滤 + 目录聚合", () => {
    saveSession(session(), "D:\\proj", "sess-g");
    const r = growthReport("sess-g", {
      since: 1500,
      by: "mtime",
      depth: 3,
      top: 10,
    }) as Record<string, any>;
    expect(r.status).toBe("completed");
    expect(r.total_files).toBe(2);
    expect(r.total_bytes).toBe(1000);
    const dirs: any[] = r.top_dirs;
    expect(dirs[0].dir.endsWith("deep")).toBe(true); // 600
    expect(dirs[1].dir.endsWith("docs")).toBe(true); // 400
    expect(r.top_files[0].path.endsWith("hit.dat")).toBe(true);
  });

  it("until 上界生效", () => {
    saveSession(session(), "D:\\proj", "sess-g2");
    const r = growthReport("sess-g2", {
      since: 1500,
      until: 2050,
      by: "mtime",
      depth: 3,
      top: 10,
    }) as Record<string, any>;
    expect(r.total_files).toBe(1); // 2100 的 hit.dat 被排除
    expect(r.top_dirs[0].dir.endsWith("docs")).toBe(true);
  });

  it("ctime 过滤可用（新采集字段）", () => {
    saveSession(session(), "D:\\proj", "sess-g3");
    const r = growthReport("sess-g3", {
      since: 1500,
      by: "ctime",
      depth: 3,
      top: 10,
    }) as Record<string, any>;
    expect(r.total_files).toBe(2);
    expect(r.by).toBe("ctime");
  });

  it("无 ctime 数据且零命中时给出回退提示", () => {
    // 手工构造无 ctime 的会话：老数据（mtime 有值，ctime 未采集）
    const root = mkDir("D:\\proj", [mkDir("docs", [mkFile("a", 1, 100)])]);
    saveSession(resultOf(root, 1, 2, 1), "D:\\proj", "sess-old");
    expect(() =>
      growthReport("sess-old", { since: 50, by: "ctime", depth: 3, top: 10 })
    ).toThrow(/ctime/);
  });

  it("归档会话（blob 路径）同样可出增长报告", () => {
    // 两次保存 → 第一次的会话转档为 gzip blob
    saveSession(session(), "D:\\proj", "sess-ga");
    saveSession(session(), "D:\\proj", "sess-gb");
    const r = growthReport("sess-ga", {
      since: 1500,
      by: "mtime",
      depth: 3,
      top: 10,
    }) as Record<string, any>;
    expect(r.total_files).toBe(2);
    expect(r.total_bytes).toBe(1000);
    // 显示路径带原始大小写
    expect(r.top_files[0].path).toBe("cache\\deep\\hit.dat");
  });
});

describe("walk 扫描器 ctime 采集（真实临时目录）", () => {
  it("文件与目录节点均带创建时间", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-walk-ct-"));
    fs.writeFileSync(path.join(dir, "f1.txt"), "x");
    const sub = path.join(dir, "sub");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "f2.txt"), "yy");
    const r = await scanViaWalk(dir, [], []);
    const f1 = r.root.children!.get("f1.txt")!;
    expect(f1.ctime).toBeGreaterThan(0);
    const subNode = r.root.children!.get("sub")!;
    expect(subNode.ctime).toBeGreaterThan(0);
    expect(subNode.children!.get("f2.txt")!.ctime).toBeGreaterThan(0);
  });
});
