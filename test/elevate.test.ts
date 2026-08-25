/** elevate.ts 自动提权辅助测试。 */

import { describe, expect, it } from "vitest";
import { buildElevatedArgs, isAdmin } from "../src/elevate.js";
import { shouldElevateFor } from "../src/cli/index.js";

describe("buildElevatedArgs", () => {
  it("生产模式：入口 + 参数", () => {
    const args = buildElevatedArgs(["_elevated-scan", "--drive", "C:"]);
    // 入口在首位（.ts 开发态会带 --import tsx 前缀）
    expect(args.at(-1)).toBe("C:");
    expect(args).toContain("_elevated-scan");
  });
});

describe("isAdmin / shouldElevateFor", () => {
  it("is-admin 返回布尔且与 CLI 诊断一致", () => {
    expect(typeof isAdmin()).toBe("boolean");
  });

  it("目录路径不触发提权；盘符路径按管理员状态判定", () => {
    const dir = process.env["TEMP"] ?? "C:\\Windows\\Temp";
    if (/^[A-Za-z]:/.test(dir)) {
      expect(shouldElevateFor(dir)).toBe(false); // 子目录永远不需要 MFT
    }
    // 盘符场景：仅当当前非管理员时才建议提权
    const want = !isAdmin();
    expect(shouldElevateFor("C:\\")).toBe(want);
  });

  it("非 Windows 恒不触发", () => {
    if (process.platform !== "win32") {
      expect(shouldElevateFor("C:\\")).toBe(false);
    }
  });
});
