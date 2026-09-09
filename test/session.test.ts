/** 会话持久化与新鲜度账本（op_count 三层防线）测试：SQLite 会话库版。 */

import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import {
  saveSession,
  loadSessionByRoot,
  loadSessionById,
  loadLatestSession,
  listSessions,
  exportSessionToFile,
  mergeRescanSubtree,
  recordOperation,
  recordOperationForSources,
  resetFreshness,
  treeFromJSON,
  treeToJSON,
  rootHashOf,
  closeSessionStore,
  type StoredSession,
} from "../src/state/session.js";
import { findNode } from "../src/cli/session-query.js";
import type { ScanResult } from "../src/types.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ds-sess-"));
  process.env["DISK_SENSE_HOME"] = home;
  closeSessionStore();
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
    const { session: s } = saveSession(fakeResult("D:\\proj"), "D:\\proj", "sess-x");
    expect(s.op_count).toBe(0);
    const loaded = loadSessionByRoot("d:/proj");
    expect(loaded).not.toBeNull();
    expect(loaded!.session_id).toBe("sess-x");
    expect(loaded!.tree.children!["docs"]!.children!["a.txt"]!.size).toBe(500);
  });

  it("裸盘符 root_path 归一化（回归：resolve('D:') 不得锚到 cwd）", () => {
    const { session: s } = saveSession(fakeResult("D:\\"), "D:", "sess-bare");
    // path.resolve("D:") 在 Windows 上会解析为 D 盘当前工作目录，
    // 持久化前必须先归一化为 "D:\"
    expect(s.root_path.toLowerCase()).toBe("d:\\");
    // 会话定位也须基于归一化后的根，保证 loadSessionByRoot 可回查
    expect(loadSessionByRoot("D:")).not.toBeNull();
    expect(loadSessionByRoot("d:/")).not.toBeNull();
    // recordOperation 用原始 "D:" 定位同一会话
    const r = recordOperation("D:", "DELETE", ["D:\\docs\\a.txt"]);
    expect(r).not.toBeNull();
    expect(r!.session.session_id).toBe("sess-bare");
  });

  it("loadLatestSession 取最近扫描的 live 会话", () => {
    saveSession(fakeResult("D:\\a"), "D:\\a", "sess-a");
    saveSession(fakeResult("E:\\b"), "E:\\b", "sess-b");
    expect(loadLatestSession()!.session_id).toBe("sess-b");
  });

  it("loadSessionById 能找到归档会话（diff 基线入口）", () => {
    saveSession(fakeResult("D:\\proj"), "D:\\proj", "sess-old");
    saveSession(fakeResult("D:\\proj"), "D:\\proj", "sess-new");
    const old = loadSessionById("sess-old");
    expect(old).not.toBeNull();
    expect(old!.archived).toBe(true);
    expect(old!.tree.children!["docs"]).toBeDefined();
  });
});

describe("快照版本化（覆盖前自动归档）", () => {
  it("二次扫描：旧会话归档、新会话 live、返回归档预警", () => {
    const first = saveSession(fakeResult("D:\\proj"), "D:\\proj", "sess-1");
    expect(first.archived).toBeNull();
    const second = saveSession(fakeResult("D:\\proj"), "D:\\proj", "sess-2");
    expect(second.archived).not.toBeNull();
    expect(second.archived!.session_id).toBe("sess-1");
    // live 语义：按根加载拿到新会话
    expect(loadSessionByRoot("D:\\proj")!.session_id).toBe("sess-2");
    // 归档语义：按 id 仍可加载旧会话（含树）
    expect(loadSessionById("sess-1")!.archived).toBe(true);
  });

  it("保留策略：每根路径最多保留 archiveKeep（默认 5）份归档", () => {
    // 8 次扫描 → 1 live + 7 归档 → 裁剪最旧 2 份 → 1 live + 5 归档
    for (let i = 1; i <= 8; i++) {
      saveSession(fakeResult("D:\\proj"), "D:\\proj", `sess-${i}`);
    }
    const all = listSessions("D:\\proj", true).sessions;
    expect(all.filter((s) => !s.archived)).toHaveLength(1);
    expect(all.filter((s) => s.archived)).toHaveLength(5);
    // 最旧的 sess-1、sess-2 被裁剪
    expect(all.find((s) => s.session_id === "sess-1")).toBeUndefined();
    expect(all.find((s) => s.session_id === "sess-2")).toBeUndefined();
    expect(all.find((s) => s.session_id === "sess-3")).toBeDefined();
  });

  it("list_sessions 根路径过滤 + 默认仅 live", () => {
    saveSession(fakeResult("D:\\proj"), "D:\\proj", "sess-d");
    saveSession(fakeResult("E:\\data"), "E:\\data", "sess-e");
    saveSession(fakeResult("E:\\data"), "E:\\data", "sess-e2");
    const liveOnly = listSessions().sessions;
    expect(liveOnly.map((s) => s.session_id).sort()).toEqual(["sess-d", "sess-e2"]);
    const eAll = listSessions("E:\\data", true).sessions;
    expect(eAll).toHaveLength(2);
    // live 优先展示；归档可按 id 定位
    expect(eAll[0]!.archived).toBe(false);
    expect(eAll.find((s) => s.session_id === "sess-e")!.archived).toBe(true);
  });

  it("export_session 导出 .json.gz 且可解压往返", () => {
    saveSession(fakeResult("D:\\proj"), "D:\\proj", "sess-x");
    const r = exportSessionToFile("sess-x");
    expect(r.status).toBe("ok");
    expect(r.out.endsWith(".json.gz")).toBe(true);
    expect(fs.existsSync(r.out)).toBe(true);
    const restored = JSON.parse(
      gunzipSync(fs.readFileSync(r.out)).toString("utf-8")
    ) as StoredSession;
    expect(restored.session_id).toBe("sess-x");
    expect(restored.tree.children!["docs"]!.children!["a.txt"]!.size).toBe(500);
  });

  it("旧版单文件 JSON 懒迁移：导入后改名 .migrated", () => {
    // 手工构造旧版 sessions/<hash>.json
    const legacyDir = path.join(home, "sessions");
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacy = saveSessionViaLegacy(fakeResult("D:\\legacy"), "D:\\legacy", "sess-legacy");
    fs.writeFileSync(
      path.join(legacyDir, `${rootHashOf("D:\\legacy")}.json`),
      JSON.stringify(legacy)
    );
    closeSessionStore(); // 触发下次打开时迁移
    const loaded = loadSessionByRoot("D:\\legacy");
    expect(loaded).not.toBeNull();
    expect(loaded!.session_id).toBe("sess-legacy");
    expect(loaded!.tree.children!["docs"]).toBeDefined();
    // 原文件改名留底（不删除）
    expect(
      fs.existsSync(path.join(legacyDir, `${rootHashOf("D:\\legacy")}.json.migrated`))
    ).toBe(true);
  });
});

