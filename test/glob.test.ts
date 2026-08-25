/** glob.ts fnmatch 等价物测试。 */

import { describe, expect, it } from "vitest";
import { fnmatch, fnmatchCase } from "../src/glob.js";

describe("fnmatch", () => {
  it("星号", () => {
    expect(fnmatch("venv", "*venv*")).toBe(true);
    expect(fnmatch(".venv310", "*venv*")).toBe(true);
    expect(fnmatch("VENV", "*venv*")).toBe(true); // 大小写不敏感
    expect(fnmatch("vendor", "venv")).toBe(false);
  });

  it("问号", () => {
    expect(fnmatch("log1.txt", "log?.txt")).toBe(true);
    expect(fnmatch("log12.txt", "log?.txt")).toBe(false);
  });

  it("字符集", () => {
    expect(fnmatch("a1", "a[0-9]")).toBe(true);
    expect(fnmatch("ab", "a[0-9]")).toBe(false);
    expect(fnmatch("ax", "a[!0-9]")).toBe(true);
  });

  it("路径分隔符不跨段", () => {
    // Python fnmatch 的 * 可匹配 /；我们的实现按 Windows 场景排除分隔符
    expect(fnmatch("cache\\sub", "cache*")).toBe(false);
  });
});

describe("fnmatchCase", () => {
  it("大小写敏感", () => {
    expect(fnmatchCase("VENV", "venv")).toBe(false);
    expect(fnmatchCase("venv", "venv")).toBe(true);
  });
});
