import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const clientSource = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

function createMockElement(tagName, className = "", parent = null) {
  const listeners = new Map();
  const el = {
    tagName: tagName.toUpperCase(),
    className,
    parentElement: parent,
    children: [],
    disabled: false,
    value: "1",
    dataset: {},
    options: [
      { value: "1", text: "Option 1", disabled: false },
      { value: "2", text: "Option 2", disabled: false },
      { value: "3", text: "Option 3", disabled: false }
    ],
    attributes: {},
    style: {},
    classList: {
      contains(c) { return className.split(/\s+/).includes(c); },
      add(c) {
        const set = new Set(className.split(/\s+/).filter(Boolean));
        set.add(c);
        className = Array.from(set).join(" ");
        el.className = className;
      },
      remove(c) {
        const set = new Set(className.split(/\s+/).filter(Boolean));
        set.delete(c);
        className = Array.from(set).join(" ");
        el.className = className;
      }
    },
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] ?? null; },
    matches(selector) {
      const classes = selector.split(",").map(s => s.trim().replace(/^\./, ""));
      return classes.some(c => className.split(/\s+/).includes(c));
    },
    closest(selector) {
      let cur = this;
      while (cur) {
        const selList = selector.split(",").map(s => s.trim());
        for (const sel of selList) {
          if (sel.includes(" ")) {
            const [ancestorClass, childTag] = sel.split(/\s+/);
            if (cur.tagName === childTag.toUpperCase()) {
              let a = cur.parentElement;
              while (a) {
                if (a.classList && a.classList.contains(ancestorClass.replace(/^\./, ""))) {
                  return cur;
                }
                a = a.parentElement;
              }
            }
          } else if (sel.startsWith(".")) {
            const cls = sel.replace(/^\./, "");
            if (cur.classList && cur.classList.contains(cls)) return cur;
          } else if (cur.tagName === sel.toUpperCase()) {
            return cur;
          }
        }
        cur = cur.parentElement;
      }
      return null;
    },
    querySelector(selector) {
      if (selector === "select") {
        return this.children.find(c => c.tagName === "SELECT") || null;
      }
      if (selector.startsWith(".")) {
        const cls = selector.slice(1);
        return this.children.find(c => c.classList?.contains(c)) || null;
      }
      return null;
    },
    querySelectorAll(selector) {
      const results = [];
      function walk(node) {
        for (const child of node.children) {
          if (selector.startsWith(".") && child.classList?.contains(selector.slice(1))) {
            results.push(child);
          }
          walk(child);
        }
      }
      walk(this);
      return results;
    },
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx !== -1) {
        this.children.splice(idx, 1);
        child.parentElement = null;
      }
      return child;
    },
    remove() {
      if (this.parentElement) {
        this.parentElement.removeChild(this);
      }
    },
    contains(target) {
      let cur = target;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentElement;
      }
      return false;
    },
    getBoundingClientRect() {
      return { top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 };
    },
    focus() { this.focused = true; },
    addEventListener(type, fn, opts) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push({ fn, capture: opts === true || opts?.capture === true });
    },
    removeEventListener(type, fn) {
      if (listeners.has(type)) {
        listeners.set(type, listeners.get(type).filter(l => l.fn !== fn));
      }
    },
    dispatchEvent(evt) {
      const list = listeners.get(evt.type) || [];
      for (const l of list) l.fn(evt);
    }
  };
  if (parent) parent.children.push(el);
  return el;
}

