/** undo-manager + file-operator + 回收站往返测试（win32 真实回收站）。 */

import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UndoManager } from "../src/operator/undo-manager.js";
import {
  FileOperator,
  executeUndo,
  chunkSources,
  CHUNK_CHAR_LIMIT,
} from "../src/operator/file-operator.js";
import { emptyRecycleBinForOp, parseIFile } from "../src/operator/recycle-bin.js";
import { recycleBinAvailable, SKIP_RB_MSG } from "./helpers.js";

let dir: string;
let dbFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-op-"));
  dbFile = path.join(dir, "op_log.db");
});

function makeTree(): string {
  // src/ 下建文件与小树
  const src = path.join(dir, "src");
  fs.mkdirSync(path.join(src, "sub"), { recursive: true });
  fs.writeFileSync(path.join(src, "a.txt"), "alpha content");
  fs.writeFileSync(path.join(src, "sub", "b.txt"), "beta");
  return src;
}

const maybeWin = process.platform === "win32" ? describe : describe.skip;

describe("chunkSources 批量分片（SHFileOperationW pFrom 缓冲上限防护）", () => {
  it("小批量单片不分", () => {
    const chunks = chunkSources(["C:\\a\\1.txt", "C:\\a\\2.txt"]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(2);
  });

  it("超 400 条按数量切片，条目不丢不重", () => {
    const srcs = Array.from({ length: 1003 }, (_, i) => `C:\\data\\f${i}.txt`);
    const chunks = chunkSources(srcs);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.every((c) => c.length <= 400)).toBe(true);
    expect(chunks.flat().length).toBe(1003);
    expect(new Set(chunks.flat()).size).toBe(1003);
  });

  it("超字符预算按体积切片", () => {
    // 每条约 110 字符：280 条 ≈ 30.8K > 30K → 至少 2 片
    const long = "C:\\" + "d".repeat(100);
    const srcs = Array.from({ length: 280 }, (_, i) => `${long}\\f${String(i).padStart(4, "0")}.txt`);
    const chunks = chunkSources(srcs);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      const chars = c.reduce((acc, s) => acc + s.length + 1, 0);
      expect(chars).toBeLessThanOrEqual(CHUNK_CHAR_LIMIT);
    }
    expect(chunks.flat().length).toBe(280);
  });

  it("不同盘符分开切片（各盘独立快照比对）", () => {
    if (process.platform !== "win32") return;
    const c = path.parse(path.resolve("C:\\x")).root;
    const chunks = chunkSources([`${c}a.txt`, `${c}b.txt`, "D:\\c.txt"]);
    expect(chunks).toHaveLength(2);
    expect(chunks.some((ch) => ch.includes("D:\\c.txt"))).toBe(true);
  });
});

maybeWin("UndoManager", () => {
  it("日志批次：插入→更新→查询", () => {
    const undo = new UndoManager(dbFile);
    const ids = undo.logBatch("u1", "DELETE", [{ source_path: "C:\\x.txt" }], "sess");
    expect(ids).toHaveLength(1);
    undo.updateEntry(ids[0]!, { status: "DONE", recycle_bin_name: "$R123" });
    const row = undo.getEntry(ids[0]!)!;
    expect(row.status).toBe("DONE");
    expect(row.recycle_bin_name).toBe("$R123");
    expect(undo.getBatch("u1")).toHaveLength(1);
    expect(undo.listOps(5)[0]!.op_uuid).toBe("u1");
    undo.close();
  });

  it("超期归档转存 .json.gz 并删除", () => {
    const undo = new UndoManager(dbFile, -1 / 86400); // 保留期为负 → 全部超期（避开秒级边界）
    undo.logBatch("old", "MOVE", [{ source_path: "C:\\a", dest_path: "D:\\a" }]);
    const archiveDir = path.join(dir, "archive");
    const n = undo.archiveExpired(archiveDir);
    expect(n).toBe(1);
    expect(undo.listOps(10)).toHaveLength(0);
    const gz = fs.readdirSync(archiveDir).find((f) => f.endsWith(".json.gz"));
    expect(gz).toBeTruthy();
    undo.close();
  });
});

