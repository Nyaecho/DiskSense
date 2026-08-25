/** CLI 端到端冒烟测试：扫描→分析→操作→记账→撤销→rescan 全链路。 */

import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.resolve("src/cli/index.ts");

function run(args: string[], env: NodeJS.ProcessEnv): any {
  const r = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    encoding: "utf-8",
    env,
    timeout: 120_000,
  });
  if (r.status !== 0 && !r.stdout.trim()) {
    throw new Error(`CLI 失败: ${r.stderr}`);
  }
  return JSON.parse(r.stdout.trim().split("\n").at(-1)!);
}

describe("DiskSense CLI e2e（win32）", () => {
  it("全链路：scan → detail → delete(stale 记账) → undo → rescan", () => {
    // 准备隔离环境
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ds-e2e-home-"));
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), "ds-e2e-tree-"));
    const docs = path.join(tree, "docs");
    fs.mkdirSync(docs);
    const keep = path.join(tree, "keep.txt");
    const victim = path.join(docs, "victim.txt");
    fs.writeFileSync(keep, "keep");
    fs.writeFileSync(victim, "delete me");
    const env = { ...process.env, DISK_SENSE_HOME: home };

    try {
      // 1. 扫描
      const scan = run(["start_scan", "--drive", tree], env);
      expect(scan.status).toBe("completed");
      expect(scan.result.summary.files).toBe(2);

      // 2. subtree 查询附带新鲜度元数据
      const sub = run(["subtree", "--path", tree, "--depth", "2"], env);
      expect(sub.subtree.value).toBeGreaterThan(0);
      expect(sub.stale_hint).toBeUndefined(); // op_count=0 无提示

      // 3. 删除（真实回收站）
      const del = run(
        ["execute_operation", "--op_type", "delete", "--sources", JSON.stringify([victim])],
        env
      );
      expect(del.status).toBe("completed");
      expect(fs.existsSync(victim)).toBe(false);
      expect(del.results[0].recycle_bin_name).toMatch(/^\$R/);

      // 4. 会话记账：op_count=1，stale 提示出现
      const sub2 = run(["subtree", "--path", tree, "--depth", "1"], env);
      expect(sub2.stale_hint).toContain("1 次");

      // 5. 审计日志可查
      const history = run(["list_recent_ops", "--limit", "5"], env);
      expect(history[0].op_uuid).toBe(del.op_uuid);

      // 6. 撤销 → 文件物理还原
      const undo = run(["undo_operation", "--op_id", String(history[0].id)], env);
      expect(undo.status).toBe("success");
      expect(fs.readFileSync(victim, "utf-8")).toBe("delete me");

      // 7. rescan 重置新鲜度账本
      const rescan = run(["rescan", "--path", docs], env);
      expect(rescan.status).toBe("completed");
      const sub3 = run(["subtree", "--path", tree, "--depth", "1"], env);
      expect(sub3.stale_hint).toBeUndefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      try {
        fs.rmSync(tree, { recursive: true, force: true });
      } catch {
        /* 回收站占用时容忍 */
      }
    }
  }, 180_000);

  it("预检防线：删除不存在的 stale 路径被拒绝", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ds-e2e-home-"));
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), "ds-e2e-tree-"));
    const ghost = path.join(tree, "ghost.txt");
    fs.writeFileSync(ghost, "boo");
    const env = { ...process.env, DISK_SENSE_HOME: home };

    try {
      run(["start_scan", "--drive", tree], env);
      // 快照后外部删除该文件
      fs.unlinkSync(ghost);
      const result = run(
        ["execute_operation", "--op_type", "delete", "--sources", JSON.stringify([ghost])],
        env
      );
      // 预检发现源已消失且带 stale 标记 → 拒绝
      expect(result.status).toBe("error");
      expect(result.error).toContain("stale_conflict");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      try {
        fs.rmSync(tree, { recursive: true, force: true });
      } catch {
        /* 容忍 */
      }
    }
  }, 120_000);
});
