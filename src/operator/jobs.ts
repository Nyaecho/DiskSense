/**
 * 异步操作任务（async-jobs 能力，无 daemon 磁盘版）。
 *
 * 长耗时变更操作改为异步：CLI 立即返回 job_id 并 spawn 一个 detached
 * 子进程执行，进度/结果实时写入 `<dataHome>/jobs/<job_id>.json`，
 * 客户端用 query_job 轮询读取。
 *
 * 状态机：pending → running → succeeded/failed。
 * 状态全部落盘：进程重启后任务状态仍可追溯；无法追溯的运行中任务由
 * 查询端按 created_at 判定并提示「任务已中断」语义。
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { jobsDir } from "../config.js";

export const JOB_PENDING = "pending";
export const JOB_RUNNING = "running";
export const JOB_SUCCEEDED = "succeeded";
export const JOB_FAILED = "failed";

export interface JobState {
  job_id: string;
  op_type: string;
  sources: string[];
  /** move/copy 的目标目录 */
  dest?: string | null;
  status: string;
  progress: number;
  processed_items: number;
  processed_bytes: number;
  total_items: number;
  error: string | null;
  result: Record<string, unknown> | null;
  op_uuid: string | null;
  created_at: number;
  finished_at: number | null;
}

function jobFile(jobId: string): string {
  return path.join(jobsDir(), `${jobId}.json`);
}

/** 磁盘任务注册表。 */
export class JobStore {
  constructor(private dir = jobsDir()) {}

  private fileOf(jobId: string): string {
    return path.join(this.dir, `${jobId}.json`);
  }

  create(opType: string, sources: readonly string[], dest?: string | null): JobState {
    fs.mkdirSync(this.dir, { recursive: true });
    const job: JobState = {
      job_id: `job-${randomUUID().slice(0, 12)}`,
      op_type: opType,
      sources: [...sources],
      ...(dest !== undefined ? { dest } : {}),
      status: JOB_PENDING,
      progress: 0,
      processed_items: 0,
      processed_bytes: 0,
      total_items: 0,
      error: null,
      result: null,
      op_uuid: null,
      created_at: Date.now() / 1000,
      finished_at: null,
    };
    this.write(job);
    return job;
  }

  get(jobId: string): JobState | null {
    try {
      return JSON.parse(fs.readFileSync(this.fileOf(jobId), "utf-8")) as JobState;
    } catch {
      return null;
    }
  }

  /** 读 + 原子改写（同进程内使用；子进程写整文件原子替换）。 */
  update(jobId: string, patch: Partial<JobState>): JobState | null {
    const job = this.get(jobId);
    if (!job) return null;
    const next = { ...job, ...patch };
    // result/op_uuid 由 finish 设置时不覆盖
    if (patch.result === undefined && job.result !== null) next.result = job.result;
    this.write(next);
    return next;
  }

  markRunning(jobId: string): void {
    const job = this.get(jobId);
    if (job && job.status === JOB_PENDING) this.write({ ...job, status: JOB_RUNNING });
  }

  setProgress(
    jobId: string,
    processedItems: number,
    processedBytes: number,
    totalItems?: number
  ): void {
    const job = this.get(jobId);
    if (!job || job.status !== JOB_RUNNING) return;
    const next: JobState = {
      ...job,
      processed_items: processedItems,
      processed_bytes: processedBytes,
    };
    if (totalItems && totalItems > 0) {
      next.total_items = totalItems;
      next.progress = Math.min(0.99, processedItems / Math.max(1, totalItems));
    }
    this.write(next);
  }

  finish(jobId: string, result?: Record<string, unknown>, error?: string): void {
    const job = this.get(jobId);
    if (!job) return;
    const next: JobState = {
      ...job,
      finished_at: Date.now() / 1000,
    };
    if (error !== undefined) {
      next.status = JOB_FAILED;
      next.error = error;
    } else {
      next.status = JOB_SUCCEEDED;
      next.result = result ?? null;
      next.progress = 1.0;
      if (result && typeof result === "object" && "op_uuid" in result) {
        next.op_uuid = String(result["op_uuid"]);
      }
    }
    this.write(next);
  }

  private write(job: JobState): void {
    const tmp = `${this.fileOf(job.job_id)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(job, null, 1), "utf-8");
    fs.renameSync(tmp, this.fileOf(job.job_id));
  }
}

/** 把任务状态序列化为对 Agent 的响应（对应 Python Job.to_dict）。 */
export function jobToDict(job: JobState): Record<string, unknown> {
  const d: Record<string, unknown> = {
    job_id: job.job_id,
    op_type: job.op_type,
    status: job.status,
    progress: Math.round(job.progress * 1000) / 1000,
    processed_items: job.processed_items,
    processed_bytes: job.processed_bytes,
    created_at: job.created_at,
  };
  if (job.error) d["error"] = job.error;
  if (job.result !== null) d["result"] = job.result;
  if (job.op_uuid) d["op_uuid"] = job.op_uuid;
  if (job.finished_at) d["finished_at"] = job.finished_at;
  return d;
}
