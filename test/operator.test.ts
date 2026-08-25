/** undo-manager + file-operator + 回收站往返测试（win32 真实回收站）。 */

import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UndoManager } from "../src/operator/undo-manager.js";
import { FileOperator, executeUndo } from "../src/operator/file-operator.js";
import { emptyRecycleBinForOp, parseIFile } from "../src/operator/recycle-bin.js";

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