maybeWin("FileOperator 删除→回收站→撤销（真实回收站往返）", () => {
  it("删除捕获精确 $R 映射，撤销物理还原", () => {
    if (!recycleBinAvailable()) return console.warn(`[skip] ${SKIP_RB_MSG}`);
    const src = makeTree();
    const target = path.join(src, "a.txt");
    const undo = new UndoManager(dbFile);
    const op = new FileOperator(undo);

    const result = op.delete([target]);
    expect(result.status).toBe("completed");
    expect(fs.existsSync(target)).toBe(false);
    const binName = result.results[0]!.recycle_bin_name!;
    expect(binName.startsWith("$R")).toBe(true);

    // 日志含精确映射
    const row = undo.getEntry(result.op_uuid ? undo.listOps(1)[0]!.id : 1)!;
    expect(row.recycle_path?.endsWith(binName)).toBe(true);
    expect(row.recycle_info_name!.startsWith("$I")).toBe(true);

    // 撤销 → 物理还原
    const undoResult = executeUndo(row.id, undo);
    expect(undoResult.status).toBe("success");
    expect(fs.readFileSync(target, "utf-8")).toBe("alpha content");
    undo.close();
  });

  it("move 与 copy 及其撤销语义", () => {
    const src = makeTree();
    const destDir = path.join(dir, "dest");
    fs.mkdirSync(destDir);
    const undo = new UndoManager(dbFile);
    const op = new FileOperator(undo);

    // COPY：撤销 = 副本进回收站
    const cp = op.copy([path.join(src, "a.txt")], destDir);
    expect(cp.status).toBe("completed");
    expect(fs.existsSync(path.join(destDir, "a.txt"))).toBe(true);
    const cpRow = undo.getBatch(cp.op_uuid)[0]!;
    executeUndo(cpRow.id, undo);
    expect(fs.existsSync(path.join(destDir, "a.txt"))).toBe(false);

    // MOVE：撤销 = 移回原位
    const mv = op.move([path.join(src, "sub")], destDir);
    expect(mv.status).toBe("completed");
    expect(fs.existsSync(path.join(src, "sub"))).toBe(false);
    const mvRow = undo.getBatch(mv.op_uuid)[0]!;
    const r = executeUndo(mvRow.id, undo);
    expect(r.status).toBe("success");
    expect(fs.existsSync(path.join(src, "sub", "b.txt"))).toBe(true);
    undo.close();
  });

  it("compress 生成 ZIP，撤销后产物消失", () => {
    const src = makeTree();
    const undo = new UndoManager(dbFile);
    const op = new FileOperator(undo);
    const result = op.compress([src]);
    expect(result.status).toBe("completed");
    const zipPath = result.results[0]!.dest!;
    expect(fs.existsSync(zipPath)).toBe(true);
    const row = undo.getBatch(result.op_uuid)[0]!;
    executeUndo(row.id, undo);
    expect(fs.existsSync(zipPath)).toBe(false);
    undo.close();
  });

  it("保护路径直接拒绝", () => {
    const src = makeTree();
    const undo = new UndoManager(dbFile);
    const op = new FileOperator(undo, (p) => p.toLowerCase().includes("src"));
    expect(() => op.delete([path.join(src, "a.txt")])).toThrow(/保护列表/);
    undo.close();
  });

  it("受控清空：仅删指定 op 的条目且校验原始路径", { timeout: 20000 }, () => {
    if (!recycleBinAvailable()) return console.warn(`[skip] ${SKIP_RB_MSG}`);
    const src = makeTree();
    const target = path.join(src, "a.txt");
    const undo = new UndoManager(dbFile);
    const op = new FileOperator(undo);
    const result = op.delete([target]);
    expect(result.status).toBe("completed");

    const out = emptyRecycleBinForOp(result.op_uuid, undo) as Record<string, any>;
    expect(out.status).toBe("completed");
    expect(out.emptied).toBe(1);
    expect(out.mismatch).toBe(0);
    expect(fs.existsSync(target)).toBe(false); // 已永久删除

    // 再次清空 → 条目已 EMPTIED，不再匹配
    const again = emptyRecycleBinForOp(result.op_uuid, undo) as Record<string, any>;
    expect(again.emptied).toBe(0);
    undo.close();
  });

  it("混合批次：缺失源跳过披露，存在源正常入回收站", { timeout: 20000 }, () => {
    if (!recycleBinAvailable()) return console.warn(`[skip] ${SKIP_RB_MSG}`);
    const src = makeTree();
    const ghost = path.join(dir, "ghost-does-not-exist.txt");
    const undo = new UndoManager(dbFile);
    const op = new FileOperator(undo);

    const result = op.delete([path.join(src, "a.txt"), ghost, path.join(src, "sub")]);
    // 缺失不再中止全批
    expect(result.status).toBe("completed");
    expect(result.summary).toEqual({ total: 3, done: 2, failed: 0, skipped: 1 });
    const skipEntry = result.results.find((r) => r.source === ghost)!;
    expect(skipEntry.status).toBe("skipped");
    expect(skipEntry.error).toContain("不存在");
    // 存在源正常删除
    expect(fs.existsSync(path.join(src, "a.txt"))).toBe(false);
    expect(fs.existsSync(path.join(src, "sub"))).toBe(false);
    // 台账：skipped 条目留痕
    const rows = undo.getBatch(result.op_uuid);
    expect(rows.find((r) => r.source_path === ghost)?.status).toBe("SKIPPED");
    // 撤销：skipped 条目进 skipped 列表，其余正常还原
    const undoResult = executeUndo(rows[0]!.id, undo);
    expect(undoResult.status).toBe("success");
    expect(undoResult.skipped?.some((s) => s.source === ghost)).toBe(true);
    expect(fs.readFileSync(path.join(src, "a.txt"), "utf-8")).toBe("alpha content");
    undo.close();
  });

  it("大批量：1000+ 文件分片删除全部成功且逐条有 $R 映射", { timeout: 120_000 }, () => {
    if (!recycleBinAvailable()) return console.warn(`[skip] ${SKIP_RB_MSG}`);
    // 构造 1000 个文件（超过单片 400 条限制，触发分片）
    const root = path.join(dir, "bulk");
    fs.mkdirSync(root, { recursive: true });
    const files: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const f = path.join(root, `f${String(i).padStart(4, "0")}.txt`);
      fs.writeFileSync(f, "x");
      files.push(f);
    }
    const undo = new UndoManager(dbFile);
    const op = new FileOperator(undo);
    const result = op.delete(files);

    expect(result.status).toBe("completed");
    expect(result.summary).toEqual({ total: 1000, done: 1000, failed: 0, skipped: 0 });
    expect(result.moved_bytes).toBe(1000);
    // 逐条都有 error 字段缺失 = done；失败的必须有 error（不静默）
    for (const r of result.results) {
      if (r.status === "failed") expect(r.error).toBeTruthy();
    }
    // 全部物理进回收站
    expect(files.every((f) => !fs.existsSync(f))).toBe(true);
    // 台账逐条 $R 映射
    const rows = undo.getBatch(result.op_uuid);
    expect(rows.filter((r) => r.status === "DONE" && r.recycle_bin_name)).toHaveLength(1000);
    undo.close();
  }, 150_000);
});

