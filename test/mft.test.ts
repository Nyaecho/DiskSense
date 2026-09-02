/** mft.ts 纯解析函数测试：用合成 MFT 记录字节验证，无需真实卷/管理员权限。 */

import { describe, expect, it } from "vitest";
import {
  applyFixups,
  buildTree,
  extractMftRuns,
  filetimeToUnix,
  parseMftBuffer,
  parseRecord,
  parseRunlist,
  parseVolumeData,
  type MftRecord,
} from "../src/scanner/mft.js";
import { finalizeTree } from "../src/types.js";

const RECORD_SIZE = 1024;
const EPOCH = 116444736000000000n;

function ft(ts: number): bigint {
  return BigInt(Math.round(ts * 1e7)) + EPOCH;
}

function u64v(v: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}

function fileNameValue(
  parent: number,
  name: string,
  size: number,
  mtime = 1000.0,
  atime = 2000.0
): Buffer {
  return Buffer.concat([
    u64v(parent),
    u64v(0),
    u64v(ft(mtime)),
    u64v(0),
    u64v(ft(atime)), // 创建/修改/MFT修改/访问（布局对齐 Python 版）
    u64v(size),
    u64v(size),
    Buffer.alloc(8), // flags/ea (2×u32)
    Buffer.from([name.length, 1]), // 名长(字符数), namespace=WIN32
    Buffer.from(name, "utf16le"),
  ]);
}

function residentAttr(attrType: number, value: Buffer): Buffer {
  const valueOff = 24;
  let total = valueOff + value.length;
  total += (8 - (total % 8)) % 8;
  const head = Buffer.alloc(valueOff);
  head.writeUInt32LE(attrType, 0);
  head.writeUInt32LE(total, 4);
  // [6..7] nonresident=0/name_len=0 已为 0；name_off/flags/instance @8..13
  head.writeUInt16LE(0, 14); // padding 保持与 Python 版一致
  head.writeUInt32LE(value.length, 16);
  head.writeUInt16LE(valueOff, 20);
  const padTo = (valueOff + value.length) % 8;
  return Buffer.concat([head, value, Buffer.alloc(padTo === 0 ? 0 : 8 - padTo)]);
}

function makeRecord(
  attrs: Buffer,
  opts: { isDir?: boolean; inUse?: boolean; base?: number } = {}
): Buffer {
  const { isDir = false, inUse = true, base = 0 } = opts;
  const flags = (inUse ? 1 : 0) | (isDir ? 2 : 0);
  const usaOff = 0x30;
  const usaCnt = 3;
  const attrsOff = 0x38;
  const used = attrsOff + attrs.length;
  const buf = Buffer.alloc(RECORD_SIZE);
  buf.write("FILE", 0, "latin1");
  buf.writeUInt16LE(usaOff, 4);
  buf.writeUInt16LE(usaCnt, 6);
  buf.writeUInt16LE(1, 0x10); // sequence
  buf.writeUInt16LE(1, 0x12); // link_count
  buf.writeUInt16LE(attrsOff, 0x14);
  buf.writeUInt16LE(flags, 0x16);
  buf.writeUInt32LE(used, 0x18);
  buf.writeUInt32LE(RECORD_SIZE, 0x1c);
  buf.writeBigInt64LE(BigInt(base), 0x20);
  attrs.copy(buf, attrsOff);
  const tag = 0x1234;
  buf.writeUInt16LE(tag, usaOff);
  buf.writeUInt16LE(0x1111, usaOff + 2);
  buf.writeUInt16LE(0x2222, usaOff + 4);
  buf.writeUInt16LE(tag, 510); // 每扇区尾部写 tag，Fixup 后还原
  buf.writeUInt16LE(tag, 1022);
  return buf;
}

function fileRecord(
  parent: number,
  name: string,
  size: number,
  mtime = 1000.0,
  atime = 2000.0,
  kw: { isDir?: boolean; inUse?: boolean; base?: number } = {}
): Buffer {
  return makeRecord(residentAttr(0x30, fileNameValue(parent, name, size, mtime, atime)), kw);
}