function createMockEnvironment() {
  const docListeners = new Map();
  const winListeners = new Map();

  const mockBody = createMockElement("body");
  const mockHead = createMockElement("head");
  const mockDoc = {
    body: mockBody,
    head: mockHead,
    documentElement: createMockElement("html"),
    activeElement: null,
    querySelector() { return null; },
    createElement(tag) {
      const el = createMockElement(tag);
      el.ownerDocument = mockDoc;
      return el;
    },
    querySelectorAll(sel) {
      return mockBody.querySelectorAll(sel);
    },
    addEventListener(type, fn, opts) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push({ fn, capture: opts === true || opts?.capture === true });
    },
    removeEventListener(type, fn) {
      if (docListeners.has(type)) {
        docListeners.set(type, docListeners.get(type).filter(l => l.fn !== fn));
      }
    }
  };

  const mockWin = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener(type, fn, opts) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push({ fn, capture: opts === true || opts?.capture === true });
    },
    removeEventListener(type, fn) {
      if (winListeners.has(type)) {
        winListeners.set(type, winListeners.get(type).filter(l => l.fn !== fn));
      }
    },
    getComputedStyle: () => ({ colorScheme: "light", fontFamily: "sans-serif" })
  };

  let loadedExports = null;
  const win = {
    ...mockWin,
    __ModuleLoader__: {
      load(bundle) {
        loadedExports = bundle.factory((name) => {
          if (name === "react") {
            return {
              Component: class { constructor(props) { this.props = props; } },
              Fragment: Symbol("Fragment"),
              createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
              createPortal: (node) => node,
              useState: (v) => [typeof v === "function" ? v() : v, () => {}],
              useEffect: () => {},
              useMemo: (fn) => fn(),
              useRef: (v) => ({ current: v }),
              useSyncExternalStore: () => ({})
            };
          }
          if (name === "@deepseek-ai/dsh-client-ui-primitives") {
            return { IconArchiveOutline20: () => null };
          }
          return {};
        });
      }
    }
  };

  const sandbox = {
    window: win,
    document: mockDoc,
    console,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    Error,
    AbortController,
    Event: class Event { constructor(t) { this.type = t; } },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    getComputedStyle: () => ({ colorScheme: "light", backgroundColor: "rgb(255,255,255)" })
  };

  runInNewContext(clientSource, sandbox);

  function dispatchDocEvent(type, target, extra = {}) {
    let prevented = false;
    let stopped = false;
    const evt = {
      type,
      target,
      preventDefault() { prevented = true; },
      stopPropagation() { stopped = true; },
      stopImmediatePropagation() { stopped = true; },
      ...extra
    };
    const list = [...(docListeners.get(type) || [])];
    for (const l of list) {
      l.fn(evt);
      if (stopped) break;
    }
    return { prevented, stopped, evt };
  }

  function dispatchWinEvent(type, target, extra = {}) {
    let prevented = false;
    let stopped = false;
    const evt = {
      type,
      target,
      preventDefault() { prevented = true; },
      stopPropagation() { stopped = true; },
      stopImmediatePropagation() { stopped = true; },
      ...extra
    };
    const list = [...(winListeners.get(type) || [])];
    for (const l of list) {
      l.fn(evt);
      if (stopped) break;
    }
    return { prevented, stopped, evt };
  }

  return {
    exports: loadedExports,
    mockDoc,
    mockWin: win,
    mockBody,
    docListeners,
    winListeners,
    dispatchDocEvent,
    dispatchWinEvent
  };
}

test("getTargetSmSelect: correctly distinguishes Session Manager selects from third-party selects", () => {
  const env = createMockEnvironment();
  const { getTargetSmSelect } = env.exports;

  // 1. Valid SM selects via direct classes
  const smViewSelect = createMockElement("select", "sm-viewSelect");
  assert.equal(getTargetSmSelect(smViewSelect), smViewSelect);

  const smSettingsSelect = createMockElement("select", "sm-settingsSelect");
  assert.equal(getTargetSmSelect(smSettingsSelect), smSettingsSelect);

  const smWsSortSelect = createMockElement("select", "sm-wsSortSelect");
  assert.equal(getTargetSmSelect(smWsSortSelect), smWsSortSelect);

  const smPrioritySelect = createMockElement("select", "sm-prioritySelectInline");
  assert.equal(getTargetSmSelect(smPrioritySelect), smPrioritySelect);

  // 2. Valid SM selects inside dialog / settings card containers
  const dialog = createMockElement("div", "sm-panelDialog");
  const dialogSelect = createMockElement("select", "", dialog);
  assert.equal(getTargetSmSelect(dialogSelect), dialogSelect);

  const card = createMockElement("div", "sm-settingsCard");
  const cardSelect = createMockElement("select", "", card);
  assert.equal(getTargetSmSelect(cardSelect), cardSelect);

  // 3. Valid SM selects inside known SM form containers
  const sortField = createMockElement("div", "sm-wsSortField");
  const sortSelect = createMockElement("select", "", sortField);
  const sortLabel = createMockElement("span", "sm-label", sortField);
  assert.equal(getTargetSmSelect(sortSelect), sortSelect);
  assert.equal(getTargetSmSelect(sortLabel), sortSelect);

  const viewField = createMockElement("div", "sm-viewField");
  const viewSelect = createMockElement("select", "", viewField);
  assert.equal(getTargetSmSelect(viewSelect), viewSelect);

  // 4. Native / Third-party selects (Issue #36 root cause)
  const nativeSelect = createMockElement("select", "");
  assert.equal(getTargetSmSelect(nativeSelect), null, "Native unclassed select must NOT be matched");

  const otherPluginContainer = createMockElement("div", "dsh-compact-saviour-settings");
  const otherPluginSelect = createMockElement("select", "saviour-model-select", otherPluginContainer);
  assert.equal(getTargetSmSelect(otherPluginSelect), null, "Third party plugin select must NOT be matched");

  const option = createMockElement("option", "", otherPluginSelect);
  assert.equal(getTargetSmSelect(option), null, "Option in third party select must NOT be matched");
});

