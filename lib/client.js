/**
 * @dsh-session-manager — Client half.
 * v0.3.0 — replaces 0.2.1 client.js which had V8 strict-mode parse errors.
 * Functionally equivalent: header actions (open/archive/move/delete/manage),
 * footer action (open session manager panel), and the panel itself with
 * delete/move confirm dialogs. The "preset migration" feature is registered
 * as a separate slot in a sibling client bundle.
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
      ".sm-headerDanger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
      ".sm-headerDanger:hover:not(:disabled){background:rgba(217,78,68,.1)}",
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
      ".sm-moveItemMeta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.sm-panelModal{width:760px;max-width:92vw}.sm-panelModal .sm-rowActions{flex-wrap:wrap;justify-content:flex-end}.sm-headerMenu{position:absolute;right:0;top:100%;z-index:50;display:flex;flex-direction:column;min-width:160px;padding:4px;background:var(--dsw-alias-surface-l1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12)}.sm-headerMenuItem{display:flex;align-items:center;width:100%;text-align:left;background:0 0;border:0;border-radius:6px;color:var(--dsw-alias-label-primary);cursor:pointer;padding:6px 10px;font-size:13px;line-height:18px}.sm-headerMenuItem:hover{background:var(--dsw-alias-interactive-bg-hover)}.sm-headerMenuItemDanger{color:var(--dsw-alias-state-error-primary)}.sm-headerBtn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;height:auto;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-fill-l2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;cursor:pointer;padding:4px 12px;font-size:13px;line-height:18px;white-space:nowrap;transition:background .15s,color .15s,border-color .15s}.sm-headerBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}.sm-headerBtn:focus-visible{outline:2px solid var(--dsw-alias-accent-primary);outline-offset:1px}.sm-headerBtn svg{width:16px;height:16px}.sm-migratePanel{display:flex;flex-direction:column;gap:14px;min-width:480px}.sm-migrateRow{display:flex;flex-direction:column;gap:8px}.sm-migrateRow>label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px;font-weight:500}.sm-migrateChips{display:flex;flex-wrap:wrap;gap:6px}.sm-migrateChip{padding:6px 12px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;cursor:pointer;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);white-space:nowrap}.sm-migrateChip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.sm-migrateChip:disabled{opacity:.5;cursor:not-allowed}.sm-migrateChipOn{background:var(--dsw-alias-accent-primary);color:#fff;border-color:var(--dsw-alias-accent-primary)}.sm-migrateEmpty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.sm-migratePreview{padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px}.sm-migrateWarn{padding:10px 12px;border:1px solid rgba(217,119,6,.25);border-radius:8px;background:rgba(217,119,6,.08);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:18px}.sm-migrateList{max-height:200px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}.sm-headerBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}.sm-headerBtnDanger{background:var(--dsw-alias-state-error-tertiary);color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);font-weight:500}.sm-headerBtnDanger:hover{background:var(--dsw-alias-state-error-secondary);color:#fff;border-color:var(--dsw-alias-state-error-primary)}.sm-header{display:inline-flex;align-items:center;gap:6px}.sm-headerBtnActive{background:var(--dsw-alias-fill-l3);color:var(--dsw-alias-label-primary)}",
      ".sm-panelDialog{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:560px;max-width:calc(100vw - 32px);max-height:540px;height:auto;box-sizing:border-box;display:flex;flex-direction:column;gap:0;background:var(--dsw-alias-surface-l1,#fff);color:var(--dsw-alias-label-primary,#111);border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.25);overflow:hidden;z-index:9999;opacity:1}.sm-panelDialog .sm-nativeDialogHeader{padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,#eee);flex:none}.sm-panelDialog .sm-nativeDialogTitle{margin:0;font-size:14px;line-height:20px;font-weight:600}.sm-panelDialog .sm-nativeDialogFooter{padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l2,#eee);flex:none;flex-wrap:wrap;justify-content:flex-end;gap:6px;margin-top:0}.sm-panelDialog .sm-panel{display:flex;flex-direction:column;gap:6px;min-height:0;flex:1 1 auto;overflow:auto;padding:8px 12px}.sm-panelDialog .sm-list{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-height:0;overflow:auto}.sm-panelDialog .sm-row{display:flex;align-items:center;gap:8px;padding:0 10px;height:36px;min-height:36px;border:1px solid transparent;border-radius:8px;background:transparent}.sm-panelDialog .sm-row:hover{background:var(--dsw-alias-interactive-bg-hover)}.sm-panelDialog .sm-rowCurrent{background:var(--dsw-alias-fill-l2);border-color:var(--dsw-alias-accent-primary,#356ae6)}.sm-panelDialog .sm-rowMain{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 auto;overflow:hidden}.sm-panelDialog .sm-rowTitle{min-width:0;flex:1 1 auto;display:flex;align-items:center;gap:6px;font-size:12px;line-height:16px;overflow:hidden}.sm-confirmDialog{z-index:10000}.sm-confirmDialog.sm-nativeDialogLayer{position:fixed;left:calc(50vw + 184px);top:calc(50vh - 90px);width:300px;max-width:calc(100vw - 32px);max-height:none;display:block;align-items:initial;justify-content:initial;box-sizing:border-box;background:transparent;border:0;box-shadow:none;padding:0;inset:calc(50vh - 90px) auto auto calc(50vw + 308px)}.sm-confirmDialog.sm-nativeDialogLayer .sm-nativeDialogBackdrop{display:none}.sm-confirmDialog.sm-nativeDialogLayer .sm-nativeDialog{position:relative;left:auto;top:auto;transform:none;width:auto;box-sizing:border-box;background:var(--dsw-alias-surface-l1,#fff);color:var(--dsw-alias-label-primary,#111);border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.25);padding:0;overflow:hidden;animation:sm-confirmPop .14s ease-out}.sm-confirmDialog .sm-nativeDialogHeader{padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,#eee)}.sm-confirmDialog .sm-nativeDialogTitle{margin:0;font-size:14px;line-height:20px;font-weight:600}.sm-confirmDialog .sm-nativeDialogBody{padding:10px 16px;display:flex;flex-direction:column;gap:8px;min-height:0}.sm-confirmDialog .sm-nativeDialogDescription{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}.sm-confirmDialog .sm-warn{padding:6px 10px;font-size:12px;line-height:16px;margin-top:0}.sm-confirmDialog .sm-nativeDialogFooter{padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l2,#eee);flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:0}.sm-confirmDialog .sm-nativeDialogButton{min-height:28px;padding:3px 14px;font-size:12px;line-height:20px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;cursor:pointer;background:transparent;color:var(--dsw-alias-label-primary)}.sm-confirmDialog .sm-nativeDialogCancel:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.sm-confirmDialog .sm-nativeDialogConfirm{background:var(--dsw-alias-state-error-primary);color:#fff;border-color:var(--dsw-alias-state-error-primary)}.sm-confirmDialog .sm-nativeDialogConfirm:hover:not(:disabled){filter:brightness(.94)}@keyframes sm-confirmPop{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}.sm-confirmDialog.sm-nativeDialog{padding:0;width:auto;max-width:none}.sm-panelDialog .sm-rowTitle>span:first-child{text-overflow:ellipsis;white-space:nowrap;overflow:hidden;flex:1 1 auto}.sm-panelDialog .sm-rowMeta{display:none}.sm-panelDialog .sm-rowActions{display:flex;gap:2px;flex:none;justify-content:flex-end}.sm-panelDialog .sm-rowActions .sm-rowBtn{min-height:22px;height:22px;padding:0 8px;font-size:11px;line-height:14px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}.sm-panelDialog .sm-rowActions .sm-rowBtn:hover{background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary)}.sm-panelDialog .sm-rowActions .sm-rowBtnDanger{color:var(--dsw-alias-state-error-primary)}.sm-panelDialog .sm-filter{flex:none;padding:6px 12px 4px;gap:4px;display:flex;flex-wrap:wrap}.sm-panelDialog .sm-filterBtn{min-height:24px;padding:2px 10px;font-size:11px;line-height:16px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}.sm-panelDialog .sm-filterBtn.sm-on{background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary)}.sm-panelDialog .sm-badge{font-size:10px;line-height:14px;padding:0 5px;border-radius:6px;flex:none}.sm-panelDialog .sm-error{padding:6px 10px;margin:0;font-size:12px;line-height:16px}.sm-panelDialog .sm-nativeDialogButton{min-height:28px;padding:3px 12px;font-size:12px;line-height:18px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}.sm-panelDialog .sm-nativeDialogCancel{background:transparent}.sm-panelDialog .sm-nativeDialogGhost{background:transparent;border-color:var(--dsw-alias-border-l2)}.sm-panelDialog .sm-nativeDialogConfirm{background:var(--dsw-alias-accent-primary,#356ae6);color:#fff;border-color:var(--dsw-alias-accent-primary,#356ae6)}.sm-panelDialog .sm-empty{padding:18px 0;font-size:12px;color:var(--dsw-alias-label-tertiary);text-align:center}.sm-panelDialog .sm-footError{font-size:11px;color:var(--dsw-alias-state-error-primary);margin-right:auto;line-height:20px}.sm-panelDialog .sm-moveLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}.sm-migrateDialog .sm-nativeDialogFooter{flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:14px}.sm-migrateDialog .sm-migrateChip{cursor:pointer;pointer-events:auto;position:relative;z-index:1}.sm-migrateDialog .sm-migrateChip[disabled]{opacity:.5;cursor:not-allowed}.sm-migrateDialog.sm-nativeDialogLayer{position:fixed;left:50vw;top:auto;bottom:48px;transform:translateX(-50%);width:min(560px,calc(100vw - 32px));max-height:none;display:block;align-items:initial;justify-content:initial;box-sizing:border-box;background:transparent;border:0;box-shadow:none;padding:0;inset:auto;z-index:10001}.sm-migrateDialog.sm-nativeDialogLayer .sm-nativeDialogBackdrop{display:none}.sm-migrateDialog.sm-nativeDialogLayer .sm-nativeDialog{position:relative;left:auto;top:auto;transform:none;width:auto;max-height:min(70vh,520px);box-sizing:border-box;background-color:#ffffff;background-color:var(--dsw-alias-surface-l1,#fff);color:var(--dsw-alias-label-primary,#111);border:1px solid #d4d4d8;border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.45);overflow:hidden;padding:0;display:flex;flex-direction:column;gap:0;opacity:1}.sm-migrateDialog{position:fixed;left:50vw;top:auto;bottom:48px;transform:translateX(-50%);width:min(560px,calc(100vw - 32px));max-height:min(70vh,520px);box-sizing:border-box;display:flex;flex-direction:column;gap:0;background-color:#ffffff;background-color:var(--dsw-alias-surface-l1,#fff);color:var(--dsw-alias-label-primary,#111);border:1px solid #d4d4d8;border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.45);overflow:hidden;opacity:1;z-index:10001;backdrop-filter:none;-webkit-backdrop-filter:none}.sm-migrateDialog .sm-nativeDialogHeader{padding:12px 18px;border-bottom:1px solid #eee;border-bottom:1px solid var(--dsw-alias-border-l2,#eee);flex:none;background-color:#fff;background-color:var(--dsw-alias-surface-l1,#fff)}.sm-migrateDialog .sm-nativeDialogTitle{margin:0;font-size:15px;line-height:22px;font-weight:600;color:#111;color:var(--dsw-alias-label-primary,#111)}.sm-migrateDialog .sm-migratePanel{padding:12px 18px;display:flex;flex-direction:column;gap:14px;background-color:#fff;background-color:var(--dsw-alias-surface-l1,#fff)}.sm-migrateDialog .sm-nativeDialogBody{padding:0;background-color:#fff;background-color:var(--dsw-alias-surface-l1,#fff)}.sm-migrateDialog .sm-nativeDialogFooter{padding:12px 18px;border-top:1px solid #eee;border-top:1px solid var(--dsw-alias-border-l2,#eee);flex:none;flex-wrap:wrap;justify-content:flex-end;gap:8px;background-color:#fff;background-color:var(--dsw-alias-surface-l1,#fff)}.sm-migrateDialog .sm-migrateRow>label{color:#444;color:var(--dsw-alias-label-secondary,#444)}.sm-migrateDialog .sm-migrateChip{padding:6px 12px;border-radius:999px;border:1px solid #d4d4d8;border:1px solid var(--dsw-alias-border-l2,#ddd);background-color:#f5f5f5;background-color:var(--dsw-alias-fill-l2,#f5f5f5);color:#111;color:var(--dsw-alias-label-primary,#111);font-size:13px;line-height:18px;cursor:pointer;pointer-events:auto;position:relative;z-index:1;white-space:nowrap}.sm-migrateDialog .sm-migrateChip:hover:not(:disabled){background-color:#e8e8e8;background-color:var(--dsw-alias-interactive-bg-hover,#e8e8e8)}.sm-migrateDialog .sm-migrateChipOn{background-color:#356ae6;background-color:var(--dsw-alias-accent-primary,#356ae6);color:#fff;border-color:#356ae6;border-color:var(--dsw-alias-accent-primary,#356ae6)}.sm-migrateDialog .sm-migrateChip.sm-migrateChipOn:hover:not(:disabled){background-color:#4576f0;background-color:var(--dsw-alias-accent-primary-hover,#4576f0);color:#fff;border-color:#4576f0;border-color:var(--dsw-alias-accent-primary-hover,#4576f0);filter:none}.sm-migrateDialog .sm-migrateChipOn:hover:not(:disabled){filter:brightness(.92)}.sm-migrateDialog .sm-migrateChip[disabled]{opacity:.5;cursor:not-allowed}.sm-migrateDialog .sm-migrateEmpty{color:#888;color:var(--dsw-alias-label-tertiary,#888)}.sm-migrateDialog .sm-migratePreview{padding:10px 12px;border:1px solid #d4d4d8;border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:8px;background-color:#f5f5f5;background-color:var(--dsw-alias-fill-l2,#f5f5f5);color:#111;color:var(--dsw-alias-label-primary,#111);font-size:13px;line-height:18px}.sm-migrateDialog .sm-migrateWarn{padding:10px 12px;border:1px solid rgba(217,119,6,.25);border-radius:8px;background-color:rgba(217,119,6,.08);color:#444;color:var(--dsw-alias-label-secondary,#444);font-size:13px;line-height:18px}.sm-migrateDialog .sm-nativeDialogButton{min-height:32px;padding:4px 14px;font-size:13px;line-height:20px;border:1px solid #d4d4d8;border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:8px;cursor:pointer;background-color:#fff;background-color:var(--dsw-alias-fill-l2,#fff);color:#111;color:var(--dsw-alias-label-primary,#111)}.sm-migrateDialog .sm-nativeDialogButton:hover:not(:disabled){background-color:#e8e8e8;background-color:var(--dsw-alias-interactive-bg-hover,#e8e8e8)}.sm-migrateDialog .sm-nativeDialogConfirm{background-color:#356ae6;background-color:var(--dsw-alias-accent-primary,#356ae6);color:#fff;border-color:#356ae6;border-color:var(--dsw-alias-accent-primary,#356ae6)}.sm-migrateDialog .sm-nativeDialogConfirm:hover:not(:disabled){filter:brightness(.94)}",
      ".sm-panelDialog .sm-nativeDialogHeader{display:flex;align-items:center;gap:8px}.sm-panelHeaderClose{min-height:26px;padding:2px 9px;border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#555);cursor:pointer;font-size:12px;line-height:18px}.sm-panelHeaderClose:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#eee);color:var(--dsw-alias-label-primary,#111)}.sm-panelHeaderClose:disabled{opacity:.5;cursor:not-allowed}.sm-migrateCurrent{padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:8px;background:var(--dsw-alias-fill-l2,#f5f5f5);font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary,#111)}.sm-migrateConfirmLayer.sm-confirmDialog.sm-nativeDialogLayer{width:300px;inset:calc(50vh - 90px) auto auto calc(50vw + 308px)}.sm-migrateConfirmLayer.sm-confirmDialog.sm-nativeDialogLayer .sm-migrateDialog{position:relative;left:auto;top:auto;bottom:auto;transform:none;width:100%;max-width:none;max-height:min(70vh,520px);z-index:auto}.sm-migrateConfirmLayer .sm-migratePanel{min-width:0}.sm-migrateConfirmLayer .sm-nativeDialogButton.sm-nativeDialogConfirm:hover:not(:disabled){background-color:#4576f0;background-color:var(--dsw-alias-accent-primary-hover,#4576f0);color:#fff;border-color:#4576f0;border-color:var(--dsw-alias-accent-primary-hover,#4576f0);filter:none}",
    ].join("");

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
    const fetchApi = (path) => fetch(API + path).then((r) => r.json());
    const formatRelative = (ts, now) => {
      const diff = Math.max(0, now - ts);
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
      const R = (typeof window !== "undefined") ? window.__smReact : null;
      const createPortal = (R && typeof R.createPortal === "function") ? R.createPortal : null;
      const body = (typeof document === "undefined") ? null : document.body;
      if (!open) return null;
      if (!body) return tree || null;
      const tree = h("div", {
        className: "sm-nativeDialogLayer sm-confirmDialog",
        style: props.anchor && typeof props.anchor.top === "number"
          ? { position: "fixed", top: props.anchor.top + "px", left: props.anchor.left + "px", zIndex: 10001 }
          : null,
        role: "presentation",
        onKeyDown: (e) => {
          if (e.key === "Escape" && !busy) { e.preventDefault(); onCancel(); }
          else if (e.key === "Enter" && !busy) { e.preventDefault(); onConfirm(); }
        },
        tabIndex: -1
      },
        h("div", {
          className: "sm-nativeDialogBackdrop",
          onMouseDown: (e) => { if (e.target === e.currentTarget && !busy) onCancel(); }
        }),
        h("section", {
          className: "sm-nativeDialog",
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": "sm-confirm-dialog-title",
          ref: (el) => { if (el && typeof el.focus === "function") el.focus(); }
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
      if (createPortal) return createPortal(tree, body);
      // Default: render inline. position:fixed escapes the sidebar
      // overflow:hidden ancestor at the DOM/CSS level, so the dialog
      // appears next to the panel. Keeping the dialog in the same
      // React tree as the panel preserves the onClick wiring (cancel /
      // confirm call setConfirmFor, which only works when the click
      // handler lives in the same root).
      return tree;
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
        if (e.key === "Escape" && !busy) {
          e.preventDefault();
          onCancel();
        } else if (e.key === "Enter" && !busy && selectedWorkspaceId && list.length > 0) {
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
        onKeyDown,
        tabIndex: -1
      },
        h("div", {
          className: "sm-nativeDialogBackdrop",
          onMouseDown: (e) => { if (e.target === e.currentTarget && !busy) onCancel(); }
        }),
        h("section", {
          className: "sm-nativeDialog",
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": "sm-move-dialog-title",
          ref: (el) => { if (el && typeof el.focus === "function") el.focus(); }
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
        setScan(null);
        setTarget("");
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
        role: "presentation",
        onKeyDown: (event) => { if (event.key === "Escape" && !busy) { event.preventDefault(); onCancel(); } }
      },
        h("div", {
          className: "sm-nativeDialogBackdrop",
          onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) onCancel(); }
        }),
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
      const list = useSessions((s) => s);
      const archivedIds = useWorkspaces((s) => s.archivedSessionIds);
      const [filter, setFilter] = useState("all");
      const [busyId, setBusyId] = useState(null);
      const [error, setError] = useState(null);
      const [now, setNow] = useState(() => Date.now());
      const [moveFor, setMoveFor] = useState(null);
      const [confirmFor, setConfirmFor] = useState(null);
      const [workspaces, setWorkspaces] = useState([]);
      const [migrating, setMigrating] = useState(false);
      const [migrateFor, setMigrateFor] = useState(null);
      useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30000);
        return () => clearInterval(timer);
      }, []);
      useEffect(() => {
        if (!open) return;
        let alive = true;
        fetchApi("/workspaces").then((data) => {
          if (alive && data.ok) setWorkspaces(data.result.workspaces || []);
        });
        return () => { alive = false; };
      }, [open]);
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
      useEffect(() => {
        if (moveFor) {
          fetchApi("/workspaces").then((data) => {
            if (data.ok) setWorkspaces(data.result.workspaces || []);
          });
        }
      }, [moveFor]);
      const archived = useMemo(() => new Set(archivedIds), [archivedIds]);
      const rows = useMemo(() => {
        const all = list.ids
          .map((id) => list.byId[id])
          .filter((s) => s !== undefined && s.origin !== "subagent" && (!s.blank || s.id === list.current));
        if (filter === "active") return all.filter((s) => !archived.has(s.id));
        if (filter === "archived") return all.filter((s) => archived.has(s.id));
        return all;
      }, [list, archived, filter]);
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
        onClick: () => setFilter(id)
      }, label);
      const renderRow = (s) => {
        const isArchived = archived.has(s.id);
        const isCurrent = s.id === list.current;
        const busy = busyId === s.id;
        return h("div", {
          key: s.id,
          className: "sm-row" + (isCurrent ? " sm-rowCurrent" : "")
        },
          h("div", { className: "sm-rowMain" },
            h("div", { className: "sm-rowTitle" },
              h("span", null, s.blank ? t("panel.session.new") : (s.displayTitle || s.id)),
              isArchived ? h("span", { className: "sm-badge sm-badgeArchived" }, t("panel.archived")) : null,
              s.running ? h("span", { className: "sm-badge sm-badgeRunning" }, t("panel.running")) : null,
              isCurrent ? h("span", { className: "sm-badge sm-badgeCurrent" }, t("panel.current")) : null
            ),
            h("div", { className: "sm-rowMeta" }, shortPath(s.cwd) + (s.cwd ? " · " : "") + formatRelative(s.updatedAt, now))
          ),
          h("div", { className: "sm-rowActions" },
            h("button", { type: "button", className: "sm-rowBtn", disabled: busy, onClick: () => onOpen(s.id) }, t("row.open")),
            h("button", { type: "button", className: "sm-rowBtn", disabled: busy, onClick: () => runRow(s.id, () => isArchived ? onUnarchive(s.id) : onArchive(s.id)) }, t(isArchived ? "row.unarchive" : "row.archive")),
            h("button", { type: "button", className: "sm-rowBtn", disabled: busy, onClick: () => setMoveFor(s) }, t("row.move")),
            h("button", { type: "button", className: "sm-rowBtn", disabled: busy, onClick: () => setMigrateFor(s) }, t("row.migrate")),
            h("button", { type: "button", className: "sm-rowBtn sm-rowBtnDanger", disabled: busy, onClick: () => setConfirmFor(s) }, t("row.delete"))
          )
        );
      };
      const rowsList = rows.length === 0
        ? h("div", { className: "sm-empty" }, filter === "archived" ? t("panel.empty.archived") : t("panel.empty"))
        : h("div", { className: "sm-list" }, rows.map(renderRow));
      const onPanelClose = () => {
        if (busyId !== null) return;
        setConfirmFor(null);
        setMoveFor(null);
        setMigrateFor(null);
        onClose();
      };
      // Single cancel button in the panel footer (no native "x").
      const onPanelKey = (e) => {
        if (e.key === "Escape" && busyId === null) {
          if (confirmFor || moveFor || migrateFor) return;
          e.preventDefault();
          onPanelClose();
        }
      };
      const panelModal = h("div", {
        className: "sm-nativeDialogLayer",
        role: "presentation",
        onKeyDown: onPanelKey,
        tabIndex: -1
      },
        h("div", {
          className: "sm-nativeDialogBackdrop",
          onMouseDown: (e) => { if (e.target === e.currentTarget && busyId === null) onPanelClose(); }
        }),
        h("section", {
          className: "sm-nativeDialog sm-panelDialog",
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": "sm-panel-dialog-title",
          ref: (el) => { if (el && typeof el.focus === "function") el.focus(); }
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
            h("div", { className: "sm-filter" },
              filterBtn("all", t("panel.filter.all")),
              filterBtn("active", t("panel.filter.active")),
              filterBtn("archived", t("panel.filter.archived"))
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
          runRow(target.id, () => onMove(target.id, targetWorkspaceId));
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
      const primary = moveDialog || deleteDialog || migrateDialog;
      return h(React.Fragment, null, panelModal, primary);
    }

        function HeaderAction(props) {
      const t = props.t;
      const sessionId = props.sessionId;
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
        h("div", { className: "sm-header" },
          h("button", {
            type: "button",
            className: "sm-headerBtn" + (isArchived ? " sm-headerBtnActive" : ""),
            "aria-label": t ? t(archiveLabelKey) : (isArchived ? "移出归档" : "归档会话"),
            onClick: () => runWithAlert("archive", () =>
              isArchived ? onUnarchive(sessionId) : onArchive(sessionId)
            )
          }, isArchived ? (t ? t("row.unarchive") : "移出归档") : (t ? t("row.archive") : "归档")),
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
      getDerivedStateFromError() { return { failed: true }; }
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
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-manager: dictionaries");
      const actions = () => ({
        onOpen: (sessionId) => { ctx.sessions.open(sessionId); },
        onArchive: async (sessionId) => { await ctx.workspaces.archiveSession(sessionId); },
        onUnarchive: async (sessionId) => {
          const response = await callApi("/unarchive", { sessionId });
          if (!response.ok) throw new Error(response.error || "unarchive failed");
        },
        onRemove: async (sessionId) => {
          const response = await callApi("/delete", { sessionId });
          if (!response.ok) throw new Error(response.error || "delete failed");
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
          // /move retires a live session, so host/session-removed can arrive on
          // the streaming channel slightly after the HTTP success response.
          // Pull both projections now and once more after that frame to make the
          // destination row appear without a browser refresh.
          await refreshMovedSession();
          setTimeout(() => { void refreshMovedSession(); }, 250);
          setTimeout(() => { void refreshMovedSession(); }, 900);
        },
        onMigrate: async (sessionId, toPreset) => {
          const wasCurrent = ctx.sessions.list.getSnapshot().current === sessionId;
          const response = await callApi("/preset-migrate", { sessionId, toPreset });
          if (!response.ok) throw new Error(response.error || "preset migration failed");
          ctx.sessions.noteAgentPreset(sessionId, toPreset);
          await ctx.sessions.refresh();
          if (wasCurrent) ctx.sessions.open(sessionId);
          // Host/session-removed and the HTTP response travel on different
          // streams. One delayed baseline closes that ordering race without a
          // page refresh and keeps the migrated conversation selectable.
          setTimeout(() => {
            void ctx.sessions.refresh().then(() => {
              ctx.sessions.noteAgentPreset(sessionId, toPreset);
              if (wasCurrent) ctx.sessions.open(sessionId);
            }).catch(() => {});
          }, 250);
        },
        onOpenPanel: () => panelStore.set(true)
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

    const inject = ["slots", "sessions", "workspaces", "locale"];

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});