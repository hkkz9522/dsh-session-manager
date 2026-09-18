/**
 * @dsh-session-manager — Client half.
 *
 * Renders the title-bar action cluster (Archive / Unarchive, Move to
 * workspace, Delete session) and the sidebar-foot Session manager panel
 * (Open / Archive / Unarchive / Move / Migrate preset / Delete per row,
 * plus search, workspace/archive/annotation filters, sorting and toggle-close behaviour).
 * Favorites, review-later flags, tags, notes and priority share a separate metadata store. No build
 * step: DSH loads the file as a Cordis client bundle via its inject
 * declaration in package.json.
 */
window.__ModuleLoader__.load({
  id: "dsh-session-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useState, useEffect, useMemo, useRef, useSyncExternalStore } = React;
    const P = require("@deepseek-ai/dsh-client-ui-primitives");
    if (typeof window !== "undefined") {
      window.__smReact = React;
      window.__smReactDOM = React.createPortal ? React : null;
      // Tiny imperative portal helper: takes a React element + a host
      // DOM node, creates a React root on the host (lazily), and re-renders
      // the element into it on each call. Used by ConfirmDialog to escape
      // the sidebar overflow:hidden ancestor.
      try {
        const RDOM = require("react-dom/client");
        if (RDOM && typeof RDOM.createRoot === "function") {
          window.__smRenderInto = (tree, host) => {
            if (!tree || !host) return;
            try {
              if (!host.__smRoot) host.__smRoot = RDOM.createRoot(host);
              host.__smRoot.render(tree);
            } catch (_) { /* ignore render failure */ }
          };
        }
      } catch (_) { /* react-dom/client not available */ }
    }

    const NS = "session-manager";
    const API = "/session-manager/api";

    const zh = {
      "marks.filter.favorite": "收藏",
      "marks.filter.favorite.aria": "收藏筛选",
      "marks.filter.review": "待回看",
      "marks.filter.review.aria": "待回看筛选",
      "marks.filter.tags": "按标签筛选",
      "marks.filter.priority": "按优先级筛选",
      "marks.favorite.add": "收藏会话",
      "marks.favorite.remove": "取消收藏",
      "marks.review.add": "标记待回看",
      "marks.review.remove": "取消待回看",
      "marks.edit": "标签/备注",
      "marks.header.edit": "标签/备注",
      "marks.edit.aria": "编辑标签、备注和优先级",
      "marks.title": "会话标记",
      "marks.favorite": "收藏",
      "marks.review": "待回看",
      "marks.tags": "标签",
      "marks.tags.placeholder": "用逗号分隔，最多 20 个标签，每个 32 字符（重复自动合并）。例如：排障，方案",
      "marks.tags.help": "最多 20 个标签，每个 32 字符；重复标签会自动合并",
      "marks.note": "备注",
      "marks.note.placeholder": "例如：等待 Windows 环境验证；下次继续检查回滚逻辑（最多 2000 字符）",
      "marks.privacy": "仅用于会话整理，不写入聊天记录，也不会自动发送给模型。",
      "marks.priority": "优先级",
      "marks.priority.all": "全部优先级",
      "marks.priority.1": "1 · 最高",
      "marks.priority.2": "2 · 高",
      "marks.priority.3": "3 · 普通",
      "marks.priority.4": "4 · 低",
      "marks.priority.5": "5 · 最低",
      "marks.priority.help": "1 最高，5 最低，默认 3（普通）",
      "marks.tags.all": "全部标签",
      "marks.tags.none": "无标签",
      "marks.tags.missing": "{tag}（无匹配）",
      "marks.save": "保存标记",
      "marks.saving": "保存中…",
      "marks.cancel": "取消",
      "marks.loading": "正在加载会话标记…",
      "marks.error": "会话标记加载失败：{message}",
      "marks.retry": "重试标记加载",
      "marks.conflict": "标记已在其他窗口更新。当前输入仍保留；请载入最新内容后再编辑。",
      "marks.reload": "载入最新内容",
      "marks.discard": "放弃当前未保存的标记修改？",
      "marks.note.exists": "有备注",
      "marks.sort": "优先级（1 → 5）",
"marks.note.exists": "有备注",
      "marks.import.copy": "复制 Prompt",
      "marks.import.copy.copied": "已复制，请粘贴到当前对话生成结果",
      "marks.import.copy.failed": "复制失败：{message}",
      "marks.import.paste": "导入",
      "marks.import.paste.label": "AI 返回结果",
      "marks.import.paste.help": "把模型返回的 JSON 粘贴到下方输入框，再点击“导入”",
      "marks.import.paste.aria": "AI 返回的 JSON",
      "marks.import.paste.placeholder": "支持 json 代码块或纯 JSON，例如: { \"tags\": [\"标签1\", \"标签2\"], \"note\": \"会话备注\" }",
      "marks.import.paste.clear": "清空输入框",
      "marks.import.empty": "请先把 AI 返回的 JSON 粘贴到上方输入框",
      "marks.import.unknown": "未知字段",
      "marks.import.discard": "导入将覆盖当前未保存的修改，是否继续？",
      "marks.import.failure": "导入失败：{message}",
      "marks.import.warnings": "已导入，但有以下调整：",
      "marks.import.success": "已从剪贴板导入 AI 结果",
      "marks.tags.clear": "清空标签",
      "marks.note.clear": "清空备注",
      "header.aria": "会话操作",
      "menu.open": "打开",
      "menu.archive": "归档会话",
      "menu.unarchive": "移出归档",
      "menu.delete": "删除会话…",
      "menu.move": "移动到工作区…",
      "menu.manage": "打开会话管理…",
      "footer.aria": "会话管理",
      "footer.label": "会话管理",
      "panel.title": "会话管理",
      "panel.search": "搜索标题、ID、标签或备注",
      "panel.workspace": "工作区",
      "panel.workspace.all": "全部工作区",
      "panel.workspace.ungrouped": "未分组",
      "panel.workspace.loading": "正在加载工作区…",
      "panel.workspace.error": "工作区加载失败：{message}",
      "panel.workspace.retry": "重试",
      "panel.sort": "排序",
      "panel.sort.unavailable": "当前 DSH 未提供创建时间，暂按原顺序显示",
      "panel.sort.updated-desc": "最近更新",
      "panel.sort.updated-asc": "最早更新",
      "panel.sort.created-desc": "最新创建",
      "panel.sort.created-asc": "最早创建",
      "panel.count": "显示 {shown} / {total} 个会话",
      "panel.reset": "重置筛选",
      "panel.empty.filtered": "没有匹配的会话，请调整搜索或筛选条件",
      "panel.filter.all": "全部",
      "panel.filter.active": "未归档",
      "panel.filter.archived": "已归档",
      "panel.empty": "暂无会话",
      "panel.empty.archived": "归档为空",
      "panel.archived": "已归档",
      "panel.running": "运行中",
      "panel.current": "当前",
      "panel.session.new": "新建会话",
      "panel.close": "关闭",
      "row.open": "打开",
      "row.archive": "归档",
      "row.unarchive": "移出归档",
      "row.move": "移动至工作区",
      "row.delete": "删除会话",
      "row.migrate": "迁移预设",
      "migrate.title": "迁移 Agent 预设",
      "migrate.current": "当前预设",
      "migrate.target": "目标预设",
      "migrate.noPresets": "没有可用的目标预设",
      "migrate.same": "请选择与当前预设不同的目标预设",
      "migrate.confirm": "确认迁移",
      "migrate.completed": "Agent 预设已迁移为 {preset}",
      "confirm.delete.title": "删除会话",
      "confirm.delete.desc": "会话「{title}」将被永久删除，包括其全部消息记录与磁盘文件，此操作不可撤销。",
      "confirm.delete.running": "该会话正在运行，删除将立即中断它。",
      "confirm.delete.confirm": "确认删除",
      "confirm.move.title": "移动会话到工作区",
      "confirm.move.desc": "将会话「{title}」移动到目标工作区。",
      "confirm.move.running": "该会话正在运行，移动会中断并关闭它；之后可在目标工作区重新打开继续。",
      "confirm.move.empty": "没有可移动到的其他工作区。",
      "confirm.move.select": "选择目标工作区",
      "confirm.move.current": "当前工作区：{name}",
      "confirm.move.confirm": "确认移动",
      "confirm.cancel": "取消",
      "busy.processing": "处理中…",
      "error.operation": "操作失败：{message}",
      "workspace.default": "默认工作区",
      "workspace.sessions": "{count} 个会话"
    };
    const en = {
      "marks.filter.favorite": "Favorites",
      "marks.filter.favorite.aria": "Favorites filter",
      "marks.filter.review": "Review later",
      "marks.filter.review.aria": "Review later filter",
      "marks.filter.tags": "Filter by tag",
      "marks.filter.priority": "Filter by priority",
      "marks.favorite.add": "Favorite session",
      "marks.favorite.remove": "Remove favorite",
      "marks.review.add": "Mark for review",
      "marks.review.remove": "Clear review flag",
      "marks.edit": "Tags/Notes",
      "marks.header.edit": "Tags/Notes",
      "marks.edit.aria": "Edit tags, notes and priority",
      "marks.title": "Session annotations",
      "marks.favorite": "Favorite",
      "marks.review": "Review later",
      "marks.tags": "Tags",
      "marks.tags.placeholder": "Separate with commas. Up to 20 tags, 32 chars each (duplicates merged). e.g. bug, design",
      "marks.tags.help": "Up to 20 tags, 32 characters each; duplicates are merged",
      "marks.note": "Note",
      "marks.note.placeholder": "For example: awaiting Windows verification; check rollback next (up to 2000 characters)",
      "marks.privacy": "For organization only. Not written into chat history or automatically sent to the model.",
      "marks.priority": "Priority",
      "marks.priority.all": "All priorities",
      "marks.priority.1": "1 · Highest",
      "marks.priority.2": "2 · High",
      "marks.priority.3": "3 · Normal",
      "marks.priority.4": "4 · Low",
      "marks.priority.5": "5 · Lowest",
      "marks.priority.help": "1 is highest, 5 is lowest. Default is 3 (Normal).",
      "marks.tags.all": "All tags",
      "marks.tags.none": "No tags",
      "marks.tags.missing": "{tag} (no matches)",
      "marks.save": "Save annotations",
      "marks.saving": "Saving…",
      "marks.cancel": "Cancel",
      "marks.loading": "Loading session annotations…",
      "marks.error": "Could not load annotations: {message}",
      "marks.retry": "Retry annotations",
      "marks.conflict": "Another window changed these annotations. Your draft is preserved; load the latest version before editing again.",
      "marks.reload": "Load latest",
      "marks.discard": "Discard unsaved annotation changes?",
      "marks.note.exists": "Has note",
      "marks.sort": "Priority (1 → 5)",
"marks.note.exists": "Has note",
      "marks.import.copy": "Copy Prompt",
      "marks.import.copy.copied": "Copied. Paste it into the current conversation to generate the result.",
      "marks.import.copy.failed": "Copy failed: {message}",
      "marks.import.paste": "Import",
      "marks.import.paste.label": "AI response",
      "marks.import.paste.help": "Paste the JSON returned by the model into the box below, then click Import.",
      "marks.import.paste.aria": "JSON returned by the model",
      "marks.import.paste.placeholder": "Supports json code fences or plain JSON, e.g. { \"tags\": [\"tag1\", \"tag2\"], \"note\": \"session note\" }",
      "marks.import.paste.clear": "Clear input",
      "marks.import.empty": "Paste the JSON returned by the model into the box above first.",
      "marks.import.unknown": "unknown field",
      "marks.import.discard": "Importing will overwrite your unsaved edits. Continue?",
      "marks.import.failure": "Import failed: {message}",
      "marks.import.warnings": "Imported, with adjustments:",
      "marks.import.success": "Imported AI result from the clipboard",
      "marks.tags.clear": "Clear tags",
      "marks.note.clear": "Clear note",
      "header.aria": "Session actions",
      "menu.open": "Open",
      "menu.archive": "Archive session",
      "menu.unarchive": "Unarchive session",
      "menu.delete": "Delete session…",
      "menu.move": "Move to workspace…",
      "menu.manage": "Open session manager…",
      "footer.aria": "Session manager",
      "footer.label": "Sessions",
      "panel.title": "Session manager",
      "panel.search": "Search title, ID, tags or notes",
      "panel.workspace": "Workspace",
      "panel.workspace.all": "All workspaces",
      "panel.workspace.ungrouped": "Ungrouped",
      "panel.workspace.loading": "Loading workspaces…",
      "panel.workspace.error": "Could not load workspaces: {message}",
      "panel.workspace.retry": "Retry",
      "panel.sort": "Sort by",
      "panel.sort.unavailable": "Creation times are unavailable in this DSH version; showing source order.",
      "panel.sort.updated-desc": "Recently updated",
      "panel.sort.updated-asc": "Least recently updated",
      "panel.sort.created-desc": "Newest created",
      "panel.sort.created-asc": "Oldest created",
      "panel.count": "Showing {shown} / {total} sessions",
      "panel.reset": "Reset filters",
      "panel.empty.filtered": "No matching sessions. Adjust your search or filters.",
      "panel.filter.all": "All",
      "panel.filter.active": "Active",
      "panel.filter.archived": "Archived",
      "panel.empty": "No sessions",
      "panel.empty.archived": "No archived sessions",
      "panel.archived": "Archived",
      "panel.running": "Running",
      "panel.current": "Current",
      "panel.session.new": "New session",
      "panel.close": "Close",
      "row.open": "Open",
      "row.archive": "Archive",
      "row.unarchive": "Unarchive",
      "row.move": "Move to workspace",
      "row.delete": "Delete session",
      "row.migrate": "Migrate preset",
      "migrate.title": "Migrate Agent preset",
      "migrate.current": "Current preset",
      "migrate.target": "Target preset",
      "migrate.noPresets": "No target presets are available",
      "migrate.same": "Choose a target preset different from the current preset",
      "migrate.confirm": "Migrate",
      "migrate.completed": "Agent preset migrated to {preset}",
      "confirm.delete.title": "Delete session",
      "confirm.delete.desc": "Session \"{title}\" will be permanently deleted, including all its messages and files on disk. This cannot be undone.",
      "confirm.delete.running": "This session is running; deleting will interrupt it immediately.",
      "confirm.delete.confirm": "Delete",
      "confirm.move.title": "Move session to workspace",
      "confirm.move.desc": "Move session \"{title}\" to the target workspace.",
      "confirm.move.running": "This session is running; moving will interrupt and close it; you can reopen it from the target workspace to continue.",
      "confirm.move.empty": "No other workspaces to move to.",
      "confirm.move.select": "Select target workspace",
      "confirm.move.current": "Current workspace: {name}",
      "confirm.move.confirm": "Move",
      "confirm.cancel": "Cancel",
      "busy.processing": "Working…",
      "error.operation": "Operation failed: {message}",
      "workspace.default": "Default workspace",
      "workspace.sessions": "{count} sessions"
    };

    const css = [
      ".sm-header{display:flex;align-items:center;gap:6px}",
      ".sm-headerBtn{box-sizing:border-box;min-height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;align-items:center;gap:4px;padding:3px 10px;font-size:12px;line-height:18px;display:inline-flex;white-space:nowrap}",
      ".sm-headerBtn:hover:not(:disabled),.sm-headerBtn:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}",
      ".sm-headerBtn:disabled{opacity:.5;cursor:not-allowed}",
      ".sm-headerBtn svg{flex:none}",
      ".sm-busy{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:28px;margin-left:4px}",
      ".sm-footer{display:flex}",
      ".sm-footerBtn{min-height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:6px;padding:3px 8px;font-size:12px;line-height:18px;display:inline-flex}",
      ".sm-footerBtn:hover,.sm-footerBtn:focus-visible{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}",
      ".sm-footerBtn svg{flex:none}",
      ".sm-panel{display:flex;flex-direction:column;gap:10px;min-height:280px;max-height:min(70vh,640px);min-width:480px}",
      ".sm-filter{display:flex;gap:4px;flex-wrap:wrap}",
      ".sm-filterBtn{cursor:pointer;color:var(--dsw-alias-label-secondary);background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:3px 12px;font-size:12px;line-height:18px}",
      ".sm-filterBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".sm-filterBtn.sm-on{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-fill-l2);border-color:transparent}",
      ".sm-list{display:flex;flex-direction:column;gap:4px;min-height:0;overflow:auto;flex:1}",
      ".sm-row{box-sizing:border-box;display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}",
      ".sm-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".sm-rowCurrent{border-color:var(--dsw-alias-accent-primary,var(--dsw-alias-label-secondary))}",
      ".sm-rowMain{min-width:0;display:flex;flex-direction:column;gap:2px;flex:1 1 280px}",
      ".sm-rowTitle{color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;display:flex;align-items:center;gap:6px;min-width:0}",
      ".sm-rowTitle>span:first-child{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}",
      ".sm-rowMeta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}",
      ".sm-rowActions{display:flex;gap:4px;flex:none;flex-wrap:wrap;justify-content:flex-end}",
      ".sm-badge{flex:none;border-radius:999px;padding:0 6px;font-size:10px;line-height:16px}",
      ".sm-badgeArchived{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-fill-l2)}",
      ".sm-badgeRunning{color:var(--dsw-alias-state-warning-primary,#d97706);background:rgba(217,119,6,.12)}",
      ".sm-badgeCurrent{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-fill-l2)}",
      ".sm-danger{color:var(--dsw-alias-state-error-primary) !important;border-color:var(--dsw-alias-state-error-primary) !important}",
      ".sm-dangerText{color:var(--dsw-alias-state-error-primary) !important}",
      ".sm-warn{display:flex;align-items:flex-start;gap:8px;color:var(--dsw-alias-label-secondary);background:rgba(217,119,6,.08);border:1px solid rgba(217,119,6,.25);border-radius:8px;padding:8px 10px;margin-top:4px}",
      ".sm-warn svg{flex:none;margin-top:1px}",
      ".sm-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;min-height:0;margin-top:4px}",
      ".sm-foot{display:flex;justify-content:flex-end;align-items:center;gap:8px;width:100%}",
      ".sm-footError{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin-right:auto}",
      ".sm-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;text-align:center;padding:24px 0}",
      ".sm-moveSection{display:flex;flex-direction:column;gap:8px}",
      ".sm-moveLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
      ".sm-moveList{display:flex;flex-direction:column;gap:4px;max-height:200px;overflow:auto}",
      ".sm-moveItem{box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;cursor:pointer;transition:all .15s}",
      ".sm-moveItem:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".sm-moveItemSelected{border-color:var(--dsw-alias-accent-primary);background:var(--dsw-alias-accent-primary-bg)}",
      ".sm-moveItemName{color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px}",
      ".sm-moveItemMeta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.sm-panelModal{width:760px;max-width:92vw}.sm-panelModal .sm-rowActions{flex-wrap:wrap;justify-content:flex-end}.sm-headerMenu{position:absolute;right:0;top:100%;z-index:50;display:flex;flex-direction:column;min-width:160px;padding:4px;background:var(--dsw-alias-surface-l1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12)}.sm-headerMenuItem{display:flex;align-items:center;width:100%;text-align:left;background:0 0;border:0;border-radius:6px;color:var(--dsw-alias-label-primary);cursor:pointer;padding:6px 10px;font-size:13px;line-height:18px}.sm-headerMenuItem:hover{background:var(--dsw-alias-interactive-bg-hover)}.sm-headerMenuItemDanger{color:var(--dsw-alias-state-error-primary)}.sm-headerBtn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;height:auto;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-fill-l2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;cursor:pointer;padding:4px 12px;font-size:13px;line-height:18px;white-space:nowrap;transition:background .15s,color .15s,border-color .15s}.sm-headerBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}.sm-headerBtn:focus-visible{outline:2px solid var(--dsw-alias-accent-primary);outline-offset:1px}.sm-headerBtn svg{width:16px;height:16px}.sm-migratePanel{display:flex;flex-direction:column;gap:14px;min-width:480px}.sm-migrateRow{display:flex;flex-direction:column;gap:8px}.sm-migrateRow>label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px;font-weight:500}.sm-migrateChips{display:flex;flex-wrap:wrap;gap:6px}.sm-migrateChip{padding:6px 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;cursor:pointer;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);white-space:nowrap}.sm-migrateChip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.sm-migrateChip:disabled{opacity:.5;cursor:not-allowed}.sm-migrateChipOn{background:var(--dsw-alias-accent-primary);color:#fff;border-color:var(--dsw-alias-accent-primary)}.sm-migrateEmpty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.sm-migratePreview{padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px}.sm-migrateWarn{padding:10px 12px;border:1px solid rgba(217,119,6,.25);border-radius:8px;background:rgba(217,119,6,.08);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:18px}.sm-migrateList{max-height:200px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}.sm-headerBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}.sm-headerBtnDanger{background:var(--dsw-alias-state-error-tertiary);color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);font-weight:500}.sm-headerBtnDanger:hover:not(:disabled){background:#d92d20!important;color:#fff!important;border-color:#d92d20!important}.sm-header{display:inline-flex;align-items:center;gap:6px}.sm-annotationToggleOpen{position:relative;z-index:10004}.sm-headerBtnActive{background:var(--dsw-alias-fill-l3);color:var(--dsw-alias-label-primary)}",
      ".sm-panelDialog{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:600px;max-width:calc(100vw - 32px);max-height:560px;height:auto;box-sizing:border-box;display:flex;flex-direction:column;gap:0;background:var(--dsw-alias-surface-l1,#fff);color:var(--dsw-alias-label-primary,#111);border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.25);overflow:hidden;z-index:9999;opacity:1}.sm-panelDialog .sm-nativeDialogHeader{padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,#eee);flex:none}.sm-panelDialog .sm-nativeDialogTitle{margin:0;font-size:14px;line-height:20px;font-weight:600}.sm-panelDialog .sm-nativeDialogFooter{padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l2,#eee);flex:none;flex-wrap:wrap;justify-content:flex-end;gap:6px;margin-top:0}.sm-panelDialog .sm-panel{display:flex;flex-direction:column;gap:6px;min-height:0;flex:1 1 auto;overflow:auto;padding:8px 12px}.sm-panelDialog .sm-list{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-height:0;overflow:auto}.sm-panelDialog .sm-row{display:flex;align-items:center;gap:8px;padding:0 10px;height:36px;min-height:36px;border:1px solid transparent;border-radius:8px;background:transparent}.sm-panelDialog .sm-row:hover{background:var(--dsw-alias-interactive-bg-hover)}.sm-panelDialog .sm-rowCurrent{background:var(--dsw-alias-fill-l2);border-color:var(--dsw-alias-accent-primary,#356ae6)}.sm-panelDialog .sm-rowMain{display:flex;align-items:stretch!important;gap:8px;min-width:0;flex:1 1 auto;overflow:hidden;text-align:left!important}.sm-panelDialog .sm-rowTitle{min-width:0;flex:1 1 0%;width:100%;align-self:stretch;display:flex;align-items:center;justify-content:flex-start;gap:6px;font-size:12px;line-height:16px;overflow:hidden;text-align:left!important;direction:ltr!important}.sm-confirmDialog{z-index:10000}.sm-confirmDialog.sm-nativeDialogLayer{position:fixed;left:calc(50vw + 184px);top:calc(50vh - 90px);width:300px;max-width:calc(100vw - 32px);max-height:none;display:block;align-items:initial;justify-content:initial;box-sizing:border-box;background:transparent;border:0;box-shadow:none;padding:0;inset:calc(50vh - 90px) auto auto calc(50vw + 308px)}.sm-confirmDialog.sm-nativeDialogLayer .sm-nativeDialogBackdrop{display:none}.sm-confirmDialog.sm-nativeDialogLayer .sm-nativeDialog{position:relative;left:auto;top:auto;transform:none;width:auto;box-sizing:border-box;background:var(--dsw-alias-surface-l1,#fff);color:var(--dsw-alias-label-primary,#111);border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.25);padding:0;overflow:hidden;animation:sm-confirmPop .14s ease-out}.sm-confirmDialog .sm-nativeDialogHeader{padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,#eee)}.sm-confirmDialog .sm-nativeDialogTitle{margin:0;font-size:14px;line-height:20px;font-weight:600}.sm-confirmDialog .sm-nativeDialogBody{padding:10px 16px;display:flex;flex-direction:column;gap:8px;min-height:0}.sm-confirmDialog .sm-nativeDialogDescription{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}.sm-confirmDialog .sm-warn{padding:6px 10px;font-size:12px;line-height:16px;margin-top:0}.sm-confirmDialog .sm-nativeDialogFooter{padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l2,#eee);flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:0}.sm-confirmDialog .sm-nativeDialogButton{min-height:28px;padding:3px 14px;font-size:12px;line-height:20px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;cursor:pointer;background:transparent;color:var(--dsw-alias-label-primary)}.sm-confirmDialog .sm-nativeDialogCancel:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.sm-confirmDialog .sm-nativeDialogConfirm{background:var(--dsw-alias-state-error-primary);color:#fff;border-color:var(--dsw-alias-state-error-primary)}.sm-confirmDialog .sm-nativeDialogConfirm:hover:not(:disabled){filter:brightness(.94)}@keyframes sm-confirmPop{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}.sm-confirmDialog.sm-nativeDialog{padding:0;width:auto;max-width:none}.sm-panelDialog .sm-rowTitle>span:first-child{display:block;min-width:0;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;flex:1 1 auto;width:auto;text-align:left!important;direction:ltr!important;unicode-bidi:plaintext}.sm-panelDialog .sm-rowMeta{display:none}.sm-panelDialog .sm-rowActions{display:flex;gap:2px;flex:none;justify-content:flex-end}.sm-panelDialog .sm-rowActions .sm-rowBtn{min-height:22px;height:22px;padding:0 8px;font-size:11px;line-height:14px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}.sm-panelDialog .sm-rowActions .sm-rowBtn:hover{background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary)}.sm-panelDialog .sm-rowActions .sm-rowBtnDanger{color:var(--dsw-alias-state-error-primary)}.sm-panelDialog .sm-filter{flex:none;padding:6px 12px 4px;gap:4px;display:flex;flex-wrap:wrap}.sm-panelDialog .sm-filterBtn{min-height:24px;padding:2px 10px;font-size:11px;line-height:16px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}.sm-panelDialog .sm-filterBtn.sm-on{background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary)}.sm-panelDialog .sm-badge{font-size:10px;line-height:14px;padding:0 5px;border-radius:6px;flex:none}.sm-panelDialog .sm-error{padding:6px 10px;margin:0;font-size:12px;line-height:16px}.sm-panelDialog .sm-nativeDialogButton{min-height:28px;padding:3px 12px;font-size:12px;line-height:18px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}.sm-panelDialog .sm-nativeDialogCancel{background:transparent}.sm-panelDialog .sm-nativeDialogGhost{background:transparent;border-color:var(--dsw-alias-border-l2)}.sm-panelDialog .sm-nativeDialogConfirm{background:var(--dsw-alias-accent-primary,#356ae6);color:#fff;border-color:var(--dsw-alias-accent-primary,#356ae6)}.sm-panelDialog .sm-empty{padding:18px 0;font-size:12px;color:var(--dsw-alias-label-tertiary);text-align:center}.sm-panelDialog .sm-footError{font-size:11px;color:var(--dsw-alias-state-error-primary);margin-right:auto;line-height:20px}.sm-panelDialog .sm-moveLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}.sm-migrateDialog .sm-nativeDialogFooter{flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:14px}.sm-migrateDialog .sm-migrateChip{cursor:pointer;pointer-events:auto;position:relative;z-index:1}.sm-migrateDialog .sm-migrateChip[disabled]{opacity:.5;cursor:not-allowed}.sm-migrateDialog.sm-nativeDialogLayer{position:fixed;left:50vw;top:auto;bottom:48px;transform:translateX(-50%);width:min(560px,calc(100vw - 32px));max-height:none;display:block;align-items:initial;justify-content:initial;box-sizing:border-box;background:transparent;border:0;box-shadow:none;padding:0;inset:auto;z-index:10001}.sm-migrateDialog.sm-nativeDialogLayer .sm-nativeDialogBackdrop{display:none}.sm-migrateDialog.sm-nativeDialogLayer .sm-nativeDialog{position:relative;left:auto;top:auto;transform:none;width:auto;max-height:min(70vh,520px);box-sizing:border-box;background-color:#ffffff;background-color:var(--dsw-alias-surface-l1,#fff);color:var(--dsw-alias-label-primary,#111);border:1px solid #d4d4d8;border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.45);overflow:hidden;padding:0;display:flex;flex-direction:column;gap:0;opacity:1}.sm-migrateDialog{position:fixed;left:50vw;top:auto;bottom:48px;transform:translateX(-50%);width:min(560px,calc(100vw - 32px));max-height:min(70vh,520px);box-sizing:border-box;display:flex;flex-direction:column;gap:0;background-color:#ffffff;background-color:var(--dsw-alias-surface-l1,#fff);color:var(--dsw-alias-label-primary,#111);border:1px solid #d4d4d8;border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.45);overflow:hidden;opacity:1;z-index:10001;backdrop-filter:none;-webkit-backdrop-filter:none}.sm-migrateDialog .sm-nativeDialogHeader{padding:12px 18px;border-bottom:1px solid #eee;border-bottom:1px solid var(--dsw-alias-border-l2,#eee);flex:none;background-color:#fff;background-color:var(--dsw-alias-surface-l1,#fff)}.sm-migrateDialog .sm-nativeDialogTitle{margin:0;font-size:15px;line-height:22px;font-weight:600;color:#111;color:var(--dsw-alias-label-primary,#111)}.sm-migrateDialog .sm-migratePanel{padding:12px 18px;display:flex;flex-direction:column;gap:14px;background-color:#fff;background-color:var(--dsw-alias-surface-l1,#fff)}.sm-migrateDialog .sm-nativeDialogBody{padding:0;background-color:#fff;background-color:var(--dsw-alias-surface-l1,#fff)}.sm-migrateDialog .sm-nativeDialogFooter{padding:12px 18px;border-top:1px solid #eee;border-top:1px solid var(--dsw-alias-border-l2,#eee);flex:none;flex-wrap:wrap;justify-content:flex-end;gap:8px;background-color:#fff;background-color:var(--dsw-alias-surface-l1,#fff)}.sm-migrateDialog .sm-migrateRow>label{color:#444;color:var(--dsw-alias-label-secondary,#444)}.sm-migrateDialog .sm-migrateChip{padding:6px 12px;border-radius:999px;border:1px solid #d4d4d8;border:1px solid var(--dsw-alias-border-l2,#ddd);background-color:#f5f5f5;background-color:var(--dsw-alias-fill-l2,#f5f5f5);color:#111;color:var(--dsw-alias-label-primary,#111);font-size:13px;line-height:18px;cursor:pointer;pointer-events:auto;position:relative;z-index:1;white-space:nowrap}.sm-migrateDialog .sm-migrateChip:hover:not(:disabled){background-color:#e8e8e8;background-color:var(--dsw-alias-interactive-bg-hover,#e8e8e8)}.sm-migrateDialog .sm-migrateChipOn{background-color:#356ae6;background-color:var(--dsw-alias-accent-primary,#356ae6);color:#fff;border-color:#356ae6;border-color:var(--dsw-alias-accent-primary,#356ae6)}.sm-migrateDialog .sm-migrateChip.sm-migrateChipOn:hover:not(:disabled){background-color:#4576f0;background-color:var(--dsw-alias-accent-primary-hover,#4576f0);color:#fff;border-color:#4576f0;border-color:var(--dsw-alias-accent-primary-hover,#4576f0);filter:none}.sm-migrateDialog .sm-migrateChipOn:hover:not(:disabled){filter:brightness(.92)}.sm-migrateDialog .sm-migrateChip[disabled]{opacity:.5;cursor:not-allowed}.sm-migrateDialog .sm-migrateEmpty{color:#888;color:var(--dsw-alias-label-tertiary,#888)}.sm-migrateDialog .sm-migratePreview{padding:10px 12px;border:1px solid #d4d4d8;border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:8px;background-color:#f5f5f5;background-color:var(--dsw-alias-fill-l2,#f5f5f5);color:#111;color:var(--dsw-alias-label-primary,#111);font-size:13px;line-height:18px}.sm-migrateDialog .sm-migrateWarn{padding:10px 12px;border:1px solid rgba(217,119,6,.25);border-radius:8px;background-color:rgba(217,119,6,.08);color:#444;color:var(--dsw-alias-label-secondary,#444);font-size:13px;line-height:18px}.sm-migrateDialog .sm-nativeDialogButton{min-height:32px;padding:4px 14px;font-size:13px;line-height:20px;border:1px solid #d4d4d8;border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:8px;cursor:pointer;background-color:#fff;background-color:var(--dsw-alias-fill-l2,#fff);color:#111;color:var(--dsw-alias-label-primary,#111)}.sm-migrateDialog .sm-nativeDialogButton:hover:not(:disabled){background-color:#e8e8e8;background-color:var(--dsw-alias-interactive-bg-hover,#e8e8e8)}.sm-migrateDialog .sm-nativeDialogConfirm{background-color:#356ae6;background-color:var(--dsw-alias-accent-primary,#356ae6);color:#fff;border-color:#356ae6;border-color:var(--dsw-alias-accent-primary,#356ae6)}.sm-migrateDialog .sm-nativeDialogConfirm:hover:not(:disabled){filter:brightness(.94)}",
      ".sm-panelDialog .sm-nativeDialogHeader{display:flex;align-items:center;gap:8px}.sm-panelHeaderClose{min-height:26px;padding:2px 9px;border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#555);cursor:pointer;font-size:12px;line-height:18px}.sm-panelHeaderClose:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#eee);color:var(--dsw-alias-label-primary,#111)}.sm-panelHeaderClose:disabled{opacity:.5;cursor:not-allowed}.sm-migrateCurrent{padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:8px;background:var(--dsw-alias-fill-l2,#f5f5f5);font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary,#111)}.sm-migrateConfirmLayer.sm-confirmDialog.sm-nativeDialogLayer{width:300px;inset:calc(50vh - 90px) auto auto calc(50vw + 308px)}.sm-migrateConfirmLayer.sm-confirmDialog.sm-nativeDialogLayer .sm-migrateDialog{position:relative;left:auto;top:auto;bottom:auto;transform:none;width:100%;max-width:none;max-height:min(70vh,520px);z-index:auto}.sm-migrateConfirmLayer .sm-migratePanel{min-width:0}.sm-migrateConfirmLayer .sm-nativeDialogButton.sm-nativeDialogConfirm:hover:not(:disabled){background-color:#4576f0;background-color:var(--dsw-alias-accent-primary-hover,#4576f0);color:#fff;border-color:#4576f0;border-color:var(--dsw-alias-accent-primary-hover,#4576f0);filter:none}",

      // Theme colors are scoped to the plugin dialogs. DSH exposes its
      // actual theme through `body[data-ds-dark-theme]` and color-scheme;
      // keeping these values local avoids changing DSH's global variables.
      "[data-sm-theme=light] .sm-panelDialog,[data-sm-theme=light] .sm-confirmDialog.sm-nativeDialogLayer .sm-nativeDialog,[data-sm-theme=light] .sm-migrateDialog.sm-nativeDialogLayer .sm-nativeDialog{--dsw-alias-surface-l1:#fff;--dsw-alias-label-primary:#1f1f1f;--dsw-alias-label-secondary:#555;--dsw-alias-label-tertiary:#888;--dsw-alias-border-l1:#d4d4d8;--dsw-alias-border-l2:#e5e5e5;--dsw-alias-fill-l2:#f5f5f5;--dsw-alias-interactive-bg-hover:#eee;--dsw-alias-state-error-primary:#d92d20;--dsw-alias-state-warning-primary:#d97706;--dsw-alias-accent-primary:#356ae6;--dsw-alias-accent-primary-bg:rgba(53,106,230,.12);background:#fff!important;background-color:#fff!important;color:#1f1f1f!important;border-color:#e5e5e5!important}",
      "[data-sm-theme=dark] .sm-panelDialog,[data-sm-theme=dark] .sm-confirmDialog.sm-nativeDialogLayer .sm-nativeDialog,[data-sm-theme=dark] .sm-migrateDialog.sm-nativeDialogLayer .sm-nativeDialog{--dsw-alias-surface-l1:#1f1f23;--dsw-alias-label-primary:#ececec;--dsw-alias-label-secondary:#b3b3b3;--dsw-alias-label-tertiary:#999;--dsw-alias-border-l1:#555;--dsw-alias-border-l2:#3a3a40;--dsw-alias-fill-l1:#1a1a1e;--dsw-alias-fill-l2:#2a2a30;--dsw-alias-interactive-bg-hover:rgba(255,255,255,.06);--dsw-alias-state-error-primary:#f47171;--dsw-alias-state-warning-primary:#f0a040;--dsw-alias-accent-primary:#5d8aff;--dsw-alias-accent-primary-bg:rgba(93,138,255,.18);background:#1f1f23!important;background-color:#1f1f23!important;color:#ececec!important;border-color:#3a3a40!important}","[data-sm-theme=dark] .sm-header{--dsw-alias-surface-l1:#1f1f23;--dsw-alias-label-primary:#ececec;--dsw-alias-label-secondary:#b3b3b3;--dsw-alias-label-tertiary:#999;--dsw-alias-border-l1:#555;--dsw-alias-border-l2:#3a3a40;--dsw-alias-fill-l1:#1a1a1e;--dsw-alias-fill-l2:#2a2a30;--dsw-alias-interactive-bg-hover:rgba(255,255,255,.06);--dsw-alias-accent-primary:#5d8aff;--dsw-alias-accent-primary-bg:rgba(93,138,255,.18)}",
      "[data-sm-theme=light] .sm-panelDialog .sm-nativeDialogHeader,[data-sm-theme=light] .sm-panelDialog .sm-nativeDialogFooter,[data-sm-theme=light] .sm-confirmDialog .sm-nativeDialogHeader,[data-sm-theme=light] .sm-confirmDialog .sm-nativeDialogFooter,[data-sm-theme=light] .sm-migrateDialog .sm-nativeDialogHeader,[data-sm-theme=light] .sm-migrateDialog .sm-nativeDialogBody,[data-sm-theme=light] .sm-migrateDialog .sm-nativeDialogFooter{background:#fff!important;background-color:#fff!important;border-color:#e5e5e5!important}",
      "[data-sm-theme=dark] .sm-panelDialog .sm-nativeDialogHeader,[data-sm-theme=dark] .sm-panelDialog .sm-nativeDialogFooter,[data-sm-theme=dark] .sm-confirmDialog .sm-nativeDialogHeader,[data-sm-theme=dark] .sm-confirmDialog .sm-nativeDialogFooter,[data-sm-theme=dark] .sm-migrateDialog .sm-nativeDialogHeader,[data-sm-theme=dark] .sm-migrateDialog .sm-nativeDialogBody,[data-sm-theme=dark] .sm-migrateDialog .sm-nativeDialogFooter{background:#1f1f23!important;background-color:#1f1f23!important;border-color:#3a3a40!important}",
      ".sm-panelDialog{max-height:min(640px,calc(100vh - 32px))}.sm-panelDialog .sm-panel{min-width:0;overflow:hidden}",
      ".sm-panelTools{display:flex;flex-direction:column;gap:8px;flex:none;padding:2px 0 6px}",
      ".sm-queryInput,.sm-viewSelect{box-sizing:border-box;width:100%;min-width:0;height:32px;padding:5px 9px;border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:7px;background:var(--dsw-alias-surface-l1,#fff);color:var(--dsw-alias-label-primary,#111);font:inherit;font-size:12px;line-height:20px}",
      ".sm-queryInput::placeholder{color:var(--dsw-alias-label-tertiary,#888)}.sm-queryInput:focus-visible,.sm-viewSelect:focus-visible,.sm-resetFilters:focus-visible{outline:2px solid var(--dsw-alias-accent-primary,#356ae6);outline-offset:2px}.sm-viewSelect:disabled{opacity:.6;cursor:wait}",
      ".sm-panelSelects{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}.sm-viewField{display:flex;flex-direction:column;gap:3px;min-width:0;color:var(--dsw-alias-label-secondary,#666);font-size:11px;line-height:16px}",
      ".sm-filterBar{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap}.sm-resultSummary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary,#888)}.sm-resetFilters{padding:2px 0;border:0;background:none;color:var(--dsw-alias-accent-primary,#356ae6);font:inherit;cursor:pointer}.sm-resetFilters:hover{text-decoration:underline}.sm-workspaceNotice{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary,#666)}",
      "@media(max-width:540px){.sm-panelSelects{grid-template-columns:minmax(0,1fr)}.sm-panelDialog .sm-row{height:auto;min-height:36px;flex-shrink:0;flex-wrap:wrap;padding:6px 8px}.sm-panelDialog .sm-rowMain{flex-basis:100%}.sm-panelDialog .sm-rowActions{width:100%;min-width:0;flex:1 1 100%;justify-content:flex-start}}",
      ".sm-panelDialog:not(.sm-annotationSurface){width:680px}.sm-panelDialog .sm-row{height:auto;min-height:36px;flex-shrink:0;flex-wrap:wrap;padding:5px 8px}.sm-panelDialog .sm-rowMain{flex:1 1 200px;flex-direction:column;gap:3px}.sm-panelDialog .sm-rowActions{margin-left:auto;max-width:100%}.sm-rowAnnotations{display:flex;align-items:center;gap:5px;min-width:0;font-size:10px;line-height:16px}",
      ".sm-markIcon{min-width:25px;padding-left:5px;padding-right:5px;font-size:15px}.sm-markIcon.sm-markOn{color:var(--dsw-alias-accent-primary,#356ae6)!important;background:var(--dsw-alias-fill-l2,#eee)}.sm-priorityBadge{padding:0 5px;border-radius:4px;background:var(--dsw-alias-fill-l2,#eee);color:var(--dsw-alias-label-secondary,#666)}.sm-priority-1{color:#c2410c;background:rgba(234,88,12,.12)}.sm-priority-2{color:#a16207;background:rgba(202,138,4,.12)}",
      "[data-sm-theme=dark] .sm-priority-1{color:#fdba74}[data-sm-theme=dark] .sm-priority-2{color:#fde68a}",
      ".sm-tagChip,.sm-noteBadge{max-width:88px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;border-radius:4px;background:var(--dsw-alias-fill-l2,#eee);color:var(--dsw-alias-label-secondary,#666);font:inherit;line-height:16px;padding:0 5px;cursor:pointer}.sm-noteBadge{background:transparent}.sm-tagChip:hover,.sm-noteBadge:hover{color:var(--dsw-alias-accent-primary,#356ae6)}",
      ".sm-markFilters{display:grid;grid-template-columns:auto auto minmax(100px,1fr) minmax(100px,1fr);align-items:end;gap:6px}.sm-markFilterToggle{height:32px;white-space:nowrap}.sm-markFilterToggle:disabled{opacity:.5;cursor:not-allowed}.sm-header{flex-wrap:wrap}",
      ".sm-annotationDialog.sm-nativeDialogLayer{position:fixed;display:block;pointer-events:none;z-index:10002;background:transparent}.sm-annotationDialog .sm-nativeDialogBackdrop{display:none}.sm-annotationDialog.sm-annotationDialog-anchored.sm-nativeDialogLayer{inset:auto;background:transparent}.sm-annotationDialog.sm-confirmDialog.sm-nativeDialogLayer:not(.sm-annotationDialog-anchored){inset:50% auto auto calc(50vw + 308px);transform:translateY(-50%);max-height:calc(100vh - 32px)}.sm-panelDialog.sm-annotationSurface{position:absolute;width:460px;max-height:min(680px,calc(100vh - 32px));pointer-events:auto;z-index:10003;box-shadow:0 16px 48px rgba(0,0,0,.25)}.sm-panelDialog.sm-annotationSurface.sm-annotationSurface-anchored{position:relative;transform:none;left:auto;top:auto;margin:0}.sm-annotationCloseHint{margin:0 16px 8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
      ".sm-annotationBody{padding:14px 16px;display:flex;flex-direction:column;gap:12px;min-height:0;overflow:auto;flex:1 1 auto}.sm-annotationTarget{font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#666)}.sm-annotationChecks{display:grid;grid-template-columns:auto 1fr;column-gap:14px;row-gap:4px;align-items:center;font-size:13px}.sm-annotationChecks>label{display:flex;gap:6px;align-items:center;cursor:pointer}.sm-annotationChecks .sm-annotationPriority{display:inline-flex;align-items:center;gap:6px;font-size:13px;line-height:18px;color:inherit}.sm-annotationChecks .sm-prioritySelectInline{height:24px;padding:2px 6px;font-size:12px;line-height:18px;min-width:104px;width:auto;border-radius:6px;color:var(--dsw-alias-label-primary,#111)}.sm-annotationChecks>small{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#888);justify-self:start}.sm-annotationHint,.sm-annotationBody small{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#888)}",
      ".sm-noteInput{box-sizing:border-box;width:100%;min-height:60px;resize:vertical;border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:7px;padding:8px;background:var(--dsw-alias-surface-l1,#fff);color:var(--dsw-alias-label-primary,#111);font:inherit;font-size:13px;line-height:19px}.sm-noteInput:focus-visible{outline:2px solid var(--dsw-alias-accent-primary,#356ae6);outline-offset:2px}.sm-markConflict{display:flex;flex-direction:column;gap:5px;font-size:12px;padding:8px;border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:6px}.sm-fieldWithClear .sm-fieldRow{position:relative;display:flex;align-items:flex-start;gap:4px}.sm-fieldRow .sm-queryInput{flex:1 1 auto;min-width:0}.sm-fieldRowNote{align-items:stretch}.sm-fieldClear{position:absolute;top:5px;right:6px;width:22px;height:22px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:4px;font-size:14px;line-height:18px;display:inline-flex;align-items:center;justify-content:center;padding:0}.sm-fieldClear:hover,.sm-fieldClear:focus-visible{color:var(--dsw-alias-accent-primary);background:var(--dsw-alias-interactive-bg-hover);outline:none}.sm-fieldClearNote{top:6px}.sm-importGroup{display:flex;flex-direction:column;gap:8px;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l2,#eee);background:var(--dsw-alias-fill-l1,#fafbfc)}.sm-importGroupButtons{display:flex;justify-content:space-between;align-items:center;gap:8px}.sm-importBtn{cursor:pointer;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-surface-l1,#fff);border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:8px;padding:5px 12px;font-size:12px;line-height:18px}.sm-importBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.sm-importBtn:disabled{opacity:.5;cursor:not-allowed}.sm-importStatus{margin:0 16px;padding:8px 10px;font-size:12px;line-height:18px;background:var(--dsw-alias-accent-primary-bg,rgba(53,106,230,.08));color:var(--dsw-alias-label-secondary);border-radius:6px;white-space:pre-wrap;word-break:break-word}",
      "@media(max-width:600px){.sm-markFilters{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.sm-panelDialog .sm-row{flex-wrap:wrap}.sm-panelDialog .sm-rowMain{flex-basis:100%}.sm-panelDialog .sm-rowActions{width:100%;min-width:0;flex:1 1 100%;justify-content:flex-start}}",
    ].join("");

    // Auto-follow DSH's theme. We detect DSH's current theme from
    // body[data-ds-dark-theme] / color-scheme / data-theme / class tokens,
    // mirror it onto <html data-sm-theme>, and apply inline dialog colors.
    // The dialogs use that attribute via the scoped CSS rules above, and
    // inline styles guarantee an opaque background even when DSH's tokens
    // resolve to `unset` / `transparent`.
    const SM_THEME_ATTR = "data-sm-theme";
    function smReadDshTheme() {
      try {
        const html = document.documentElement;
        const body = document.body;
        if (body && body.hasAttribute("data-ds-dark-theme")) return "dark";
        const elements = [html, body].filter(Boolean);
        const dark = /\b(dark|dim)\b/i;
        const light = /\b(light|bright)\b/i;
        for (const el of elements) {
          const value = ["theme", "data-theme", "data-bs-theme", "color-scheme", "data-color-mode", "data-mode"]
            .map((name) => String(el.getAttribute(name) || ""))
            .join(" ");
          if (dark.test(value)) return "dark";
          if (light.test(value)) return "light";
        }
        for (const el of elements) {
          const scheme = String(getComputedStyle(el).colorScheme || "").toLowerCase();
          if (scheme.includes("dark")) return "dark";
          if (scheme.includes("light")) return "light";
        }
        const bg = body ? getComputedStyle(body).backgroundColor : "";
        const match = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (match) {
          const luminance = (Number(match[1]) * 299 + Number(match[2]) * 587 + Number(match[3]) * 114) / 1000;
          return luminance < 128 ? "dark" : "light";
        }
      } catch (_) { /* ignore */ }
      return "light";
    }
    function smApplyInlineTheme(theme) {
      try {
        const values = theme === "dark"
          ? { background: "#1f1f23", color: "#ececec", border: "#3a3a40" }
          : { background: "#fff", color: "#1f1f1f", border: "#e5e5e5" };
        const roots = document.querySelectorAll(
          ".sm-panelDialog," +
          ".sm-confirmDialog.sm-nativeDialogLayer .sm-nativeDialog," +
          ".sm-migrateDialog.sm-nativeDialogLayer .sm-nativeDialog"
        );
        for (const el of roots) {
          el.style.setProperty("background", values.background, "important");
          el.style.setProperty("background-color", values.background, "important");
          el.style.setProperty("color", values.color, "important");
          el.style.setProperty("border-color", values.border, "important");
        }
      } catch (_) { /* ignore */ }
    }
    function smApplyTheme() {
      try {
        const theme = smReadDshTheme();
        document.documentElement.setAttribute(SM_THEME_ATTR, theme);
        smApplyInlineTheme(theme);
      } catch (_) { /* ignore */ }
    }
    smApplyTheme();
    if (typeof MutationObserver === "function") {
      try {
        const observer = new MutationObserver(() => smApplyTheme());
        const options = { attributes: true, attributeFilter: ["class", "theme", "data-theme", "data-bs-theme", "data-ds-dark-theme", "data-color-mode", "data-mode", "color-scheme", "style"] };
        if (document.documentElement) observer.observe(document.documentElement, options);
        if (document.body) observer.observe(document.body, options);
        observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
      } catch (_) { /* ignore */ }
    }

    const CSS_ID = "dsh-session-manager/session-manager";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_ID) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-session-manager";
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = css;
      document.head.appendChild(tag);
    }


    // Anchor the session manager panel to the sidebar right edge so it
    // always fits within the sidebar area, regardless of viewport size.
    const SM_PANEL_CSS_ID = "dsh-session-manager/session-manager-anchor";
    const installAnchor = () => {
      if (typeof document === "undefined") return;
      if (document.querySelector("style[data-plugin-css=" + JSON.stringify(SM_PANEL_CSS_ID) + "]") !== null) return;
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-session-manager";
      tag.dataset.pluginCss = SM_PANEL_CSS_ID;
      tag.textContent = ":root{--sm-panel-left:8px}";
      document.head.appendChild(tag);
      const updateLeft = () => {
        let right = 8;
        const candidates = [
          "[data-dsh-sidebar]",
          "[data-testid=sidebar]",
          "[aria-label=会话][role=navigation]",
          "aside",
          ".dsw-sidebar"
        ];
        for (const sel of candidates) {
          const el = document.querySelector(sel);
          if (el !== null) {
            const rect = el.getBoundingClientRect();
            if (rect.right > 100 && rect.right < window.innerWidth - 40) {
              right = Math.round(rect.right) + 8;
              break;
            }
          }
        }
        document.documentElement.style.setProperty("--sm-panel-left", right + "px");
      };
      updateLeft();
      window.addEventListener("resize", updateLeft);
    };
    try { installAnchor(); } catch (_) {}

    const h = (type, props, ...children) => React.createElement(type, props, ...children);
    const callApi = (path, payload) => fetch(API + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload || {}) }).then((r) => r.json());
    const fetchApi = (path, options) => fetch(API + path, options).then((r) => r.json());

    const EMPTY_ANNOTATION = Object.freeze({ favorite: false, reviewLater: false, tags: Object.freeze([]), note: "", priority: 3, revision: 0 });
    const validAnnotation = value => value && typeof value.favorite === "boolean" && typeof value.reviewLater === "boolean" && Array.isArray(value.tags) && value.tags.every(tag => typeof tag === "string") && typeof value.note === "string" && (value.priority === null || Number.isInteger(value.priority) && value.priority >= 1 && value.priority <= 5) && Number.isSafeInteger(value.revision) && value.revision >= 0;
    const annotationOf = (state, id) => Object.hasOwn(state.entries, id) ? state.entries[id] : EMPTY_ANNOTATION;
    const annotationStore = (() => {
      let state = { entries: {}, loaded: false, loading: false, error: null, pending: new Set() };
      const listeners = new Set();
      let tail = Promise.resolve(); let loading; let refreshAgain = false;
      const publish = patch => { state = { ...state, ...patch }; for (const listener of [...listeners]) listener(); };
      const enqueue = operation => { const result = tail.then(operation); tail = result.catch(() => {}); return result; };
      const apiError = data => Object.assign(new Error(data?.error || "Annotation request failed"), { code: data?.code });
      const store = {
        notify: null,
        getSnapshot: () => state,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        hasSubscribers: () => listeners.size > 0,
        load(force = false) {
          if (loading) { if (force) refreshAgain = true; return loading; }
          if (state.loaded && !force) return Promise.resolve();
          publish({ loading: true, error: null });
          loading = enqueue(async () => {
            const data = await fetchApi("/annotations", { cache: "no-store" });
            if (!data?.ok) throw apiError(data);
            const entries = data.result?.annotations;
            if (!entries || typeof entries !== "object" || Array.isArray(entries)
              || Object.values(entries).some(value => !validAnnotation(value))) throw new Error("Invalid annotation response");
            publish({ entries, loaded: true, error: null });
          }).catch(error => { publish({ error: error instanceof Error ? error.message : String(error) }); })
            .finally(() => { loading = null; publish({ loading: false }); if (refreshAgain) { refreshAgain = false; void store.load(true); } });
          return loading;
        },
        save(id, patch, expectedRevision) {
          if (state.pending.has(id)) return Promise.reject(new Error("This session's annotations are being saved"));
          if (!state.loaded || state.error) return Promise.reject(new Error(state.error || "Annotations have not loaded yet"));
          publish({ pending: new Set([...state.pending, id]) });
          return enqueue(async () => {
            const data = await callApi("/annotations", { sessionId: id, patch, ...(expectedRevision !== undefined ? { expectedRevision } : {}) });
            if (!data?.ok) throw apiError(data);
            const annotation = data.result?.annotation;
            if (!validAnnotation(annotation)) throw new Error("Invalid annotation response");
            publish({ entries: { ...state.entries, [id]: annotation } });
            try { store.notify?.(); } catch (_) { /* cross-tab sync is best-effort */ }
            return annotation;
          }).finally(() => { const pending = new Set(state.pending); pending.delete(id); publish({ pending }); });
        }
      };
      return store;
    })();
    const useAnnotations = (refreshOnMount = false) => {
      const state = useSyncExternalStore(annotationStore.subscribe, annotationStore.getSnapshot, annotationStore.getSnapshot);
      useEffect(() => { void annotationStore.load(refreshOnMount); }, [refreshOnMount]);
      return state;
    };
    const annotationButtons = (id, title, t, state, className, onToggle, onEdit, disabled = false, editorOpen = false) => {
      const value = annotationOf(state, id);
      const busy = disabled || !state.loaded || !!state.error || state.pending.has(id);
      const favoriteLabel = t(value.favorite ? "marks.favorite.remove" : "marks.favorite.add") + ": " + title;
      const reviewLabel = t(value.reviewLater ? "marks.review.remove" : "marks.review.add") + ": " + title;
      return h(React.Fragment, null,
        h("button", { type: "button", className: className + " sm-markIcon" + (value.favorite ? " sm-markOn" : ""), disabled: busy, "aria-label": favoriteLabel, title: favoriteLabel, "aria-pressed": value.favorite, onClick: () => onToggle({ favorite: !value.favorite }) }, value.favorite ? "★" : "☆"),
        h("button", { type: "button", className: className + " sm-markIcon" + (value.reviewLater ? " sm-markOn" : ""), disabled: busy, "aria-label": reviewLabel, title: reviewLabel, "aria-pressed": value.reviewLater, onClick: () => onToggle({ reviewLater: !value.reviewLater }) }, "◷"),
        h("button", { type: "button", className: className + (editorOpen ? " sm-annotationToggleOpen sm-headerBtnActive" : ""), disabled: busy, "aria-label": t("marks.edit.aria") + ": " + title, title: t("marks.edit.aria"), ...(className === "sm-headerBtn" ? { "aria-expanded": editorOpen } : {}), onClick: e => onEdit(e) }, t(className === "sm-headerBtn" ? "marks.header.edit" : "marks.edit"), className === "sm-headerBtn" ? h("span", { className: "sm-priorityBadge sm-priority-" + (value.priority ?? 3), title: t("marks.priority." + (value.priority ?? 3)) }, "P" + (value.priority ?? 3)) : null)
      );
    };


    // Inline clipboard parser mirroring lib/clipboard-parser.js. The server
    // re-validates the patch via annotationStore.save, so this helper only
    // needs to be permissive enough to surface obvious mistakes early.
    const TAG_LIMITS = { tags: 20, tagLength: 32, noteLength: 2000 };
    const TAG_REJECT_RE = /[,，\x00-\x1f]/;
    // Recover the most useful JSON object from a possibly noisy
    // clipboard string. Tries, in order:
    //   1. JSON.parse on the trimmed text.
    //   2. JSON.parse inside a Markdown \`\`\`json ... \`\`\` fence.
    //   3. JSON.parse on the first balanced {...} the scanner finds.
    //   4. JSON.parse after repairing common AI mistakes
    //      (smart quotes, full-width punctuation, stray backslashes,
    //       trailing commas).
    // Every failing attempt appends the underlying error so the user can
    // see what actually went wrong.
    const parseImportedAnnotation = raw => {
      if (typeof raw !== "string" || raw.trim() === "") return { ok: false, error: "剪贴板为空 / Clipboard is empty" };
      let work = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
      work = work.replace(/^\s+|\s+$/g, "");
      const fence = work.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/);
      const scanForObject = text => {
        const len = text.length;
        for (let i = 0; i < len; i++) {
          if (text[i] !== "{") continue;
          let depth = 0, inString = false, escape = false;
          for (let j = i; j < len; j++) {
            const c = text[j];
            if (inString) {
              if (escape) escape = false;
              else if (c === String.fromCharCode(92)) escape = true;
              else if (c === String.fromCharCode(34)) inString = false;
              continue;
            }
            if (c === String.fromCharCode(34)) inString = true;
            else if (c === "{") depth++;
            else if (c === "}") { depth--; if (depth === 0) return text.slice(i, j + 1); }
          }
        }
        return null;
      };
      const repairLooseJson = text => text
        // Smart quotes from Chinese / English typography.
        .replace(/[“”]/g, "\"")
        .replace(/[‘’]/g, "'")
        // Stray single backslashes that aren't part of a valid JSON escape.
        // Walk the string char-by-char to avoid touching \", \, \/, \n etc.
        .replace(/\\(?![\\"/bfnrtu])/g, "\\\\");
      const attempts = [];
      const tryParse = (label, value) => {
        try { return JSON.parse(value); }
        catch (error) { attempts.push(label + ": " + error.message); return null; }
      };
      let parsed;
      const primary = fence ? fence[1] : work;
      parsed = tryParse("原始", primary) || tryParse("修复引号/反斜杠", repairLooseJson(primary));
      if (parsed === null) {
        const scanned = scanForObject(work);
        if (scanned !== null) {
          parsed = tryParse("扫描对象", scanned) || tryParse("扫描对象+修复", repairLooseJson(scanned));
        }
      }
      if (parsed === null) {
        return { ok: false, error: "剪贴板中的 JSON 无法解析 — " + attempts.join("；") };
      }
      if (typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: "剪贴板内容不是 JSON 对象" };
      }
      const allowed = new Set(["tags", "note", "priority"]);
      const warnings = [];
      for (const key of Object.keys(parsed)) if (!allowed.has(key)) warnings.push({ field: key, kind: "ignored" });
      let tags = [];
      if ("tags" in parsed) {
        if (!Array.isArray(parsed.tags)) return { ok: false, error: "tags must be an array of strings" };
        const seen = new Set();
        for (const item of parsed.tags) {
          if (typeof item !== "string") { warnings.push({ field: "tags", kind: "rejected" }); continue; }
          const tag = item.trim();
          if (!tag) continue;
          if (tag.length > TAG_LIMITS.tagLength || TAG_REJECT_RE.test(tag)) {
            warnings.push({ field: "tags", kind: "rejected", value: tag });
            continue;
          }
          const key = tag.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          if (tags.length >= TAG_LIMITS.tags) { warnings.push({ field: "tags", kind: "truncated" }); continue; }
          tags.push(tag);
        }
      }
      let note = "";
      if ("note" in parsed) {
        if (typeof parsed.note !== "string") return { ok: false, error: "note must be a string" };
        if (parsed.note.includes(String.fromCharCode(0))) return { ok: false, error: "note must not contain NUL characters" };
        if (parsed.note.length > TAG_LIMITS.noteLength) {
          warnings.push({ field: "note", kind: "truncated", from: parsed.note.length, to: TAG_LIMITS.noteLength });
          note = parsed.note.slice(0, TAG_LIMITS.noteLength);
        } else note = parsed.note;
      }
      let priority;
      if ("priority" in parsed) {
        // AI-returned null is treated as the default priority (3 = Normal) so
        // the UI never has to special-case unset entries.
        if (parsed.priority === null) priority = 3;
        else if (Number.isInteger(parsed.priority) && parsed.priority >= 1 && parsed.priority <= 5) priority = parsed.priority;
        else warnings.push({ field: "priority", kind: "rejected", value: parsed.priority });
      }
      const annotation = { tags, note };
      if (priority !== undefined) annotation.priority = priority;
      return { ok: true, annotation, warnings };
    };
    const CLIPBOARD_PROMPT_TEXT = {
      zh: [
        "请根据当前对话内容，为这个会话生成整理标记。",
        "",
        "要求：",
        "1. 生成最多 20 个标签，每个标签最多 32 个字符。",
        "2. 标签应简洁、具体，便于之后搜索。",
        "3. 标签不要重复，不要生成无意义的标签。",
        "4. 生成一段不超过 2000 个字符的备注，总结本次对话的主题、结论、未完成事项或下一步行动。",
        "5. 不要编造对话中没有出现的信息。",
        "6. 只返回合法 JSON，不要使用 Markdown 代码块，不要附加解释。",
        "",
        "返回格式：",
        "{",
        '  "tags": ["标签1", "标签2"],',
        '  "note": "会话备注"',
        "}"
      ].join(String.fromCharCode(10)),
      en: [
        "Summarize this conversation into session annotations.",
        "",
        "Requirements:",
        "1. Up to 20 tags, at most 32 characters each.",
        "2. Tags should be concise and help future searches.",
        "3. Do not repeat tags or invent meaningless ones.",
        "4. Write a note under 2000 characters summarizing the topic, conclusions, outstanding items and next steps.",
        "5. Do not fabricate details that are not present in the conversation.",
        "6. Return only valid JSON, no Markdown fences, no extra commentary.",
        "",
        "Return shape:",
        "{",
        '  "tags": ["tag1", "tag2"],',
        '  "note": "session note"',
        "}"
      ].join(String.fromCharCode(10))
    };
    const promptFor = lang => CLIPBOARD_PROMPT_TEXT[lang] || CLIPBOARD_PROMPT_TEXT.zh;

    function AnnotationDialog({ sessionId, displayTitle, t, onClose, anchor }) {
      const annotations = useAnnotations();
      const latest = annotationOf(annotations, sessionId);
      const [base, setBase] = useState(() => latest);
      const [favorite, setFavorite] = useState(() => latest.favorite);
      const [reviewLater, setReviewLater] = useState(() => latest.reviewLater);
      const [tagsText, setTagsText] = useState(() => latest.tags.join(", "));
      const [note, setNote] = useState(() => latest.note);
      const [priority, setPriority] = useState(() => String(latest.priority ?? 3));
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const dialogRef = useRef(null);
      const dirty = favorite !== base.favorite || reviewLater !== base.reviewLater || tagsText !== base.tags.join(", ") || note !== base.note || priority !== String(base.priority ?? 3);
      const cancel = () => { if (busy || dirty && !window.confirm(t("marks.discard"))) return false; onClose(); return true; };
      const reload = () => {
        if (dirty && !window.confirm(t("marks.discard"))) return;
        setBase(latest); setFavorite(latest.favorite); setReviewLater(latest.reviewLater);
        setTagsText(latest.tags.join(", ")); setNote(latest.note); setPriority(String(latest.priority ?? 3)); setError(null);
      };
      const save = async () => {
        if (busy || annotations.pending.has(sessionId)) return;
        setBusy(true); setError(null);
        try {
          await annotationStore.save(sessionId, { favorite, reviewLater, tags: tagsText.split(/[,，\n]/).map(tag => tag.trim()).filter(Boolean), note, priority: Number(priority) }, base.revision);
          onClose();
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error));
          if (error?.code === "annotation-conflict") await annotationStore.load(true);
        } finally { setBusy(false); }
      };
      const escStateRef = useRef({}); escStateRef.current = { busy, cancel };
      useEffect(() => {
        const handler = e => {
          if (e.key !== "Escape" || e.isComposing || e.keyCode === 229) return;
          if (e.defaultPrevented) return;
          if (escStateRef.current.busy) return;
          e.preventDefault(); e.stopPropagation();
          if (escStateRef.current.cancel()) {
            const ae = document.activeElement;
            if (ae && typeof ae.blur === "function" && ae !== document.body) ae.blur();
          }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
      }, []);

      const onKeyDown = e => {
        if (e.key !== "Tab" || !dialogRef.current) return;
        const controls = [...dialogRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')];
        if (!controls.length) return;
        const first = controls[0], last = controls[controls.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      };
      const [importStatus, setImportStatus] = useState(null);
      const copyPrompt = async () => {
        if (busy) return;
        const text = promptFor(activeLanguage);
        try {
          if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === "function") await navigator.clipboard.writeText(text);
          else { const ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "absolute"; ta.style.left = "-9999px"; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta); }
          setImportStatus(t("marks.import.copy.copied"));
        } catch (err) { setImportStatus(t("marks.import.copy.failed", { message: err instanceof Error ? err.message : String(err) })); }
      };
      const [importText, setImportText] = useState("");
      const pasteFromInput = () => {
        if (busy) return;
        const text = (importText || "").trim();
        if (!text) { setImportStatus(t("marks.import.failure", { message: t("marks.import.empty") })); return; }
        if (dirty && !window.confirm(t("marks.import.discard"))) { setImportStatus(null); return; }
        const result = parseImportedAnnotation(text);
        if (!result.ok) { setImportStatus(t("marks.import.failure", { message: result.error })); return; }
        const ann = result.annotation;
        if (Array.isArray(ann.tags)) setTagsText(ann.tags.join(", "));
        if (typeof ann.note === "string") setNote(ann.note);
        if ("priority" in ann) setPriority(String(ann.priority ?? 3));
        setError(null);
        const warningLines = (result.warnings || []).map(w => {
          const field = w.field || t("marks.import.unknown");
          const detail = w.kind === "truncated" && typeof w.from === "number" && typeof w.to === "number"
            ? field + ": " + w.from + " -> " + w.to
            : w.kind === "rejected" && w.value !== undefined ? field + ": " + JSON.stringify(w.value)
            : w.kind ? field + " (" + w.kind + ")" : field;
          return "  - " + detail + (w.reason ? " - " + w.reason : "");
        });
        if (warningLines.length) setImportStatus(t("marks.import.warnings") + String.fromCharCode(10) + warningLines.join(String.fromCharCode(10)));
        else setImportStatus(t("marks.import.success"));
      };
      // Detect the active UI language by probing a key both dictionaries define.
      // Falls back to the cached window flag (set elsewhere if available) and ultimately
      // to "zh" so the prompt never reads empty.
      const detectLanguage = (translator) => {
        if (typeof window !== "undefined" && window.__smActiveLanguage) return window.__smActiveLanguage;
        const sample = translator("marks.favorite");
        if (typeof sample === "string") {
          if (sample === "Favorite") return "en";
          if (sample === "收藏") return "zh";
        }
        return "zh";
      };
      const activeLanguage = detectLanguage(t);
      const hasAnchor = anchor && typeof anchor.top === "number" && typeof anchor.left === "number";
      const layerClass = "sm-nativeDialogLayer sm-annotationDialog sm-confirmDialog" + (hasAnchor ? " sm-annotationDialog-anchored" : "");
      const surfaceClass = "sm-nativeDialog sm-panelDialog sm-annotationSurface" + (hasAnchor ? " sm-annotationSurface-anchored" : "");
      // Default position matches ConfirmDialog / MoveDialog so all inner
      // dialogs line up at top calc(50vh - 90px), left calc(50vw + 308px).
      const layerStyle = hasAnchor
        ? { position: "fixed", top: anchor.top + "px", left: anchor.left + "px", zIndex: 10002 }
        : null;
      return h("div", { className: layerClass, style: layerStyle, role: "presentation" },
        h("section", { className: surfaceClass, role: "dialog", "aria-labelledby": "sm-annotation-title", ref: dialogRef, onKeyDown },
          h("div", { className: "sm-nativeDialogHeader" }, h("h2", { id: "sm-annotation-title", className: "sm-nativeDialogTitle" }, t("marks.title"))),
          h("div", { className: "sm-annotationBody" },
            h("div", { className: "sm-annotationTarget", title: displayTitle || sessionId }, displayTitle || sessionId),
            h("div", { className: "sm-annotationChecks" },
              h("label", null, h("input", { type: "checkbox", "aria-label": t("marks.favorite"), checked: favorite, disabled: busy, onChange: e => setFavorite(e.target.checked) }), t("marks.favorite")),
              h("label", { className: "sm-annotationPriority" },
                h("span", null, t("marks.priority")),
                h("select", { className: "sm-viewSelect sm-prioritySelectInline", "aria-label": t("marks.priority"), value: priority, disabled: busy, onChange: e => setPriority(e.target.value) },
                  [1,2,3,4,5].map(value => h("option", { key: value, value: String(value) }, t("marks.priority." + value)))
                )
              ),
              h("label", null, h("input", { type: "checkbox", "aria-label": t("marks.review"), checked: reviewLater, disabled: busy, onChange: e => setReviewLater(e.target.checked) }), t("marks.review")),
              h("small", null, t("marks.priority.help"))
            ),
            h("label", { className: "sm-viewField sm-fieldWithClear" }, h("span", null, t("marks.tags")), h("div", { className: "sm-fieldRow sm-fieldRowNote" }, h("textarea", { className: "sm-noteInput", "aria-label": t("marks.tags"), value: tagsText, maxLength: 1000, autoFocus: true, rows: 3, placeholder: t("marks.tags.placeholder"), disabled: busy, onChange: e => setTagsText(e.target.value) }), tagsText && !busy ? h("button", { type: "button", className: "sm-fieldClear sm-fieldClearNote", "aria-label": t("marks.tags.clear"), title: t("marks.tags.clear"), onClick: () => setTagsText("") }, String.fromCharCode(10005)) : null)),
            h("label", { className: "sm-viewField sm-fieldWithClear" }, h("span", null, t("marks.note")), h("div", { className: "sm-fieldRow sm-fieldRowNote" }, h("textarea", { className: "sm-noteInput", "aria-label": t("marks.note"), value: note, maxLength: 2000, rows: 3, placeholder: t("marks.note.placeholder"), disabled: busy, onChange: e => setNote(e.target.value) }), note && !busy ? h("button", { type: "button", className: "sm-fieldClear sm-fieldClearNote", "aria-label": t("marks.note.clear"), title: t("marks.note.clear"), onClick: () => setNote("") }, String.fromCharCode(10005)) : null)),
            latest.revision !== base.revision ? h("div", { className: "sm-markConflict", role: "status" }, t("marks.conflict"), h("button", { type: "button", className: "sm-resetFilters", disabled: busy, onClick: reload }, t("marks.reload"))) : null,
            annotations.error ? h("div", { className: "sm-error", role: "alert" }, t("marks.error", { message: annotations.error }), h("button", { type: "button", className: "sm-resetFilters", disabled: busy || annotations.loading, onClick: () => annotationStore.load(true) }, t("marks.retry"))) : null,
            error ? h("div", { className: "sm-error", role: "alert" }, error) : null
          ),
          h("div", { className: "sm-importGroup" },
            h("div", { className: "sm-importGroupButtons" },
              h("button", { type: "button", className: "sm-importBtn", disabled: busy || !importText.trim(), onClick: pasteFromInput }, t("marks.import.paste")),
              h("button", { type: "button", className: "sm-importBtn", disabled: busy, onClick: copyPrompt }, t("marks.import.copy"))),
            h("div", { className: "sm-fieldWithClear" },
              h("div", { className: "sm-fieldRow sm-fieldRowNote" },
                h("textarea", { className: "sm-noteInput", "aria-label": t("marks.import.paste.aria"), value: importText, placeholder: t("marks.import.paste.placeholder"), disabled: busy, rows: 3, onChange: e => setImportText(e.target.value) }),
                importText && !busy ? h("button", { type: "button", className: "sm-fieldClear sm-fieldClearNote", "aria-label": t("marks.import.paste.clear"), title: t("marks.import.paste.clear"), onClick: () => setImportText("") }, String.fromCharCode(10005)) : null))),
            importStatus ? h("div", { className: "sm-importStatus", role: "status" }, importStatus) : null,
          h("div", { className: "sm-nativeDialogFooter" },
            h("button", { type: "button", className: "sm-nativeDialogButton", disabled: busy, onClick: cancel }, t("marks.cancel")),
            h("button", { type: "button", className: "sm-nativeDialogButton sm-nativeDialogConfirm", disabled: busy || !annotations.loaded || !!annotations.error || latest.revision !== base.revision, onClick: save }, t(busy ? "marks.saving" : "marks.save"))
          )
        )
      );
    }


    const formatRelative = (ts, now) => {
      const timestamp = sessionTime(ts);
      if (timestamp === null) return "—";
      const diff = Math.max(0, now - timestamp);
      const s = Math.floor(diff / 1000);
      if (s < 60) return s + "s";
      const m = Math.floor(s / 60);
      if (m < 60) return m + "m";
      const hr = Math.floor(m / 60);
      if (hr < 24) return hr + "h";
      const d = Math.floor(hr / 24);
      if (d < 30) return d + "d";
      const mo = Math.floor(d / 30);
      if (mo < 12) return mo + "mo";
      return Math.floor(mo / 12) + "y";
    };
    const shortPath = (cwd) => {
      if (!cwd) return "";
      const parts = cwd.replace(/[\\\/]+$/, "").split(/[\\\/]/);
      const last = parts[parts.length - 1] || "";
      return last.length > 26 ? last.slice(0, 24) + "\u2026" : last;
    };

    function ConfirmDialog(props) {
      const open = props.open === true;
      const onCancel = typeof props.onCancel === "function" ? props.onCancel : () => {};
      const onConfirm = typeof props.onConfirm === "function" ? props.onConfirm : () => {};
      const busy = props.busy === true;
      const title = props.title || "";
      const description = props.description || "";
      const warning = props.warning || "";
      const confirmLabel = props.confirmLabel || "确认";
      const cancelLabel = props.cancelLabel || "取消";
      // Esc is handled at window level (issue #7): the layer-bound
      // onKeyDown was unreachable when the row button that opened
      // the dialog stayed focused. ConfirmDialog's portal to body
      // makes it a separate subtree from the panel section, so
      // keydown never bubbles through it. Enter was previously on
      // the layer too, but that races with the focused Cancel /
      // Confirm button's native Enter handler -- removing the layer
      // Enter leaves Enter handling purely to the focused button.
      const escStateRef = useRef({});
      escStateRef.current = { busy, onCancel };
      useEffect(() => {
        if (!open) return;
        const handler = (e) => {
          if (e.key !== "Escape") return;
          if (e.defaultPrevented) return;
          const s = escStateRef.current;
          if (s.busy) return;
          e.preventDefault();
          e.stopPropagation();
          s.onCancel();
          // See SessionManagerPanel for the rationale.
          const ae = document.activeElement;
          if (ae && typeof ae.blur === "function" && ae !== document.body) ae.blur();
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
      }, [open]);
      // Render inline as a sibling of the panel; createPortal to document.body broke under some hosts. Migrate and AnnotationDialog render inline; do the same here.


      if (!open) return null;

      return h("div", {
        className: "sm-nativeDialogLayer sm-confirmDialog",
        style: props.anchor && typeof props.anchor.top === "number"
          ? { position: "fixed", top: props.anchor.top + "px", left: props.anchor.left + "px", zIndex: 10001 }
          : null,
        role: "presentation"
      },

        h("section", {
          className: "sm-nativeDialog",
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": "sm-confirm-dialog-title"
        },
          h("div", { className: "sm-nativeDialogHeader" },
            h("h2", { id: "sm-confirm-dialog-title", className: "sm-nativeDialogTitle" }, title)
          ),
          h("div", { className: "sm-nativeDialogBody" },
            description ? h("div", { className: "sm-nativeDialogDescription" }, description) : null,
            warning ? h("div", { className: "sm-warn" }, h("span", null, warning)) : null
          ),
          h("div", { className: "sm-nativeDialogFooter" },
            h("button", {
              type: "button",
              className: "sm-nativeDialogButton sm-nativeDialogCancel",
              disabled: busy,
              onClick: () => { if (!busy) onCancel(); }
            }, cancelLabel),
            h("button", {
              type: "button",
              className: "sm-nativeDialogButton sm-nativeDialogConfirm",
              disabled: busy,
              onClick: () => { if (!busy) onConfirm(); }
            }, confirmLabel)
          )
        )
      );
    }

    function MoveDialog(props) {
      const t = typeof props.t === "function" ? props.t : (key) => key;
      const open = props.open === true;
      const onCancel = typeof props.onCancel === "function" ? props.onCancel : () => {};
      const onConfirm = typeof props.onConfirm === "function" ? props.onConfirm : () => {};
      const busy = props.busy === true;
      const title = props.title || t("confirm.move.title");
      const description = props.description || "";
      const currentWorkspaceId = props.currentWorkspaceId || "";
      const confirmLabel = props.confirmLabel || t("confirm.move.confirm");
      const cancelLabel = props.cancelLabel || t("confirm.cancel");
      const error = props.error || "";
      const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
      // Esc handled at window level (issue #7) -- Enter stays on the
      // layer because (a) it gates on selectedWorkspaceId which is set
      // only by clicking a listbox item, and (b) racing Enter on the
      // Cancel / Confirm buttons is benign since the layer Enter
      // handler only fires when focus is inside the dialog subtree,
      // which is exactly when the focused button's native Enter has
      // already triggered its own click -- and in MoveDialog that
      // click just toggles selection, never cancels or confirms.
      const escStateRef = useRef({});
      escStateRef.current = { busy, onCancel };
      useEffect(() => {
        if (!open) return;
        const handler = (e) => {
          if (e.key !== "Escape") return;
          if (e.defaultPrevented) return;
          const s = escStateRef.current;
          if (s.busy) return;
          e.preventDefault();
          e.stopPropagation();
          s.onCancel();
          // See SessionManagerPanel for the rationale.
          const ae = document.activeElement;
          if (ae && typeof ae.blur === "function" && ae !== document.body) ae.blur();
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
      }, [open]);
      if (!open) return null;

      const list = (Array.isArray(props.workspaces) ? props.workspaces : [])
        .filter((ws) => ws && typeof ws === "object" && typeof ws.id === "string" && ws.id !== currentWorkspaceId);
      const body = h("div", { className: "sm-nativeDialogBody" },
        h("div", { className: "sm-nativeDialogDescription" }, description),
        list.length === 0
          ? h("div", { className: "sm-moveLabel" }, t("confirm.move.empty"))
          : h("div", { className: "sm-moveSection" },
              h("div", { className: "sm-moveLabel" }, t("confirm.move.select")),
              h("div", { className: "sm-moveList", role: "listbox", "aria-label": t("confirm.move.select") },
                list.map((ws) => h("button", {
                  key: ws.id,
                  type: "button",
                  role: "option",
                  "aria-selected": selectedWorkspaceId === ws.id,
                  className: "sm-moveItem" + (selectedWorkspaceId === ws.id ? " sm-moveItemSelected" : ""),
                  disabled: busy,
                  onClick: () => setSelectedWorkspaceId(ws.id)
                },
                  h("span", { className: "sm-moveItemName" }, String(ws.title || ws.name || ws.id)),
                  h("span", { className: "sm-moveItemMeta" }, ws.path ? String(ws.path) : "")
                ))
              )
            ),
        error ? h("div", { className: "sm-error", role: "alert" }, String(error)) : null
      );
      // Single cancel button (footer) + ESC handler. No "x" close button so the
      // user only sees one cancel entry point.
      const onKeyDown = (e) => {
        // Enter only -- Esc moved to a window-level listener (see above).
        if (e.key === "Enter" && !busy && selectedWorkspaceId && list.length > 0) {
          e.preventDefault();
          onConfirm(selectedWorkspaceId);
        }
      };
      return h("div", {
        className: "sm-nativeDialogLayer sm-confirmDialog",
        style: props.anchor && typeof props.anchor.top === "number"
          ? { position: "fixed", top: props.anchor.top + "px", left: props.anchor.left + "px", zIndex: 10001 }
          : null,
        role: "presentation",
        onKeyDown
      },

        h("section", {
          className: "sm-nativeDialog",
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": "sm-move-dialog-title"
        },
          h("div", { className: "sm-nativeDialogHeader" },
            h("h2", { id: "sm-move-dialog-title", className: "sm-nativeDialogTitle" }, title)
          ),
          body,
          h("div", { className: "sm-nativeDialogFooter" },
            h("button", {
              type: "button",
              className: "sm-nativeDialogButton sm-nativeDialogCancel",
              disabled: busy,
              onClick: onCancel
            }, cancelLabel),
            h("button", {
              type: "button",
              className: "sm-nativeDialogButton sm-nativeDialogConfirm",
              disabled: busy || !selectedWorkspaceId || list.length === 0,
              onClick: () => { if (!busy && selectedWorkspaceId) onConfirm(selectedWorkspaceId); }
            }, confirmLabel)
          )
        )
      );
    }

    function MigratePresetDialog(props) {
      const t = typeof props.t === "function" ? props.t : (key) => key;
      const open = props.open === true;
      const onCancel = typeof props.onCancel === "function" ? props.onCancel : () => {};
      const onRun = typeof props.onRun === "function" ? props.onRun : () => {};
      const busy = props.busy === true;
      const sessionId = props.sessionId || "";
      const fallbackPreset = props.currentPreset || "";
      const [scan, setScan] = useState(null);
      const [target, setTarget] = useState("");
      useEffect(() => {
        if (!open || !sessionId) return;
        let alive = true;
        // Skip setScan(null)/setTarget("") -- no-ops on initial mount that
        // would force an extra render cycle, slowing dialog open.
        fetchApi("/preset-scan?sessionId=" + encodeURIComponent(sessionId)).then((d) => {
          if (!alive) return;
          if (d && d.ok) {
            const result = d.result || {};
            const rows = Array.isArray(result.rows)
              ? result.rows
              : (result.rows && Array.isArray(result.rows.rows) ? result.rows.rows : []);
            const availablePresets = Array.isArray(result.availablePresets)
              ? result.availablePresets
              : (result.rows && Array.isArray(result.rows.availablePresets) ? result.rows.availablePresets : []);
            const row = rows.find((item) => item && item.sessionId === sessionId) || null;
            setScan({ ok: true, row, availablePresets });
          } else {
            setScan({ ok: false, error: (d && d.error) || "scan failed" });
          }
        }).catch((error) => {
          if (alive) setScan({ ok: false, error: error instanceof Error ? error.message : String(error) });
        });
        return () => { alive = false; };
      }, [open, sessionId]);
      // Esc handled at window level (issue #7). MigratePresetDialog is
      // a sibling of the panel layer in the panel's render tree, so
      // the layer-bound onKeyDown (which the dialog relied on for
      // Esc) was dead code -- focus never reached the dialog's own
      // subtree because the row Migrate button stayed focused.
      const escStateRef = useRef({});
      escStateRef.current = { busy, onCancel };
      useEffect(() => {
        if (!open) return;
        const handler = (e) => {
          if (e.key !== "Escape") return;
          if (e.defaultPrevented) return;
          const s = escStateRef.current;
          if (s.busy) return;
          e.preventDefault();
          e.stopPropagation();
          s.onCancel();
          // See SessionManagerPanel for the rationale.
          const ae = document.activeElement;
          if (ae && typeof ae.blur === "function" && ae !== document.body) ae.blur();
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
      }, [open]);
      if (!open) return null;

      const currentPreset = (scan && scan.ok && scan.row && (scan.row.finalPreset || scan.row.headerPreset)) || fallbackPreset || "—";
      const presets = scan && scan.ok
        ? Array.from(new Set((scan.availablePresets || []).filter((preset) => typeof preset === "string" && preset.length > 0))).sort()
        : [];
      const targets = presets.filter((preset) => preset !== currentPreset);
      const ready = target !== "" && target !== currentPreset;
      const body = h("div", { className: "sm-migratePanel" },
        scan === null
          ? h("div", { className: "sm-empty" }, t("busy.processing"))
          : !scan.ok
            ? h("div", { className: "sm-error", role: "alert" }, scan.error || "scan failed")
            : h(React.Fragment, null,
                h("div", { className: "sm-migrateRow" },
                  h("label", null, t("migrate.current")),
                  h("div", { className: "sm-migrateCurrent" }, currentPreset)
                ),
                h("div", { className: "sm-migrateRow" },
                  h("label", null, t("migrate.target")),
                  targets.length === 0
                    ? h("div", { className: "sm-migrateEmpty" }, t("migrate.noPresets"))
                    : h("div", { className: "sm-migrateChips" }, targets.map((preset) => h("button", {
                        key: preset,
                        type: "button",
                        className: "sm-migrateChip" + (target === preset ? " sm-migrateChipOn" : ""),
                        disabled: busy,
                        onClick: () => setTarget(preset)
                      }, preset)))
                ),
                target === currentPreset ? h("div", { className: "sm-migrateWarn" }, t("migrate.same")) : null
              )
      );
      return h("div", {
        className: "sm-nativeDialogLayer sm-confirmDialog sm-migrateConfirmLayer",
        role: "presentation"
      },

        h("section", {
          className: "sm-nativeDialog sm-migrateDialog",
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": "sm-migrate-dialog-title"
        },
          h("div", { className: "sm-nativeDialogHeader" },
            h("h2", { id: "sm-migrate-dialog-title", className: "sm-nativeDialogTitle" }, t("migrate.title"))
          ),
          body,
          h("div", { className: "sm-nativeDialogFooter" },
            h("button", {
              type: "button",
              className: "sm-nativeDialogButton sm-nativeDialogCancel",
              disabled: busy,
              onClick: onCancel
            }, t("confirm.cancel")),
            h("button", {
              type: "button",
              className: "sm-nativeDialogButton sm-nativeDialogConfirm",
              disabled: busy || !ready,
              onClick: () => { if (ready) onRun(target); }
            }, busy ? t("busy.processing") : t("migrate.confirm"))
          )
        )
      );
    }

    const panelStore = {
      open: false,
      listeners: new Set(),
      getSnapshot() { return this.open; },
      subscribe(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); },
      set(v) { if (this.open === v) return; this.open = v; for (const fn of [...this.listeners]) fn(); },
      toggle() { this.open = !this.open; for (const fn of [...this.listeners]) fn(); },
      // Pending action queued by the title-bar buttons (e.g. 移动至工作区).
      // The SessionManagerPanel consumes this on mount so it can pre-open
      // the matching inner dialog (move / delete / migrate) next to itself.
      pendingMove: null,
      pendingListeners: new Set(),
      _emitPending() { for (const fn of [...this.pendingListeners]) fn(); },
      subscribePending(cb) { this.pendingListeners.add(cb); return () => this.pendingListeners.delete(cb); },
      setPendingMove(v) { this.pendingMove = v; this._emitPending(); },
      consumePendingMove() { const v = this.pendingMove; this.pendingMove = null; return v; }
    };

    const DEFAULT_SORT = "updated-desc";
    const SORT_ORDERS = ["updated-desc", "updated-asc", "created-desc", "created-asc", "priority"];
    const workspaceValue = (id) => "workspace:" + id;
    const pathKey = (value) => {
      if (typeof value !== "string" || value === "") return "";
      const path = value.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
      return /^[a-z]:(?:\/|$)/i.test(path) || path.startsWith("//") ? path.toLowerCase() : path;
    };
    const sessionTime = (value) => {
      if (typeof value !== "number" && typeof value !== "string") return null;
      if (typeof value === "string" && value.trim() === "") return null;
      const time = typeof value === "number" || /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : Date.parse(value);
      return Number.isFinite(time) ? time : null;
    };
    const indexWorkspaces = (workspaces) => {
      const bySession = new Map();
      const byPath = new Map();
      const ids = new Set();
      for (const workspace of workspaces) {
        ids.add(workspace.id);
        const key = pathKey(workspace.path);
        if (key) {
          if (!byPath.has(key)) byPath.set(key, new Set());
          byPath.get(key).add(workspace.id);
        }
        for (const id of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) {
          if (!bySession.has(id)) bySession.set(id, new Set());
          bySession.get(id).add(workspace.id);
        }
      }
      return { bySession, byPath, ids };
    };
    const rowWorkspaces = (session, index) => {
      // Registry membership includes archived sessions and takes precedence
      // over a stale cwd. Older metadata can fall back to workspaceId/cwd.
      if (index.bySession.has(session.id)) return index.bySession.get(session.id);
      if (index.ids.has(session.workspaceId)) return new Set([session.workspaceId]);
      return index.byPath.get(pathKey(session.cwd)) ?? new Set();
    };

    function SessionManagerPanel(props) {
      const t = props.t;
      const open = props.open;
      const onClose = props.onClose;
      const useSessions = props.useSessions;
      const useWorkspaces = props.useWorkspaces;
      const onOpen = props.onOpen;
      const onArchive = props.onArchive;
      const onUnarchive = props.onUnarchive;
      const onRemove = props.onRemove;
      const onMove = props.onMove;
      const onMigrate = props.onMigrate;
      const annotations = useAnnotations(true);
      const marksReady = annotations.loaded && !annotations.error;
      const [onlyFavorite, setOnlyFavorite] = useState(false);
      const [onlyReview, setOnlyReview] = useState(false);
      const [tagFilter, setTagFilter] = useState("all");
      const [priorityFilter, setPriorityFilter] = useState("all");
      const [annotationFor, setAnnotationFor] = useState(null);
      const [annotationAnchor, setAnnotationAnchor] = useState(null);
      const list = useSessions((s) => s);
      const workspaceSnapshot = useWorkspaces((s) => s);
      const archivedIds = workspaceSnapshot.archivedSessionIds || [];
      const [filter, setFilter] = useState("all");
      const [query, setQuery] = useState("");
      const [workspaceFilter, setWorkspaceFilter] = useState("all");
      const [sortOrder, setSortOrder] = useState(DEFAULT_SORT);
      const [busyId, setBusyId] = useState(null);
      const [error, setError] = useState(null);
      const [now, setNow] = useState(() => Date.now());
      const [moveFor, setMoveFor] = useState(null);
      const [confirmFor, setConfirmFor] = useState(null);
      const [workspaces, setWorkspaces] = useState([]);
      const [createdTimes, setCreatedTimes] = useState({});
      const [workspacesLoading, setWorkspacesLoading] = useState(true);
      const [workspacesError, setWorkspacesError] = useState(null);
      const [workspaceRefresh, setWorkspaceRefresh] = useState(0);
      const [migrating, setMigrating] = useState(false);
      const [migrateFor, setMigrateFor] = useState(null);
      const sessionMembershipKey = useMemo(() => [...list.ids].sort().join("\0"), [list.ids]);
      useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30000);
        return () => clearInterval(timer);
      }, []);
      useEffect(() => {
        if (!open) return;
        let alive = true;
        const controller = new AbortController();
        setWorkspacesLoading(true);
        setWorkspacesError(null);
        fetchApi("/workspaces", { signal: controller.signal }).then((data) => {
          if (!data?.ok || !Array.isArray(data.result?.workspaces)) throw new Error(data?.error || "Invalid workspace response");
          const next = data.result.workspaces.filter(workspace => workspace && typeof workspace.id === "string");
          if (!alive) return;
          setWorkspaces(next);
          const times = data.result.sessionCreatedAt;
          setCreatedTimes(times && typeof times === "object" && !Array.isArray(times) ? times : {});
          setWorkspaceFilter(value => value.startsWith("workspace:") && !next.some(workspace => workspaceValue(workspace.id) === value) ? "all" : value);
        }).catch(error => {
          if (alive) setWorkspacesError(error instanceof Error ? error.message : String(error));
        }).finally(() => {
          if (alive) setWorkspacesLoading(false);
        });
        return () => { alive = false; controller.abort(); };
      }, [open, workspaceSnapshot, Boolean(moveFor), workspaceRefresh, sessionMembershipKey]);
      // Drain any pending action queued by a header button. The panel is
      // the single owner of every inner dialog, so opening it with a
      // pending action pre-populates the corresponding dialog state.
      useEffect(() => {
        if (!open) return;
        const pending = panelStore.consumePendingMove();
        if (pending && pending.sessionId) {
          setMoveFor({ id: pending.sessionId, displayTitle: pending.displayTitle || pending.sessionId, workspaceId: pending.workspaceId || "" });
        }
      }, [open]);
      const archived = useMemo(() => new Set(archivedIds), [archivedIds]);
      const workspaceIndex = useMemo(() => indexWorkspaces(workspaces), [workspaces]);
      const allRows = useMemo(() => list.ids.map(id => list.byId[id])
        .filter(session => session != null && session.origin !== "subagent" && (!session.blank || session.id === list.current)), [list]);
      const availableTags = useMemo(() => {
        const tags = new Map();
        for (const session of allRows) for (const tag of annotationOf(annotations, session.id).tags) if (!tags.has(tag.toLowerCase())) tags.set(tag.toLowerCase(), tag);
        return [...tags].sort((a, b) => a[1].localeCompare(b[1]));
      }, [allRows, annotations.entries]);
      useEffect(() => {
        // A removed last tag must not leave an invisible active filter while
        // the select falls back to displaying "All tags".
        if (annotations.loaded && !annotations.error && tagFilter.startsWith("tag:")
          && !availableTags.some(([key]) => key === tagFilter.slice(4))) setTagFilter("all");
      }, [availableTags, tagFilter, annotations.loaded, annotations.error]);
      const rows = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const selected = allRows.filter(session => {
          if (filter === "active" && archived.has(session.id)) return false;
          if (filter === "archived" && !archived.has(session.id)) return false;
          const mark = annotationOf(annotations, session.id);
          if (onlyFavorite && !mark.favorite || onlyReview && !mark.reviewLater) return false;
          if (tagFilter === "none" && mark.tags.length !== 0) return false;
          if (tagFilter.startsWith("tag:") && !mark.tags.some(tag => tag.toLowerCase() === tagFilter.slice(4))) return false;
          if (priorityFilter !== "all" && (mark.priority ?? 3) !== Number(priorityFilter)) return false;
          const title = session.blank ? t("panel.session.new") : session.displayTitle || session.id;
          if (needle && ![title, session.id, mark.note, ...mark.tags].some(value => value.toLowerCase().includes(needle))) return false;
          if (workspaceFilter !== "all") {
            const memberships = rowWorkspaces(session, workspaceIndex);
            if (workspaceFilter === "ungrouped" ? memberships.size !== 0 : !memberships.has(workspaceFilter.slice("workspace:".length))) return false;
          }
          return true;
        });
        const field = sortOrder.startsWith("created-") ? "createdAt" : "updatedAt";
        const direction = sortOrder === "priority" || sortOrder.endsWith("-asc") ? 1 : -1;
        // Sort a derived array only. Equal timestamps preserve source order;
        // missing/invalid timestamps stay last in either direction. Priority
        // is normalized to 1-5 (legacy null treated as 3) so unset rows sort
        // alongside priority 3.
        const timeFor = session => {
          if (sortOrder === "priority") return annotationOf(annotations, session.id).priority ?? 3;
          return field === "createdAt" ? sessionTime(session.createdAt) ?? sessionTime(createdTimes[session.id]) : sessionTime(session.updatedAt);
        };
        return selected.map((session, rank) => ({ session, rank, time: timeFor(session) }))
          .sort((a, b) => a.time === b.time ? a.rank - b.rank : a.time === null ? 1 : b.time === null ? -1 : direction * (a.time - b.time))
          .map(item => item.session);
      }, [allRows, archived, filter, query, workspaceFilter, workspaceIndex, sortOrder, createdTimes, annotations.entries, onlyFavorite, onlyReview, tagFilter, priorityFilter, t]);
      const creationTimeUnavailable = sortOrder.startsWith("created-") && allRows.length > 0
        && !allRows.some(session => (sessionTime(session.createdAt) ?? sessionTime(createdTimes[session.id])) !== null);
      const hasViewChanges = onlyFavorite || onlyReview || tagFilter !== "all" || priorityFilter !== "all" || query !== "" || filter !== "all" || workspaceFilter !== "all" || sortOrder !== DEFAULT_SORT;
      const resetView = () => { setQuery(""); setFilter("all"); setWorkspaceFilter("all"); setSortOrder(DEFAULT_SORT); setOnlyFavorite(false); setOnlyReview(false); setTagFilter("all"); setPriorityFilter("all"); };
      const runRow = async (sessionId, fn) => {
        if (busyId !== null) return;
        setBusyId(sessionId);
        setError(null);
        try {
          await fn();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusyId(null);
        }
      };
      const filterBtn = (id, label) => h("button", {
        type: "button",
        key: id,
        className: "sm-filterBtn" + (filter === id ? " sm-on" : ""),
        "aria-pressed": filter === id,
        onClick: () => setFilter(id)
      }, label);
      const renderRow = (s) => {
        const isArchived = archived.has(s.id);
        const isCurrent = s.id === list.current;
        const busy = busyId === s.id;
        const mark = annotationOf(annotations, s.id);
        return h("div", {
          key: s.id,
          "data-session-id": s.id,
          className: "sm-row" + (isCurrent ? " sm-rowCurrent" : "")
        },
          h("div", { className: "sm-rowMain" },
            h("div", { className: "sm-rowTitle" },
              h("span", null, s.blank ? t("panel.session.new") : (s.displayTitle || s.id)),
              isArchived ? h("span", { className: "sm-badge sm-badgeArchived" }, t("panel.archived")) : null,
              s.running ? h("span", { className: "sm-badge sm-badgeRunning" }, t("panel.running")) : null,
              isCurrent ? h("span", { className: "sm-badge sm-badgeCurrent" }, t("panel.current")) : null
            ),
            mark.priority !== null || mark.tags.length || mark.note ? h("div", { className: "sm-rowAnnotations" },
              h("span", { className: "sm-priorityBadge sm-priority-" + (mark.priority ?? 3), title: t("marks.priority." + (mark.priority ?? 3)) }, "P" + (mark.priority ?? 3)),
              mark.tags.slice(0, 2).map(tag => h("button", { key: tag, type: "button", className: "sm-tagChip", title: tag, onClick: () => setTagFilter("tag:" + tag.toLowerCase()) }, tag)),
              mark.tags.length > 2 ? h("span", { title: mark.tags.join(", ") }, "+" + (mark.tags.length - 2)) : null,
              mark.note ? h("button", { type: "button", className: "sm-noteBadge", title: t("marks.note.exists"), onClick: () => { setAnnotationAnchor(null); setAnnotationFor(current => current?.id === s.id ? null : s); } }, "✎") : null
            ) : null,
            h("div", { className: "sm-rowMeta" }, shortPath(s.cwd) + (s.cwd ? " · " : "") + formatRelative(s.updatedAt, now))
          ),
          h("div", { className: "sm-rowActions" },
            h("button", { type: "button", className: "sm-rowBtn", disabled: busy, onClick: () => onOpen(s.id) }, t("row.open")),
            h("button", { type: "button", className: "sm-rowBtn", disabled: busy, onClick: () => runRow(s.id, () => isArchived ? onUnarchive(s.id) : onArchive(s.id)) }, t(isArchived ? "row.unarchive" : "row.archive")),
            annotationButtons(s.id, s.displayTitle || s.id, t, annotations, "sm-rowBtn", patch => runRow(s.id, () => annotationStore.save(s.id, patch)), () => { setAnnotationAnchor(null); setAnnotationFor(current => current?.id === s.id ? null : s); }, busy),
            h("button", { type: "button", className: "sm-rowBtn", disabled: busy, onClick: () => { if (moveFor && moveFor.id === s.id) setMoveFor(null); else setMoveFor(s); } }, t("row.move")),
            h("button", { type: "button", className: "sm-rowBtn", disabled: busy, onClick: () => { if (migrateFor && migrateFor.id === s.id) setMigrateFor(null); else setMigrateFor(s); } }, t("row.migrate")),
            h("button", { type: "button", className: "sm-rowBtn sm-rowBtnDanger", disabled: busy, onClick: () => { if (confirmFor && confirmFor.id === s.id) setConfirmFor(null); else setConfirmFor(s); } }, t("row.delete"))
          )
        );
      };
      const rowsList = rows.length === 0
        ? h("div", { className: "sm-empty" }, allRows.length > 0 ? t("panel.empty.filtered") : filter === "archived" ? t("panel.empty.archived") : t("panel.empty"))
        : h("div", { className: "sm-list" }, rows.map(renderRow));
      const onPanelClose = () => {
        if (busyId !== null) return;
        setConfirmFor(null);
        setMoveFor(null);
        setMigrateFor(null);
        onClose();
      };
      // Esc is handled at window level (issue #7): the original layer-
      // bound onKeyDown was unreachable when focus stayed on the sidebar
      // toggle button that opened the panel -- that button is a sibling
      // of the panel layer, so keydown never bubbles into the panel
      // subtree. The state ref lets the listener see the latest values
      // without re-subscribing on every render. The panel listener
      // returns early when any inner dialog is open so the child
      // dialog's own window listener gets the first shot at Esc.
      const escStateRef = useRef({});
      escStateRef.current = { busyId, confirmFor, moveFor, migrateFor, annotationFor, onPanelClose };
      useEffect(() => {
        if (!open) return;
        const handler = (e) => {
          if (e.key !== "Escape") return;
          if (e.defaultPrevented) return;
          if (e.isComposing || e.keyCode === 229) return;
          const s = escStateRef.current;
          if (s.busyId !== null) return;
          if (s.confirmFor || s.moveFor || s.migrateFor || s.annotationFor) return;
          e.preventDefault();
          e.stopPropagation();
          s.onPanelClose();
          // Esc after a keyboard-driven close leaves the originally-
          // focused trigger button (sidebar toggle / row button) with
          // :focus-visible still active -- blur it so no focus ring
          // lingers after the panel closes. Mouse-driven closes are
          // not affected: :focus-visible only activates for keyboard
          // focus, so the ring never shows in that path.
          const ae = document.activeElement;
          if (ae && typeof ae.blur === "function" && ae !== document.body) ae.blur();
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
      }, [open]);
      const panelModal = h("div", {
        className: "sm-nativeDialogLayer",
        role: "presentation"
      },
        h("section", {
          className: "sm-nativeDialog sm-panelDialog",
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": "sm-panel-dialog-title"
        },
          h("div", { className: "sm-nativeDialogHeader" },
            h("h2", { id: "sm-panel-dialog-title", className: "sm-nativeDialogTitle" }, t("panel.title")),
            h("button", {
              type: "button",
              className: "sm-panelHeaderClose",
              disabled: busyId !== null || migrating,
              onClick: onPanelClose
            }, t("panel.close"))
          ),
          h("div", { className: "sm-panel" },
            h("div", { className: "sm-panelTools" },
              h("input", {
                type: "search", className: "sm-queryInput", value: query,
                placeholder: t("panel.search"), "aria-label": t("panel.search"), autoComplete: "off",
                onChange: event => setQuery(event.target.value)
              }),
              h("div", { className: "sm-panelSelects" },
                h("label", { className: "sm-viewField" },
                  h("span", null, t("panel.workspace")),
                  h("select", {
                    className: "sm-viewSelect", "aria-label": t("panel.workspace"), value: workspaceFilter,
                    disabled: workspacesLoading || workspacesError !== null,
                    onChange: event => setWorkspaceFilter(event.target.value)
                  },
                    h("option", { value: "all" }, t("panel.workspace.all")),
                    h("option", { value: "ungrouped" }, t("panel.workspace.ungrouped")),
                    workspaces.map(workspace => h("option", { key: workspace.id, value: workspaceValue(workspace.id), title: workspace.path || workspace.id }, workspace.title || workspace.name || workspace.id))
                  )
                ),
                h("label", { className: "sm-viewField" },
                  h("span", null, t("panel.sort")),
                  h("select", {
                    className: "sm-viewSelect", "aria-label": t("panel.sort"), value: sortOrder,
                    onChange: event => setSortOrder(event.target.value)
                  }, SORT_ORDERS.map(value => h("option", { key: value, value, disabled: value === "priority" && !marksReady }, t(value === "priority" ? "marks.sort" : "panel.sort." + value))))
                )
              ),
              h("div", { className: "sm-markFilters" },
                h("button", { type: "button", className: "sm-filterBtn sm-markFilterToggle" + (onlyFavorite ? " sm-on" : ""), "aria-label": t("marks.filter.favorite.aria"), "aria-pressed": onlyFavorite, disabled: !marksReady, onClick: () => setOnlyFavorite(value => !value) }, "★ " + t("marks.filter.favorite")),
                h("button", { type: "button", className: "sm-filterBtn sm-markFilterToggle" + (onlyReview ? " sm-on" : ""), "aria-label": t("marks.filter.review.aria"), "aria-pressed": onlyReview, disabled: !marksReady, onClick: () => setOnlyReview(value => !value) }, "◷ " + t("marks.filter.review")),
                h("label", { className: "sm-viewField" }, h("span", null, t("marks.tags")), h("select", { className: "sm-viewSelect", "aria-label": t("marks.filter.tags"), value: tagFilter, disabled: !marksReady, onChange: e => setTagFilter(e.target.value) },
                  h("option", { value: "all" }, t("marks.tags.all")), h("option", { value: "none" }, t("marks.tags.none")),
                  availableTags.map(([key, tag]) => h("option", { key, value: "tag:" + key }, tag)),
                  tagFilter.startsWith("tag:") && !availableTags.some(([key]) => "tag:" + key === tagFilter) ? h("option", { value: tagFilter }, t("marks.tags.missing", { tag: tagFilter.slice(4) })) : null
                )),
                h("label", { className: "sm-viewField" }, h("span", null, t("marks.priority")), h("select", { className: "sm-viewSelect", "aria-label": t("marks.filter.priority"), value: priorityFilter, disabled: !marksReady, onChange: e => setPriorityFilter(e.target.value) },
                  h("option", { value: "all" }, t("marks.priority.all")),
                  [1,2,3,4,5].map(value => h("option", { key: value, value: String(value) }, t("marks.priority." + value)))
                ))
              ),
              h("div", { className: "sm-filterBar" },
                h("div", { className: "sm-filter" },
                  filterBtn("all", t("panel.filter.all")),
                  filterBtn("active", t("panel.filter.active")),
                  filterBtn("archived", t("panel.filter.archived"))
                ),
                h("div", { className: "sm-resultSummary" },
                  h("span", { role: "status", "aria-live": "polite", "aria-atomic": "true" }, t("panel.count", { shown: rows.length, total: allRows.length })),
                  hasViewChanges ? h("button", { type: "button", className: "sm-resetFilters", onClick: resetView }, t("panel.reset")) : null
                )
              ),
              annotations.loading && !annotations.loaded ? h("div", { className: "sm-workspaceNotice", role: "status" }, t("marks.loading")) : null,
              annotations.error ? h("div", { className: "sm-workspaceNotice", role: "alert" }, t("marks.error", { message: annotations.error }), h("button", { type: "button", className: "sm-resetFilters", onClick: () => annotationStore.load(true) }, t("marks.retry"))) : null,
              creationTimeUnavailable && !workspacesLoading ? h("div", { className: "sm-workspaceNotice", role: "status" }, t("panel.sort.unavailable")) : null,
              workspacesLoading ? h("div", { className: "sm-workspaceNotice", role: "status" }, t("panel.workspace.loading")) : null,
              workspacesError ? h("div", { className: "sm-workspaceNotice", role: "alert" },
                h("span", null, t("panel.workspace.error", { message: workspacesError })),
                h("button", { type: "button", className: "sm-resetFilters", onClick: () => setWorkspaceRefresh(value => value + 1) }, t("panel.workspace.retry"))
              ) : null
            ),
            error ? h("div", { className: "sm-error", role: "alert" }, t("error.operation", { message: error })) : null,
            rowsList
          )
        )
      );

      const deleteDialog = confirmFor === null ? null : h(ConfirmDialog, {
        open: true,
        onClose: () => { if (busyId === null) setConfirmFor(null); },
        title: t("confirm.delete.title"),
        description: t("confirm.delete.desc", { title: confirmFor.displayTitle || confirmFor.id }),
        warning: confirmFor.running ? t("confirm.delete.running") : null,
        confirmLabel: t("confirm.delete.confirm"),
        cancelLabel: t("confirm.cancel"),
        busy: busyId !== null,
        onCancel: () => { if (busyId === null) setConfirmFor(null); },
        onConfirm: () => {
          const target = confirmFor;
          setConfirmFor(null);
          runRow(target.id, () => onRemove(target.id));
        }
      });
      const moveDialog = moveFor === null ? null : h(MoveDialog, {
        open: true,
        onClose: () => { if (busyId === null) setMoveFor(null); },
        title: t("confirm.move.title"),
        description: t("confirm.move.desc", { title: moveFor.displayTitle || moveFor.id }),
        sessionTitle: moveFor.displayTitle || moveFor.id,
        currentWorkspaceId: moveFor.workspaceId,
        workspaces: workspaces,
        confirmLabel: t("confirm.move.confirm"),
        cancelLabel: t("confirm.cancel"),
        busy: busyId !== null,
        onCancel: () => { if (busyId === null) setMoveFor(null); },
        onConfirm: (targetWorkspaceId) => {
          const target = moveFor;
          setMoveFor(null);
          runRow(target.id, async () => {
            await onMove(target.id, targetWorkspaceId);
            setWorkspaceRefresh(value => value + 1);
          });
        }
      });
      const migrateDialog = migrateFor === null ? null : h(MigratePresetDialog, {
        open: true,
        t: t,
        sessionId: migrateFor.id,
        currentPreset: migrateFor.agentPreset || "",
        onCancel: () => { if (!migrating) setMigrateFor(null); },
        busy: migrating,
        onRun: async (targetPreset) => {
          const target = migrateFor;
          setMigrating(true);
          setError(null);
          try {
            await onMigrate(target.id, targetPreset);
            setMigrateFor(null);
            try { window.alert(t("migrate.completed", { preset: targetPreset })); } catch (_) {}
          } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
            setMigrateFor(null);
          } finally {
            setMigrating(false);
          }
        }
      });
      // Render the panel AND the inner dialog as siblings so React keeps
      // both mounted. CSS z-index keeps the right ordering: the inner
      // dialog (.sm-confirmDialog / .sm-moveDialog / .sm-migrateDialog)
      // carries z-index 10000 and therefore sits ON TOP OF the panel
      // (z-index 9999). Clicking inside the panel that the inner dialog
      // blocks is not possible because the inner backdrop covers the
      // panel area entirely (the inner modal is centered).
      const annotationDialog = annotationFor ? h(AnnotationDialog, { key: annotationFor.id, sessionId: annotationFor.id, displayTitle: annotationFor.displayTitle || annotationFor.id, t, anchor: annotationAnchor, onClose: () => { setAnnotationFor(null); setAnnotationAnchor(null); } }) : null;
      // Render panel + ALL inner dialogs together; z-index ordering puts
      // whichever dialog is open above the panel.
      return h(React.Fragment, null, panelModal, annotationDialog, moveDialog, deleteDialog, migrateDialog);
    }

    function HeaderAction(props) {
      const t = props.t;
      const sessionId = props.sessionId;
      const annotations = useAnnotations();
      const [annotationFor, setAnnotationFor] = useState(null);
      const [annotationAnchor, setAnnotationAnchor] = useState(null);
      // Slot framework spreads inject-factory return into top-level props,
      // so the action callbacks live directly on props (not under .actions).
      const onArchive = props.onArchive, onUnarchive = props.onUnarchive;
      const onMove = props.onMove, onRemove = props.onRemove;
      // Archive state lives in the workspace registry's archivedSessionIds
      // (exposed through the global standard kit's useWorkspaces selector).
      const useWorkspaces = props.useWorkspaces;
      const archivedIds = (useWorkspaces ? useWorkspaces((s) => s.archivedSessionIds) : null) || [];
      const isArchived = archivedIds.includes(sessionId);

      const [confirmFor, setConfirmFor] = useState(null);
      const [confirmAnchor, setConfirmAnchor] = useState(null);
      const [moveFor, setMoveFor] = useState(null);
      const [moveAnchor, setMoveAnchor] = useState(null);
      const [workspaces, setWorkspaces] = useState([]);
      const runWithAlert = (label, fn) => {
        return Promise.resolve()
          .then(() => fn())
          .catch((e) => {
            try {
              const msg = e instanceof Error ? e.message : String(e);
              window.alert(((t && t("error.operation")) || "操作失败：{message}").replace("{message}", msg));
            } catch (_) {}
          });
      };
      useEffect(() => {
        if (!moveFor) { setWorkspaces([]); return; }
        let alive = true;
        fetchApi("/workspaces").then((d) => {
          if (alive && d && d.ok) setWorkspaces(d.result.workspaces || []);
        });
        return () => { alive = false; };
      }, [moveFor ? (moveFor.id || "x") : null]);
      const anchorFor = (el) => {
        if (!el || typeof el.getBoundingClientRect !== "function") return null;
        const r = el.getBoundingClientRect();
        return {
          top: Math.round(r.top + r.height + 6),
          left: Math.max(8, Math.round(r.right - 320))
        };
      };
      const archiveLabelKey = isArchived ? "row.unarchive" : "row.archive";
      return h(React.Fragment, null,
        annotationFor ? h(AnnotationDialog, { key: annotationFor.id, sessionId: annotationFor.id, displayTitle: annotationFor.displayTitle, t, anchor: annotationAnchor, onClose: () => { setAnnotationFor(null); setAnnotationAnchor(null); } }) : null,
        h("div", { className: "sm-header" },
          h("button", {
            type: "button",
            className: "sm-headerBtn" + (isArchived ? " sm-headerBtnActive" : ""),
            "aria-label": t ? t(archiveLabelKey) : (isArchived ? "移出归档" : "归档会话"),
            onClick: () => runWithAlert("archive", () =>
              isArchived ? onUnarchive(sessionId) : onArchive(sessionId)
            )
          }, isArchived ? (t ? t("row.unarchive") : "移出归档") : (t ? t("row.archive") : "归档")),

          annotationButtons(sessionId, props.displayTitle || sessionId, t, annotations, "sm-headerBtn", patch => runWithAlert("annotations", () => annotationStore.save(sessionId, patch)), (e) => {
            const nextOpen = !(annotationFor && annotationFor.id === sessionId);
            setMoveFor(null); setConfirmFor(null);
            if (nextOpen && e && e.currentTarget) {
              const r = e.currentTarget.getBoundingClientRect();
              setAnnotationAnchor({ top: Math.round(r.top + r.height + 6), left: Math.max(8, Math.round(r.right - 460)) });
            } else setAnnotationAnchor(null);
            setAnnotationFor(current => current?.id === sessionId ? null : { id: sessionId, displayTitle: props.displayTitle || sessionId });
          }, false, annotationFor?.id === sessionId),
          annotations.error ? h("button", { type: "button", className: "sm-headerBtn", title: t("marks.error", { message: annotations.error }), "aria-label": t("marks.retry"), onClick: () => annotationStore.load(true) }, "!") : null,

          h("button", {
            type: "button",
            className: "sm-headerBtn" + (moveFor ? " sm-headerBtnActive" : ""),
            "aria-label": t ? t("row.move") : "移动到工作区",
            onClick: (e) => {
              e.stopPropagation();
              setConfirmFor(null);
              setConfirmAnchor(null);
              if (moveFor && moveFor.id === sessionId) {
                setMoveFor(null);
                setMoveAnchor(null);
              } else {
                setMoveAnchor(anchorFor(e.currentTarget));
                setMoveFor({ id: sessionId, displayTitle: sessionId, workspaceId: "" });
              }
            }
          }, t ? t("row.move") : "移动"),
          h("button", {
            type: "button",
            className: "sm-headerBtn sm-headerBtnDanger" + (confirmFor ? " sm-headerBtnActive" : ""),
            "aria-label": t ? t("row.delete") : "删除会话",
            onClick: (e) => {
              e.stopPropagation();
              setMoveFor(null);
              setMoveAnchor(null);
              if (confirmFor && confirmFor.id === sessionId) {
                setConfirmFor(null);
                setConfirmAnchor(null);
              } else {
                setConfirmAnchor(anchorFor(e.currentTarget));
                setConfirmFor({ id: sessionId, displayTitle: sessionId });
              }
            }
          }, t ? t("row.delete") : "删除")
        ),
        confirmFor === null ? null : h(ConfirmDialog, {
          open: true,
          anchor: confirmAnchor,
          onClose: () => setConfirmFor(null),
          onCancel: () => setConfirmFor(null),
          onConfirm: () => {
            const target = confirmFor;
            setConfirmFor(null);
            runWithAlert("delete", () => onRemove(target.id));
          },
          title: t ? t("confirm.delete.title") : "删除会话",
          description: (confirmFor && (t ? t("confirm.delete.desc", { title: confirmFor.displayTitle || confirmFor.id }) : ("将删除 " + (confirmFor.displayTitle || confirmFor.id)))) || "",
          confirmLabel: t ? t("confirm.delete.confirm") : "确认删除",
          cancelLabel: t ? t("confirm.cancel") : "取消",
          busy: false
        }),
        moveFor === null ? null : h(MoveDialog, {
          open: true,
          anchor: moveAnchor,
          t: t,
          workspaces: workspaces,
          currentWorkspaceId: moveFor.workspaceId || "",
          onClose: () => { setMoveFor(null); setMoveAnchor(null); },
          onCancel: () => { setMoveFor(null); setMoveAnchor(null); },
          title: t ? t("confirm.move.title") : "移动会话到工作区",
          description: (moveFor && (t ? t("confirm.move.desc", { title: moveFor.displayTitle || moveFor.id }) : "")) || "",
          sessionTitle: moveFor.displayTitle || moveFor.id,
          confirmLabel: t ? t("confirm.move.confirm") : "确认移动",
          cancelLabel: t ? t("confirm.cancel") : "取消",
          busy: false,
          onConfirm: (targetWorkspaceId) => {
            const target = moveFor;
            setMoveFor(null);
            setMoveAnchor(null);
            runWithAlert("move", () => onMove(target.id, targetWorkspaceId));
          }
        })
      );
    }

    class SafePanel extends React.Component {
      constructor(p) { super(p); this.state = { failed: false }; }
      static getDerivedStateFromError() { return { failed: true }; }
      componentDidCatch(error) { try { console.error("[dsh-session-manager] SessionManagerPanel crashed:", error); } catch (_) {} }
      render() {
        if (this.state.failed) return null;
        return h(SessionManagerPanel, {
          open: true,
          onClose: () => { try { this.props.panelStore.set(false); } catch (_) {} },
          useSessions: this.props.useSessions,
          useWorkspaces: this.props.useWorkspaces,
          t: this.props.t,
          onOpen: (id) => { try { this.props.panelStore.set(false); this.props.props.onOpen(id); } catch (_) {} },
          onArchive: this.props.props.onArchive,
          onUnarchive: this.props.props.onUnarchive,
          onRemove: this.props.props.onRemove,
          onMove: this.props.props.onMove,
          onMigrate: this.props.props.onMigrate
        });
      }
    }

    function FooterAction(props) {
      const t = props.t;
      const onOpenPanel = props.onOpenPanel;
      const open = useSyncExternalStore(
        (cb) => panelStore.subscribe(cb),
        () => panelStore.getSnapshot(),
        () => panelStore.getSnapshot()
      );
      return h("div", { className: "sm-footer" },
        h("button", { type: "button", className: "sm-footerBtn", "aria-label": t("footer.aria"), onClick: () => onOpenPanel() },
          h(P.IconArchiveOutline20, { size: 14 }),
          h("span", null, t("footer.label"))
        ),
        // The panel is mounted ONLY while the user has the modal open. When
        // The wrap guards against an in-panel crash by returning null on its
        // own error boundary rather than letting it bubble up to the slot.
        open ? h(SafePanel, {
          panelStore: panelStore,
          props: props,
          t: t,
          useSessions: props.useSessions,
          useWorkspaces: props.useWorkspaces,
        }) : null
      );
    }

    function apply(ctx) {
      ctx.effect(() => {
        const refresh = () => { if (annotationStore.hasSubscribers()) void annotationStore.load(true); };
        window.addEventListener("focus", refresh);
        let channel;
        try {
          if (typeof BroadcastChannel === "function") {
            channel = new BroadcastChannel("dsh-session-manager-annotations-v1");
            channel.onmessage = event => { if (event.data?.type === "changed") refresh(); };
            annotationStore.notify = () => channel.postMessage({ type: "changed" });
          }
        } catch (_) { /* unavailable browser messaging: focus refresh still works */ }
        return () => { window.removeEventListener("focus", refresh); channel?.close(); annotationStore.notify = null; };
      }, "session-manager: annotation synchronization");
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-manager: dictionaries");
      const actions = () => ({
        // DSH 0.1.6+ removed ctx.sessions.open(); the navigation owner is
        // `ctx.uiWorkspace.openSession()`, and the bare SessionController only
        // exposes `retain()`. Pick the live surface so the row's "Open" button
        // actually navigates on every supported host build.
        onOpen: (sessionId) => {
          const uiWorkspace = ctx.uiWorkspace;
          if (uiWorkspace && typeof uiWorkspace.openSession === "function") {
            uiWorkspace.openSession(sessionId);
            return;
          }
          const sessions = ctx.sessions;
          if (sessions && typeof sessions.retain === "function") {
            // The bare retain() returns a SessionReference whose release()
            // tears down the in-memory binding; the user normally expects the
            // session to stay open, so a header-less build simply keeps it.
            sessions.retain(sessionId, { source: "mainView" });
            return;
          }
          throw new Error("session-manager: no Session open API on this DSH host");
        },
        onArchive: async (sessionId) => { await ctx.workspaces.archiveSession(sessionId); },
        onUnarchive: async (sessionId) => {
          const response = await callApi("/unarchive", { sessionId });
          if (!response.ok) throw new Error(response.error || "unarchive failed");
        },
        onRemove: async (sessionId) => {
          const response = await callApi("/delete", { sessionId });
          if (!response.ok) throw new Error(response.error || "delete failed");
          await annotationStore.load(true);
          if (response.result?.warning) window.alert(response.result.warning);
          const current = ctx.sessions.list.getSnapshot().current;
          if (current === sessionId) ctx.sessions.clear();
        },
        onMove: async (sessionId, targetWorkspaceId) => {
          const wasCurrent = ctx.sessions.list.getSnapshot().current === sessionId;
          const response = await callApi("/move", { sessionId, targetWorkspaceId });
          if (!response.ok) throw new Error(response.error || "move failed");
          const refreshMovedSession = async () => {
            await Promise.allSettled([
              typeof ctx.workspaces?.refresh === "function" ? ctx.workspaces.refresh() : Promise.resolve(),
              ctx.sessions.refresh()
            ]);
            if (wasCurrent && ctx.sessions.list.getSnapshot().byId[sessionId] !== undefined) {
              ctx.sessions.open(sessionId);
            }
          };
          // The 0.4.6+ move path keeps the live agent/session intact (no
          // session/disposed, no half-resumed Session object), so the chat
          // panel keeps the in-memory session as active. We still refresh
          // the workspace + session-list projections so the destination
          // workspace and the moved row appear without a manual refresh.
          await refreshMovedSession();
          setTimeout(() => { void refreshMovedSession(); }, 250);
          setTimeout(() => { void refreshMovedSession(); }, 900);
        },
        onMigrate: async (sessionId, toPreset) => {
          const wasCurrent = ctx.sessions.list.getSnapshot().current === sessionId;
          const response = await callApi("/preset-migrate", { sessionId, toPreset });
          if (!response.ok) throw new Error(response.error || "preset migration failed");
          // The current DSH client session store derives agentPreset from
          // the refreshed projection; older builds exposed noteAgentPreset,
          // but calling it unconditionally breaks migration on newer builds.
          await ctx.sessions.refresh();
          if (wasCurrent) ctx.sessions.open(sessionId);
          // The migrate rewrite happens in-process on the live session, so
          // we just need a delayed baseline to let the api-gateway's projection
          // settle before re-activating the in-memory session.
          setTimeout(() => {
            void ctx.sessions.refresh().then(() => {
              if (wasCurrent) ctx.sessions.open(sessionId);
            }).catch(() => {});
          }, 250);
        },
        onOpenPanel: () => panelStore.toggle()
      });
      ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
        name: "conversation.session.header.actions",
        id: "session-manager-header",
        order: 40,
        locale: NS,
        inject: () => actions()
      }, HeaderAction));
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name: "sidebar.footer.action",
        id: "session-manager-footer",
        order: 30,
        locale: NS,
        inject: () => actions()
      }, FooterAction));
    }

    const inject = ["slots", "sessions", "workspaces", "locale", "uiWorkspace"];

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});