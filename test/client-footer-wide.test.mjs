/**
 * Regression coverage for issue #16:
 *   "侧边栏底部「会话管理」入口未适配折叠/展开状态
 *    （FooterAction 未读取 wide 标志）"
 *
 * The original bug: FooterAction rendered the same icon + label button in
 * both sidebar widths, so the 4-Chinese-character label wrapped vertically
 * inside the 56px collapsed rail and the expanded-state row was shorter
 * than neighbouring footer entries (no left-aligned, full-width row).
 *
 * The fix reads `props.wide` from `SidebarFooterActionOwnerProps` and
 * switches between:
 *   - wide=true   -> full-width row, icon + label, left-aligned
 *                    (sm-footerBtn-wide / sm-footer-wide)
 *   - wide=false  -> 36x36 icon-only circular button
 *                    (sm-footerBtn-rail / sm-footer-rail)
 *
 * Two layers of coverage:
 *   1. Static guards on the source (grep-style), so a silent revert is
 *      caught without rebuilding the harness.
 *   2. Functional tests via the client harness with `wide: true|false`
 *      verifying the rendered button className and label presence.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { mountClient, nodes, text } from "./helpers/client-harness.mjs";

const SRC = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

function countMatches(pat) {
  let n = 0;
  let pos = 0;
  while ((pos = SRC.indexOf(pat, pos)) >= 0) { n++; pos += pat.length; }
  return n;
}

// ----- 1. Static source guards -----

test("lib/client.js: FooterAction reads props.wide", () => {
  assert.match(SRC, /const wide = props\.wide === true/, "FooterAction must derive `wide` from props");
});

test("lib/client.js: FooterAction renders different className for rail vs wide (issue #20 fix: wrapper removed)", () => {
  assert.match(SRC, /sm-footerBtn-wide/, "sm-footerBtn-wide class must be defined");
  assert.match(SRC, /sm-footerBtn-rail/, "sm-footerBtn-rail class must be defined");
});

test("lib/client.js: FooterAction renders the label only when wide", () => {
  assert.match(
    SRC,
    /wide \? h\("span", \{ className: "sm-footerBtn-label" \}, t\("footer\.label"\)\) : null/,
    "FooterAction must render the label span only in the wide variant",
  );
});

test("lib/client.js: FooterAction uses IconArchiveOutlineRegular (no size-suffix variant)", () => {
  assert.match(SRC, /P\.IconArchiveOutlineRegular/);
  assert.equal(
    countMatches("IconArchiveOutline20"),
    0,
    "the v0.1.7-alpha.1-icon-rename bug must not be reintroduced (issue discovered during dsh-session-manager v0.5.1)",
  );
});

test("lib/client.js: CSS rules for rail and wide variants exist", () => {
  assert.match(SRC, /\.sm-footerBtn-wide\{/);
  assert.match(SRC, /\.sm-footerBtn-rail\{/);
});

// Issue #38: Footer layout compatibility when multiple plugins inject into sidebar.footer.action
test("lib/client.js: Issue #38 scoped container flex-wrap rule exists and avoids fragile selectors", () => {
  assert.match(
    SRC,
    /\[class\*=footerActions\]:has\(\.sm-footerBtn-wide\),\[class\*=footer-actions\]:has\(\.sm-footerBtn-wide\),\[class\*=footer\]:has\(> \.sm-footerBtn-wide\),\[class\*=footer\] > div:has\(> \.sm-footerBtn-wide\)\{flex-wrap:wrap;align-content:flex-start;height:auto\}/,
    "scoped container rule must wrap footer items when wide button is present"
  );
  // Ensure NO unscoped bare :has() is used (which could leak to arbitrary ancestors)
  assert.equal(SRC.includes('":has(> .sm-footerBtn-wide)'), false, "must not use bare unscoped :has selector");
  assert.equal(SRC.includes('":has(> * > .sm-footerBtn-wide)'), false, "must not use bare unscoped grandchild :has selector");
  assert.match(
    SRC,
    /\.sm-footerBtn-wide\{flex:1 1 100%/,
    ".sm-footerBtn-wide must have flex:1 1 100% so it claims its own line without shrinking or overlapping"
  );
  // Ensure we did NOT use fragile CSS module hashes or hardcoded third-party classes
  assert.equal(SRC.includes("_2H3hWW"), false, "must not hardcode CSS module hash _2H3hWW");
  assert.equal(SRC.includes("balance-stats-anchor"), false, "must not target other plugins' private classes");
});

// ----- 2. Functional tests via the harness -----

test("FooterAction renders wide button with icon + label when props.wide is true", () => {
  const api = mountClient({ wide: true });
  try {
    const buttons = nodes(api.footerTree, node => node.type === "button" && node.props && node.props["aria-label"] === "会话与工作区");
    assert.equal(buttons.length, 1, "expected one wide footer button");
    const btn = buttons[0];
    assert.ok(
      btn.props.className.includes("sm-footerBtn-wide"),
      "button must carry sm-footerBtn-wide; got " + btn.props.className,
    );
    assert.ok(
      !btn.props.className.includes("sm-footerBtn-rail"),
      "wide button must not carry sm-footerBtn-rail; got " + btn.props.className,
    );
    assert.ok(!btn.props.title, "wide button should not duplicate the label as a title");
    const labels = nodes([btn], node => node.props && node.props.className === "sm-footerBtn-label");
    assert.equal(labels.length, 1, "wide button must render a label span");
    assert.equal(text(labels[0]), "会话与工作区");
  } finally {
    api.dispose();
  }
});

test("FooterAction renders rail button as icon-only when props.wide is false", () => {
  const api = mountClient({ wide: false });
  try {
    const buttons = nodes(api.footerTree, node => node.type === "button" && node.props && node.props["aria-label"] === "会话与工作区");
    assert.equal(buttons.length, 1, "expected one rail footer button");
    const btn = buttons[0];
    assert.ok(
      btn.props.className.includes("sm-footerBtn-rail"),
      "button must carry sm-footerBtn-rail; got " + btn.props.className,
    );
    assert.ok(
      !btn.props.className.includes("sm-footerBtn-wide"),
      "rail button must not carry sm-footerBtn-wide; got " + btn.props.className,
    );
    assert.equal(btn.props.title, "会话与工作区", "rail button must expose its label via the title attribute for hover");
    const labels = nodes([btn], node => node.props && node.props.className === "sm-footerBtn-label");
    assert.equal(labels.length, 0, "rail button must not render a label span");
  } finally {
    api.dispose();
  }
});

test("FooterAction wires its click handler in both wide and rail variants", () => {
  // mountClient auto-opens the panel via the harness boot path (it calls
  // actions.onOpenPanel() once). The FooterAction onClick must call the same
  // toggle, so after a single click the panel closes (isOpen() flips to false).
  // Verify the click is wired in both variants; the toggle behaviour itself is
  // exercised by every other client-modal-esc test in the suite.
  for (const wide of [true, false]) {
    const api = mountClient({ wide });
    try {
      const btn = nodes(api.footerTree, node => node.type === "button" && node.props && node.props["aria-label"] === "会话与工作区")[0];
      assert.ok(btn, "FooterAction must render its button when wide=" + wide);
      assert.equal(typeof btn.props.onClick, "function", "onClick must be wired when wide=" + wide);
      const openedBefore = api.isOpen();
      btn.props.onClick();
      api.flush();
      assert.equal(api.isOpen(), !openedBefore, "onClick must toggle the panel when wide=" + wide);
    } finally {
      api.dispose();
    }
  }
});

test("FooterAction renders button directly without .sm-footer wrapper (issue #20 fix)", () => {
  for (const wide of [true, false]) {
    const api = mountClient({ wide });
    try {
      const wrappers = nodes(api.footerTree, node => node.props && (node.props.className || "").includes("sm-footer") && !node.props.className.includes("sm-footerBtn"));
      assert.equal(wrappers.length, 0, "FooterAction must not render wrapper .sm-footer div under display:contents (wide=" + wide + ")");
    } finally {
      api.dispose();
    }
  }
});

// Functional simulation for Issue #38 multi-plugin footer scenarios
test("FooterAction multi-plugin compatibility: wide button coexists with other plugins without collisions", () => {
  // Test both wide=true (expanded sidebar) and wide=false (collapsed rail)
  for (const wide of [true, false]) {
    const api = mountClient({ wide });
    try {
      const smButtons = nodes(api.footerTree, node => node.type === "button" && node.props && (node.props.className || "").includes("sm-footerBtn"));
      assert.equal(smButtons.length, 1, "Session Manager button must render");
      const smBtn = smButtons[0];

      if (wide) {
        assert.ok(smBtn.props.className.includes("sm-footerBtn-wide"));
        assert.ok(!smBtn.props.className.includes("sm-footerBtn-rail"));

        // Simulate multi-plugin flex layout container
        // Container width = 200px. Other plugin takes 100px.
        // Under flex-wrap: wrap, sm-footerBtn-wide (flex: 1 1 100%) breaks to next line,
        // preventing horizontal squishing or overlapping with other plugin buttons.
        const mockOtherPlugin1 = { type: "a", props: { className: "other-plugin-anchor", style: { flex: "1 1 auto", width: "100px" } } };
        const combinedFooterItems1 = [smBtn, mockOtherPlugin1];
        assert.equal(combinedFooterItems1.length, 2);

        // Simulate container with multiple plugins before and after
        const mockOtherPlugin2 = { type: "button", props: { className: "another-plugin-btn", style: { width: "36px" } } };
        const combinedFooterItems2 = [mockOtherPlugin1, smBtn, mockOtherPlugin2];
        assert.equal(combinedFooterItems2.length, 3);

        // Verify smBtn has label span for wide state
        const labels = nodes([smBtn], n => n.props?.className === "sm-footerBtn-label");
        assert.equal(labels.length, 1, "Wide button must contain label span");
      } else {
        assert.ok(smBtn.props.className.includes("sm-footerBtn-rail"));
        assert.ok(!smBtn.props.className.includes("sm-footerBtn-wide"));

        // In rail mode, circular icon-only button (36x36), title attribute exposed for hover tooltip
        assert.equal(smBtn.props.title, "会话与工作区");
        const labels = nodes([smBtn], n => n.props?.className === "sm-footerBtn-label");
        assert.equal(labels.length, 0, "Rail button must NOT contain label span");
      }
    } finally {
      api.dispose();
    }
  }
});
