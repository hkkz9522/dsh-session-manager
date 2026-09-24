import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { DEFAULT_ANNOTATION, normalizeAnnotationPatch } from "../../lib/annotation-store.js";

const source = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
export function nodes(tree, predicate = () => true) {
  const found = [];
  const walk = value => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== "object") return;
    if (predicate(value)) found.push(value);
    walk(value.props?.children);
  };
  walk(tree);
  return found;
}
export function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (tree === null || tree === undefined || typeof tree === "boolean") return "";
  return typeof tree === "object" ? text(tree.props?.children) : String(tree);
}

// Per-mount clipboard stub shared with the runInNewContext sandbox so
// tests can observe prompt writes without relying on navigator.clipboard.
// mountClient() resets .writes at the start of each test.
const clipboardStub = { writes: [], writeText(text) { this.writes.push(text); return Promise.resolve(); } };

/** Real, unmodified client bundle and registered slots, with a small hook host
 * to keep CI dependency-free. Tests exercise rendered controls, shared-store
 * subscriptions, async responses and the actual annotation editor. */
export function mountClient({ sessions = [], current = "", archivedIds = [], workspaces = [], language = "zh", sessionCreatedAt = {}, fetchWorkspaces, sessionAnnotations = {}, fetchAnnotations, saveAnnotations, confirm = () => true, wide = true } = {}) {
  // Fresh clipboard stub per mount so each test sees only its own writes.
  clipboardStub.writes.length = 0;
  let list = { ids: sessions.map(s => s.id), byId: Object.fromEntries(sessions.map(s => [s.id, s])), current };
  let workspaceSnapshot = { archivedSessionIds: archivedIds };
  let workspaceData = workspaces, response = fetchWorkspaces, annotationFetch = fetchAnnotations, annotationSave = saveAnnotations;
  let annotationData = Object.fromEntries(Object.entries(sessionAnnotations).map(([id, value]) => [id, { ...DEFAULT_ANNOTATION, revision: 1, ...value }]));
  const requests = [], alerts = [], pluginCleanup = [];
  const listeners = new Map();
  let activeHost;
  // Spy array so tests can observe ctx.sessions.open() calls triggered by
  // the Session Manager panel's row buttons without owning a real ctx.
  const sessionOpenCalls = [];
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const hook = () => {
    if (!activeHost) throw new Error("Hook called outside render");
    const index = activeHost.cursor++;
    return [activeHost, activeHost.hooks[index] ??= {}];
  };
  const React = {
    Component: class { constructor(props) { this.props = props; } }, Fragment: Symbol("Fragment"),
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const [host, slot] = hook();
      if (!("value" in slot)) slot.value = typeof initial === "function" ? initial() : initial;
      return [slot.value, next => { const value = typeof next === "function" ? next(slot.value) : next; if (!Object.is(value, slot.value)) { slot.value = value; host.dirty = true; } }];
    },
    useRef(initial) { const [, slot] = hook(); return slot.ref ??= { current: initial }; },
    useMemo(factory, deps) { const [, slot] = hook(); if (!sameDeps(slot.deps, deps)) { slot.value = factory(); slot.deps = deps; } return slot.value; },
    useEffect(effect, deps) { const [host, slot] = hook(); if (sameDeps(slot.deps, deps)) return; slot.deps = deps; host.effects.push(() => { slot.cleanup?.(); slot.cleanup = effect(); }); },
    useSyncExternalStore(subscribe, getSnapshot) {
      const [host, slot] = hook();
      if (slot.subscribe !== subscribe) { slot.cleanup?.(); slot.subscribe = subscribe; slot.cleanup = subscribe(() => { host.dirty = true; }); }
      return getSnapshot();
    },
  };
  function host(component, props) {
    const result = { hooks: [], effects: [], cursor: 0, dirty: true, tree: null, props,
      render() {
        this.dirty = false; this.cursor = 0; activeHost = this;
        try { this.tree = component(this.props); } finally { activeHost = undefined; }
        for (const effect of this.effects.splice(0)) effect();
        return this.tree;
      },
      dispose() { for (const slot of this.hooks) slot.cleanup?.(); },
    };
    result.render(); return result;
  }
  const element = () => ({ dataset: {}, style: { setProperty() {} }, getAttribute: () => "", setAttribute() {}, hasAttribute: () => false });
  const document = { documentElement: element(), body: element(), head: { appendChild() {} }, querySelector: () => null, querySelectorAll: () => [], createElement: element };
  let exports;
  const window = {
    innerWidth: 1200, confirm, alert: message => alerts.push(message),
    addEventListener(type, handler) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(handler); },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
    __ModuleLoader__: { load(bundle) { exports = bundle.factory(name => name === "react" ? React : name === "@deepseek-ai/dsh-client-ui-primitives" ? { IconArchiveOutline20: () => null } : {}); } },
  };
  const navigator = { clipboard: clipboardStub };
  runInNewContext(source, {
    window, document, console, navigator, Error, AbortController,
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1,
    getComputedStyle: () => ({ colorScheme: "light", backgroundColor: "rgb(255,255,255)" }),
    fetch: async (url, options) => {
      requests.push({ url, options }); let data;
      if (url === "/session-manager/api/workspaces") data = response ? await response(options) : { ok: true, result: { workspaces: workspaceData, sessionCreatedAt } };
      else if (url === "/session-manager/api/annotations" && options?.method !== "POST") data = annotationFetch ? await annotationFetch() : { ok: true, result: { annotations: structuredClone(annotationData) } };
      else if (url === "/session-manager/api/annotations") {
        const body = JSON.parse(options.body);
        if (annotationSave) data = await annotationSave(body);
        else {
          const previous = Object.hasOwn(annotationData, body.sessionId) ? annotationData[body.sessionId] : DEFAULT_ANNOTATION;
          if (body.expectedRevision !== undefined && body.expectedRevision !== previous.revision) data = { ok: false, code: "annotation-conflict", error: "Annotation conflict: load latest" };
          else {
            try {
              const annotation = { ...previous, ...normalizeAnnotationPatch(body.patch), revision: previous.revision + 1 };
              annotationData = { ...annotationData, [body.sessionId]: annotation };
              data = { ok: true, result: { sessionId: body.sessionId, annotation } };
            } catch (error) { data = { ok: false, code: error.code, error: error.message }; }
          }
        }
      } else throw new Error("Unexpected request: " + url);
      return { json: async () => data };
    },
  }, { filename: "lib/client.js" });
  const registered = new Map(); let dictionaries;
  const ctx = {
    effect(fn) { const cleanup = fn(); if (typeof cleanup === "function") pluginCleanup.push(cleanup); },
    locale: { register(_name, values) { dictionaries = values; } },
    slots: { inject(_slot, fn) { fn(); }, register(options, component) { registered.set(options.id, { options, component }); } },
    sessions: { open(id) { sessionOpenCalls.push(id); }, retain(id) { sessionOpenCalls.push(id); return { sessionId: id, release() {} }; }, refresh: async () => {}, list: { getSnapshot: () => list } }, uiWorkspace: { openSession(id) { sessionOpenCalls.push(id); } },
    workspaces: { archiveSession: async () => {}, refresh: async () => {} },
  };
  exports.apply(ctx);
  const t = (key, values = {}) => (dictionaries[language][key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
  const common = { t, useSessions: selector => selector(list), useWorkspaces: selector => selector(workspaceSnapshot) };
  const footer = registered.get("session-manager-footer"), actions = footer.options.inject(); actions.onOpenPanel();
  const footerHost = host(footer.component, { ...actions, ...common, wide });
  const safePanel = nodes(footerHost.tree, node => typeof node.type === "function" && node.type.prototype?.render)[0];
  const panel = new safePanel.type(safePanel.props).render();
  const panelHost = host(panel.type, panel.props);
  let headerHost, dialogHost, dialogKey;
  const control = (tree, label) => { const match = nodes(tree, node => node.props?.["aria-label"] === label)[0]; if (!match) throw new Error("Control not found: " + label); return match; };
  const api = {
    get tree() { return [panelHost.tree, dialogHost?.tree]; },
    get footerTree() { return footerHost.tree; },
    get headerTree() { return headerHost?.tree; },
    get requests() { return requests; }, get workspaceRequests() { return requests.filter(r => r.url.endsWith("/workspaces")); },
    get sourceIds() { return list.ids; }, get annotations() { return annotationData; }, get alerts() { return alerts; },
    async flush() {
      for (let i = 0; i < 40; i++) {
        await Promise.resolve();
        if (panelHost.dirty) panelHost.render();
        if (headerHost?.dirty) headerHost.render();
        const child = nodes([panelHost.tree, headerHost?.tree], node => node.type?.name === "AnnotationDialog")[0];
        if (!child) { dialogHost?.dispose(); dialogHost = undefined; dialogKey = undefined; }
        else if (!dialogHost || child.props.sessionId !== dialogKey) { dialogHost?.dispose(); dialogKey = child.props.sessionId; dialogHost = host(child.type, child.props); }
        else if (dialogHost.dirty || dialogHost.props !== child.props) { dialogHost.props = child.props; dialogHost.render(); }
      }
      return api;
    },
    find(predicate) { return nodes(api.tree, predicate); },
    // Shared clipboard stub -- reset by each mountClient() call so tests can
    // observe prompt writes without relying on navigator.clipboard in the
    // runInNewContext sandbox.
    get clipboardWrites() { return clipboardStub.writes; },
    control(label) { return control(api.tree, label); },
    async change(label, value) { const item = api.control(label); if (item.props.disabled) throw new Error("Control is disabled: " + label); item.props.onChange({ target: { value, checked: value } }); return api.flush(); },
    async click(label) { const button = api.find(node => node.type === "button" && text(node) === label)[0]; if (!button) throw new Error("Button not found: " + label); if (button.props.disabled) throw new Error("Button is disabled: " + label); button.props.onClick(); return api.flush(); },
    async clickLabel(label) { const button = api.control(label); if (button.props.disabled) throw new Error("Button is disabled: " + label); button.props.onClick(); return api.flush(); },
    async mountHeader(id = current) { const slot = registered.get("session-manager-header"); headerHost = host(slot.component, { ...slot.options.inject(), ...common, sessionId: id, displayTitle: list.byId[id]?.displayTitle || id }); return api.flush(); },
    async clickHeader(label) { const button = control(headerHost.tree, label); if (button.props.disabled) throw new Error("Header button is disabled"); button.props.onClick(); return api.flush(); },
    headerControl(label) { return control(headerHost.tree, label); },
    rowIds() { return nodes(panelHost.tree, node => node.props?.["data-session-id"]).map(node => node.props["data-session-id"]); },
    setSessions(next, nextCurrent = list.current) { list = { ids: next.map(s => s.id), byId: Object.fromEntries(next.map(s => [s.id, s])), current: nextCurrent }; panelHost.dirty = true; },
    setWorkspaces(next, nextArchived = workspaceSnapshot.archivedSessionIds) { workspaceData = next; workspaceSnapshot = { archivedSessionIds: nextArchived }; panelHost.dirty = true; },
    setFetcher(next) { response = next; }, setAnnotationFetcher(next) { annotationFetch = next; }, setAnnotationSaver(next) { annotationSave = next; },
    setAnnotations(next) { annotationData = Object.fromEntries(Object.entries(next).map(([id, value]) => [id, { ...DEFAULT_ANNOTATION, revision: 1, ...value }])); },
    async focus() { for (const fn of listeners.get("focus") ?? []) fn(); return api.flush(); },
    keydown(event) { for (const handler of listeners.get("keydown") ?? []) handler(event); },
    isOpen() { return nodes(footerHost.render(), node => typeof node.type === "function" && node.type.prototype?.render).length > 0; },
    // Spy on ctx.sessions.open() calls triggered by the Session Manager row
    // Open button. Each entry is the session id passed to open().
    sessionOpenCalls: sessionOpenCalls,
    dispose() { dialogHost?.dispose(); headerHost?.dispose(); panelHost.dispose(); footerHost.dispose(); for (const cleanup of pluginCleanup) cleanup(); },
  };
  return api;
}
