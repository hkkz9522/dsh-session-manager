/**
 * Session "..." menu entries (sidebar.workspaces.session.menu.item), the
 * shell.overlay host they feed, and the title-bar style preference.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mountClient, nodes, text } from "./helpers/client-harness.mjs";

const sessions = [
  { id: "s1", displayTitle: "First Session", updatedAt: 300 },
  { id: "s2", displayTitle: "Second Session", updatedAt: 200 }
];
const workspaces = [
  { id: "w1", name: "local", sessionIds: ["s1"] },
  { id: "w2", name: "uco", sessionIds: ["s2"] }
];

async function setup(t, options = {}) {
  const app = mountClient({ sessions, current: "s1", workspaces, language: "en", ...options });
  t.after(() => app.dispose());
  await app.flush();
  return app;
}

function mountEntry(app, id, extra = {}) {
  const entry = app.registered.get(id);
  assert.ok(entry, "entry registered: " + id);
  const menu = { open: true, closes: 0 };
  const props = {
    ...entry.options.inject(),
    t: app.t,
    sessionId: "s1",
    displayTitle: "First Session",
    useMenuOpenState: () => [menu.open, (next) => { menu.open = next; if (!next) menu.closes++; }],
    ...extra
  };
  const host = app.mountComponent(entry.component, props);
  const rerender = async () => { for (let i = 0; i < 10; i++) { await Promise.resolve(); if (host.dirty) host.render(); } return host.tree; };
  return { entry, host, menu, rerender };
}

const menuItems = tree => nodes(tree, n => n.type?.name === "SmMenuRow");
const label = row => text(row.props.label);
const keys = row => (row.props.shortcut?.keys || []).filter(k => typeof k === "string").join("");

test("session-menu: three entries register into the Session menu slot after Archive (400)", async (t) => {
  const app = await setup(t);
  const ids = ["session-manager.menu.review", "session-manager.menu.marks", "session-manager.menu.move"];
  assert.equal(app.registered.get("session-manager.menu.favorite"), undefined, "Favorite stays in the manager panel only");
  const orders = ids.map(id => app.registered.get(id)?.options);
  for (const options of orders) assert.equal(options.name, "sidebar.workspaces.session.menu.item");
  assert.deepEqual(orders.map(o => o.order), [420, 430, 440]);
  assert.ok(orders.every(o => o.order > 400 && o.order < 500), "between host Archive (400) and other plugins (500)");
  assert.equal(app.registered.get("session-manager.menu-overlay")?.options.name, "shell.overlay");
});

test("session-menu: single-key accelerator triggers its row while the menu is open", async (t) => {
  const app = await setup(t);
  const { rerender, menu } = mountEntry(app, "session-manager.menu.review");
  await rerender();
  let prevented = false;
  app.keydown({ key: "l", preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.ok(prevented);
  assert.equal(menu.closes, 1);
  await app.flush();
  assert.equal(app.annotations.s1.reviewLater, true);
  // Modified keys and typing into inputs are left alone.
  let ignored = true;
  app.keydown({ key: "l", metaKey: true, preventDefault() { ignored = false; }, stopPropagation() {} });
  app.keydown({ key: "l", target: { tagName: "INPUT" }, preventDefault() { ignored = false; }, stopPropagation() {} });
  assert.ok(ignored);
});

test("session-menu: tags row opens the annotation editor through the overlay host", async (t) => {
  const app = await setup(t);
  const overlay = app.registered.get("session-manager.menu-overlay");
  const overlayHost = app.mountComponent(overlay.component, { ...overlay.options.inject(), t: app.t });
  assert.equal(overlayHost.tree, null);
  const { host, menu, rerender } = mountEntry(app, "session-manager.menu.marks");
  await rerender();
  const [row] = menuItems(host.tree);
  assert.equal(label(row), "Tags & notes…");
  assert.equal(keys(row), "T");
  row.props.onSelect();
  assert.equal(menu.closes, 1);
  overlayHost.render();
  assert.equal(overlayHost.tree?.type?.name, "AnnotationDialog");
  assert.equal(overlayHost.tree.props.sessionId, "s1");
  assert.equal(typeof overlayHost.tree.props.anchor.top, "number");
  overlayHost.tree.props.onClose();
  overlayHost.render();
  assert.equal(overlayHost.tree, null);
});

test("session-menu: move submenu lists workspaces, marks the current one and moves on pick", async (t) => {
  const app = await setup(t);
  const moves = [];
  const { host, menu, rerender } = mountEntry(app, "session-manager.menu.move", { onMove: async (id, ws) => { moves.push([id, ws]); } });
  await app.flush();
  await rerender();
  const wrap = host.tree;
  assert.match(wrap.props.className, /sm-menuSubWrap/);
  wrap.props.onMouseEnter();
  await rerender();
  const submenu = nodes(host.tree, n => n.props?.role === "menu")[0];
  assert.ok(submenu, "submenu rendered on hover");
  const rows = menuItems(submenu);
  assert.deepEqual(rows.map(label), ["local", "uco"]);
  assert.deepEqual(rows.map(keys), ["1", "2"]);
  // Current workspace carries the check icon and is a no-op.
  assert.equal(rows[0].props.icon?.type?.name, "CheckMenuIcon");
  assert.notEqual(rows[1].props.icon?.type?.name, "CheckMenuIcon");
  rows[0].props.onSelect();
  assert.equal(moves.length, 0);
  // Digit accelerator picks the second workspace.
  app.keydown({ key: "2", preventDefault() {}, stopPropagation() {} });
  await app.flush();
  assert.deepEqual(moves, [["s1", "w2"]]);
  assert.equal(menu.closes, 1);
});

test("session-menu: header style defaults to icon buttons and can be switched", async (t) => {
  const app = await setup(t);
  await app.mountHeader("s1");
  const header = nodes(app.headerTree, n => typeof n.props?.className === "string" && /(^| )sm-header( |$)/.test(n.props.className))[0];
  assert.doesNotMatch(header.props.className, /sm-header-menuOnly/);

  const settings = app.registered.get("session-manager-settings");
  const card = app.mountComponent(settings.component, { ...settings.options.inject(), t: app.t });
  const select = nodes(card.tree, n => n.type === "select" && n.props["aria-label"] === "Title bar actions")[0];
  assert.equal(select.props.value, "icons");
  select.props.onChange({ target: { value: "menu" } });
  await app.flush();
  const menuHeader = nodes(app.headerTree, n => typeof n.props?.className === "string" && /(^| )sm-header( |$)/.test(n.props.className))[0];
  assert.match(menuHeader.props.className, /sm-header-menuOnly/);

  select.props.onChange({ target: { value: "off" } });
  assert.equal(app.localStorage.getItem("dsh-session-manager-header-style"), "off");
  await app.flush();
  assert.equal(app.headerTree, null);

  select.props.onChange({ target: { value: "icons" } });
  await app.flush();
  const iconsHeader = nodes(app.headerTree, n => typeof n.props?.className === "string" && /(^| )sm-header( |$)/.test(n.props.className))[0];
  assert.doesNotMatch(iconsHeader.props.className, /sm-header-menuOnly/);
});

test("session-menu: a moved session leads its new workspace's saved sidebar order", async (t) => {
  const app = await setup(t);
  const calls = [];
  const ui = app.ctx.uiWorkspace;
  ui.view = { pinSessionOrder: (...args) => calls.push(args) };
  // Projection still shows the pre-move membership.
  ui.workspaces = { list: { getSnapshot: () => ({
    items: [{ workspaceId: "w1", sessionIds: ["s1"] }, { workspaceId: "w2", sessionIds: ["s2"] }],
    pinnedSessionIds: [], archivedSessionIds: []
  }) } };
  ui.sessions = app.ctx.sessions;
  const actions = app.registered.get("session-manager.menu.move").options.inject();
  await actions.onMove("s1", "w2");
  assert.equal(app.requests.filter(r => r.url.endsWith("/move")).length, 1);
  assert.equal(calls.length, 1);
  // Arrays come from the bundle's own realm: compare as plain JSON.
  const [id, accounts, source] = JSON.parse(JSON.stringify(calls[0]));
  assert.equal(id, "s1");
  assert.deepEqual(accounts, ["w2", "__flat_session_order__"]);
  assert.deepEqual(source.members.w2, ["s1", "s2"]);
  assert.deepEqual(source.members.w1, []);
  assert.deepEqual(source.members[""], []);
  assert.deepEqual(source.members.__flat_session_order__, ["s1", "s2"]);
});

test("session-menu: moving without a host view store still succeeds", async (t) => {
  const app = await setup(t);
  const actions = app.registered.get("session-manager.menu.move").options.inject();
  await actions.onMove("s1", "w2");
  assert.equal(app.requests.filter(r => r.url.endsWith("/move")).length, 1);
});
