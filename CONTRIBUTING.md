# 贡献指南

## 提交规范

Conventional Commits：`feat(scope): ...` / `fix(scope): ...` / `docs: ...` / `refactor(scope): ...` / `test(scope): ...`

## 代码规范

- TypeScript strict 全开（含 `exactOptionalPropertyTypes` / `noUncheckedIndexedAccess`），ESM + NodeNext
- 提交前必须通过：

```powershell
npm run typecheck
npm test
npm run build
```

- 相对导入必须带 `.js` 后缀（NodeNext 要求）

## 隐私红线（最高优先级，违反即拒绝合并）

1. **零内容读取**：除 `src/magic.ts`（文件头 ≤16 字节魔数）外，任何代码不得读取/解析/记录文件内容
2. **删除只走回收站**：任何删除路径必须经 `SHFileOperationW(FOF_ALLOWUNDO)`；禁止 `unlinkSync`/`rmSync` 出现在用户数据删除链路（临时文件清理除外）
3. **权限不越界**：禁止 takeown/icacls 等强制改 ACL；受限目录一律跳过并记录
4. **先日志后执行**：一切变更操作必须先写 SQLite 日志（ACTIVE）再执行

## 测试约定

- 纯函数（mft 解析 / 规则引擎 / 聚合器分类）用合成字节/合成树，不碰真实磁盘大对象
- 真实回收站往返测试仅在 win32 运行；测试产生的回收站条目由用例自行清理或撤销
- 涉及会话状态的测试必须设置独立 `DISK_SENSE_HOME`
