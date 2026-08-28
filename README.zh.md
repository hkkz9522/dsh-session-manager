# dsh-session-manager — DeepSeek Harness 会话管理器

[English](README.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-session-manager)](https://www.npmjs.com/package/dsh-session-manager)
[![GitHub](https://img.shields.io/badge/GitHub-仓库-blue)](https://github.com/hkkz9522/dsh-session-manager)
[![CI](https://github.com/hkkz9522/dsh-session-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/hkkz9522/dsh-session-manager/actions/workflows/ci.yml)

用于管理 DeepSeek Harness（DSH）Web 对话的插件。它提供归档管理、永久删除、
跨工作区移动，以及**按单条对话迁移 Agent 预设**的能力。

## 功能

- **归档 / 移出归档**对话。
- **删除会话**：带不可逆操作的二次确认。
- **移动至工作区**：保留历史、标题、归档状态和派生会话关系，同时把会话的
  工作目录更新为目标工作区。
- **单条对话迁移 Agent 预设**：当原预设被改名或删除，导致会话无法恢复时，可
  单独修复该对话。
- **会话管理窗口**：在侧边栏中浏览未归档和已归档会话，并对每一行执行打开、
  归档 / 移出归档、移动、删除、迁移预设。
- 当前对话标题区域提供归档 / 移出归档、移动至工作区和红色的删除会话按钮。

## UI 入口

- **对话标题右侧**：归档 / 移出归档、移动至工作区、删除会话。
- **侧边栏底部 → 会话管理**：查看全部会话（含归档会话）并操作每一条会话。
- **会话管理的会话行 → 迁移预设**：只迁移当前这一条会话；不再提供批量迁移。

## Agent 预设迁移

当对话无法恢复，且报错表明原 Agent 预设不存在时（例如删掉了
`router-standard`），可以使用单条迁移功能。

1. 打开**会话管理**。
2. 找到目标对话，点击**迁移预设**。
3. 从当前可用的预设中选择目标预设并确认。

插件会优先读取最后一条 `agent-preset/selected` 事件中的有效预设；若不存在该
事件，则读取会话 header 中的预设。迁移时会安全改写对应的持久化记录、释放可能残留
的 live persistence owner，并刷新会话列表。若该会话当前打开，请在迁移后重新打开
再继续对话。

> 迁移预设只会修改会话元数据，不会改写历史消息、文件或当前工作区。

## 安装

### 从 npm 安装

```powershell
dsh plugin --profile web add npm:dsh-session-manager
```

### 从 GitHub 安装

```powershell
dsh plugin --profile web add github:hkkz9522/dsh-session-manager
```

安装后重启 DSH Web。若浏览器仍加载旧的客户端代码，请使用 `Ctrl+Shift+R` 强制刷新。

### 本地开发 / 运行时注入

```text
dev_inject_plugin {"dir": "<本仓库的绝对路径>"}
```

## HTTP API

以下本地接口供 Web UI 使用，也可用于集成和排查：

```text
POST /session-manager/api/delete         { sessionId }
POST /session-manager/api/unarchive      { sessionId }
GET  /session-manager/api/workspaces
POST /session-manager/api/move           { sessionId, targetWorkspaceId }
GET  /session-manager/api/preset-scan?sessionId=<sessionId>
POST /session-manager/api/preset-migrate { sessionId, toPreset }
```

示例：将一条对话迁移到 `standard` 预设。

```bash
curl -s -X POST http://127.0.0.1:3080/session-manager/api/preset-migrate \
  -H 'content-type: application/json' \
  -d '{"sessionId":"session-...","toPreset":"standard"}'
```

## 安全与行为说明

- **删除不可恢复**，因此界面始终要求确认。
- 移动正在运行的对话时，插件会先中断并关闭该会话，然后自动刷新侧边栏；请在
  目标工作区重新打开会话后继续。
- 移动会改写会话保存的 `cwd`，之后的工具调用将在目标工作区执行。
- subagent 会话和临时空白会话占位不会参与删除、移动或预设迁移。
- 文件改写使用临时文件和原子替换（环境支持时），避免产生部分写入的会话工件。

## 兼容性与开发

- 本插件是 Cordis 插件，声明的 peer dependency 为 `cordis >=4.0.0-rc <5`。
- `lib/index.js` 是 host 端 ESM 插件，`lib/client.js` 是 Web 客户端 bundle，
  无需构建步骤。
- 提交修改前请运行：

```powershell
node --check lib/client.js
node --check lib/index.js
git diff --check
node scripts/smoke-test.mjs
npm pack --dry-run
```

发布记录见 [CHANGELOG.md](CHANGELOG.md)。

## 开源许可

[MIT](LICENSE)
