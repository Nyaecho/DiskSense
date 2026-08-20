# 贡献指南与项目规范

本文件是 DiskSense 仓库的**开发宪法**。任何提交（包括 AI 生成的提交）都必须遵守本规范。
需求源头为仓库根目录的 [`方案书.md`](方案书.md)；实现与方案书存在差异时，必须在
README 的「与方案书的差异说明」一节中记录差异与理由。

---

## 1. 目录结构规范

```
DiskSense/
├── 方案书.md                  # 需求源头（只读参考，不修改）
├── SKILL.md                   # Agent Skill 提示词定义（交付物）
├── scripts/                   # Agent 胶水脚本（launcher / api_client）
├── disk_sense/                # 核心引擎 Python 包
│   ├── server.py              # FastAPI 服务（HTTP + WebSocket）
│   ├── scanner.py             # 扫描调度（MFT 优先 / os.walk 降级）
│   ├── mft.py                 # NTFS MFT 解析器
│   ├── aggregator.py          # 指纹聚合器
│   ├── magic.py               # 魔数识别（唯一允许读文件头的地方）
│   ├── rules_engine.py        # 结构化规则安全评估器
│   ├── file_operator.py       # 文件操作（回收站 / $I$R 映射）
│   ├── undo_manager.py        # SQLite 操作日志与五步回滚
│   ├── preferences.py         # 用户偏好（原子写入 + filelock）
│   ├── report.py              # HTML 报告渲染
│   └── templates/             # 仪表盘模板与前端资源
├── config/                    # YAML 配置（服务 / 规则）
├── tests/                     # pytest 测试（与模块一一对应）
├── Data/                      # 运行时生成（gitignore，删除即卸载）
└── docs/                      # 补充文档
```

规则：
- 一个模块只做一件事；新增模块需在本文件登记。
- 运行时产生的任何文件只能写入 `Data/`，**严禁**写入注册表、系统目录、用户目录。
- `tests/` 文件名与被测模块对应：`scanner.py` → `test_scanner.py`。

## 2. 代码规范

- Python **3.10+**，遵循 PEP 8；单行不超过 100 字符。
- 所有公开函数/类/方法必须有类型注解和中文 docstring（说明用途、参数、返回、异常）。
- 文件一律 UTF-8；`open()` 必须显式 `encoding="utf-8"`（Windows 默认 GBK 会埋雷）。
- 常量用 `UPPER_SNAKE_CASE`，模块级私有用 `_` 前缀。
- 阻塞 IO（扫描、文件操作）在 FastAPI 中必须经 `asyncio.to_thread` 委派，禁止阻塞事件循环。
- Windows 专用代码（ctypes / pywin32）必须提供非 Windows 下的优雅降级路径，测试用
  `pytest.mark.skipif(sys.platform != "win32", ...)` 守护。
- 打印中文/emoji 到 stdout 前先 `sys.stdout.reconfigure(errors="replace")`，防止 GBK 控制台崩溃。

## 3. 隐私与安全红线（Code Review 必查项）

这三条来自方案书「三大铁律」，**任何提交不得违背**：

1. **零内容读取**：除 `magic.py`（读文件头 16 字节判定格式，绝不记录内容）外，
   全仓库禁止以文本模式或解析库读取文件正文。出现 `open(p, "r")` 即拒绝合并。
2. **删除可逆**：删除只能经 `file_operator.py` 的回收站路径
   （`FOF_ALLOWUNDO`），严禁 `os.remove` / `shutil.rmtree` 永久删除用户文件。
   每次操作必须落 SQLite 日志。
3. **永不越权**：严禁调用 `takeown` / `icacls` 或任何修改 ACL / 所有的操作；
   权限不足时静默降级并标记「受限区域」。

另：新增第三方依赖必须更新 `requirements.txt` 并在提交说明中给出理由。

## 4. 提交规范（Conventional Commits）

格式：`<type>(<scope>): <subject>`

- **subject** 用中文祈使句，不超过 50 字，结尾不加句号。
- **body**（可选）说明动机与影响，为什么改比改了什么更重要。
- **footer**（可选）标注关联，如 `Refs: 方案书 §7`。

| type | 用途 |
| :--- | :--- |
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `docs` | 仅文档变更 |
| `test` | 仅测试变更 |
| `refactor` | 重构（不改行为） |
| `perf` | 性能优化 |
| `chore` | 构建/工具/规范等杂务 |

scope 取模块名：`scanner`、`mft`、`aggregator`、`rules`、`ops`、`prefs`、`server`、
`dashboard`、`skill`、`config`、`repo`。

**提交节奏**：按方案书阶段划分，每完成一个可独立验证的阶段提交一次；
每次提交前 `pytest` 必须全绿（阶段未涉及的可先 `xfail`/`skip` 并注明）。

示例：

```
feat(scanner): 实现极速扫描引擎

- 盘符类型主动探测，本地 NTFS 优先 MFT，失败静默降级 os.walk
- 多线程生产者-消费者遍历，Junction 死循环防护
Refs: 方案书 §6
```

## 5. 分支策略

- `main`：始终可运行、测试全绿的稳定分支。
- 功能开发使用 `feat/<模块>-<简述>` 分支，验证通过后合入 `main`。

## 6. 测试规范

- 框架：pytest（`python -m pytest`，配置见 `pyproject.toml`）。
- 每个核心模块必须有对应测试文件；测试不得依赖管理员权限或真实系统盘
  （MFT 解析用合成字节测试；文件系统用 `tmp_path` fixture）。
- 涉及回收站/权限的 Windows 专属测试加 skipif 守护。
- 提交信息中如实报告测试结果；测试失败不得提交（除非标记 `xfail` 并说明）。

## 7. 文档规范

- `README.md`：面向使用者与开发者的一站式入口，须保持与实现同步。
- 与方案书的任何偏离（技术选型、字段、端点）记录在 README「与方案书的差异说明」。
- 配置项变更须同步更新 README 的配置参考表。
