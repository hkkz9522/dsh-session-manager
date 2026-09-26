# dsh-session-manager — DeepSeek Harness 会话管理器

[English](README.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-session-manager)](https://www.npmjs.com/package/dsh-session-manager)
[![GitHub](https://img.shields.io/badge/GitHub-仓库-blue)](https://github.com/hkkz9522/dsh-session-manager)
[![CI](https://github.com/hkkz9522/dsh-session-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/hkkz9522/dsh-session-manager/actions/workflows/ci.yml)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

## 0 简介

DSH Web 会话管理：删除、归档、跨工作区移动、迁移预设；收藏、待看、搜索、排序、设置优先级、添加标签和备注；批量处理。欢迎至 GitHub 提意见。

## 1 功能

### 1.1 会话生命周期管理

- **删除**：不可逆操作，UI 始终要求二次确认。subagent 会话和尚未落盘的空白会话占位不能删除。
- **归档 / 移出归档**：把会话移出或移回主列表，不删除磁盘内容。
- **移动至工作区**：跨工作区移动时保留历史、标题、归档状态和派生会话关系，同时把 `cwd` 重写为目标工作区，并就地更新 live writer 的 header，使挂起的工具调用继续落到新路径。
- **迁移 Agent 预设**：原预设被改名或删除导致会话无法恢复时，可修复该会话。迁移会就地重写最后一条 `agent-preset/selected` 事件（若从未记录则修改会话 header），不改动历史消息。

### 1.2 会话快捷管理

- **收藏 / 待回看**：长期标记和手动提醒；不会随归档或会话结束自动清除。
- **搜索**：按标题、会话 ID、备注、标签不区分大小写匹配，自动去除首尾空格，不读取聊天历史。
- **筛选与排序**：工作区（全部 / 未分组 / 具体）与归档状态（全部 / 未归档 / 已归档）可叠加；可叠加收藏 / 待回看、标签和优先级筛选；排序支持最近更新（默认）、最早更新、最新创建、最早创建以及**优先级（1 → 5）**。
- **优先级**：下拉 **1 最高、2 高、3 普通、4 低、5 最低**，**默认 3（普通）**；旧数据中的 `null` 归一化为 3。
- **标签 / 备注**：每会话最多 20 个标签（每个 ≤ 32 字符）、备注最多 2000 字符。英文 `,` 与中文 `，` 都是分隔符，首尾空白被去除，重复标签按大小写不敏感合并。
- **AI 整理（手动、可选）**：标签 / 备注编辑窗口内的 **复制 Prompt** 把结构化提示复制到剪贴板，**导入** 解析剪贴板 JSON（可识别 Markdown 代码块、对话包裹、智能引号、孤立反斜杠和开头 BOM），按相同规则校验后填入字段；两者都不会自动调用模型。
- 标记保存在 `dsh-session-manager/annotations.v1.json`，按会话 ID 关联；同源浏览器标签页通过 `BroadcastChannel` 同步；保存可跨进程崩溃恢复，版本冲突会提示"载入最新内容"。

### 1.3 批量处理

- **批量模式入口**：在会话管理窗口顶部点击 **批量处理** 切换按钮，行左侧出现复选框，工具栏出现 **全选当前筛选 / 清空选择** 和 **批量按钮区**；退出批量模式会清空当前选中。
- **批量按钮区** 列出所有批量动作：
  - **标记切换**：**归档 / 取消归档 / 收藏 / 取消收藏 / 待回看 / 取消待看**。
  - **变更操作**：**添加标签 / 清空标签 / 设置优先级 / 移动至工作区 / 迁移预设 / 删除会话**。
- **执行流程**：非破坏性操作（归档 / 取消归档 / 收藏 / 取消收藏 / 待回看 / 取消待看 / 添加标签 / 清空标签 / 设置优先级 / 移动至工作区 / 迁移预设）立即执行，结果按会话逐条展示在 **结果对话框** 的 **成功 / 失败 / 跳过** 分组里，并提供 **重试失败项** 一键把失败 ID 重新加入选中；破坏性操作（**删除会话**）先弹 **预览对话框** 列出受影响的会话，再显示进度条，最后给出逐条结果。

## 2 UI入口

### 2.1 标题栏入口

标题栏右侧对**当前会话**提供：**归档 / 移出归档**、**标签 / 备注**、**移动至工作区**、**删除会话**。

### 2.2 会话管理入口与界面

从 DSH 侧边栏底部进入 **会话管理**，可浏览全部会话、切换工作区、按标题 / ID / 备注 / 标签搜索、应用筛选与排序，并对每条会话执行 **打开 / 归档 / 移出归档 / 标签 / 备注 / 移动 / 迁移预设 / 删除** 操作。窗口顶部承载工作区选择、归档筛选、收藏 / 待回看、标签、优先级筛选与排序控件，以及匹配 / 总数计数和"重置筛选"。

### 2.3 批量管理入口

会话管理窗口顶部的 **批量处理** 按钮即是入口：点一下进入批量模式，行左侧出现复选框，工具栏出现 **全选当前筛选 / 清空选择** 和 **批量按钮区**；再点一次退出批量模式。

## 3 安装

### 3.1 从官方插件管理入口安装

进入 DSH 应用内的 **插件管理**，搜索 `dsh-session-manager` 并安装。

### 3.2 从 dsh-market 安装

```powershell
dsh plugin --profile web add npm:dsh-session-manager
```

### 3.3 从 GitHub 安装

```powershell
dsh plugin --profile web add github:hkkz9522/dsh-session-manager
```

安装后重启 DSH Web；若浏览器仍加载旧的客户端代码，请使用 `Ctrl+Shift+R` 强制刷新。

### 3.4 本地开发 / 运行时注入

```text
dev_inject_plugin {"dir": "<本仓库的绝对路径>"}
```

## 4 安全说明

- **删除不可恢复**，UI 始终要求二次确认；删除前校验会话 ID、目录边界和工件 header，不允许通过路径穿越、符号链接或 junction 操作其他目录。
- 移动和迁移预设保留 live session / agent；只有删除才会取消运行并释放会话。移动会更新保存的 cwd 和 live writer 的 header。
- 会话管理列表隐藏 subagent 会话，移动接口也拒绝 subagent；尚未落盘的空白会话不能跨工作区移动。
- 冷会话重写保留原工件格式（V1 / V2 / V3 / V4 都可读，绝不强制升级）。损坏或截断的 Zstd 日志、缺少完整尾行的 JSONL 会拒绝移动 / 重写，不会把部分历史当作完整日志保存。
- 迁移预设按"备份 → 发布 → 回滚"分阶段处理。如果回滚失败，会保留恢复文件并在错误中报告路径；不要删除这些文件。
- 启动扫描不完整时跳过工作区归属修复；完整扫描也不会清除仍在内存中或扫描期间新加入的会话。
- 同一会话的插件写操作按顺序执行；请求体限制为 64 KiB。该队列不替代 DSH 自身的持久化写入协调。

## 5 兼容性

| 插件版本   | 已验证 DSH 版本    |
| ------ | ------------- |
| 0.5.3  | v0.1.7-rc.2   |
| 0.5.2  | v0.1.7-rc.1   |
| 0.5.1 | v0.1.6-alpha.2   |
| 0.4.11 | v0.1.5-rc.2   |
| 0.4.10 | v0.1.5-rc.1   |
| 0.4.9  | v0.1.5-rc.1   |
| 0.4.7  | v0.1.5-rc.1   |
| 0.4.6  | 0.1.3-alpha.2 |
| 0.4.4  | 0.1.3-alpha.2 |
| 0.4.1  | 0.1.3-alpha.2 |
| 0.4.0  | v0.1.2-rc.1   |
| 0.1.2  | v0.1.0-rc.7   |
| 0.1.1  | v0.1.0-rc.7   |
| 0.1.0  | v0.1.0-rc.7   |

运行时要求 Node.js 22.15+（22.x）或 24+，以提供内置 Zstd 支持。

本插件是 Cordis 插件，peer dependency 为 `cordis: ">=4.0.0-rc <5"`。

## 6 开发

- `lib/index.js` 是 host 端 ESM 插件，`lib/client.js` 是 Web 客户端 bundle，无需构建步骤。
- 提交修改前请运行：

```powershell
npm run check
npm test
npm run check:package
git diff --check
```

测试使用隔离临时目录和真实插件入口，不操作真实会话。CI 在 Windows / Linux、Node 22.15.0 / 24 上执行相同检查。

可选集成检查：在 DSH Web 已运行的测试环境中执行 `node scripts/smoke-test.mjs`；它会请求实际服务，不属于默认单元测试。

发布记录见 [CHANGELOG.md](CHANGELOG.md)。

## 7 致谢

感谢每一位安装和使用 dsh-session-manager 的用户，也感谢提交 Issue 与 Pull Request 帮助改进本插件的朋友们。本插件已被 [dsh-market](https://github.com/dsh-market/dsh-market) 和 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 收录。欢迎提出修改意见。

## 8 开源许可

[MIT](LICENSE)
