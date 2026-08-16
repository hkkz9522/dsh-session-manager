# dsh-session-manager — 会话管理器（删除 + 归档管理）

[English](README.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-session-manager)](https://www.npmjs.com/package/dsh-session-manager)
[![GitHub](https://img.shields.io/badge/GitHub-repo-blue)](https://github.com/hkkz9522/dsh-session-manager)
[![CI](https://github.com/hkkz9522/dsh-session-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/hkkz9522/dsh-session-manager/actions/workflows/ci.yml)

为 DeepSeek Harness Web 增加两件官方缺失的能力：

1. **删除对话**（删除前二次确认）：物理删除会话 —— 停止并销毁对应 agent、清空
   会话存储条目（所有标签页同步移除该行）、删除磁盘上的 JSONL 会话目录、
   清理工作区记账与归档集合。
2. **归档管理**：移入归档（官方已有 `workspace.archiveSession`）与 **移出归档**
   （官方 rc.6 没有 unarchive API，本插件在 host 端补齐，走 workspace registry
   自己的持久化队列，`host/archived-sessions-changed` 帧自动同步所有客户端）。

## 特性

- 🗑 **删除会话**：会话头部「删除会话…」按钮 + 管理面板每行删除，全部带二次确认
- 📦 **归档 / 移出归档**：会话头部按钮 + 管理面板逐行操作
- 📋 **会话管理面板**（侧边栏底部入口）：全部 / 未归档 / 已归档 过滤（已归档会话
  侧边栏默认不可见，只有这里能找回），每行「打开 / 归档 / 移出归档 / 删除」
- 🏷 状态徽标：已归档 / 运行中 / 当前会话；相对时间与工作区目录
- ⚠️ 删除确认弹窗展示会话标题与“不可撤销”警告；会话运行中会提示“删除将立即中断它”

## UI 入口

| 位置 | 内容 |
|---|---|
| 会话头部（当前会话标题旁） | 「归档 / 移出归档」与「删除会话…」（红色，二次确认弹窗）两个文字按钮 |
| 侧边栏底部 | 「会话管理」按钮：打开完整管理面板 |

## 安装

### 从 npm 安装（推荐）

```powershell
dsh plugin --profile web add dsh-session-manager
```

重启 web 后生效（profile bundle 自动装配，`lib/` 即运行时产物，无需构建）。

### 从 GitHub 安装（备用）

```powershell
dsh plugin --profile web add github:hkkz9522/dsh-session-manager
```

### 本地开发 / 运行时注入

克隆本仓库后，在已常驻 [dsh-super-injector](https://github.com/yjh051108/dsh-super-injector)
的 web 会话中注入（注入即生效，免重启）：

```
dev_inject_plugin {"dir": "<仓库目录绝对路径>"}
```

## 卸载

- 若通过 `dsh plugin add` 装配：从 `~/.dsh/profiles/web/package.json` 的
  `dependencies` 与 `dsh.profile.bundles` 中移除对应条目，重启。
- 若通过运行时注入安装：`dev_uninject_plugin {"name": "dsh-session-manager"}`

## 兼容性（升级 DSH 后）

- **客户端 UI** 只使用官方插件面（slot 契约 `conversation.session.header.actions` /
  `sidebar.footer.action`、标准工具包 `useSessions` / `useWorkspaces` / `t`、locale、
  client bundle 格式），升级大概率无缝。
- **host 端** 不 import 任何 `@deepseek-ai` 包（仅 node 内置模块），升级不会在
  加载期失败；删除 / 移出归档用到了少数 rc.6 未公开的内部结构（已做防御性访问），
  若未来版本重构这些内部实现，会表现为运行时操作报错而非崩溃，按报错适配即可。
- `peerDependencies` 仅声明 `cordis` 范围，不硬编码 DSH 版本。
- 建议升级后自检一次：新建空白会话并删除（端到端 30 秒），或运行
  `node scripts/smoke-test.mjs`（对两个 host 端点的只读冒烟检查，不触碰真实会话）。

## 开发与维护

- **无构建步骤**：`lib/` 即运行时产物（host 为 ESM，client 为 loader factory 格式手写 bundle）。
- **冒烟测试**：`node scripts/smoke-test.mjs [baseUrl]`（需运行中的 dsh web）。
- **CI**（`.github/workflows/ci.yml`）：`node --check` 两个文件 + `npm pack --dry-run`
  校验发布包内容。
- 变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

## 实现说明

- **host 端**（`lib/index.js`）：cordis 插件，注入
  `webServer / workspaceRegistry / sessions / agents / sessionPersistence`，
  注册两条 HTTP 端点：
  - `POST /session-manager/api/delete { sessionId }`
  - `POST /session-manager/api/unarchive { sessionId }`
- **client 端**（`lib/client.js`）：loader factory 格式手写 bundle（无构建步骤），
  注册两个 slot：
  - `conversation.session.header.actions`（每会话操作 + 删除确认）
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

## 开源许可

本项目基于 [MIT License](./LICENSE) 开源。

你可以自由地使用、修改、复制、分发本项目（包括商业用途），但需保留版权声明与
本许可文本；项目按“现状”提供，作者不对其适用性、可靠性或特定用途的适配性作任何
明示或默示的担保。完整条款见 [LICENSE](./LICENSE)。
