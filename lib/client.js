/**
 * @dsh-external/dsh-session-manager — Client half.
 *
 * Adds two UI surfaces to the web app:
 *
 *  1. conversation.session.header.actions — a per-session menu on the open
 *     conversation's header: 归档 / 移出归档 / 删除（二次确认）/ 打开会话管理。
 *  2. sidebar.footer.action — a "会话管理" footer button that opens the full
 *     management panel (all sessions, archived filter, per-row open / archive /
 *     unarchive / delete with confirmation).
 *
 * Archive uses the built-in `workspaces.archiveSession` wire API; unarchive and
 * delete go through this plugin's own host HTTP endpoints
 * (/session-manager/api/unarchive, /session-manager/api/delete).
 *
 * Written as the loader's factory-form bundle by hand (no build step), using
 * React.createElement instead of JSX so the file ships as-is.
 */
window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-session-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const {
      useState,
      useEffect,
      useMemo,
      useRef,
      useSyncExternalStore
    } = React;
    const P = require("@deepseek-ai/dsh-client-ui-primitives");

    const NS = "session-manager";
    const API = "/session-manager/api";

    // ---------------------------------------------------------------------
    // Styles (theme-token driven; matches the dsh web design language)
    // ---------------------------------------------------------------------
    const css = [
      ".sm-headerBtn{min-width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:6px;justify-content:center;align-items:center;padding:0;display:inline-flex}",
      ".sm-headerBtn:hover,.sm-headerBtn:focus-visible{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}",
      ".sm-busy{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:28px;margin-left:4px}",
      ".sm-footer{display:flex}",
      ".sm-footerBtn{min-height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:6px;padding:3px 8px;font-size:12px;line-height:18px;display:inline-flex}",
      ".sm-footerBtn:hover,.sm-footerBtn:focus-visible{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}",
      ".sm-footerBtn svg{flex:none}",
      ".sm-panel{display:flex;flex-direction:column;gap:10px;min-height:280px;max-height:min(60vh,560px)}",
      ".sm-filter{display:flex;gap:4px;flex:none}",
      ".sm-filterBtn{cursor:pointer;color:var(--dsw-alias-label-secondary);background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:3px 12px;font-size:12px;line-height:18px}",
      ".sm-filterBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".sm-filterBtn.sm-on{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-fill-l2);border-color:transparent}",
      ".sm-list{display:flex;flex-direction:column;gap:4px;min-height:0;overflow:auto;flex:1}",
      ".sm-row{box-sizing:border-box;display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}",
      ".sm-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".sm-rowCurrent{border-color:var(--dsw-alias-accent-primary,var(--dsw-alias-label-secondary))}",
      ".sm-rowMain{min-width:0;display:flex;flex-direction:column;gap:2px;flex:1}",
      ".sm-rowTitle{color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;display:flex;align-items:center;gap:6px;min-width:0}",
      ".sm-rowTitle>span:first-child{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}",
      ".sm-rowMeta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}",
      ".sm-rowActions{display:flex;gap:4px;flex:none}",
      ".sm-badge{flex:none;border-radius:999px;padding:0 6px;font-size:10px;line-height:16px}",
      ".sm-badgeArchived{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-fill-l2)}",
      ".sm-badgeRunning{color:var(--dsw-alias-state-warning-primary,#d97706);background:rgba(217,119,6,.12)}",
      ".sm-badgeCurrent{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-fill-l2)}",
      ".sm-danger{color:var(--dsw-alias-state-error-primary) !important;border-color:var(--dsw-alias-state-error-primary) !important}",
      ".sm-dangerText{color:var(--dsw-alias-state-error-primary) !important}",
      ".sm-warn{display:flex;align-items:flex-start;gap:8px;color:var(--dsw-alias-label-secondary);background:rgba(217,119,6,.1);border:1px solid rgba(217,119,6,.35);border-radius:8px;padding:8px 10px;font-size:12px;line-height:18px}",
      ".sm-warn svg{flex:none;margin-top:1px}",
      ".sm-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;min-height:18px}",
      ".sm-foot{display:flex;justify-content:flex-end;align-items:center;gap:8px;width:100%}",
      ".sm-footError{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin-right:auto}",
      ".sm-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;text-align:center;padding:24px 0}"
    ].join("");

    const CSS_ID = "@dsh-external/dsh-session-manager/session-manager";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_ID) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "@dsh-external/dsh-session-manager";
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    // ---------------------------------------------------------------------
    // Locales
    // ---------------------------------------------------------------------
    const zh = {
      "header.aria": "会话操作",
      "menu.archive": "归档会话",
      "menu.unarchive": "移出归档",
      "menu.delete": "删除会话…",
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
      "row.open": "打开",
      "row.archive": "归档",
      "row.unarchive": "移出归档",
      "row.delete": "删除",
      "confirm.delete.title": "删除会话",
      "confirm.delete.desc": "会话「{title}」将被永久删除，包括其全部消息记录与磁盘文件，此操作不可撤销。",
      "confirm.delete.running": "该会话正在运行，删除将立即中断它。",
      "confirm.delete.confirm": "确认删除",
      "confirm.cancel": "取消",
      "busy.processing": "处理中…",
      "error.operation": "操作失败：{message}"
    };
    const en = {
      "header.aria": "Session actions",
      "menu.archive": "Archive session",
      "menu.unarchive": "Unarchive session",
      "menu.delete": "Delete session…",
      "menu.manage": "Open session manager…",
      "footer.aria": "Session manager",
      "footer.label": "Sessions",
      "panel.title": "Session manager",
      "panel.filter.all": "All",
      "panel.filter.active": "Active",
      "panel.filter.archived": "Archived",
      "panel.empty": "No sessions",
      "panel.empty.archived": "Archive is empty",
      "panel.archived": "Archived",
      "panel.running": "Running",
      "panel.current": "Current",
      "row.open": "Open",
      "row.archive": "Archive",
      "row.unarchive": "Unarchive",
      "row.delete": "Delete",
      "confirm.delete.title": "Delete session",
      "confirm.delete.desc": "Session \"{title}\" will be permanently deleted, including all its messages and files on disk. This cannot be undone.",
      "confirm.delete.running": "This session is running; deleting will interrupt it immediately.",
      "confirm.delete.confirm": "Delete",
      "confirm.cancel": "Cancel",
      "busy.processing": "Working…",
      "error.operation": "Operation failed: {message}"
    };

    // ---------------------------------------------------------------------
    // Shared panel-open store (footer owns the modal; header opens it)
    // ---------------------------------------------------------------------
    const panelStore = {
      open: false,
      listeners: new Set(),
      getSnapshot: () => panelStore.open,
      subscribe: (fn) => {
        panelStore.listeners.add(fn);
        return () => panelStore.listeners.delete(fn);
      },
      set: (open) => {
        if (panelStore.open === open) return;
        panelStore.open = open;
        for (const fn of [...panelStore.listeners]) fn();
      }
    };

    // ---------------------------------------------------------------------
    // Host API
    // ---------------------------------------------------------------------
    async function callApi(path, payload) {
      const response = await fetch(API + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload || {})
      });
      let data;
      try {
        data = await response.json();
      } catch {
        data = { ok: false, error: "HTTP " + response.status };
      }
      return data;
    }

    // ---------------------------------------------------------------------
    // Small helpers
    // ---------------------------------------------------------------------
    const h = (type, props, ...children) => React.createElement(type, props, ...children);

    function formatRelative(ts, now) {
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
    }

    function shortPath(cwd) {
      if (!cwd) return "";
      const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
      const last = parts[parts.length - 1] || "";
      return last.length > 26 ? last.slice(0, 24) + "…" : last;
    }

    // ---------------------------------------------------------------------
    // Confirm dialog (delete needs explicit confirmation)
    // ---------------------------------------------------------------------
    function ConfirmDialog({ open, title, description, warning, confirmLabel, cancelLabel, busy, error, onCancel, onConfirm }) {
      return h(P.Modal, {
        open,
        onClose: () => {
          if (!busy) onCancel();
        },
        title,
        description,
        closeLabel: cancelLabel,
        children: h("div", { className: "sm-panel" },
          warning ? h("div", { className: "sm-warn" },
            h(P.IconWarningOutline16, {}),
            h("span", null, warning)
          ) : null
        ),
        footer: h("div", { className: "sm-foot" },
          h("span", { className: "sm-footError", role: "alert" }, error || null),
          h(P.Button, { variant: "ghost", onClick: onCancel, disabled: busy }, cancelLabel),
          h(P.Button, { variant: "primary", className: "sm-danger", onClick: onConfirm, disabled: busy }, confirmLabel)
        )
      });
    }

    // ---------------------------------------------------------------------
    // Header actions (per open session): direct delete + archive menu
    // ---------------------------------------------------------------------
    function HeaderAction({ sessionId, useSessions, useWorkspaces, t, onArchive, onUnarchive, onRemove, onOpenPanel }) {
      const archivedIds = useWorkspaces((s) => s.archivedSessionIds);
      const summary = useSessions((s) => s.byId[sessionId]);
      const archived = useMemo(() => new Set(archivedIds), [archivedIds]);
      const isArchived = archived.has(sessionId);
      const [menuOpen, setMenuOpen] = useState(false);
      const [confirmOpen, setConfirmOpen] = useState(false);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);

      const run = async (fn) => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
          await fn();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      };

      const items = [
        {
          id: isArchived ? "unarchive" : "archive",
          label: t(isArchived ? "menu.unarchive" : "menu.archive"),
          icon: h(P.IconArchiveOutline20, { size: 16 })
        },
        { type: "separator", id: "sep1" },
        {
          id: "manage",
          label: t("menu.manage"),
          icon: h(P.IconListPenOutline16, {})
        }
      ];

      return h("div", { className: "sm-header" },
        h("button", {
          type: "button",
          className: "sm-headerBtn",
          "aria-label": t("menu.delete"),
          title: t("menu.delete"),
          onClick: (e) => {
            e.stopPropagation();
            setConfirmOpen(true);
          }
        }, h(P.IconTrashOutline16, {})),
        h(P.Menu, {
          open: menuOpen,
          onClose: () => setMenuOpen(false),
          items,
          portal: true,
          closeOnPointerLeave: true,
          onSelect: (id) => {
            setMenuOpen(false);
            if (id === "archive") run(() => onArchive(sessionId));
            else if (id === "unarchive") run(() => onUnarchive(sessionId));
            else if (id === "manage") onOpenPanel();
          },
          anchor: h("button", {
            type: "button",
            className: "sm-headerBtn",
            "aria-label": t(isArchived ? "menu.unarchive" : "menu.archive"),
            title: t(isArchived ? "menu.unarchive" : "menu.archive"),
            onClick: (e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }
          }, h(P.IconArchiveOutline20, { size: 16 }))
        }),
        busy ? h("span", { className: "sm-busy" }, t("busy.processing")) : null,
        h(ConfirmDialog, {
          open: confirmOpen,
          title: t("confirm.delete.title"),
          description: t("confirm.delete.desc", { title: summary?.displayTitle ?? sessionId }),
          warning: summary?.running ? t("confirm.delete.running") : null,
          confirmLabel: t("confirm.delete.confirm"),
          cancelLabel: t("confirm.cancel"),
          busy,
          error: error ? t("error.operation", { message: error }) : null,
          onCancel: () => setConfirmOpen(false),
          onConfirm: () => run(async () => {
            await onRemove(sessionId);
            setConfirmOpen(false);
          })
        })
      );
    }

    // ---------------------------------------------------------------------
    // Session manager panel (full management surface)
    // ---------------------------------------------------------------------
    function SessionManagerPanel({ open, onClose, useSessions, useWorkspaces, t, onOpen, onArchive, onUnarchive, onRemove }) {
      const list = useSessions((s) => s);
      const archivedIds = useWorkspaces((s) => s.archivedSessionIds);
      const [filter, setFilter] = useState("all");
      const [confirm, setConfirm] = useState(null);
      const [busyId, setBusyId] = useState(null);
      const [error, setError] = useState(null);
      const [now, setNow] = useState(() => Date.now());

      useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30000);
        return () => clearInterval(timer);
      }, []);

      const archived = useMemo(() => new Set(archivedIds), [archivedIds]);

      const rows = useMemo(() => {
        const all = list.ids
          .map((id) => list.byId[id])
          .filter((s) => s !== void 0 && s.origin !== "subagent");
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

      return h(P.Modal, {
        open,
        onClose,
        title: t("panel.title"),
        closeLabel: t("confirm.cancel"),
        contentClassName: "sm-panel",
        children: [
          h("div", { className: "sm-filter", key: "filter" },
            filterBtn("all", t("panel.filter.all")),
            filterBtn("active", t("panel.filter.active")),
            filterBtn("archived", t("panel.filter.archived"))
          ),
          error ? h("div", { className: "sm-error", role: "alert", key: "error" },
            t("error.operation", { message: error })
          ) : null,
          rows.length === 0
            ? h("div", { className: "sm-empty", key: "empty" },
                filter === "archived" ? t("panel.empty.archived") : t("panel.empty")
              )
            : h("div", { className: "sm-list", key: "list" },
                rows.map((s) => {
                  const isArchived = archived.has(s.id);
                  const isCurrent = s.id === list.current;
                  const busy = busyId === s.id;
                  return h("div", {
                    key: s.id,
                    className: "sm-row" + (isCurrent ? " sm-rowCurrent" : "")
                  },
                    h("div", { className: "sm-rowMain" },
                      h("div", { className: "sm-rowTitle" },
                        h("span", null, s.displayTitle || s.id),
                        isArchived ? h("span", { className: "sm-badge sm-badgeArchived" }, t("panel.archived")) : null,
                        s.running ? h("span", { className: "sm-badge sm-badgeRunning" }, t("panel.running")) : null,
                        isCurrent ? h("span", { className: "sm-badge sm-badgeCurrent" }, t("panel.current")) : null
                      ),
                      h("div", { className: "sm-rowMeta" },
                        shortPath(s.cwd) + (s.cwd ? " · " : "") + formatRelative(s.updatedAt, now)
                      )
                    ),
                    h("div", { className: "sm-rowActions" },
                      h(P.Button, { variant: "ghost", size: "sm", disabled: busy, onClick: () => onOpen(s.id) }, t("row.open")),
                      h(P.Button, {
                        variant: "ghost",
                        size: "sm",
                        disabled: busy,
                        onClick: () => runRow(s.id, () => isArchived ? onUnarchive(s.id) : onArchive(s.id))
                      }, t(isArchived ? "row.unarchive" : "row.archive")),
                      h(P.Button, {
                        variant: "ghost",
                        size: "sm",
                        className: "sm-dangerText",
                        disabled: busy,
                        onClick: () => setConfirm(s)
                      }, t("row.delete"))
                    )
                  );
                })
              )
        ],
        footer: h(ConfirmDialog, {
          open: confirm !== null,
          title: t("confirm.delete.title"),
          description: t("confirm.delete.desc", { title: confirm?.displayTitle ?? confirm?.id ?? "" }),
          warning: confirm?.running ? t("confirm.delete.running") : null,
          confirmLabel: t("confirm.delete.confirm"),
          cancelLabel: t("confirm.cancel"),
          busy: busyId !== null,
          error: null,
          onCancel: () => setConfirm(null),
          onConfirm: () => runRow(confirm.id, async () => {
            await onRemove(confirm.id);
            setConfirm(null);
          })
        })
      });
    }

    // ---------------------------------------------------------------------
    // Footer action (owns the management panel modal)
    // ---------------------------------------------------------------------
    function FooterAction({ wide, useSessions, useWorkspaces, t, onOpen, onArchive, onUnarchive, onRemove, onOpenPanel }) {
      const open = useSyncExternalStore(panelStore.subscribe, panelStore.getSnapshot);
      return h("div", { className: "sm-footer" },
        h("button", {
          type: "button",
          className: "sm-footerBtn",
          "aria-label": t("footer.aria"),
          onClick: () => onOpenPanel()
        },
          h(P.IconArchiveOutline20, { size: 14 }),
          wide ? h("span", null, t("footer.label")) : null
        ),
        h(SessionManagerPanel, {
          open,
          onClose: () => panelStore.set(false),
          useSessions,
          useWorkspaces,
          t,
          onOpen,
          onArchive,
          onUnarchive,
          onRemove
        })
      );
    }

    // ---------------------------------------------------------------------
    // Plugin entry
    // ---------------------------------------------------------------------
    const inject = ["slots", "sessions", "workspaces", "locale"];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-manager: dictionaries");

      // NOTE: the slot renderer SPREADS the inject factory's return value into
      // the component's props as flat members (see renderEntry: ...injected).
      // So these are delivered as onOpen/onArchive/... props, not under an
      // `actions` namespace.
      const actions = () => ({
        onOpen: (sessionId) => {
          ctx.sessions.open(sessionId);
        },
        onArchive: async (sessionId) => {
          await ctx.workspaces.archiveSession(sessionId);
        },
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
        onOpenPanel: () => {
          panelStore.set(true);
        }
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

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
