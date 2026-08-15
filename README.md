# dsh-session-manager — 会话管理器（删除 + 归档管理）

为运行中的 DeepSeek Harness Web 增加两件官方缺失的能力：

1. **删除对话**（删除前二次确认）：物理删除会话 —— 停止并销毁对应 agent、清空
   会话存储条目（所有标签页同步移除该行）、删除磁盘上的 JSONL 会话目录、
   清理工作区记账与归档集合。
2. **归档管理**：移入归档（官方已有 `workspace.archiveSession`）与 **移出归档**
   （官方 rc.6 没有 unarchive API，本插件在 host 端补齐，走 workspace registry
   自己的持久化队列，`host/archived-sessions-changed` 帧自动同步所有客户端）。

## UI 入口

| 位置 | 内容 |
|---|---|
| 会话头部（当前会话标题旁） | ⋯ 菜单：**归档 / 移出归档**、**删除会话…**（二次确认）、**打开会话管理…** |
| 侧边栏底部 | **会话管理** 按钮：打开完整管理面板 |

管理面板支持：

- 过滤：全部 / 未归档 / 已归档（已归档会话在侧边栏默认不可见，只有这里能找回）
- 每行操作：**打开**、**归档 / 移出归档**、**删除**（弹窗确认）
- 状态徽标：已归档 / 运行中 / 当前会话；相对时间与工作区目录

删除确认弹窗会：

- 展示会话标题与“不可撤销”警告
- 若该会话正在运行，额外提示“删除将立即中断它”（host 端会自动 cancel）

## 安装（注入）

插件包目录：`本目录`（含 `package.json` + `lib/`），无需构建。

对当前 web 会话中的 AI 说：

```
dev_inject_plugin {"dir": "C:/Users/qinlong/dsh-session-manager"}
```

或（若不想让 AI 代劳）在已常驻注入器的会话里手动执行同名的注入工具。
注入即生效（host API + client UI），不需要重启。

验证：

- 侧边栏底部出现「会话管理」按钮；
- 任意已打开会话的标题栏右侧出现归档图标按钮。

## 卸载

```
dev_uninject_plugin {"name": "dsh-session-manager"}
```

## 实现说明

- **host 端**（`lib/index.js`）：cordis 插件，注入
  `webServer / workspaceRegistry / sessions / agents / sessionPersistence`，
  注册两条 HTTP 端点：
  - `POST /session-manager/api/delete { sessionId }`
  - `POST /session-manager/api/unarchive { sessionId }`
- **client 端**（`lib/client.js`）：loader factory 格式手写 bundle（无构建步骤），
  注册两个 slot：
  - `conversation.session.header.actions`（每会话菜单 + 删除确认）
  - `sidebar.footer.action`（会话管理面板入口）

删除 live 会话的顺序：`agent.cancel`（中断运行）→ `agent.scope.dispose`（安静销毁
agent fiber，3s 上限）→ 从 agents 注册表移除僵尸条目 → `sessions.flush` → 会话
store 条目 detach（触发 `session/disposed` → 各端移除行）→ 工作区记账清理 →
归档集合清理 → 删除磁盘目录。

## 风险与边界

- 删除是不可逆操作（文件物理删除），UI 已做二次确认。
- live 会话删除依赖 host 内部结构（会话 store / agent registry 的实例字段），
  未来 DSH 版本若重构这些内部实现可能需要同步适配（代码均做了防御性访问）。
- 已归档会话若其磁盘文件已被外部删除，移出归档只会把它放回列表（行可能不显示）。
