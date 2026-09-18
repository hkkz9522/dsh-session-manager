// Clipboard parser for AI-generated annotation payloads. Accepts a raw
// string from navigator.clipboard.readText() and extracts a structured
// {tags, note, priority?} payload. Tolerates fenced code blocks and
// conversational wrappers, then enforces the same normalization rules
// as the annotation store so the import button can call
// annotationStore.save without re-validating.

import { ANNOTATION_LIMITS, normalizeAnnotationPatch } from "./annotation-store.js";

const NUL = String.fromCharCode(0);
const BACKSLASH = String.fromCharCode(92);
const QUOTE = String.fromCharCode(34);
const NEWLINE = String.fromCharCode(10);
const TAG_REJECT = /[,，\x00-\x1f]/;

const tagRejectReason = (key, reason) => ({ field: "tags", kind: "rejected", key, reason });

const trimLength = (value, max) => value.length > max ? value.slice(0, max) : value;

const rejectNonPositive = value => value !== null && (!Number.isInteger(value) || value < 1 || value > 5);

const normalizeStringArray = (value, warnings) => {
  if (!Array.isArray(value)) throw new Error("tags must be an array of strings");
  const seen = new Set();
  const tags = [];
  let dropped = 0;
  for (const item of value) {
    if (typeof item !== "string") { dropped++; continue; }
    const trimmed = item.trim();
    if (!trimmed) { dropped++; continue; }
    if (trimmed.length > ANNOTATION_LIMITS.tagLength || TAG_REJECT.test(trimmed)) {
      warnings.push(tagRejectReason(trimmed, "每个标签最多 32 字符，不能包含逗号或控制字符"));
      dropped++;
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(trimmed);
  }
  return { tags, dropped };
};

const normalizeNote = (value, warnings) => {
  if (typeof value !== "string") throw new Error("note must be a string");
  if (value.includes(NUL)) throw new Error("note must not contain NUL characters");
  if (value.length > ANNOTATION_LIMITS.noteLength) {
    warnings.push({ field: "note", kind: "truncated", from: value.length, to: ANNOTATION_LIMITS.noteLength });
    return trimLength(value, ANNOTATION_LIMITS.noteLength);
  }
  return value;
};

const normalizePriority = (value, warnings) => {
  if (value === undefined) return undefined;
  // Treat AI-returned null as the default priority (3 = Normal) so the UI
  // never has to special-case unset entries.
  if (value === null) return 3;
  if (rejectNonPositive(value)) {
    warnings.push({ field: "priority", kind: "rejected", value, reason: "优先级必须为 1–5 的整数；省略或 null 会按 3（普通）保存" });
    return undefined;
  }
  return value;
};

// Find the first balanced top-level JSON object in the text. Handles
// strings, escapes and nested objects without relying on regular
// expressions.
const scanForJsonObject = text => {
  const len = text.length;
  for (let i = 0; i < len; i++) {
    const ch = text[i];
    if (ch !== "{") continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < len; j++) {
      const c = text[j];
      if (inString) {
        if (escape) escape = false;
        else if (c === BACKSLASH) escape = true;
        else if (c === QUOTE) inString = false;
        continue;
      }
      if (c === QUOTE) inString = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return text.slice(i, j + 1);
      }
    }
  }
  return null;
};

// Strip common conversational wrappers (Markdown fences, leading prose)
// before scanning for JSON. The fence language tag is honored when
// present so we still find JSON inside triple-backtick fences.
const stripWrappers = text => {
  // Strip UTF-8 BOM (U+FEFF) if present so JSON.parse doesn't reject it,
  // then trim leading and trailing whitespace (the prior /s+/g was a literal
  // "s+" regex and stripped only literal "s" characters, not whitespace).
  let trimmed = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  trimmed = trimmed.replace(/^\s+|\s+$/g, "");
  const fence = trimmed.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/);
  if (fence) return fence[1];
  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) return trimmed.slice(braceStart, braceEnd + 1);
  return trimmed;
};

const ALLOWED_KEYS = new Set(["tags", "note", "priority"]);

// Parse a clipboard string into an annotation patch. The returned patch
// is compatible with annotationStore.save: tags/note/priority are
// normalized the same way as the server-side validation. Surfaces a
// list of warnings for truncated notes and dropped tags instead of
// failing the import.
export function parseClipboardAnnotation(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, error: "剪贴板为空" };
  }
  const stripped = stripWrappers(raw);
  let parsed;
  try { parsed = JSON.parse(stripped); }
  catch {
    const fallback = scanForJsonObject(stripped);
    if (fallback === null) return { ok: false, error: "无法在剪贴板内容中找到合法的 JSON 对象" };
    try { parsed = JSON.parse(fallback); }
    catch { return { ok: false, error: "剪贴板中的 JSON 无法解析" }; }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "剪贴板内容不是 JSON 对象" };
  }
  const warnings = [];
  const unknown = Object.keys(parsed).filter(key => !ALLOWED_KEYS.has(key));
  for (const key of unknown) warnings.push({ field: key, kind: "ignored", reason: "未知的标记字段，已忽略" });

  let tags = [];
  let note = "";
  let priority;
  if ("tags" in parsed) {
    try { const result = normalizeStringArray(parsed.tags, warnings); tags = result.tags; }
    catch (error) { return { ok: false, error: error.message }; }
  }
  if ("note" in parsed) {
    try { note = normalizeNote(parsed.note, warnings); }
    catch (error) { return { ok: false, error: error.message }; }
  }
  if ("priority" in parsed) {
    const normalized = normalizePriority(parsed.priority, warnings);
    if (normalized !== undefined) priority = normalized;
  }
  const patch = { tags, note, ...(priority !== undefined ? { priority } : {}) };
  try { normalizeAnnotationPatch(patch); }
  catch (error) { return { ok: false, error: error.message }; }
  return { ok: true, annotation: patch, warnings };
}

// Static prompt templates copied to the clipboard. The Chinese version
// is the default; English is exposed for users who prefer it. Both ask
// the model to return strict JSON so the importer can validate it.
export const CLIPBOARD_PROMPTS = Object.freeze({
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
    "  ", "tags", ": [", "标签1", ", ", "标签2", "],",
    "  ", "note", ": ", "会话备注", ",",
    "}"
  ].join(NEWLINE),
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
    "  ", "tags", ": [", "tag1", ", ", "tag2", "],",
    "  ", "note", ": ", "session note", ",",
    "}"
  ].join(NEWLINE)
});

// Resolve the locale key from the active dictionary. Falls back to zh.
export function clipboardPromptFor(dictionaries, language) {
  const available = dictionaries ? Object.keys(dictionaries) : [];
  const key = available.includes(language) ? language
    : available.includes("zh") ? "zh"
    : available[0] || "zh";
  return { key, text: CLIPBOARD_PROMPTS[key] ?? CLIPBOARD_PROMPTS.zh };
}