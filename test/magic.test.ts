/** magic.ts 魔数识别测试（合成字节，不读真实大文件）。 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyMagicNumber } from "../src/magic.js";

function tmpFile(name: string, chunks: Buffer[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-magic-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.concat(chunks));
  return file;
}

const hex = (s: string) => Buffer.from(s, "hex");
const latin = (s: string) => Buffer.from(s, "latin1");
// 补齐到至少 16 字节
const pad = (n: number) => Buffer.alloc(Math.max(0, n));

describe("classifyMagicNumber", () => {
  it("PNG", () => {
    expect(classifyMagicNumber(tmpFile("a.png", [hex("89504E470D0A1A0A"), pad(32)]))).toMatchObject({
      magic_type: "PNG 图片",
      confidence: "high",
    });
  });

  it("JPEG", () => {
    expect(classifyMagicNumber(tmpFile("a.jpg", [hex("FFD8FF"), pad(32)])).magic_type).toBe("JPEG 图片");
  });

  it("ZIP 容器", () => {
    expect(classifyMagicNumber(tmpFile("a.zip", [hex("504B0304"), pad(32)]))).toMatchObject({
      mime: "application/zip",
      confidence: "high",
    });
  });

  it("RIFF/WebP 细分", () => {
    const f = tmpFile("a.webp", [latin("RIFF"), hex("00000000"), latin("WEBP"), pad(32)]);
    expect(classifyMagicNumber(f)).toMatchObject({ magic_type: "WebP 图片", confidence: "high" });
  });

  it("RIFF/WAV 细分", () => {
    const f = tmpFile("a.wav", [latin("RIFF"), hex("00000000"), latin("WAVE"), pad(32)]);
    expect(classifyMagicNumber(f).magic_type).toBe("WAV 音频");
  });

  it("MP4 ftyp 在偏移 4", () => {
    const f = tmpFile("a.mp4", [pad(4), latin("ftyp"), pad(32)]);
    expect(classifyMagicNumber(f)).toMatchObject({ magic_type: "MP4/MOV 视频", confidence: "high" });
  });

  it("PE 可执行", () => {
    expect(classifyMagicNumber(tmpFile("a.exe", [latin("MZ"), pad(64)])).magic_type).toBe(
      "PE 可执行(exe/dll)"
    );
  });

  it("ISO CD001 在 0x8001", () => {
    const f = tmpFile("a.iso", [pad(0x8001), latin("CD001")]);
    expect(classifyMagicNumber(f)).toMatchObject({
      magic_type: "ISO 9660 光盘镜像",
      confidence: "high",
    });
  });

  it("TAR ustar 在 0x101", () => {
    const f = tmpFile("a.tar", [pad(0x101), latin("ustar")]);
    expect(classifyMagicNumber(f).magic_type).toBe("TAR 归档");
  });

  it("RAR5 长前缀优先于更短前缀", () => {
    // RAR5 签名 526172211A070100 是 RAR4 前缀的扩展；长前缀必须先匹配
    const f = tmpFile("a.rar", [hex("526172211A070100"), pad(16)]);
    expect(classifyMagicNumber(f).magic_type).toBe("RAR5 压缩包");
  });

  it("过小文件 → EMPTY_OR_SPARSE", () => {
    expect(classifyMagicNumber(tmpFile("t.bin", [Buffer.alloc(4)]))).toMatchObject({
      magic_type: "EMPTY_OR_SPARSE",
      confidence: "low",
    });
  });

  it("未知内容 → UNKNOWN", () => {
    const f = tmpFile("u.dat", [Buffer.alloc(64, 0xab)]);
    expect(classifyMagicNumber(f).confidence).toBe("low");
  });

  it("缺失文件带 error", () => {
    const r = classifyMagicNumber(path.join(os.tmpdir(), "ds-no-such-file-xyz.bin"));
    expect(r.magic_type).toBe("UNKNOWN");
    expect(r.error).toBeTruthy();
  });
});
