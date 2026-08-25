/**
 * 异步任务 worker：detached 子进程入口。
 *
 * 用法：`disk-sense _job-worker --job_id job-xxxx`
 * 从磁盘读取任务定义，执行操作并把进度/结果写回任务文件。
 */

import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { dataHome } from "../config.js";
import { JobStore } from "../operator/jobs.js";
import { FileOperator } from "../operator/file-operator.js";
import { Preferences } from "../preferences.js";
import { UndoManager } from "../operator/undo-manager.js";
import { recordOperationForSources } from "../state/session.js";

export function registerWorkerCommand(program: Command): void {
  program
    .command("_job-worker", { hidden: true })
    .requiredOption("--job_id <id>")
    .action((opts) => {
      const store = new JobStore();
      const job = store.get(opts.job_id);
      if (!job) process.exit(1);
      store.markRunning(job.job_id);

      const prefs = new Preferences(path.join(dataHome(), "user_preferences.json"));
      const undo = new UndoManager(path.join(dataHome(), "op_log.db"));
      const op = new FileOperator(undo, (p) => prefs.isProtected(p), job.job_id);

      try {
        let result;
        if (job.op_type === "move") result = op.move(job.sources, job.dest ?? "");
        else if (job.op_type === "copy") result = op.copy(job.sources, job.dest ?? "");
        else if (job.op_type === "delete") result = op.delete(job.sources);
        else throw new Error(`worker 不支持的操作类型: ${job.op_type}`);

        store.finish(job.job_id, result as unknown as Record<string, unknown>);
        // 新鲜度账本：按源路径所属会话记账
        recordOperationForSources(job.op_type.toUpperCase(), job.sources, result.op_uuid);
        if (job.op_type === "move" && job.dest) {
          recordOperationForSources("MOVE_DEST", [job.dest], result.op_uuid);
        }
      } catch (e) {
        store.finish(job.job_id, undefined, e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      } finally {
        undo.close();
      }
    });
}
