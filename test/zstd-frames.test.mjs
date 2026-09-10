/**
 * Standalone tests for the strict multi-frame Zstandard decoder in
 * lib/compat/zstd-frames.js. Run with `node --test test/zstd-frames.test.mjs`.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { zstdCompressSync } from "node:zlib";
import {
  scanZstdFrames,
  decompressZstdFrame,
  decompressAllZstdFrames,
} from "../lib/compat/zstd-frames.js";

function frame(text) {
  return zstdCompressSync(Buffer.from(text, "utf8"));
}

test("scan: single complete frame", () => {
  const buf = frame("hello");
  const scan = scanZstdFrames(buf);
  assert.equal(scan.frames.length, 1);
  assert.equal(scan.tornStart, undefined);
  assert.equal(scan.frames[0].end, buf.length);
});

test("scan: multiple concatenated frames", () => {
  const buf = Buffer.concat([frame("a"), frame("b"), frame("c")]);
  const scan = scanZstdFrames(buf);
  assert.equal(scan.frames.length, 3);
  assert.equal(scan.tornStart, undefined);
});

test("scan: rejects non-zstd bytes", () => {
  assert.throws(() => scanZstdFrames(Buffer.from("hello world")), /invalid frame magic/);
});

test("scan: short bytes report torn at start", () => {
  const buf = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x00]);
  const scan = scanZstdFrames(buf);
  assert.equal(scan.frames.length, 0);
  assert.equal(scan.tornStart, 0);
});

test("decompress: single frame", async () => {
  const text = "header";
  const out = await decompressZstdFrame(frame(text));
  assert.equal(out.toString("utf8"), text);
});

test("decompressAll: concatenates all frames", async () => {
  const buf = Buffer.concat([frame("alpha"), frame("beta"), frame("gamma")]);
  const out = await decompressAllZstdFrames(buf);
  assert.equal(out.frameCount, 3);
  assert.equal(out.torn, false);
  assert.equal(out.content.toString("utf8"), "alphabetagamma");
});

test("decompressAll: rejects empty input", async () => {
  await assert.rejects(decompressAllZstdFrames(Buffer.alloc(0)), /empty or header-less/);
});

test("scan: torn tail is reported when last frame ends mid-header", () => {
  const buf = Buffer.concat([
    frame("complete"),
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00]),
  ]);
  const scan = scanZstdFrames(buf);
  assert.equal(scan.frames.length, 1);
  assert.equal(typeof scan.tornStart, "number");
  assert.ok(scan.tornStart > 0);
});
