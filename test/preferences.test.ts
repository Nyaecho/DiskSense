/** preferences.ts 用户偏好测试（对应 Python test_preferences.py）。 */

import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Preferences } from "../src/preferences.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-prefs-"));
  file = path.join(dir, "user_preferences.json");
});

describe("Preferences", () => {
  it("缺失文件回退默认值", () => {
    const p = new Preferences(file);
    expect(p.ignorePatterns).toEqual([]);
    expect(p.isProtected("C:\\anything")).toBe(false);
  });

  it("保护路径前缀匹配（大小写不敏感）", () => {
    const p = new Preferences(file);
    p.addProtection("D:/Work");
    expect(p.isProtected("d:\\work\\sub\\file.txt")).toBe(true);
    expect(p.isProtected("D:\\Work")).toBe(true);
    expect(p.isProtected("D:\\Workspace")).toBe(false);
    p.removeProtection("d:/work");
    expect(p.isProtected("D:\\Work\\sub")).toBe(false);
  });

  it("标签按归一化移除", () => {
    const p = new Preferences(file);
    p.setTag("D:/Models", "ai");
    expect(p.tagsByPrefix["d:\\models"]).toBe("ai");
    p.removeTag("d:\\models");
    expect(Object.keys(p.tagsByPrefix)).toHaveLength(0);
  });

  it("忽略模式去重添加", () => {
    const p = new Preferences(file);
    p.addIgnorePattern("node_modules");
    p.addIgnorePattern("node_modules");
    expect(p.ignorePatterns).toEqual(["node_modules"]);
  });

  it("伪实体标记路径增删", () => {
    const p = new Preferences(file);
    p.addPseudoEntityPath("D:/Data/BigSet");
    expect(p.pseudoEntityPaths).toEqual(["D:/Data/BigSet"]);
    p.removePseudoEntityPath("d:/data/bigset");
    expect(p.pseudoEntityPaths).toHaveLength(0);
  });

  it("自动清理规则读取", () => {
    const p = new Preferences(file);
    expect(p.getAutoCleanRule("temp")).toMatchObject({ max_age_days: 30, enabled: true });
    expect(p.getAutoCleanRule("nope")).toBeNull();
  });

  it("损坏 JSON 回退默认值且可写回", () => {
    fs.writeFileSync(file, "{broken json!!");
    const p = new Preferences(file);
    expect(p.ignorePatterns).toEqual([]);
    p.addIgnorePattern("x");
    expect(JSON.parse(fs.readFileSync(file, "utf-8")).ignore_patterns).toEqual(["x"]);
  });

  it("持久化跨实例加载", () => {
    const a = new Preferences(file);
    a.addProtection("E:/Keep");
    const b = new Preferences(file);
    expect(b.isProtected("e:/keep/inner")).toBe(true);
  });
});
