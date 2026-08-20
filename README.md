# DiskSense

> 便携式 AI 磁盘文件管理器 —— 由 LLM Agent 驱动的本地磁盘语义化管理 Agent Skill 包

融合 **Everything 的检索速度 + SpaceSniffer 的可视化 + 文件管理器的操作能力 + LLM 的语义推理**。

- 需求源头：[方案书.md](方案书.md)（v3.3 封版）
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
11. [与方案书的差异说明](#与方案书的差异说明)

---

## 它是什么

DiskSense 不是独立的可执行程序，而是一个 **Agent Skill 包**：`SKILL.md`（提示词）
+ Python 脚本。Agent 加载后即可：

| 能力 | 说明 |
| :--- | :--- |
| 极速扫描 | 本地 NTFS 盘优先 MFT 直读（需管理员，自动降级多线程 os.scandir） |
| 指纹聚合 | 百万文件 → 50~200 个「软件实体」档案（≤5000 Token），附语义信号 |
| 语义信号 | `CACHE_DOMINANT`、`EXE_MISSING` 等结构化规则信号，Agent 即时推理 |
| 可视化 | 浏览器 Treemap 仪表盘（D3 内嵌，离线可开），Agent 可远程高亮/标注 |
| 可逆操作 | 删除强制回收站 + $R 精确映射 + SQLite 日志 + 五步回滚 |
| 用户记忆 | 保护路径 / 标签 / 忽略模式持久化 |

## 快速开始

```bash
# 1. 安装依赖（Python 3.10+，Windows 10/11）
pip install -r requirements.txt

# 2. 验证安装（自动拉起服务并扫描 D:\ 某目录）
python scripts/api_client.py start_scan --drive D:/some/dir

# 3. 打开仪表盘
start http://127.0.0.1:58901/
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

> **不要**直接把整个仓库打成 zip：`.venv/`（上万文件）会撞 cc-switch 的
> ZIP 条目数上限/解压预算导致安装失败，开发产物也会污染技能目录。
> cc-switch 的识别规则：解压后递归扫描含 `SKILL.md` 的目录，按 frontmatter
> 的 `name`（本技能为 `disk-sense-manager`）作为安装名。

### Claude Code（手动）

```bash
python scripts/package_skill.py
unzip dist/disk-sense-manager-skill.zip -d ~/.claude/skills/
```

### Cline

把整个 `DiskSense/` 仓库目录放入 Cline Skills 目录（或配置指向），
Cline 自动加载 `SKILL.md`。聊天框输入「扫描 C 盘」即可。

### OpenAI Assistant / 自定义 Agent

把 `SKILL.md` 内容并入 System Prompt，注册「执行 Python 脚本」工具
（Bash/Code Interpreter），技能目录作为 `{SKILL_DIR}` 传入。

**Claude Desktop**：原生 MCP 不支持直接执行脚本，需自行封装 MCP 工具
（不推荐，见方案书 §16.2）。

Agent 的完整工作流（扫描 → 信号分析 → 仪表盘高亮 → 确认后执行 → 可回滚）
见 [SKILL.md](SKILL.md)。

## 手动使用（无 Agent）

```bash
python scripts/launcher.py --start                 # 启动服务（也可 --stop / --status）
python scripts/api_client.py start_scan --drive C: # 扫描（同步等待，打印指纹 JSON）
python scripts/api_client.py list_recent_ops       # 查看操作历史
python scripts/api_client.py undo_operation --op_id 1  # 撤销
```

仪表盘：浏览器打开 `http://127.0.0.1:58901/`（扫描后 Treemap 生长）。
离线报告：`Data/reports/report_*.html`（单文件，无网络也能打开）。

## 架构

```
用户 ↔ Agent 聊天窗 / 浏览器仪表盘
        │ 脚本执行(api_client.py)      │ HTTP / WebSocket
        ▼                              ▼
   scripts/launcher.py ──拉起──▶ disk_sense/server.py (FastAPI, 127.0.0.1:58901)
                                      │ asyncio.to_thread
   ┌──────────┬──────────┬───────────┼──────────┬────────────┐
   │ scanner  │aggregator│ rules_engine│file_operator│ undo_manager │
   │ +mft.py  │ +magic.py│ (YAML 规则) │(回收站$I/$R)│(SQLite+五步) │
   └──────────┴──────────┴───────────┴──────────┴────────────┘
                                      │
                              templates/template.html（D3 内嵌仪表盘）
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
| `server.py` | 全部端点、WS Hub、空闲自毁、单例锁 |
| `report.py` | 模板渲染 + 离线报告 |

## API 契约

| 端点 | 方法 | 入参 | 返回 |
| :--- | :--- | :--- | :--- |
| `/scan` | POST | `{"drive": "C:"}`（也接受任意目录路径） | `{"status":"completed","session_id","result":{指纹}}` 或 scanning/timeout |
| `/result` | GET | `?session_id` | 会话状态/进度/指纹 |
| `/detail` | GET | `?entity_id&category` | 实体某角色 Top5 文件（数组） |
| `/classify` | POST | `{"path"}` | `{"magic_type","mime","confidence"}` |
| `/viz` | POST | `{"action","target","payload"}` | `{"status":"ok","seq"}` |
| `/operation` | POST | `{"op_type","sources","dest"}` | `{"op_uuid","status","results"}` |
| `/history` | GET | `?limit` | 操作记录数组 |
| `/undo` | POST | `{"op_id"}` | `{"status","restored","failed","skipped"}` |
| `/protect` | POST | `{"path","add"}` | `{"status"}` |
| `/tag` | POST | `{"path","tag"}` | `{"status"}` |
| `/ws` | WS | snapshot/progress/scan_complete/overlay/operation 消息 | 实时推送 |
| `/poll` | GET | `?since` | WS 降级轮询（500ms） |
| `/health` `/shutdown` | GET | — | 存活探测 / 优雅退出 |

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
| `report.max_entities` | 200 | 指纹实体数上限（Token 优化） |

信号规则：`config/classification_rules.yaml`（结构化条件树，SafeEvaluator 评估）。
用户偏好（保护路径/标签/忽略）运行时存于 `Data/user_preferences.json`。

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

## 验收状态

| 指标（方案书 §18） | 结果 | 说明 |
| :--- | :--- | :--- |
| 自动化测试 | ✅ 150 passed | 单元 + 集成 + 真实回收站往返 |
| MFT 解析正确性 | ✅ 合成记录单测 | Fixup/$FILE_NAME/命名空间/孤儿/环防护 |
| 回收站映射准确率 | ✅ $I 前后快照 + 长度前缀解析 | Win10/11 实测捕获 $R 名 |
| 回滚（父目录存续） | ✅ 集成测试 | 冲突重命名/批量部分失败/已撤销跳过 |
| 误删防护 | ✅ | 无任何永久删除代码路径；保护路径 403 |
| Token 消耗 | ✅ 指纹 JSON < 20KB 断言 | ~5000 Token 预算 |
| 仪表盘 | ✅ 浏览器实测 | 14 瓷贴/三类叠加层/表格视图/离线报告 |
| 端到端旅程 | ✅ 全链路冒烟 | 方案书 §17 十三步全部走通 |
| 扫描速度（1TB HDD ≤45s） | ⏳ 待真机验收 | MFT 路径需管理员环境实测 |
| 单例锁并发 10 次 | ⏳ 待专项压测 | filelock + 端口绑定双保险已实现 |

## 与方案书的差异说明

实现与方案书 v3.3 的一致性记录（差异均为工程化修正，均已在提交说明注明）：

1. **`requirements.txt` 补充 `requests`**：方案书 §3.2 清单遗漏，但 §5 的
   launcher/api_client 代码依赖它。
2. **删除 API 用 `SHFileOperationW`（ctypes）而非 IFileOperation**：语义完全
   等价（同一 Shell 层，`FOF_ALLOWUNDO` 同样进回收站），避免 pywin32 缺少
   IFileOperation 直接封装的问题。
3. **回收站映射用 $I 文件解析而非 Shell.NameSpace 枚举**：方案书 §12.2 的
   名称比对在 Win10/11 下拿不到物理 $R 名；直接解析
   `$Recycle.Bin\<SID>\$I` 二进制（兼容长度前缀与 NUL 两种布局）得到精确映射。
4. **新增模块 `models.py` / `mft.py` / `magic.py` / `report.py`**：方案书 §16.1
   清单的合理细化（Node 树共享、MFT 解析独立可测、魔数库独立、渲染独立）。
5. **指纹 JSON 附加字段**：`signals_legend`（帮助 Agent 理解信号）、`treemap`
   （仪表盘数据）、实体 `display`/`location_anomaly`/`tags`——均为超集，不破坏
   方案书 §7.3 结构。
6. **新增伪实体 `system-temp`**：AppData\Local\Temp 与 Windows\Temp 的无主缓存
   归入「系统临时文件」实体（方案书未定义，清理建议高价值目标）。
7. **操作范围校验细化**：整盘扫描放行该盘全域；目录扫描仅放行该目录前缀
   （方案书 §15「属于本次扫描盘符」的更严格实现）。
8. **`/operation` 同步执行**：返回 `completed` + 逐源 `results`（方案书示例的
   `queued` 为异步队列语义，当前同步实现更简单且日志一致）。
9. **仪表盘配色**：按数据可视化规范采用经校验的分类/序数调色板（all-pairs CVD
   校验通过），非方案书示例中的任意色值；每瓷贴直接标签 + 表格视图满足对比度
   救济规则。
10. **`last_access_days` 语义**：取实体所有文件 `max(mtime, atime)`（NTFS 可能
    关闭访问时间更新，取二者较新者更稳健）。

## 许可证

[MIT](LICENSE) © 2026 Nyaecho
