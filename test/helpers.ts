/** 测试共享助手。 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { FileOperator } from "../src/operator/file-operator.js";
import { UndoManager } from "../src/operator/undo-manager.js";

let binProbe: boolean | null = null;

/**
 * 探测当前环境回收站是否真实可用。
 *
 * 部分 Windows Server / CI runner 镜像禁用了回收站：
 * SHFileOperationW(FOF_ALLOWUNDO) 表现为「文件直接消失、无任何 $I/$R 产生」。
 * 此类环境下「精确 $R 映射」「受控清空」等用例无法成立，应跳过而非失败。
 */
export function recycleBinAvailable(): boolean {
  if (binProbe !== null) return binProbe;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-rb-probe-"));
  const dbFile = path.join(dir, "probe.db");
  const undo = new UndoManager(dbFile);
  try {
    const file = path.join(dir, `probe-${randomUUID().slice(0, 6)}.txt`);
    fs.writeFileSync(file, "probe");
    const op = new FileOperator(undo);
    const result = op.delete([file]);
    binProbe =
      result.status === "completed" &&
      result.results[0]?.recycle_bin_name != null &&
      !fs.existsSync(file);
  } catch {
    binProbe = false;
  } finally {
    undo.close();
    try {
      fs.rmSync(dbFile, { force: true });
      // 目录里可能残留探针的 $R 物理文件（在回收站里，无法 rm）——容忍
    } catch {
      /* 忽略 */
    }
  }
  return binProbe;
}

export const SKIP_RB_MSG =
  "当前环境回收站不可用（文件未进入 $Recycle.Bin），跳过依赖精确 $R 映射的用例";