/** 直接构造 StoredSession（模拟旧版文件内容，绕过 SQLite）。 */
function saveSessionViaLegacy(result: ScanResult, rootPath: string, id: string): StoredSession {
  return {
    session_id: id,
    root_path: path.resolve(rootPath),
    mode: "walk",
    scanned_at: 1000,
    op_count: 0,
    recent_ops: [],
    files: result.files,
    dirs: result.dirs,
    total_bytes: result.totalBytes,
    skipped_paths: [],
    orphans: 0,
    elapsed_sec: 0,
    archived: false,
    archived_at: null,
    tree: treeToJSON(result.root),
  };
}

describe("recordOperation（会话级 + 节点级记账）", () => {
  let session: StoredSession;
  beforeEach(() => {
    const r = saveSession(fakeResult("D:\\proj"), "D:\\proj", "sess-y");
    session = r.session;
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
    // 大小写归一化后定位同一会话
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

describe("mergeRescan（SQLite 子树合并）", () => {
  it("替换子树行并沿祖先链重算体积、重置账本", () => {
    const { session } = saveSession(fakeResult("D:\\proj"), "D:\\proj", "sess-r");
    recordOperation("D:\\proj", "DELETE", ["D:\\proj\\docs\\a.txt"]);
    // 重扫 docs：a.txt 消失，新增 b.txt (300)
    const mk = (name: string): any => ({
      name, size: 0, mtime: 200, atime: 200, ctime: 50, isDir: true, isLink: false,
      cacheType: null, children: new Map(),
    });
    const subRoot = mk("docs");
    subRoot.children.set("b.txt", { ...mk("b.txt"), isDir: false, size: 300, children: undefined });
    mergeRescanSubtree(session, "D:\\proj\\docs", {
      root: subRoot,
      files: 1,
      dirs: 1,
      totalBytes: 300,
    });
    const loaded = loadSessionByRoot("D:\\proj")!;
    expect(loaded.op_count).toBe(0);
    expect(loaded.tree.stale).toBeUndefined();
    const docs = loaded.tree.children!["docs"]!;
    expect(docs.children!["b.txt"]!.size).toBe(300);
    expect(docs.children!["a.txt"]).toBeUndefined();
    expect(docs.size).toBe(300);
    expect(loaded.tree.size).toBe(300);
  });

  it("路径不在快照中报错", () => {
    const { session } = saveSession(fakeResult("D:\\proj"), "D:\\proj", "sess-r2");
    const mk = (name: string): any => ({ name, size: 0, mtime: 0, atime: 0, isDir: true, isLink: false, cacheType: null, children: new Map() });
    expect(() =>
      mergeRescanSubtree(session, "D:\\proj\\nope", { root: mk("nope"), files: 0, dirs: 1, totalBytes: 0 })
    ).toThrow("不在快照");
  });
});

describe("v1 → v2 结构升级（含 rel/parent_low 冗余列的旧库）", () => {
  it("打开即升级：数据保真、冗余列移除", () => {
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const dbPath = path.join(home, "sessions.db");
    fs.mkdirSync(home, { recursive: true });
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY, root_path TEXT NOT NULL, root_hash TEXT NOT NULL,
        mode TEXT NOT NULL, scanned_at REAL NOT NULL, op_count INTEGER NOT NULL DEFAULT 0,
        recent_ops TEXT NOT NULL DEFAULT '[]', files INTEGER NOT NULL DEFAULT 0,
        dirs INTEGER NOT NULL DEFAULT 0, total_bytes INTEGER NOT NULL DEFAULT 0,
        skipped_paths TEXT NOT NULL DEFAULT '[]', orphans INTEGER NOT NULL DEFAULT 0,
        elapsed_sec REAL NOT NULL DEFAULT 0, fingerprint TEXT, entity_detail TEXT,
        archived INTEGER NOT NULL DEFAULT 0, archived_at REAL
      );
      CREATE TABLE nodes (
        session_id TEXT NOT NULL, rel_low TEXT NOT NULL, rel TEXT NOT NULL,
        name TEXT NOT NULL, parent_low TEXT NOT NULL, size INTEGER NOT NULL,
        mtime REAL NOT NULL DEFAULT 0, atime REAL NOT NULL DEFAULT 0, ctime REAL,
        is_dir INTEGER NOT NULL DEFAULT 0, is_link INTEGER NOT NULL DEFAULT 0,
        cache_type TEXT, stale INTEGER NOT NULL DEFAULT 0, stale_since REAL,
        PRIMARY KEY (session_id, rel_low)
      ) WITHOUT ROWID;
    `);
    const ins = raw.prepare(
      `INSERT INTO nodes (session_id, rel_low, rel, name, parent_low, size, mtime, atime, ctime, is_dir)
       VALUES ('sess-v1', ?, ?, ?, ?, 500, 100, 100, NULL, ?)`
    );
    ins.run("", "D:\\Proj", "Proj", "", 1);
    ins.run("docs", "D:\\Proj\\docs", "docs", "", 1);
    ins.run("docs\\a.txt", "D:\\Proj\\docs\\a.txt", "a.txt", "docs", 0);
    raw.prepare(
      `INSERT INTO sessions (session_id, root_path, root_hash, mode, scanned_at, files, dirs, total_bytes)
       VALUES ('sess-v1', 'D:\\Proj', 'x', 'walk', 1, 1, 2, 500)`
    ).run();
    raw.close();

    const loaded = loadSessionById("sess-v1");
    expect(loaded).not.toBeNull();
    expect(loaded!.tree.children!["docs"]!.children!["a.txt"]!.size).toBe(500);
    // 冗余列已移除
    const check = new Database(dbPath);
    const cols = (check.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain("rel");
    expect(cols).not.toContain("parent_low");
    check.close();
  });
});

describe("归档会话只读", () => {
  it("mergeRescan 拒绝归档会话", () => {
    const mk = (name: string): any => ({
      name, size: 0, mtime: 0, atime: 0, isDir: true, isLink: false, cacheType: null, children: new Map(),
    });
    saveSession(fakeResult("D:\\proj"), "D:\\proj", "sess-a1");
    saveSession(fakeResult("D:\\proj"), "D:\\proj", "sess-a2");
    const archivedMeta = loadSessionById("sess-a1")!;
    expect(archivedMeta.archived).toBe(true);
    expect(() =>
      mergeRescanSubtree(archivedMeta, "D:\\proj\\docs", { root: mk("docs"), files: 0, dirs: 1, totalBytes: 0 })
    ).toThrow(/归档会话不可变更/);
  });
});

describe("tree 序列化往返", () => {
  it("TreeNodeJSON 序列化保真（JSON 往返，含 ctime）", () => {
    const { session: s } = saveSession(fakeResult("D:\\x"), "D:\\x", "s");
    const json = JSON.parse(JSON.stringify(s.tree)) as typeof s.tree;
    expect(json.children!["docs"]!.children!["a.txt"]!.size).toBe(500);
    const node = treeFromJSON(json);
    expect(node.children!.get("docs")!.children!.get("a.txt")!.size).toBe(500);
  });
});

describe("findNode（裸盘符根回归：root_path 带尾分隔符不得破坏前缀匹配）", () => {
  it("裸盘符根下可定位子路径；范围外返回 null", () => {
    const { session: s } = saveSession(fakeResult("D:\\"), "D:", "sess-find");
    // root_path = "D:\"，旧实现 rootLow + "\\" 拼出 "d:\\" → 恒 false
    expect(findNode(s, "D:/docs")!.name).toBe("docs");
    expect(findNode(s, "D:\\docs\\a.txt")!.name).toBe("a.txt");
    expect(findNode(s, "D:\\")).not.toBeNull();
    expect(findNode(s, "E:/elsewhere")).toBeNull();
  });

  it("普通目录根行为不变", () => {
    const { session: s } = saveSession(fakeResult("D:\\proj"), "D:\\proj", "sess-find2");
    expect(findNode(s, "D:/proj/docs/a.txt")!.name).toBe("a.txt");
    expect(findNode(s, "D:/proj")).not.toBeNull();
    expect(findNode(s, "D:/other")).toBeNull();
  });
});