describe("parseRecord", () => {
  it("解析文件记录", () => {
    const rec = parseRecord(fileRecord(5, "data.bin", 1234));
    expect(rec).not.toBeNull();
    expect(rec!.parent).toBe(5);
    expect(rec!.name).toBe("data.bin");
    expect(rec!.size).toBe(1234);
    expect(rec!.mtime).toBeCloseTo(1000.0);
    expect(rec!.atime).toBeCloseTo(2000.0);
    expect(rec!.flags).toBe(0);
  });

  it("解析目录记录", () => {
    const rec = parseRecord(fileRecord(5, "Windows", 0, 1000, 2000, { isDir: true }));
    expect(rec).not.toBeNull();
    expect(rec!.flags & 1).toBe(1);
  });

  it("未使用记录跳过", () => {
    expect(parseRecord(fileRecord(5, "x", 1, 1000, 2000, { inUse: false }))).toBeNull();
  });

  it("扩展记录跳过", () => {
    expect(parseRecord(fileRecord(5, "x", 1, 1000, 2000, { base: 0x50000 }))).toBeNull();
  });

  it("损坏 Fixup 拒绝", () => {
    const buf = Buffer.from(fileRecord(5, "x", 1));
    buf[510] = 0xde;
    buf[511] = 0xad; // 破坏扇区尾校验
    expect(applyFixups(buf)).toBeNull();
  });

  it("错误魔数拒绝", () => {
    expect(applyFixups(Buffer.alloc(1024))).toBeNull();
  });

  it("含 $ATTRIBUTE_LIST 的记录仍提取驻留 $FILE_NAME", () => {
    const attrs = Buffer.concat([
      residentAttr(0x20, Buffer.alloc(32)),
      residentAttr(0x30, fileNameValue(5, "y", 9)),
    ]);
    const rec = parseRecord(makeRecord(attrs));
    expect(rec).not.toBeNull();
    expect(rec!.name).toBe("y");
    expect(rec!.parent).toBe(5);
  });

  it("仅含 $ATTRIBUTE_LIST 无 $FILE_NAME 的记录返回 null", () => {
    const attrs = residentAttr(0x20, Buffer.alloc(32));
    expect(parseRecord(makeRecord(attrs))).toBeNull();
  });

  function fnValue(parent: number, name: string, size: number, namespace: number): Buffer {
    return Buffer.concat([
      u64v(parent),
      u64v(0),
      u64v(ft(1.0)),
      u64v(0),
      u64v(ft(1.0)),
      u64v(size),
      u64v(size),
      Buffer.alloc(8),
      Buffer.from([name.length, namespace]),
      Buffer.from(name, "utf16le"),
    ]);
  }

  it("Win32 长名优先于 DOS 短名", () => {
    const dos = residentAttr(0x30, fnValue(5, "LONGFI~1.TXT", 7, 2));
    const win32 = residentAttr(0x30, fnValue(5, "LongFileName.txt", 7, 1));
    const rec = parseRecord(makeRecord(Buffer.concat([dos, win32])));
    expect(rec).not.toBeNull();
    expect(rec!.name).toBe("LongFileName.txt");
  });

  it("仅 DOS 名回退", () => {
    const dos = residentAttr(0x30, fnValue(5, "PROGRA~1", 0, 2));
    const rec = parseRecord(makeRecord(dos));
    expect(rec).not.toBeNull();
    expect(rec!.name).toBe("PROGRA~1");
  });

  it("Unicode 名称", () => {
    const rec = parseRecord(fileRecord(5, "新建文件夹", 100));
    expect(rec).not.toBeNull();
    expect(rec!.name).toBe("新建文件夹");
  });
});