describe("parseIFile（合成 $I 字节）", () => {
  it("v2 长度前缀布局", () => {
    const rawPath = Buffer.from("C:\\Users\\tom\\file.txt", "utf16le");
    const header = Buffer.alloc(24);
    header.writeBigUInt64LE(2n, 0); // version
    header.writeBigUInt64LE(4096n, 8); // size
    header.writeBigUInt64LE(132700000000000000n, 16); // filetime
    const lenPrefix = Buffer.alloc(4);
    lenPrefix.writeUInt32LE(rawPath.length / 2 + 1, 0); // 含结尾 NUL
    const data = Buffer.concat([header, lenPrefix, rawPath, Buffer.alloc(2)]);
    const info = parseIFile(data);
    expect(info).not.toBeNull();
    expect(info!.size).toBe(4096n);
    expect(info!.original_path).toBe("C:\\Users\\tom\\file.txt");
  });

  it("v2 NUL 终止布局（Vista/7）", () => {
    const rawPath = Buffer.from("D:\\old\\thing.dat", "utf16le");
    const header = Buffer.alloc(24);
    header.writeBigUInt64LE(2n, 0);
    const data = Buffer.concat([header, rawPath, Buffer.alloc(2), Buffer.alloc(4)]);
    const info = parseIFile(data);
    expect(info).not.toBeNull();
    expect(info!.original_path).toBe("D:\\old\\thing.dat");
  });

  it("非法版本返回 null", () => {
    const data = Buffer.alloc(32);
    data.writeBigUInt64LE(7n, 0);
    expect(parseIFile(data)).toBeNull();
  });
});