test("installCustomDropdownInterceptor: ignores third-party selects and only intercepts SM selects", () => {
  const env = createMockEnvironment();
  const { installCustomDropdownInterceptor } = env.exports;

  const dispose = installCustomDropdownInterceptor();
  assert.equal(typeof dispose, "function");

  // 1. Third-party select: mousedown must NOT be intercepted!
  const thirdPartySelect = createMockElement("select", "compact-saviour-select");
  thirdPartySelect.ownerDocument = env.mockDoc;
  const thirdPartyRes = env.dispatchDocEvent("mousedown", thirdPartySelect);
  assert.equal(thirdPartyRes.prevented, false, "Third-party select mousedown must NOT be prevented");
  assert.equal(thirdPartyRes.stopped, false, "Third-party select mousedown must NOT be stopped");
  assert.equal(env.mockBody.children.length, 0, "No custom dropdown menu should be appended for third-party select");

  // 2. Third-party select: click must NOT be intercepted!
  const thirdPartyClick = env.dispatchDocEvent("click", thirdPartySelect);
  assert.equal(thirdPartyClick.prevented, false, "Third-party select click must NOT be prevented");
  assert.equal(thirdPartyClick.stopped, false, "Third-party select click must NOT be stopped");

  // 3. SM select: mousedown MUST be intercepted and custom menu opened!
  const smSelect = createMockElement("select", "sm-viewSelect");
  smSelect.ownerDocument = env.mockDoc;
  const smRes = env.dispatchDocEvent("mousedown", smSelect);
  assert.equal(smRes.prevented, true, "SM select mousedown MUST be prevented");
  assert.equal(smRes.stopped, true, "SM select mousedown MUST be stopped");
  assert.equal(env.mockBody.children.length, 1, "Custom dropdown menu MUST be opened for SM select");
  const menu = env.mockBody.children[0];
  assert.equal(menu.className, "sm-customSelectMenu");

  // 4. SM select: click MUST be intercepted
  const smClick = env.dispatchDocEvent("click", smSelect);
  assert.equal(smClick.prevented, true, "SM select click MUST be prevented");
  assert.equal(smClick.stopped, true, "SM select click MUST be stopped");

  // 5. Disabled SM select: mousedown prevented/stopped but menu NOT opened
  env.dispatchDocEvent("mousedown", env.mockBody); // close current menu
  assert.equal(env.mockBody.children.length, 0, "Menu should close on outside mousedown");

  const disabledSmSelect = createMockElement("select", "sm-viewSelect");
  disabledSmSelect.disabled = true;
  disabledSmSelect.ownerDocument = env.mockDoc;
  const disabledRes = env.dispatchDocEvent("mousedown", disabledSmSelect);
  assert.equal(disabledRes.prevented, true);
  assert.equal(disabledRes.stopped, true);
  assert.equal(env.mockBody.children.length, 0, "Disabled select must not open custom menu");

  // Cleanup
  dispose();
  assert.equal(env.docListeners.get("mousedown")?.length ?? 0, 0, "mousedown listener removed on dispose");
  assert.equal(env.docListeners.get("click")?.length ?? 0, 0, "click listener removed on dispose");
  assert.equal(env.docListeners.get("keydown")?.length ?? 0, 0, "keydown listener removed on dispose");
  assert.equal(env.winListeners.get("resize")?.length ?? 0, 0, "resize listener removed on dispose");
  assert.equal(env.winListeners.get("scroll")?.length ?? 0, 0, "scroll listener removed on dispose");
});

test("onResizeOrScroll: PR #37 scrolling inside menu keeps it open, scrolling outside closes it", () => {
  const env = createMockEnvironment();
  const { installCustomDropdownInterceptor } = env.exports;

  const dispose = installCustomDropdownInterceptor();

  // 1. Open custom menu
  const smSelect = createMockElement("select", "sm-viewSelect");
  smSelect.ownerDocument = env.mockDoc;
  env.dispatchDocEvent("mousedown", smSelect);

  assert.equal(env.mockBody.children.length, 1, "Menu should be open");
  const menu = env.mockBody.children[0];
  assert.ok(menu.children.length > 0, "Menu should have option items");
  const optionItem = menu.children[0];

  // 2. Scroll INSIDE the menu (e.g. mouse wheel over option item) -> MENU STAYS OPEN! (PR #37)
  env.dispatchWinEvent("scroll", optionItem);
  assert.equal(env.mockBody.children.length, 1, "Menu must stay open when scroll event originates inside option item");

  env.dispatchWinEvent("scroll", menu);
  assert.equal(env.mockBody.children.length, 1, "Menu must stay open when scroll event originates on menu container");

  // 3. Scroll OUTSIDE the menu (e.g. page body or dialog container) -> MENU CLOSES!
  const outsideContainer = createMockElement("div", "settings-page");
  env.dispatchWinEvent("scroll", outsideContainer);
  assert.equal(env.mockBody.children.length, 0, "Menu must close when scrolling outside element");

  // 4. Re-open and test window resize
  env.dispatchDocEvent("mousedown", smSelect);
  assert.equal(env.mockBody.children.length, 1, "Menu re-opened");

  env.dispatchWinEvent("resize", env.mockWin);
  assert.equal(env.mockBody.children.length, 0, "Menu must close on window resize");

  dispose();
});

