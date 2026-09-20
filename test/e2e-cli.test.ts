/** CLI 端到端冒烟测试：扫描→分析→操作→记账→撤销→rescan 全链路。 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recycleBinAvailable, SKIP_RB_MSG } from "./helpers.js";

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
    if (!recycleBinAvailable()) return console.warn(`[skip] ${SKIP_RB_MSG}`);
    // 准备隔离环境
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ds-e2e-home-"));
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), "ds-e2e-tree-"));
    const docs = path.join(tree, "docs");
    fs.mkdirSync(docs);
    const keep = path.join(tree, "keep.txt");
    const victim = path.join(docs, "victim.txt");
    const VICTIM_BYTES = Buffer.byteLength("delete me");
    fs.writeFileSync(keep, "keep");
    fs.writeFileSync(victim, "delete me");
    const env = { ...process.env, DISK_SENSE_HOME: home };

    try {
      // 1. 扫描（默认摘要模式）
      const scan = run(["start_scan", "--drive", tree], env);
      expect(scan.status).toBe("completed");
      expect(scan.summary.files).toBe(2);
      expect(scan.result).toBeUndefined(); // 摘要模式不刷全量
      expect(typeof scan.result_file).toBe("string");
      expect(fs.existsSync(scan.result_file)).toBe(true); // 完整指纹已落盘

      // --path 别名 + --full 输出全量指纹
      const full = run(["start_scan", "--path", tree, "--full"], env);
      expect(full.result.summary.files).toBe(2);
      // 重复扫描 → 旧会话归档为 diff 基线
      expect(typeof full.old_session_archived).toBe("string");

      // 2. subtree 查询附带新鲜度元数据
      const sub = run(["subtree", "--path", tree, "--depth", "2"], env);
      expect(sub.subtree.value).toBeGreaterThan(0);
      expect(sub.stale_hint).toBeUndefined(); // op_count=0 无提示

      // 3. dry-run 预演：不执行任何操作，给出体积与回收站落位
      const dry = run(
        [
          "execute_operation",
          "--op_type",
          "delete",
          "--sources",
          JSON.stringify([victim]),
          "--dry-run",
        ],
        env
      );
      expect(dry.status).toBe("dry_run");
      expect(dry.items[0].exists).toBe(true);
      expect(dry.items[0].bytes).toBe(VICTIM_BYTES);
      expect(dry.items[0].recycle_drive).toBeTruthy();
      expect(fs.existsSync(victim)).toBe(true); // 预演不动盘

      // 4. 删除（真实回收站）
      const del = run(
        ["execute_operation", "--op_type", "delete", "--sources", JSON.stringify([victim])],
        env
      );
      expect(del.status).toBe("completed");
      expect(fs.existsSync(victim)).toBe(false);
      expect(del.results[0].recycle_bin_name).toMatch(/^\$R/);
      expect(del.moved_bytes).toBe(VICTIM_BYTES); // 实测体积
      expect(del.freed_bytes).toBe(0); // 进回收站不释放占用

      // 5. 会话记账：op_count=1，stale 提示出现
      const sub2 = run(["subtree", "--path", tree, "--depth", "1"], env);
      expect(sub2.stale_hint).toContain("1 次");

      // 6. 审计日志可查（信封 {status, data}）
      const history = run(["list_recent_ops", "--limit", "5"], env);
      expect(history.status).toBe("ok");
      expect(history.data[0].op_uuid).toBe(del.op_uuid);
      expect(history.data[0].file_size).toBe(VICTIM_BYTES); // 操作时刻体积留台账

      // 7. 撤销 → 文件物理还原
      const undo = run(["undo_operation", "--op_id", String(history.data[0].id)], env);
      expect(undo.status).toBe("success");
      expect(fs.readFileSync(victim, "utf-8")).toBe("delete me");

      // 8. rescan 重置新鲜度账本
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
      run(["start_scan", "--drive", tree, "--elevate", "never"], env);
      // 快照后外部删除该文件
      fs.unlinkSync(ghost);
      const result = run(
        ["execute_operation", "--op_type", "delete", "--sources", JSON.stringify([ghost])],
        env
      );
      // 预检发现源已消失且在快照内 → 拒绝
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

  it("stale 三分类：幂等重跑放行 / 外部冲突拒绝 / --allow-stale 降级", () => {
    if (!recycleBinAvailable()) return console.warn(`[skip] ${SKIP_RB_MSG}`);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ds-e2e-home-"));
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), "ds-e2e-tree-"));
    const a = path.join(tree, "a.txt");
    const b = path.join(tree, "b.txt");
    fs.writeFileSync(a, "aaa");
    fs.writeFileSync(b, "bbb");
    const env = { ...process.env, DISK_SENSE_HOME: home };

    try {
      run(["start_scan", "--drive", tree], env);

      // ① 幂等重跑：本工具删除 a 成功（节点标 stale）后，重跑含 a 的批次应放行
      const del = run(
        ["execute_operation", "--op_type", "delete", "--sources", JSON.stringify([a])],
        env
      );
      expect(del.status).toBe("completed");
      const rerun = run(
        ["execute_operation", "--op_type", "delete", "--sources", JSON.stringify([a, b])],
        env
      );
      // a 幂等 skipped、b 正常删除，不整批拒绝
      expect(rerun.status).toBe("completed");
      expect(rerun.summary).toEqual({ total: 2, done: 1, failed: 0, skipped: 1 });
      expect(rerun.stale_idempotent).toEqual([a]);
      const aEntry = rerun.results.find((r: any) => r.source === a)!;
      expect(aEntry.status).toBe("skipped");
      expect(aEntry.error).toContain("已处理过");
      expect(fs.existsSync(b)).toBe(false);

      // ② 外部冲突：快照已知但无本工具操作史、磁盘消失 → 默认整批拒绝
      const c = path.join(tree, "c.txt");
      fs.writeFileSync(c, "ccc");
      run(["rescan", "--path", tree], env); // c 入快照且清除 stale 账本
      fs.unlinkSync(c); // 外部删除（不经本工具）
      const blocked = run(
        ["execute_operation", "--op_type", "delete", "--sources", JSON.stringify([c])],
        env
      );
      expect(blocked.status).toBe("error");
      expect(blocked.error).toContain("stale_conflict");
      expect(blocked.stale_conflicts).toEqual([c]);

      // ③ --allow-stale 降级：外部消失的源改逐条 skipped，不再整批拒绝
      const downgraded = run(
        [
          "execute_operation",
          "--op_type",
          "delete",
          "--sources",
          JSON.stringify([c]),
          "--allow-stale",
        ],
        env
      );
      expect(downgraded.status).toBe("completed");
      expect(downgraded.summary).toEqual({ total: 1, done: 0, failed: 0, skipped: 1 });
      expect(downgraded.results[0].error).toContain("不存在");

      // ④ dry-run 提前披露 stale_conflicts 与降级提示
      const d = path.join(tree, "d.txt");
      fs.writeFileSync(d, "ddd");
      run(["rescan", "--path", tree], env);
      fs.unlinkSync(d);
      const dry = run(
        [
          "execute_operation",
          "--op_type",
          "delete",
          "--sources",
          JSON.stringify([d]),
          "--dry-run",
        ],
        env
      );
      expect(dry.status).toBe("dry_run");
      expect(dry.stale_conflicts).toEqual([d]);
      expect(dry.stale_hint).toContain("--allow-stale");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      try {
        fs.rmSync(tree, { recursive: true, force: true });
      } catch {
        /* 回收站占用时容忍 */
      }
    }
  }, 180_000);

  it("无会话直删：unverified 披露 + moved_bytes 真实体积（目录递归）", () => {
    if (!recycleBinAvailable()) return console.warn(`[skip] ${SKIP_RB_MSG}`);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ds-e2e-home-"));
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), "ds-e2e-tree-"));
    const sub = path.join(tree, "pkg");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "a.dat"), "x".repeat(4096));
    fs.writeFileSync(path.join(sub, "b.dat"), "y".repeat(1024));
    const env = { ...process.env, DISK_SENSE_HOME: home };

    try {
      // 未扫描直接删目录：不再要求先全量扫描
      const del = run(
        ["execute_operation", "--op_type", "delete", "--sources", JSON.stringify([sub])],
        env
      );
      expect(del.status).toBe("completed");
      expect(del.unverified).toEqual([sub]); // 如实披露未经快照校验
      expect(del.moved_bytes).toBe(4096 + 1024); // 目录 = 递归实测，不再是目录条目 4KB
      // 台账同样留存真实体积
      const history = run(["list_recent_ops", "--limit", "5"], env);
      expect(history.data[0].file_size).toBe(4096 + 1024);
      // 撤销可回滚
      const undo = run(["undo_operation", "--op_id", String(history.data[0].id)], env);
      expect(undo.status).toBe("success");
      expect(fs.existsSync(path.join(sub, "a.dat"))).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      try {
        fs.rmSync(tree, { recursive: true, force: true });
      } catch {
        /* 回收站占用时容忍 */
      }
    }
  }, 120_000);
});
