/** 会话持久化与新鲜度账本（op_count 三层防线）测试。 */

import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  saveSession,
  loadSessionByRoot,
  recordOperation,
  recordOperationForSources,
  resetFreshness,
  treeFromJSON,
  type StoredSession,
} from "../src/state/session.js";
import type { ScanResult } from "../src/types.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ds-sess-"));
  process.env["DISK_SENSE_HOME"] = home;
});

function fakeResult(rootPath: string): ScanResult {
  const mk = (name: string): any => ({
    name,
    size: 0,
    mtime: 100,
    atime: 100,
    isDir: true,
    isLink: false,
    cacheType: null,
    children: new Map(),
  });
  const root = mk(rootPath);
  const docs = mk("docs");
  const file = { ...mk("a.txt"), isDir: false, size: 500, children: undefined };
  docs.children.set("a.txt", file);
  root.children.set("docs", docs);
  return {
    root,
    mode: "walk",
    files: 1,
    dirs: 2,
    totalBytes: 500,
    skippedPaths: [],
    orphans: 0,
    elapsedSec: 0.05,
  };
}

describe("会话持久化", () => {
  it("保存→按根路径加载，op_count 初始为 0", () => {
    const s = saveSession(fakeResult("D:\\proj"), "D:\\proj", "sess-x");
    expect(s.op_count).toBe(0);
    const loaded = loadSessionByRoot("d:/proj");
    expect(loaded).not.toBeNull();
    expect(loaded!.session_id).toBe("sess-x");
    expect(loaded!.tree.children!["docs"]!.children!["a.txt"]!.size).toBe(500);
  });
});

describe("recordOperation（会话级 + 节点级记账）", () => {
  let session: StoredSession;
  beforeEach(() => {
    session = saveSession(fakeResult("D:\\proj"), "D:\\proj", "sess-y");
  });

  it("操作计数递增、recent_ops 记录摘要", () => {
    const r1 = recordOperation("D:\\proj", "DELETE", ["D:\\proj\\docs\\a.txt"], "op-uuid-1");
    expect(r1).not.toBeNull();
    expect(r1!.session.op_count).toBe(1);
    expect(r1!.seq).toBe(1);
    expect(r1!.session.recent_ops[0]!.op_type).toBe("DELETE");
    expect(r1!.session.recent_ops[0]!.op_uuid).toBe("op-uuid-1");

    const r2 = recordOperation("D:/proj", "MOVE", ["D:\\proj\\docs"]);
    expect(r2!.seq).toBe(2);
    // 大小写归一化后定位同一会话文件
    expect(loadSessionByRoot("D:\\Proj")!.op_count).toBe(2);
  });

  it("受影响子树标 stale（祖先链）", () => {
    recordOperation("D:\\proj", "DELETE", ["D:\\proj\\docs\\a.txt"]);
    const loaded = loadSessionByRoot("D:\\proj")!;
    const root = loaded.tree;
    expect(root.stale).toBe(true); // 根在祖先链上
    const docs = root.children!["docs"]!;
    expect(docs.stale).toBe(true);
    const a = docs.children!["a.txt"]!;
    expect(a.stale).toBe(true);
    expect(a.staleSince).toBeGreaterThan(0);
  });

  it("范围外路径不污染树", () => {
    // 自动定位：无会话覆盖 E: 源路径 → 不记账
    const r = recordOperationForSources("DELETE", ["E:\\elsewhere\\x"]);
    expect(r).toBeNull();
    expect(loadSessionByRoot("D:\\proj")!.op_count).toBe(0);
  });

  it("recordOperationForSources 自动定位所属会话", () => {
    const r = recordOperationForSources("DELETE", ["D:\\proj\\docs\\a.txt"], "u9");
    expect(r).not.toBeNull();
    expect(r!.session.session_id).toBe("sess-y");
  });

  it("rescan 归零：resetFreshness 清空计数与 stale", () => {
    recordOperation("D:\\proj", "DELETE", ["D:\\proj\\docs\\a.txt"]);
    resetFreshness("D:\\proj");
    const loaded = loadSessionByRoot("D:\\proj")!;
    expect(loaded.op_count).toBe(0);
    expect(loaded.recent_ops).toHaveLength(0);
    expect(loaded.tree.stale).toBeUndefined();
    expect(loaded.tree.children!["docs"]!.children!["a.txt"]!.stale).toBeUndefined();
  });

  it("recent_ops 环上限 50", () => {
    for (let i = 0; i < 55; i++) {
      recordOperation("D:\\proj", "TOUCH", [`D:\\proj\\f${i}`]);
    }
    const loaded = loadSessionByRoot("D:\\proj")!;
    expect(loaded.recent_ops.length).toBeLessThanOrEqual(50);
    expect(loaded.op_count).toBe(55); // 计数本身单调递增不截断
    expect(loaded.recent_ops.at(-1)!.sources[0]).toBe("D:\\proj\\f54");
  });
});

describe("tree 序列化往返", () => {
  it("TreeNodeJSON 序列化保真（JSON 往返）", () => {
    const s = saveSession(fakeResult("D:\\x"), "D:\\x", "s");
    const json = JSON.parse(JSON.stringify(s.tree)) as typeof s.tree;
    expect(json.children!["docs"]!.children!["a.txt"]!.size).toBe(500);
    const node = treeFromJSON(json);
    expect(node.children!.get("docs")!.children!.get("a.txt")!.size).toBe(500);
  });
});
