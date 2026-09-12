# dsh-session-manager — DeepSeek Harness 会话管理器

[English](README.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-session-manager)](https://www.npmjs.com/package/dsh-session-manager)
[![GitHub](https://img.shields.io/badge/GitHub-仓库-blue)](https://github.com/hkkz9522/dsh-session-manager)
[![CI](https://github.com/hkkz9522/dsh-session-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/hkkz9522/dsh-session-manager/actions/workflows/ci.yml)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

用于在 DeepSeek Harness（DSH）Web 中进行会话管理，包括：删除会话、归档会话、跨工作区移动会话、迁移会话的 Agent 预设。欢迎至 GitHub 提意见。

## 功能

- **归档 / 移出归档**会话。
- **删除会话**：带不可逆操作的二次确认。
- **移动至工作区**：保留历史、标题、归档状态和派生会话关系，同时把会话的 `cwd` 更新为目标工作区。
- **迁移 Agent 预设**：按需修改。典型工况：当原预设被改名或删除，导致会话无法恢复时，可修复该会话。
- **会话管理窗口**：在侧边栏中浏览未归档和已归档会话，并对每一行执行打开、归档 / 移出归档、移动、迁移预设、删除。
- 当前会话标题区域提供归档 / 移出归档、移动至工作区和红色的删除会话按钮。
- 弹窗按钮（移动、迁移预设、删除，以及"会话管理"入口）再次点击会关闭对应弹窗，与标题栏原生按钮行为一致。

## UI 入口

- **会话标题右侧**：归档 / 移出归档、移动至工作区、删除会话。
- **侧边栏底部 → 会话管理**：查看全部会话（含归档会话）并操作每一条会话。

## Agent 预设迁移

1. 打开**会话管理**。
2. 找到目标会话，点击**迁移预设**。
3. 从当前可用的预设中选择目标预设并确认。

例如：当会话无法恢复，报错表明原 Agent 预设不存在时（例如删掉了 `router-standard`），可以使用迁移功能。

插件会读取最后一条 `agent-preset/selected` 事件中的有效预设（若不存在则读取会话 header），然后就地重写该事件（若会话从未记录过选择事件则追加新事件）——这一做法是持久的，旧事件保留在日志中作为历史。对 live session，新事件通过 `Session.append()` 追加到内存，再通过 `SessionStore.flush()` 刷到磁盘；api-gateway 的聊天面板在下次事件折叠时即可看到新预设。

> 迁移预设只会修改会话元数据，不会改写历史消息、文件或当前工作区。

## 安装

本插件已收录于 [dsh-market](https://github.com/dsh-market/dsh-market) 和 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，可以通过 DSH 应用内的**插件市场**直接搜索安装。

### 从 dsh-market 安装

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

## 安全与行为说明

- **删除不可恢复**，因此界面始终要求确认。
- 移动和迁移预设会先 quiesce 该会话的 live agent（取消运行 + 释放 scope + 移出 SessionStore），即使聊天标签页还开着也能成功；侧边栏会自动刷新。
- 移动会改写会话保存的 `cwd`，之后的工具调用将在目标工作区执行。
- subagent 会话和临时空白会话占位不会参与删除、移动或迁移预设。
- 持久化改写走 DSH 自身的 `open/create/append/flush` 接口，编解码链在内部处理 v2 → v3 格式迁移，写出的工件对当前 DSH 版本始终合法。

## 兼容性

| 插件版本 | 已验证 DSH 版本 |
| --- | --- |
| 0.4.10 | v0.1.5-rc.1 |
| 0.4.9 | v0.1.5-rc.1 |
| 0.4.7 | v0.1.5-rc.1 |
| 0.4.4 | 0.1.3-alpha.2 |
| 0.4.1 | 0.1.3-alpha.2 |
| 0.4.0 | v0.1.2-rc.1 |
| 0.1.2 | v0.1.0-rc.7 |
| 0.1.1 | v0.1.0-rc.7 |
| 0.1.0 | v0.1.0-rc.7 |

本插件是 Cordis 插件，peer dependency 为 `cordis: ">=4.0.0-rc <5"`。

## 开发

- `lib/index.js` 是 host 端 ESM 插件，`lib/client.js` 是 Web 客户端 bundle，无需构建步骤。
- 提交修改前请运行：

```powershell
node --check lib/client.js
node --check lib/index.js
node --test test/*.test.mjs
node scripts/smoke-test.mjs
git diff --check
npm pack --dry-run
```

发布记录见 [CHANGELOG.md](CHANGELOG.md)。

## 致谢

感谢每一位安装和使用 dsh-session-manager 的用户，也感谢提交 Issue 与 Pull Request 帮助改进本插件的朋友们。

本插件已被 [dsh-market](https://github.com/dsh-market/dsh-market) 和 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 收录。欢迎提出修改意见。

## 开源许可

[MIT](LICENSE)
