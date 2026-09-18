import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLIPBOARD_PROMPTS,
  clipboardPromptFor,
  parseClipboardAnnotation,
} from "../lib/clipboard-parser.js";

test("parses clean JSON and normalizes tags/note/priority", () => {
  const result = parseClipboardAnnotation(JSON.stringify({
    tags: [" Design ", "design", "Bug"],
    note: "first line\nsecond line",
    priority: 2,
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.annotation.tags, ["Design", "Bug"]);
  assert.equal(result.annotation.note, "first line\nsecond line");
  assert.equal(result.annotation.priority, 2);
  assert.equal(result.warnings.length, 0);
});

test("strips Markdown fences and conversational prose", () => {
  const fenced = "```json\n" + JSON.stringify({ tags: ["a"], note: "n" }) + "\n```";
  assert.equal(parseClipboardAnnotation(fenced).ok, true);

  const chatter = "Sure! Here is the summary:\n" + JSON.stringify({ tags: ["a"], note: "n" }) + "\nLet me know.";
  assert.equal(parseClipboardAnnotation(chatter).ok, true);
  assert.deepEqual(parseClipboardAnnotation(chatter).annotation.tags, ["a"]);
});



test("strips a leading UTF-8 BOM and trims whitespace before parsing", () => {
  const json = JSON.stringify({ tags: ["alpha"], note: "beta" });
  const result = parseClipboardAnnotation("\uFEFF  " + json + "\n\n");
  assert.equal(result.ok, true);
  assert.deepEqual(result.annotation.tags, ["alpha"]);
  assert.equal(result.annotation.note, "beta");
});

test("recovers from prose-and-fence wrappers around a 20-tag Chinese payload", () => {
  // Mirrors a realistic AI response: greeting prose + ```json fence +
  // the annotation object + closing fence + farewell prose. The note
  // intentionally includes Windows-style backslash paths that must
  // round-trip through JSON.parse unchanged.
  const payload = {
    tags: [
      "DSH一键启动", "PowerShell菜单脚本", "bat批处理入口", "UTF8-BOM-CRLF编码",
      "cmd-GBK-936乱码", "SendKeys-IME冲突", "PSReadLine::Insert",
      "git-stash-pop保护", "端口3080状态检测", "版本对比upstream",
      "菜单1-2-3循环", "状态颜色Running", "Clear-Host保留历史",
      "自动续轮免Enter", "pnpm-12.4.1字段", "package.json本地改动",
      "DSH仓库路径配置", "启动器目录迁移", "临时测试pwsh验证", "fetch失败错误处理"
    ],
    note: "路径 D:\\1Workspace\\AI\\DSH\\dsh-launch\\，仓库 D:\\Program Package\\deepseek-harness\\"
  };
  const wrapped = "以下是整理结果：\n\n"
    + "```json\n"
    + JSON.stringify(payload)
    + "\n```\n\n"
    + "如有需要请告诉我。";
  const result = parseClipboardAnnotation(wrapped);
  assert.equal(result.ok, true);
  assert.equal(result.annotation.tags.length, 20);
  assert.equal(result.annotation.note, payload.note);
});
test("truncates notes exceeding the limit and warns", () => {
  const long = "x".repeat(2500);
  const result = parseClipboardAnnotation(JSON.stringify({ tags: [], note: long }));
  assert.equal(result.ok, true);
  assert.equal(result.annotation.note.length, 2000);
  assert.deepEqual(result.warnings, [{ field: "note", kind: "truncated", from: 2500, to: 2000 }]);
});

test("drops invalid tags instead of failing and reports each one", () => {
  const result = parseClipboardAnnotation(JSON.stringify({
    tags: ["ok", "", "  ", "with,comma", "x".repeat(40), "good"],
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.annotation.tags, ["ok", "good"]);
  const kinds = result.warnings.map(w => w.kind).sort();
  assert.deepEqual(kinds, ["rejected", "rejected"]);
});

test("rejects out-of-range priority with a warning and omits it from the patch", () => {
  const result = parseClipboardAnnotation(JSON.stringify({ priority: 99 }));
  assert.equal(result.ok, true);
  assert.equal("priority" in result.annotation, false);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].field, "priority");
});

test("normalizes AI-returned priority null to the default 3 (Normal)", () => {
  const result = parseClipboardAnnotation(JSON.stringify({ priority: null }));
  assert.equal(result.ok, true);
  assert.equal(result.annotation.priority, 3);
});

test("warns about unknown keys without failing", () => {
  const result = parseClipboardAnnotation(JSON.stringify({ tags: ["a"], color: "blue" }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, [{
    field: "color",
    kind: "ignored",
    reason: "未知的标记字段，已忽略",
  }]);
});

test("rejects empty clipboard, non-JSON text, and arrays at the top level", () => {
  assert.deepEqual(parseClipboardAnnotation(""), { ok: false, error: "剪贴板为空" });
  assert.deepEqual(parseClipboardAnnotation("   "), { ok: false, error: "剪贴板为空" });
  assert.equal(parseClipboardAnnotation("hello world").ok, false);
  assert.equal(parseClipboardAnnotation(JSON.stringify(["nope"])).ok, false);
  assert.equal(parseClipboardAnnotation(JSON.stringify(null)).ok, false);
});

test("recovers from wrapped JSON with leading prose when the scanner can find a balanced object", () => {
  const wrapped = "Here you go:\n{\"tags\":[\"alpha\"],\"note\":\"beta\"} -- enjoy!";
  const result = parseClipboardAnnotation(wrapped);
  assert.equal(result.ok, true);
  assert.deepEqual(result.annotation.tags, ["alpha"]);
  assert.equal(result.annotation.note, "beta");
});

test("exposes zh and en prompt templates", () => {
  assert.ok(typeof CLIPBOARD_PROMPTS.zh === "string" && CLIPBOARD_PROMPTS.zh.includes("标签"));
  assert.ok(typeof CLIPBOARD_PROMPTS.en === "string" && CLIPBOARD_PROMPTS.en.includes("tags"));
  assert.ok(CLIPBOARD_PROMPTS.zh.includes("返回格式"));
  assert.ok(CLIPBOARD_PROMPTS.en.includes("Return shape"));
});

test("clipboardPromptFor falls back to zh when language is missing", () => {
  const dicts = { zh: { any: 1 }, en: { any: 2 } };
  assert.equal(clipboardPromptFor(dicts, "zh").key, "zh");
  assert.equal(clipboardPromptFor(dicts, "en").key, "en");
  assert.equal(clipboardPromptFor(dicts, "fr").key, "zh");
  assert.equal(clipboardPromptFor(null, "en").key, "zh");
});
