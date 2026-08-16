# Changelog

## 0.1.0 — 2026-08-16

- **删除对话（二次确认）**：物理删除会话 —— 中断并销毁对应 agent、会话存储 detach
  （所有标签页同步移除）、删除磁盘 JSONL 目录、清理工作区记账与归档集合。
- **归档管理**：移入归档（官方 `workspace.archiveSession`）与移出归档
  （官方 rc.6 缺失，host 端补齐，走 workspace registry 持久化队列）。
- **会话管理面板**（侧边栏底部入口）：全部 / 未归档 / 已归档过滤，逐行
  打开 / 归档 / 移出归档 / 删除。
- **会话头部操作**：「归档 / 移出归档」与「删除会话…」（红色、二次确认）按钮。
- 兼容性：host 端不 import 任何 `@deepseek-ai` 包；`peerDependencies` 仅声明
  `cordis` 范围；升级 DSH 大概率无缝（详见 README「兼容性」）。