describe("parseVolumeData", () => {
  /** 按权威 DWORD 布局构造（winioctl.h + Win11 实测）。 */
  function packVolumeData(o: {
    sectors?: number;
    totalClusters?: number;
    free?: number;
    reserved?: number;
    sectorSize?: number;
    clusterSize?: number;
    frs?: number;
    cpfrs?: number;
    mftVdl?: number;
    mftStart?: number;
  } = {}): Buffer {
    const b = Buffer.alloc(96);
    b.writeBigInt64LE(0x06068b25068b1539n, 0);
    b.writeBigInt64LE(BigInt(o.sectors ?? 251_672_575), 8);
    b.writeBigInt64LE(BigInt(o.totalClusters ?? 31_459_071), 16);
    b.writeBigInt64LE(BigInt(o.free ?? 5_374_210), 24);
    b.writeBigInt64LE(BigInt(o.reserved ?? 663_007), 32);
    b.writeUInt32LE(o.sectorSize ?? 512, 40);
    b.writeUInt32LE(o.clusterSize ?? 0x100000, 44);
    b.writeUInt32LE(o.frs ?? 1024, 48);
    b.writeUInt32LE(o.cpfrs ?? 0, 52);
    b.writeBigInt64LE(BigInt(o.mftVdl ?? 1_232_076_800), 56);
    b.writeBigInt64LE(BigInt(o.mftStart ?? 786_432), 64);
    b.writeBigInt64LE(2n, 72);
    b.writeBigInt64LE(BigInt(23_592_000), 80);
    b.writeBigInt64LE(BigInt(23_643_200), 88);
    return b;
  }

  it("往返解析（Win11 实测数据，@44 簇字段失真时仍正确推导）", () => {
    const info = parseVolumeData(packVolumeData());
    expect(info.bytesPerCluster).toBe(4096);
    expect(info.bytesPerFrs).toBe(1024);
    expect(info.mftValidDataLength).toBe(1_232_076_800);
    expect(info.mftStartLcn).toBe(786_432);
  });

  it("经典布局（@44 为真实簇大小）同样正确", () => {
    const info = parseVolumeData(packVolumeData({ clusterSize: 4096 }));
    expect(info.bytesPerCluster).toBe(4096);
  });

  it("短缓冲拒绝", () => {
    expect(() => parseVolumeData(Buffer.alloc(88))).toThrow();
  });

  it("推导失败拒绝（totalClusters=0）", () => {
    expect(() => parseVolumeData(packVolumeData({ totalClusters: 0 }))).toThrow();
  });

  it("非法 FRS 拒绝", () => {
    expect(() => parseVolumeData(packVolumeData({ frs: 1000 }))).toThrow();
    expect(() => parseVolumeData(packVolumeData({ frs: 0 }))).toThrow();
  });

  it("非法 MFT 定位拒绝", () => {
    expect(() => parseVolumeData(packVolumeData({ mftVdl: 0 }))).toThrow();
    expect(() => parseVolumeData(packVolumeData({ mftStart: -1 }))).toThrow();
  });
});

describe("parseRunlist", () => {
  it("单个区段（lenLen=1, offLen=3）", () => {
    const b = Buffer.from([0x31, 0x40, 0x00, 0x00, 0x0c, 0x00]);
    expect(parseRunlist(b, 0)).toEqual([{ startLcn: 0xc0000, clusters: 0x40 }]);
  });

  it("多区段含负相对偏移", () => {
    const b = Buffer.from([0x31, 0x40, 0x00, 0x00, 0x0c, 0x11, 0x10, 0xf0, 0x00]);
    const runs = parseRunlist(b, 0);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual({ startLcn: 0xc0000, clusters: 0x40 });
    expect(runs[1]).toEqual({ startLcn: 0xc0000 - 0x10, clusters: 0x10 });
  });

  it("终止符结束 / 稀疏区段停止 / 越界停止", () => {
    expect(parseRunlist(Buffer.from([0x00]), 0)).toEqual([]);
    expect(parseRunlist(Buffer.from([0x21]), 0)).toEqual([]);
    expect(parseRunlist(Buffer.from([0x31, 0x40]), 0)).toEqual([]);
  });
});

describe("extractMftRuns", () => {
  function mftRecord0(runlist: Buffer): Buffer {
    const attr = Buffer.alloc(0x50);
    attr.writeUInt32LE(0x80, 0); // $DATA
    attr.writeUInt32LE(attr.length, 4);
    attr.writeUInt8(1, 8); // nonResident
    attr.writeUInt32LE(0x40, 0x20); // runlist 偏移（相对属性头）
    runlist.copy(attr, 0x40);
    return makeRecord(Buffer.concat([residentAttr(0x30, fileNameValue(5, "$MFT", 0)), attr]));
  }

  it("提取 $DATA runlist", () => {
    const runs = extractMftRuns(mftRecord0(Buffer.from([0x31, 0x40, 0x00, 0x00, 0x0c, 0x00])));
    expect(runs).toEqual([{ startLcn: 0xc0000, clusters: 0x40 }]);
  });

  it("非 $MFT 魔数返回 null", () => {
    expect(extractMftRuns(Buffer.alloc(1024))).toBeNull();
  });

  it("驻留 $DATA（无 runlist）返回 null", () => {
    const attr = Buffer.alloc(0x50);
    attr.writeUInt32LE(0x80, 0);
    attr.writeUInt32LE(attr.length, 4);
    attr.writeUInt8(0, 8); // resident
    const rec = makeRecord(Buffer.concat([residentAttr(0x30, fileNameValue(5, "$MFT", 0)), attr]));
    expect(extractMftRuns(rec)).toBeNull();
  });
});

