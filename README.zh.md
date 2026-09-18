# dsh-session-manager — DeepSeek Harness 会话管理器

[English](README.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-session-manager)](https://www.npmjs.com/package/dsh-session-manager)
[![GitHub](https://img.shields.io/badge/GitHub-仓库-blue)](https://github.com/hkkz9522/dsh-session-manager)
[![CI](https://github.com/hkkz9522/dsh-session-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/hkkz9522/dsh-session-manager/actions/workflows/ci.yml)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

DSH Web 会话管理：删除、归档、跨工作区移动、迁移预设；收藏、待看、搜索、排序、设置优先级、添加（手动/半自动）标签和备注。欢迎至 GitHub 提意见。

## 功能

### 会话生命周期

- **归档 / 移出归档**会话。
- **删除会话**：不可逆操作的二次确认。subagent 会话和临时空白会话占位会被拒绝。
- **移动至工作区**：保留历史、标题、归档状态和派生会话关系，同时把会话的 `cwd` 更新为目标工作区。移动会就地更新 live writer 的 header，使挂起的工具调用继续落到新路径。
- **迁移 Agent 预设**：按需修改。典型工况：当原预设被改名或删除，导致会话无法恢复时，可修复该会话。迁移会就地重写最后一条 `agent-preset/selected` 事件（若从未记录选择事件则修改会话 header），不会改写历史消息。

### 会话管理窗口（侧边栏）

- 浏览未归档和已归档会话、切换工作区、在列表中筛选 / 排序 / 搜索。
- 直接从某一行打开会话，或点击标签直接按该标签筛选。
- 每行操作：**打开**、**归档 / 移出归档**、**移动**、**迁移预设**、**删除**。
- 各弹窗（移动 / 迁移预设 / 删除 / 面板本身）在触发按钮再次点击时会切换关闭，与标题栏原生按钮的行为一致。

### 搜索、筛选和排序

- 不区分大小写的标题和会话 ID 搜索，自动去除首尾空格；不读取聊天历史。
- 工作区下拉（全部 / 未分组 / 具体工作区）可与归档状态筛选（全部 / 未归档 / 已归档）叠加。
- 可叠加收藏 / 待回看、标签和优先级筛选；排序支持最近更新（默认）、最早更新、最新创建、最早创建以及**优先级（1 → 5）**。
- 显示匹配 / 总数，并提供"重置筛选"。这些控件只影响管理窗口，不改变会话归属、归档状态或原生侧边栏顺序。
- 工作区加载失败时可重试，标题 / ID 搜索和更新时间排序仍可使用。

### 收藏、待回看、标签、备注与优先级

- **标题栏**（当前会话）和 **管理窗口**（每一行）都提供收藏 / 待回看 / **标签 / 备注** / 优先级操作入口。
- 收藏是长期标记，待回看是手动提醒；不会随归档或会话结束自动清除。
- 优先级下拉：**1 最高、2 高、3 普通、4 低、5 最低**，**默认 3（普通）**；管理行 / 标题栏始终显示 P1–P5 徽标。旧数据中的 `null` 优先级归一化为 3。
- 标签：每个会话最多 20 个，每个最多 32 字符；英文 `,` 与中文 `，` 都是分隔符，首尾空白被去除，重复标签按大小写不敏感合并。
- 备注：最多 2000 字符的多行纯文本。
- 标签、备注、AI 粘贴三个输入框使用相同的 `sm-noteInput` 样式与 `rows: 3` 高度（60px min-height），三个字段在视觉上对齐。
- "标签 / 备注" 编辑窗口内还提供 **复制 Prompt** / **导入** 两个按钮，用于 AI 辅助整理（见下）。
- 标记明文保存在 DSH home 下的 `dsh-session-manager/annotations.v1.json`，按会话 ID 关联；不写入 JSONL/Zstd 历史，也不自动发送给模型。移动 / 迁移预设会保留标记；删除会话后会清理对应标记（清理失败会单独提示）。
- 标题栏和管理窗口实时共享状态；同源浏览器标签页通过 `BroadcastChannel` 通知同步，重新获得焦点或打开管理窗口也会刷新数据。
- 保存采用原子写入并使用跨进程锁；版本冲突时保留草稿，要求显式"载入最新内容"。保存失败不会关闭编辑窗口或丢弃草稿。
- 异常退出遗留的 `annotations.v1.lock` 不会被自动强行删除；应在确认没有进程写入后再处理。

### AI 整理（手动、可选）

**标签/备注** 编辑窗口在标准"取消 / 保存标记"按钮之外，还多了两个按钮，位于粘贴输入框上方。两者都不会自动调用模型，是否发送完全由你决定：

- **复制 Prompt** / **Copy Prompt**：把结构化 Prompt（中文或英文，跟随当前界面语言）复制到剪贴板。粘贴到当前对话中，要求模型按本插件的限制生成标签 / 备注 / 优先级（最多 20 个标签、每个 ≤ 32 字符、备注 ≤ 2000 字符、优先级 1–5 默认 3）。
- **导入** / **Import**：读取剪贴板，提取首个 JSON 对象（可识别 Markdown 代码块、对话包裹、智能引号、孤立反斜杠和开头 BOM），按相同规则校验后填入编辑窗口。如果当前有未保存的修改，会先询问是否覆盖再继续。超限的标签会被丢弃、超长的备注会被截断，所有调整都会在状态消息中列出，确认后再保存。如果仍然解析失败，错误信息会附带每一次修复尝试中 `JSON.parse` 给出的具体位置（原始 / 修复引号反斜杠 / 扫描对象 / 扫描对象+修复），方便定位坏掉的字符。

Prompt 模板和导入解析逻辑位于 `lib/clipboard-parser.js`，直接打包进客户端，无需额外构建步骤，也不会发起任何网络请求。

### 当前会话标题栏

标题栏右侧提供：

- **归档 / 移出归档** 当前会话。
- **移动至工作区**，弹窗选择目标工作区。
- 红色的 **删除会话** 按钮，带确认。

同样的按钮在管理窗口每一行也可用。

## UI 入口

- **会话标题右侧**：归档 / 移出归档、移动至工作区、删除会话。
- **侧边栏底部 → 会话管理**：查看全部会话（含归档会话）并操作每一条会话。

## Agent 预设迁移

1. 打开**会话管理**。
2. 找到目标会话，点击**迁移预设**。
3. 从当前可用的预设中选择目标预设并确认。

例如：当会话无法恢复，报错表明原 Agent 预设不存在时（例如删掉了 `router-standard`），可以使用迁移功能。

插件会读取最后一条 `agent-preset/selected` 事件中的有效预设（若不存在则读取会话 header）。冷会话会重写最后一条选择事件；从未记录选择事件时修改 header。正常的 live session 通过 `Session.append()` 追加选择事件，再通过 `SessionStore.flush()` 刷到磁盘；api-gateway 的聊天面板在下次事件折叠时即可看到新预设。

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

- **删除不可恢复**，因此界面始终要求确认。删除前校验会话 ID、目录边界和工件 header；不允许通过路径穿越、符号链接或 junction 操作其他目录。
- 移动和迁移预设保留 live session / agent；删除才会取消运行并释放会话。移动会更新保存的 cwd 和 live writer 的 header。
- 会话管理列表隐藏 subagent 会话，移动接口也拒绝 subagent；尚未落盘的空白会话不能跨工作区移动。
- 冷会话重写保留原工件格式，不强制升级 v2 → v3。损坏或截断的 Zstd 日志、缺少完整尾行的 JSONL 会拒绝移动/重写，不会把部分历史当作完整日志保存。
- 迁移预设按“备份 → 发布 → 回滚”分阶段处理。如果回滚失败，会保留恢复文件并在错误中报告路径；不要删除这些文件。
- 启动扫描不完整时跳过工作区归属修复；完整扫描也不会清除仍在内存中或扫描期间新加入的会话。
- 同一会话的插件写操作按顺序执行；请求体限制为 64 KiB。该队列不替代 DSH 自身的持久化写入协调。

## 兼容性

| 插件版本   | 已验证 DSH 版本    |
| ------ | ------------- |
| 0.5.1 | v0.1.6-alpha.2   |
| 0.4.11 | v0.1.5-rc.2   |
| 0.4.10 | v0.1.5-rc.1   |
| 0.4.9  | v0.1.5-rc.1   |
| 0.4.7  | v0.1.5-rc.1   |
| 0.4.4  | 0.1.3-alpha.2 |
| 0.4.1  | 0.1.3-alpha.2 |
| 0.4.0  | v0.1.2-rc.1   |
| 0.1.2  | v0.1.0-rc.7   |
| 0.1.1  | v0.1.0-rc.7   |
| 0.1.0  | v0.1.0-rc.7   |

运行时要求 Node.js 22.15+（22.x）或 24+，以提供内置 Zstd 支持。

本插件是 Cordis 插件，peer dependency 为 `cordis: ">=4.0.0-rc <5"`。

## 开发

- `lib/index.js` 是 host 端 ESM 插件，`lib/client.js` 是 Web 客户端 bundle，无需构建步骤。
- 提交修改前请运行：

```powershell
npm run check
npm test
npm run check:package
git diff --check
```

测试使用隔离临时目录和真实插件入口，不操作真实会话。CI 在 Windows/Linux、Node 22.15.0/24 上执行相同检查。

可选集成检查：在 DSH Web 已运行的测试环境中执行 `node scripts/smoke-test.mjs`；它会请求实际服务，不属于默认单元测试。

发布记录见 [CHANGELOG.md](CHANGELOG.md)。

## 致谢

感谢每一位安装和使用 dsh-session-manager 的用户，也感谢提交 Issue 与 Pull Request 帮助改进本插件的朋友们。

本插件已被 [dsh-market](https://github.com/dsh-market/dsh-market) 和 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 收录。欢迎提出修改意见。

## 开源许可

[MIT](LICENSE)
