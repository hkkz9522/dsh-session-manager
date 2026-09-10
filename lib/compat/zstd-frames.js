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
import { zstdDecompress } from "node:zlib";
import { promisify } from "node:util";

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

export async function decompressZstdFrame(frame) {
  return zstdDecompressAsync(frame);
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