describe("parseMftBuffer", () => {
  it("两条记录", () => {
    const chunk = Buffer.concat([fileRecord(5, "a.txt", 10), fileRecord(5, "b.txt", 20)]);
    const records = new Map<number, MftRecord>();
    const [n, sz] = parseMftBuffer(chunk, RECORD_SIZE, records, 100);
    expect(n).toBe(2);
    expect(sz).toBe(30);
    expect(records.get(100)?.name).toBe("a.txt");
    expect(records.get(101)?.name).toBe("b.txt");
  });

  it("混入垃圾数据", () => {
    const chunk = Buffer.concat([Buffer.alloc(RECORD_SIZE), fileRecord(5, "c.txt", 5)]);
    const records = new Map<number, MftRecord>();
    const [n] = parseMftBuffer(chunk, RECORD_SIZE, records, 0);
    expect(n).toBe(1);
    expect(records.has(1)).toBe(true);
    expect(records.has(0)).toBe(false);
  });
});

describe("buildTree", () => {
  function records(): Map<number, MftRecord> {
    const r = (parent: number, name: string, size: number, flags: number): MftRecord => ({
      parent, name, size, mtime: 1.0, atime: 1.0, flags,
    });
    return new Map([
      [5, r(5, "C:", 0, 1)],
      [100, r(5, "Users", 0, 1)],
      [101, r(100, "tom", 0, 1)],
      [102, r(101, "a.doc", 1000, 0)],
      [103, r(101, "b.doc", 2000, 0)],
      [104, r(5, "pagefile.sys", 5000, 0)],
      [105, r(5, "junction", 0, 1 | 2)], // 链接目录
      [106, r(5, "$RECYCLE.BIN", 9999, 1)], // 应被忽略
      [200, r(999_999, "orphan.txt", 10, 0)], // 孤儿
    ]);
  }

  it("树结构与聚合", () => {
    const [root, orphans] = buildTree(records(), "C:", ["$RECYCLE.BIN"]);
    expect(root.name).toBe("C:");
    expect([...root.children!.keys()]).toEqual(["Users", "pagefile.sys", "junction"]);
    const tom = root.children!.get("Users")!.children!.get("tom")!;
    const [files, dirs, total] = finalizeTree(root);
    expect(tom.size).toBe(3000);
    expect(files).toBe(3);
    expect(total).toBe(8000);
    expect(dirs).toBeGreaterThanOrEqual(3);
    expect(orphans).toBe(1);
  });

  it("Junction 不下钻但保留", () => {
    const [root] = buildTree(records(), "C:", ["$RECYCLE.BIN"]);
    const j = root.children!.get("junction")!;
    expect(j.isLink).toBe(true);
    expect(j.isDir).toBe(true);
    expect(j.children).toBeUndefined();
  });

  it("忽略通配模式", () => {
    const [root] = buildTree(records(), "C:", ["$RECYCLE.BIN"]);
    expect(root.children!.has("$RECYCLE.BIN")).toBe(false);
  });

  it("忽略点条目", () => {
    const recs = new Map<number, MftRecord>([
      [5, { parent: 5, name: "C:", size: 0, mtime: 0, atime: 0, flags: 1 }],
      [10, { parent: 5, name: ".", size: 0, mtime: 0, atime: 0, flags: 1 }],
      [11, { parent: 5, name: "..", size: 0, mtime: 0, atime: 0, flags: 1 }],
    ]);
    const [root] = buildTree(recs, "C:", []);
    expect(root.children?.size ?? 0).toBe(0);
  });

  it("环防护", () => {
    const recs = new Map<number, MftRecord>([
      [5, { parent: 5, name: "C:", size: 0, mtime: 0, atime: 0, flags: 1 }],
      [100, { parent: 101, name: "a", size: 0, mtime: 0, atime: 0, flags: 1 }],
      [101, { parent: 100, name: "b", size: 0, mtime: 0, atime: 0, flags: 1 }],
    ]);
    const [root] = buildTree(recs, "C:", []);
    expect(root.children?.size ?? 0).toBe(0);
  });
});

describe("filetimeToUnix", () => {
  it("零值", () => {
    expect(filetimeToUnix(0n)).toBe(0);
  });

  it("纪元换算", () => {
    expect(filetimeToUnix(EPOCH)).toBeCloseTo(0);
    expect(filetimeToUnix(ft(1700000000))).toBeCloseTo(1700000000, -3);
  });
});
