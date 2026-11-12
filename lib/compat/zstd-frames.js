/** Strict, generation-safe Zstandard concatenated-frame helpers.
 *
 * DSH session artifacts are concatenated checksummed Zstandard frames (one
 * frame per durable batch), so the multi-frame boundary must be computed
 * from the frame header itself, not from a magic-byte scan. This is a
 * direct port of DSH's frame scanner and shares its layout contract:
 *
 *   - Each frame begins with the 4-byte LE magic 0xfd2fb528.
 *   - Reserved bits in the frame-header descriptor byte must be zero.
 *   - Each block carries a 3-byte LE header; reserved block type 0x3 fails.
 *   - Optional 4-byte frame checksum is appended after the last block.
 *
 * @module dsh-session-manager/compat/zstd-frames
 */
import { zstdDecompress, createZstdDecompress } from "node:zlib";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const zstdDecompressAsync = promisify(zstdDecompress);
const ZSTD_MAGIC = 0xfd2fb528;

/** Locate complete Zstandard frames; an incomplete final frame is returned
 * separately as `tornStart` and can be ignored by read-only paths.
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUint32LE(offset) != ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUint8(offset++);
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>>6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for(;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

export async function decompressZstdFrame(frame, options) {
  return zstdDecompressAsync(frame, options);
}

export function decompressZstdFirstLine(frame, limit) {
  return new Promise((resolve, reject) => {
    const stream = createZstdDecompress();
    const chunks = [];
    let size = 0;
    let settled = false;
    let lineFound = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      if (error) reject(error); else resolve(value);
    };
    stream.on("error", error => finish(error));
    stream.on("end", () => lineFound
      ? finish(null, Buffer.concat(chunks, size))
      : finish(new Error("会话头行不完整或超过大小限制")));
    stream.on("data", chunk => {
      if (lineFound) return;
      const newline = chunk.indexOf(10);
      const part = newline < 0 ? chunk : chunk.subarray(0, newline + 1);
      size += part.length;
      if (size > limit) return finish(new Error("会话头行不完整或超过大小限制"));
      chunks.push(part);
      if (newline >= 0) lineFound = true;
    });
    if (Buffer.isBuffer(frame)) stream.end(frame);
    else pipeline(Readable.from(frame), stream).catch(error => finish(error));
  });
}

/** Feed exactly the first complete frame, with bounded reads even for huge batches.
 * Keep consuming after the first line to validate the frame/checksum before discovery.
 */
export async function* firstZstdFrameChunks(handle) {
  let position = 0;
  const exact = async size => {
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(bytes, offset, size - offset, position);
      if (!bytesRead) throw new Error("会话日志存在截断的 Zstd 帧");
      offset += bytesRead;
      position += bytesRead;
    }
    return bytes;
  };
  const prefix = await exact(5);
  if (prefix.readUInt32LE(0) !== ZSTD_MAGIC) throw new Error("corrupt Zstandard session log: invalid frame magic");
  const descriptor = prefix[4];
  if (descriptor & 0x18) throw new Error("corrupt Zstandard session log: reserved frame-header bit");
  yield prefix;
  const sizeFlag = descriptor >>> 6;
  const singleSegment = Boolean(descriptor & 0x20);
  const dictionaryFlag = descriptor & 3;
  const headerSize = (singleSegment ? 0 : 1) + (dictionaryFlag === 3 ? 4 : dictionaryFlag)
    + (sizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << sizeFlag);
  if (headerSize) yield await exact(headerSize);
  for (;;) {
    const header = await exact(3);
    const block = header.readUIntLE(0, 3);
    const type = (block >>> 1) & 3;
    if (type === 3) throw new Error("corrupt Zstandard session log: reserved block type");
    yield header;
    let remaining = type === 1 ? 1 : block >>> 3;
    while (remaining) {
      const count = Math.min(remaining, 64 * 1024);
      yield await exact(count);
      remaining -= count;
    }
    if (block & 1) break;
  }
  if (descriptor & 4) yield await exact(4);
}

export async function decompressAllZstdFrames(buffer) {
  const scan = scanZstdFrames(buffer);
  if (scan.frames.length === 0) {
    throw new Error("empty or header-less Zstandard session log");
  }
  const decoded = [];
  for (const frame of scan.frames) {
    decoded.push(await decompressZstdFrame(buffer.subarray(frame.start, frame.end)));
  }
  return {
    content: Buffer.concat(decoded),
    frameCount: decoded.length,
    torn: scan.tornStart !== undefined,
  };
}