test("keyboard navigation: Escape closes menu, Enter toggles, third party select keyboard is unaffected", () => {
  const env = createMockEnvironment();
  const { installCustomDropdownInterceptor } = env.exports;

  const dispose = installCustomDropdownInterceptor();

  // 1. Third-party select focused: Escape / Enter / ArrowDown must NOT be prevented or stopped
  const thirdPartySelect = createMockElement("select", "third-party-model-select");
  env.mockDoc.activeElement = thirdPartySelect;

  const tpEsc = env.dispatchDocEvent("keydown", thirdPartySelect, { key: "Escape" });
  assert.equal(tpEsc.prevented, false, "Third-party Escape must not be prevented");
  assert.equal(tpEsc.stopped, false, "Third-party Escape must not be stopped");

  const tpEnter = env.dispatchDocEvent("keydown", thirdPartySelect, { key: "Enter" });
  assert.equal(tpEnter.prevented, false, "Third-party Enter must not be prevented");
  assert.equal(tpEnter.stopped, false, "Third-party Enter must not be stopped");

  const tpArrow = env.dispatchDocEvent("keydown", thirdPartySelect, { key: "ArrowDown" });
  assert.equal(tpArrow.prevented, false, "Third-party ArrowDown must not be prevented");
  assert.equal(tpArrow.stopped, false, "Third-party ArrowDown must not be stopped");

  // 2. SM select focused: Enter opens custom select
  const smSelect = createMockElement("select", "sm-viewSelect");
  smSelect.ownerDocument = env.mockDoc;
  env.mockDoc.activeElement = smSelect;

  const smEnter = env.dispatchDocEvent("keydown", smSelect, { key: "Enter" });
  assert.equal(smEnter.prevented, true, "SM Enter must be prevented");
  assert.equal(smEnter.stopped, true, "SM Enter must be stopped");
  assert.equal(env.mockBody.children.length, 1, "Menu opened on Enter");

  // 4. ArrowDown cycles selection
  const smDown = env.dispatchDocEvent("keydown", smSelect, { key: "ArrowDown" });
  assert.equal(smDown.prevented, true);
  assert.equal(smDown.stopped, true);
  assert.equal(smSelect.value, "2", "ArrowDown should advance selection from 1 to 2");

  dispose();
});

test("custom select option click: selecting an option updates value and dispatches events", () => {
  const env = createMockEnvironment();
  const { installCustomDropdownInterceptor } = env.exports;

  const dispose = installCustomDropdownInterceptor();

  const smSelect = createMockElement("select", "sm-viewSelect");
  smSelect.ownerDocument = env.mockDoc;
  smSelect.value = "1";

  let changeFired = false;
  smSelect.addEventListener("change", () => { changeFired = true; });

  // Open menu
  env.dispatchDocEvent("mousedown", smSelect);
  assert.equal(env.mockBody.children.length, 1, "Menu opened");

  const menu = env.mockBody.children[0];
  const option2 = menu.children[1]; // Second option ({ value: "2", text: "Option 2" })
  assert.ok(option2, "Option 2 should exist");

  // Click Option 2
  option2.dispatchEvent({ type: "mousedown", preventDefault() {}, stopPropagation() {} });
  assert.equal(smSelect.value, "2", "Select value should be updated to 2");
  assert.equal(changeFired, true, "change event should be fired on select");
  assert.equal(env.mockBody.children.length, 0, "Menu should close after option selection");

  dispose();
});

test("interceptor lifecycle: re-installing cleans up previous listeners without leaks", () => {
  const env = createMockEnvironment();
  const { installCustomDropdownInterceptor } = env.exports;

  const dispose1 = installCustomDropdownInterceptor();
  assert.equal(typeof env.mockWin.__dshSmDropdownInterceptorOff, "function");
  const initialMousedownCount = env.docListeners.get("mousedown")?.length ?? 0;
  assert.equal(initialMousedownCount, 1);

  // Calling install again should tear down previous one
  const dispose2 = installCustomDropdownInterceptor();
  const afterSecondMousedownCount = env.docListeners.get("mousedown")?.length ?? 0;
  assert.equal(afterSecondMousedownCount, 1, "Should still have exactly 1 mousedown listener after re-install");

  dispose2();
  assert.equal(env.docListeners.get("mousedown")?.length ?? 0, 0, "All listeners cleaned up after final dispose");
  assert.equal(env.mockWin.__dshSmDropdownInterceptorOff, null);
});

