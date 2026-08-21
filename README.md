# DiskSense

> 便携式 AI 磁盘文件管理器 —— 由 LLM Agent 驱动的本地磁盘语义化管理 Agent Skill 包
> 纯vibe coding项目，可能存在隐形bug和逆天表述

融合 **Everything 的检索速度 + SpaceSniffer 的可视化 + 文件管理器的操作能力 + LLM 的语义推理**。

- 开发规范：[CONTRIBUTING.md](CONTRIBUTING.md)
- 环境：Windows 10/11 · Python 3.10+

---

## 目录

1. [它是什么](#它是什么)
2. [快速开始](#快速开始)
3. [在 Agent 平台使用](#在-agent-平台使用)
4. [手动使用（无 Agent）](#手动使用无-agent)
5. [架构](#架构)
6. [API 契约](#api-契约)
7. [配置参考](#配置参考)
8. [隐私与安全](#隐私与安全)
9. [开发指南](#开发指南)
10. [验收状态](#验收状态)

---

## 它是什么

DiskSense 不是独立的可执行程序，而是一个 **Agent Skill 包**：`SKILL.md`（提示词）
+ Python 脚本。Agent 加载后即可：

| 能力 | 说明 |
| :--- | :--- |
| 极速扫描 | 本地 NTFS 盘优先 MFT 直读（需管理员，自动降级多线程 os.scandir） |
| 指纹聚合 | 百万文件 → 50~200 个「软件实体」档案（≤5000 Token），附语义信号 |
| 语义信号 | `CACHE_DOMINANT`、`EXE_MISSING` 等结构化规则信号，Agent 即时推理 |
| 高亮指令 | `viz_command` 记录高亮/标注指令（环形缓冲，可增量查询回放） |
| 可逆操作 | 删除强制回收站 + $R 精确映射 + SQLite 日志 + 五步回滚 |
| 用户记忆 | 保护路径 / 标签 / 忽略模式持久化 |

## 快速开始

```bash
# 1. 安装依赖（Python 3.10+，Windows 10/11）
pip install -r requirements.txt

# 2. 验证安装（自动拉起服务并扫描 D:\ 某目录）
python scripts/api_client.py start_scan --drive D:/some/dir
```

服务按需自动启动（首次调用任意工具时拉起），**空闲 5 分钟自动退出**，扫描进行中永不退出。卸载 = 删除整个文件夹。

## 在 Agent 平台使用

### cc-switch（推荐，支持一键安装 Skill）

```bash
# 1. 构建技能包（dist/disk-sense-manager-skill.zip，约 170KB / 24 文件）
python scripts/package_skill.py

# 2. cc-switch → Skills 页 → 导入 ZIP → 选择该文件
#    安装到 ~/.cc-switch/skills/ 并 symlink 到 ~/.claude/skills/ 等应用目录
```

> cc-switch 的识别规则：解压后递归扫描含 `SKILL.md` 的目录，按 frontmatter
> 的 `name`（本技能为 `disk-sense-manager`）作为安装名。

### Claude Code

Claude Code 从以下位置发现技能（目录名即调用名 `/disk-sense-manager`）：

| 级别 | 路径 |
| :--- | :--- |
| 个人（所有项目可用） | `~/.claude/skills/disk-sense-manager/SKILL.md` |
| 项目（仅当前仓库） | `<repo>/.claude/skills/disk-sense-manager/SKILL.md` |

安装方式（二选一）：

```bash
# 方式 A：解压技能包到个人技能目录
python scripts/package_skill.py
unzip dist/disk-sense-manager-skill.zip -d /tmp/skill
mv /tmp/skill/disk-sense-manager ~/.claude/skills/

# 方式 B：直接 symlink 仓库目录（开发时改 SKILL.md 即时生效）
mkdir -p ~/.claude/skills
mklink /J "%USERPROFILE%\.claude\skills\disk-sense-manager" "<仓库绝对路径>"
```

- 会话内输入 `/disk-sense-manager` 显式调用，或直接说"分析 D 盘空间"按
  description 自动触发
- 修改 `SKILL.md` 免重启，Claude Code 会热加载

### OpenCode

OpenCode 兼容多家目录约定，以下任一位置均可被发现：

| 级别 | 路径 |
| :--- | :--- |
| 项目原生 | `<repo>/.opencode/skills/disk-sense-manager/SKILL.md` |
| 项目 Claude 兼容 | `<repo>/.claude/skills/disk-sense-manager/SKILL.md` |
| 全局 Claude 兼容 | `~/.claude/skills/disk-sense-manager/SKILL.md` |
| 全局代理标准 | `~/.agents/skills/disk-sense-manager/SKILL.md` |

安装方式（二选一）：

```bash
# 方式 A：装到全局代理标准目录（推荐，Codex 也能识别）
mkdir -p ~/.agents/skills
mklink /J "%USERPROFILE%\.agents\skills\disk-sense-manager" "<仓库绝对路径>"

# 方式 B：项目级，仓库内 symlink
mkdir -p .opencode/skills
mklink /J .opencode\skills\disk-sense-manager "<仓库绝对路径>"
```

- OpenCode 从 cwd 向上遍历到 git 根，逐级加载 `.opencode/`、`.claude/`、`.agents/` 下的 `skills/*/SKILL.md`
- 通过原生 `skill` 工具按需加载：`skill({ name: "disk-sense-manager" })`
- 注意：OpenCode 要求 frontmatter `name` 全小写连字符且**与目录名一致**（本技能已满足），未知 frontmatter 字段会被忽略

### Codex（OpenAI）

Codex 只认 `.agents/skills` 目录（不认 `.claude/`）：

| 级别 | 路径 |
| :--- | :--- |
| 仓库 | `$REPO_ROOT/.agents/skills/disk-sense-manager/SKILL.md`（从 cwd 向上扫描） |
| 用户 | `~/.agents/skills/disk-sense-manager/SKILL.md` |

安装方式（二选一）：

```bash
# 方式 A：用户级（所有仓库可用）
mkdir -p ~/.agents/skills
mklink /J "%USERPROFILE%\.agents\skills\disk-sense-manager" "<仓库绝对路径>"

# 方式 B：仓库级（随 git 分发给协作者）
mkdir -p .agents/skills
mklink /J .agents\skills\disk-sense-manager "<仓库绝对路径>"
```

- 显式调用：`$disk-sense-manager`；也可按 description 隐式触发
- Codex 支持 symlink，会跟随到目标目录读取 `SKILL.md`
- 可选：在技能目录加 `agents/openai.yaml` 配置 `allow_implicit_invocation: false` 禁止隐式触发


## 手动使用（无 Agent）

```bash
python scripts/launcher.py --start                 # 启动服务（也可 --stop / --status）
python scripts/api_client.py start_scan --drive C: # 扫描（同步等待，打印指纹 JSON）
python scripts/api_client.py list_recent_ops       # 查看操作历史
python scripts/api_client.py undo_operation --op_id 1  # 撤销
```

> 服务仅监听本地回环（127.0.0.1），全部交互经 Agent API 完成。

## 架构

```
用户 ↔ Agent 聊天窗
        │ 脚本执行(api_client.py) / HTTP
        ▼
   scripts/launcher.py ──拉起──▶ disk_sense/server.py (FastAPI, 127.0.0.1:58901)
                                      │ asyncio.to_thread
   ┌──────────┬──────────┬───────────┼──────────┬────────────┐
   │ scanner  │aggregator│ rules_engine│file_operator│ undo_manager │
   │ +mft.py  │ +magic.py│ (YAML 规则) │(回收站$I/$R)│(SQLite+五步) │
   └──────────┴──────────┴───────────┴──────────┴────────────┘
```

模块速览（详见各文件 docstring）：

| 模块 | 职责 |
| :--- | :--- |
| `scanner.py` / `mft.py` | 盘符探测 → MFT 直读 → 多线程 walk 降级；Junction 防护、节流 |
| `aggregator.py` | 种子提取、四角色映射、位置异常关联、global_anomalies 批量魔数 |
| `magic.py` | 文件头 16 字节魔数识别（**全仓库唯一**允许读文件字节处） |
| `rules_engine.py` | SafeEvaluator：受限算子白名单评估 YAML 条件树，绝不 eval |
| `file_operator.py` | SHFileOperationW 回收站删除、$I 快照比对、五步回滚 |
| `undo_manager.py` | SQLite 操作日志、批量原子性、超期归档 |
| `preferences.py` | filelock + 原子写入的用户偏好 |
| `server.py` | 全部端点、叠加层指令缓冲、空闲自毁、单例锁 |

## API 契约

| 端点 | 方法 | 入参 | 返回 |
| :--- | :--- | :--- | :--- |
| `/scan` | POST | `{"drive": "C:"}`（也接受任意目录路径） | `{"status":"completed","session_id","result":{指纹}}` 或 scanning/timeout |
| `/result` | GET | `?session_id` | 会话状态/进度/指纹 |
| `/detail` | GET | `?entity_id&category` | 实体某角色 Top5 文件（数组） |
| `/classify` | POST | `{"path"}` | `{"magic_type","mime","confidence"}` |
| `/viz` | POST | `{"action","target","payload"}` | `{"status":"ok","seq"}`（写入指令缓冲） |
| `/overlays` | GET | `?since_seq` | `{"overlays":[...]}`（seq 之后的高亮指令增量，最近 100 条） |
| `/operation` | POST | `{"op_type","sources","dest"}` | `{"op_uuid","status","results"}` |
| `/history` | GET | `?limit` | 操作记录数组 |
| `/undo` | POST | `{"op_id"}` | `{"status","restored","failed","skipped"}` |
| `/protect` | POST | `{"path","add"}` | `{"status"}` |
| `/tag` | POST | `{"path","tag"}` | `{"status"}` |
| `/health` `/shutdown` | GET | — | 存活探测 / 优雅退出 |
| `/dir_stat` | GET | `?path` | `{"path","is_dir","mtime","atime","ctime","size"}`（只读，无需扫描） |
| `/search_dirs` | GET | `?pattern&root&top` | `{"dirs":[...],"files":[...],"total_*_matched","skipped_inaccessible"}`（fnmatch 搜目录与文件，按大小 Top N） |
| `/path_size` | GET | `?path` | `{"total_bytes","files","dirs","skipped_inaccessible"}`（递归测体积，跳过链接） |
| `/subtree` | GET | `?path&depth`（depth 1–5，默认 1） | `{"path","depth","subtree":{...}}`（treemap 逐层下钻，纯内存；单层 200 项限流；stale 透传） |
| `/operation`（异步） | POST | `{...,"async_mode":true}` | HTTP 202 `{"status":"accepted","job_id"}`（后台执行，审计/回收站/撤销与同步等价） |
| `/job` | GET | `?job_id` | `{"job_id","status":"pending\|running\|succeeded\|failed\|interrupted","progress","result"}` |
| `/rescan` | POST | `?path` | 增量重扫指定路径并合并进会话（操作后 stale 数据刷新，无需全盘重扫） |
| `/recycle_bin_status` | GET | — | `{"entries","total_bytes","per_drive"}`（回收站占用，只读） |
| `/recycle_bin/empty` | POST | `{"op_uuid"}`（必填，不提供全清） | `{"status","freed_bytes","emptied","mismatch","warning"}`（仅清指定操作条目，不可撤销） |

`op_type` ∈ `move|copy|delete|compress`；`action` ∈ `highlight|label|group|protect|clear`。
删除自动走回收站；**源路径须位于已扫描盘符/目录内**（误操作防线）。

## 配置参考

`config/config.yaml`（全部可省略）：

| 键 | 默认 | 说明 |
| :--- | :--- | :--- |
| `server.port` | 58901 | 本地监听端口（仅 127.0.0.1） |
| `scan.use_mft` | true | 本地 NTFS 盘尝试 MFT 直读（需管理员，失败自动降级） |
| `scan.max_workers` | CPU-2 | walk 模式线程数 |
| `scan.throttle_every` | 1000 | 每 N 个文件让出 CPU |
| `scan_api.sync_timeout_sec` | 120 | /scan 同步等待上限 |
| `idle.shutdown_timeout_sec` | 300 | 空闲自毁阈值 |
| `history.retention_days` | 30 | 日志归档天数 |

信号规则：`config/classification_rules.yaml`（结构化条件树，SafeEvaluator 评估）。
同文件还定义**缓存目录模式库** `cache_dir_patterns`（pnpm/yarn/pip/conda/huggingface/torch 等内置，可扩展）：命中目录在指纹 `cache_dirs` 中带 `CACHE_DOMINANT:<type>` 信号，不归入「未归类文件」。
用户偏好（保护路径/标签/忽略/伪实体标记 `pseudo_entity_paths`）运行时存于 `Data/user_preferences.json`；扫描无已知实体时自动按顶层目录生成伪实体（`kind:"pseudo"`），纯数据盘也能走标准实体分析流程。

## 隐私与安全

| 检查项 | 状态 |
| :--- | :--- |
| 读取文件正文（PDF/Word/TXT/图片） | ❌ 永不；仅 `magic.py` 读 16 字节文件头判定格式 |
| 数据上传 | ❌ 全部本地（127.0.0.1），零遥测 |
| 删除可逆 | ✅ 强制回收站 + $R 精确映射 + SQLite 审计 |
| 权限越界 | ❌ 永不 takeown/icacls；受限目录标记跳过 |
| 便携无痕 | ✅ 零注册表/服务/自启；删除目录即卸载 |
| 稀疏文件 | ✅ 读取前比对实际占用，避免触发填充 |

## 开发指南

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements-dev.txt
.venv/Scripts/python -m pytest        # 150 项测试（含真实回收站往返）
```

- 提交规范 / 代码规范 / 隐私红线：[CONTRIBUTING.md](CONTRIBUTING.md)
- MFT 解析器、规则引擎、聚合器均为纯函数，测试用合成数据，无需管理员权限
- `tests/test_file_operator.py::TestRealRecycleBin` 为真实回收站集成测试（仅 Windows）


## 许可证

[MIT](LICENSE) © 2026 Nyaecho
