# DiskSense

> 便携式 AI 磁盘文件管理器 —— 由 LLM Agent 驱动的本地磁盘语义化管理 CLI（Agent Skill 包）
> Node/TypeScript 重写版；Python 历史版本归档于 [`python-legacy`](https://github.com/Nyaecho/DiskSense/tree/python-legacy) 分支

融合 **Everything 的检索速度 + SpaceSniffer 的可视化 + 文件管理器的操作能力 + LLM 的语义推理**。

- 开发规范：[CONTRIBUTING.md](CONTRIBUTING.md)
- 环境：Windows 10/11 · Node.js ≥ 22

---

## 目录

1. [它是什么](#它是什么)
2. [快速开始](#快速开始)
3. [在 Agent 平台使用](#在-agent-平台使用)
4. [架构](#架构)
5. [新鲜度账本（三层防线）](#新鲜度账本三层防线)
6. [隐私与安全](#隐私与安全)
7. [开发指南](#开发指南)

---

## 它是什么

DiskSense 是一个 **Agent Skill 包**：`SKILL.md`（提示词）+ `disk-sense` CLI。Agent 加载后即可：

| 能力 | 说明 |
| :--- | :--- |
| 极速扫描 | 本地 NTFS 盘优先 MFT 直读（需管理员，自动降级并发遍历） |
| 指纹聚合 | 百万文件 → 50~200 个「软件实体」档案（≤5000 Token），附语义信号 |
| 语义信号 | `CACHE_DOMINANT`、`EXE_MISSING` 等结构化规则信号，Agent 即时推理 |
| 高亮指令 | `viz_command` 记录高亮/标注指令（JSONL 持久化，可增量查询回放） |
| 可逆操作 | 删除强制回收站 + $R 精确映射 + SQLite 日志 + 五步回滚 |
| 新鲜度账本 | 会话级 `op_count` / 节点级 `stale` / 执行时预检，三层防过时改动 |
| 无 daemon | 无后台服务；会话状态落盘 `%LOCALAPPDATA%\disk-sense\`，npm 一装即用 |

## 快速开始

```powershell
# 1. 安装（Node.js ≥ 20）
npm install -g disk-sense

# 2. 验证（扫描 D:\ 某目录）
disk-sense start_scan --drive D:/some/dir
```

无配置即可运行；卸载 = `npm uninstall -g disk-sense` 并删除 `%LOCALAPPDATA%\disk-sense`。

> MFT 直读需要管理员权限运行终端；普通权限自动降级为多线程遍历（速度略慢但功能等价）。

## 在 Agent 平台使用

### cc-switch / Claude Code / OpenCode / Codex

本包是标准 Agent Skill（frontmatter 符合各家识别规则），安装方式二选一：

```powershell
# 方式 A：npm 全局安装 CLI + symlink 技能目录
mkdir -p ~/.claude/skills
mklink /J "%USERPROFILE%\.claude\skills\disk-sense-manager" "<仓库绝对路径>"

# 方式 B：仅 symlink（Agent 内通过 npx 调用 CLI）
mklink /J "%USERPROFILE%\.agents\skills\disk-sense-manager" "<仓库绝对路径>"
```

- Claude Code：会话内 `/disk-sense-manager` 显式调用，或说"分析 D 盘空间"按 description 自动触发
- OpenCode：从 cwd 向上遍历加载 `.opencode/`、`.claude/`、`.agents/` 下的 `skills/*/SKILL.md`
- Codex：认 `.agents/skills` 目录，显式调用 `$disk-sense-manager`

## 架构

```
用户 ↔ Agent 聊天窗
        │ Bash: disk-sense <tool>
        ▼
   disk-sense CLI（单进程，无 daemon）
        │
   ┌────┴─────┬──────────┬───────────┬────────────┬──────────┐
   │ scanner  │aggregator│ rules     │ operator   │ state    │
   │ mft.ts   │ 四角色映射│ engine.ts │ recycle-bin│ session  │
   │ walk.ts  │ 伪实体   │ (YAML 规则)│ undo(SQLite)│ overlays │
   └──────────┴──────────┴───────────┴────────────┴──────────┘
```

| 模块 | 职责 |
| :--- | :--- |
| `scanner/mft.ts` | koffi 开卷句柄 → FSCTL 定位 $MFT → Fixup/$FILE_NAME 解析；失败静默降级 |
| `scanner/walk.ts` | libuv 线程池并发 readdir；Junction 防护、忽略模式、受限目录跳过 |
| `aggregator.ts` | 种子提取、四角色映射、位置异常关联、global_anomalies 批量魔数 |
| `magic.ts` | 文件头 16 字节魔数识别（全仓库唯一允许读文件字节处） |
| `rules-engine.ts` | SafeEvaluator：受限算子白名单评估 YAML 条件树，绝不 eval |
| `operator/recycle-bin.ts` | SHFileOperationW 回收站删除、$I/$R 解析、受控清空 |
| `operator/file-operator.ts` | move/copy/compress + 五步回滚 + 保护路径拒绝 |
| `operator/undo-manager.ts` | SQLite 操作日志、超期归档 |
| `state/session.ts` | 会话持久化 + op_count 新鲜度账本 + 子树 stale 标记 |

## 新鲜度账本（三层防线）

无 daemon 化后「快照 vs 磁盘现状」的偏差由三层机制防护：

| 层级 | 机制 | 回答的问题 |
| :--- | :--- | :--- |
| 会话级 | `op_count` + `recent_ops`（每次 execute/undo 后递增，rescan 归零） | 这份分析结论整体还可信吗 |
| 节点级 | 受影响子树 `stale`/`stale_since` 标记（查询端点透传） | 这个子树的具体数字还准吗 |
| 执行时 | 预检逐源校验存在性 + mtime 比对，冲突拒绝或告警 | 这条路径现在还能动吗 |

所有分析类输出附带 `stale_hint`（如 `"快照后已有 2 次操作"`），Agent 据此决定是否 rescan。

## 隐私与安全

| 检查项 | 状态 |
| :--- | :--- |
| 读取文件正文（PDF/Word/TXT/图片） | ❌ 永不；仅 `magic.ts` 读 16 字节文件头判定格式 |
| 数据上传 | ❌ 全部本地执行，零遥测 |
| 删除可逆 | ✅ 强制回收站 + $R 精确映射 + SQLite 审计 |
| 权限越界 | ❌ 永不 takeown/icacls；受限目录标记跳过 |
| 便携无痕 | ✅ 零注册表/服务/自启；npm 卸载 + 删数据目录即清除 |
| 稀疏文件 | ✅ 读取前比对实际占用，避免触发填充 |

## 开发指南

```powershell
npm install
npm test          # vitest（含真实回收站往返集成测试）
npm run typecheck # tsc --noEmit
npm run build     # 输出 dist/
```

- 提交规范 / 代码规范 / 隐私红线：[CONTRIBUTING.md](CONTRIBUTING.md)
- MFT 解析器、规则引擎、聚合器均为纯函数，测试用合成字节，无需管理员权限
- Python 历史实现见 `python-legacy` 分支（模块级对照移植）

## 许可证

[MIT](LICENSE) © 2026 Nyaecho
