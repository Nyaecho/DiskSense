/**
 * 配置加载与路径常量。
 *
 * 路径解析规则（npm 全局安装友好）：
 * - 运行时状态根目录：环境变量 DISK_SENSE_HOME，默认
 *   `%LOCALAPPDATA%\disk-sense`（无 LOCALAPPDATA 时回退 `~/.disk-sense`）。
 * - 配置文件：优先 `<cwd>/config/`（项目级覆盖），否则用随包分发的
 *   `config/`。配置文件可整体缺失，缺失时使用内置默认值。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load as yamlLoad } from "js-yaml";

// ---------------------------------------------------------------------------
// 路径常量
// ---------------------------------------------------------------------------
export function dataHome(): string {
  const override = process.env["DISK_SENSE_HOME"];
  if (override) return path.resolve(override);
  if (process.env["LOCALAPPDATA"]) {
    return path.join(process.env["LOCALAPPDATA"], "disk-sense");
  }
  return path.join(os.homedir(), ".disk-sense");
}

export function archiveDir(): string {
  return path.join(dataHome(), "archive");
}

/** 包自带 config/ 目录（dist/../config） */
function bundledConfigDir(): string {
  // dist/config.js → 包根 → config/
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "config");
}

function resolveConfigFile(name: string): string {
  const cwdCandidate = path.join(process.cwd(), "config", name);
  if (fs.existsSync(cwdCandidate)) return cwdCandidate;
  return path.join(bundledConfigDir(), name);
}

export function configFile(): string {
  return resolveConfigFile("config.yaml");
}

export function rulesFile(): string {
  return resolveConfigFile("classification_rules.yaml");
}

export function opLogDb(): string {
  return path.join(dataHome(), "op_log.db");
}

export function prefsFile(): string {
  return path.join(dataHome(), "user_preferences.json");
}

export function sessionsDir(): string {
  return path.join(dataHome(), "sessions");
}

export function jobsDir(): string {
  return path.join(dataHome(), "jobs");
}

export function ensureDataDirs(): void {
  fs.mkdirSync(archiveDir(), { recursive: true });
  fs.mkdirSync(sessionsDir(), { recursive: true });
  fs.mkdirSync(jobsDir(), { recursive: true });
}

// ---------------------------------------------------------------------------
// 配置结构（字段默认值即文档）
// ---------------------------------------------------------------------------
export interface ServerConfig {
  host: string;
  /** 兼容保留：Python 版监听端口；CLI 无服务时仅作默认 job/会话命名空间 */
  port: number;
}

export interface ScanConfig {
  useMft: boolean;
  /** null = max(1, CPU-2) */
  maxWorkers: number | null;
  throttleEvery: number;
  throttleSleepMs: number;
  defaultDirIgnores: string[];
}

export interface ScanApiConfig {
  syncTimeoutSec: number;
}

export interface HistoryConfig {
  retentionDays: number;
}

export interface Config {
  server: ServerConfig;
  scan: ScanConfig;
  scanApi: ScanApiConfig;
  history: HistoryConfig;
}

const DEFAULT_DIR_IGNORES = ["$RECYCLE.BIN", "System Volume Information"];

export function defaultScanWorkers(): number {
  return Math.max(1, (os.cpus()?.length ?? 4) - 2);
}

export function loadConfig(filePath?: string): Config {
  const p = filePath ?? configFile();
  let raw: Record<string, unknown> = {};
  try {
    const text = fs.readFileSync(p, "utf-8");
    raw = (yamlLoad(text) as Record<string, unknown>) ?? {};
  } catch {
    // 文件不存在或解析失败 → 全默认值（零配置可运行）
    raw = {};
  }

  const pick = <T extends object>(section: string, base: T): T => {
    const over = raw[section];
    if (over && typeof over === "object" && !Array.isArray(over)) {
      return { ...base, ...(over as Partial<T>) };
    }
    return base;
  };

  return {
    server: pick("server", { host: "127.0.0.1", port: 58901 }),
    scan: pick("scan", {
      useMft: true,
      maxWorkers: null,
      throttleEvery: 1000,
      throttleSleepMs: 1,
      defaultDirIgnores: [...DEFAULT_DIR_IGNORES],
    }),
    scanApi: pick("scan_api", { syncTimeoutSec: 120 }),
    history: pick("history", { retentionDays: 30 }),
  };
}
