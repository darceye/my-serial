/**
 * Slices a chunk stream into logical rows for display.
 *
 * Pure functions — no DOM, no Svelte. Unit-testable. The OutputView component
 * calls `sliceIntoRows` reactively when chunks or displayMode change, then
 * virtual-scrolls over the resulting `Row[]`.
 *
 * Row boundaries:
 *  - ascii / ascii+hex: split on \n. A trailing partial line (no terminating
 *    \n) is kept as its own row so streaming data shows up immediately.
 *  - hex: fixed-width rows of 16 bytes (ignoring newlines in the data — hex
 *    dumps traditionally break at 16 regardless of content).
 *
 * Each row carries:
 *  - its source slice (byte range + owning chunk reference for tooltip),
 *  - decoded text (ascii modes),
 *  - per-row receive timestamp (for line-prefix timestamp).
 */

import type { DataChunk } from "./rx-buffer";
import type { ChunkDir } from "./rx-buffer";

/** A single rendered row in the output view. */
export interface Row {
  /** Display mode that produced this row. */
  mode: "ascii" | "hex" | "ascii+hex";
  /** First byte's global offset (for ruler alignment + tooltip lookup). */
  startOffset: number;
  /** Raw bytes covered by this row. ascii modes: bytes of the row's text;
   *  hex modes: exactly 16 (or fewer for the final row). */
  bytes: Uint8Array;
  /** UTF-8 decoded text of this row (ascii modes only; empty for pure hex). */
  text: string;
  /** Direction of the row (from the chunk that produced its first byte).
   *  Used for tx/rx coloring. */
  dir: ChunkDir;
  /** Receive timestamp of the chunk that produced this row's first byte.
   *  Used for the line-prefix timestamp. */
  ts: number;
  /** True if this row's source chunk ended without a \n — i.e., more bytes
   *  may still arrive for this logical line. We keep it as a row anyway so
   *  streaming data is visible immediately, but downstream code can choose
   *  to merge it with the next chunk's continuation. */
  partial: boolean;
}

/** Bytes per row in pure hex mode. Traditional hex-dump width. */
export const HEX_BYTES_PER_ROW = 16;

/**
 * Slice chunks into rows according to the display mode.
 *
 * For ascii/ascii+hex: splits on \n across chunk boundaries. A \r\n pair is
 * treated as a single line break (the \r is stripped from the row text but
 * kept in bytes for fidelity). Bare \r is also a line break (some devices
 * use it instead of \n).
 *
 * For hex: ignores content newlines, just chunks bytes into 16-byte rows.
 */
export function sliceIntoRows(
  chunks: DataChunk[],
  mode: "ascii" | "hex" | "ascii+hex",
): Row[] {
  if (mode === "hex") return sliceHexRows(chunks);
  return sliceAsciiRows(chunks, mode);
}

/** Hex mode: 16-byte rows, ignoring line content. */
function sliceHexRows(chunks: DataChunk[]): Row[] {
  const rows: Row[] = [];
  let buffer: number[] = [];
  let rowStartOffset = 0;
  let rowDir: ChunkDir = "rx";
  let rowTs = 0;
  let started = false;

  const flush = (final: boolean) => {
    if (buffer.length === 0 && !final) return;
    if (buffer.length === 0) return;
    const bytes = new Uint8Array(buffer);
    rows.push({
      mode: "hex",
      startOffset: rowStartOffset,
      bytes,
      text: "",
      dir: rowDir,
      ts: rowTs,
      partial: false,
    });
    buffer = [];
    started = false;
  };

  for (const chunk of chunks) {
    if (chunk.dir === "system") {
      // System markers (reconnect divider): flush current hex row, then emit
      // the marker as its own text-only row.
      flush(true);
      if (chunk.text) {
        rows.push({
          mode: "hex",
          startOffset: chunk.offset,
          bytes: new Uint8Array(0),
          text: chunk.text,
          dir: "system",
          ts: chunk.ts,
          partial: false,
        });
      }
      continue;
    }
    for (let i = 0; i < chunk.bytes.length; i++) {
      if (!started) {
        rowStartOffset = chunk.offset + i;
        rowDir = chunk.dir;
        rowTs = chunk.ts;
        started = true;
      }
      buffer.push(chunk.bytes[i]);
      if (buffer.length >= HEX_BYTES_PER_ROW) flush(false);
    }
  }
  flush(true);
  return rows;
}

/** Ascii / ascii+hex mode: split on line boundaries across chunks. */
function sliceAsciiRows(
  chunks: DataChunk[],
  mode: "ascii" | "ascii+hex",
): Row[] {
  const rows: Row[] = [];
  // Pending row state — accumulates across chunks until a newline arrives.
  let pendingBytes: number[] = [];
  let pendingStartOffset = 0;
  let pendingDir: ChunkDir = "rx";
  let pendingTs = 0;
  let hasPending = false;

  const startRow = (chunk: DataChunk, byteIdx: number) => {
    pendingStartOffset = chunk.offset + byteIdx;
    pendingDir = chunk.dir;
    pendingTs = chunk.ts;
    pendingBytes = [];
    hasPending = true;
  };

  const flushRow = (partial: boolean) => {
    if (!hasPending) return;
    const bytes = new Uint8Array(pendingBytes);
    // Decode the row's bytes as UTF-8 (rows may split a multi-byte char if
    // the device sends \n mid-character; that's rare and from_utf8_lossy
    // handles it gracefully with the replacement char).
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    rows.push({
      mode,
      startOffset: pendingStartOffset,
      bytes,
      text,
      dir: pendingDir,
      ts: pendingTs,
      partial,
    });
    hasPending = false;
    pendingBytes = [];
  };

  for (const chunk of chunks) {
    if (chunk.dir === "system") {
      // Flush any pending row, then emit the marker as its own row.
      flushRow(false);
      if (chunk.text) {
        rows.push({
          mode,
          startOffset: chunk.offset,
          bytes: new Uint8Array(0),
          text: chunk.text,
          dir: "system",
          ts: chunk.ts,
          partial: false,
        });
      }
      continue;
    }

    for (let i = 0; i < chunk.bytes.length; i++) {
      const b = chunk.bytes[i];
      // Recognize line breaks: \n, bare \r, or \r\n (consume \r before \n).
      if (b === 0x0a) {
        // \n — flush current row. If the last pending byte was \r, drop it
        // (it was the CRLF pair's CR, already did its job by signaling EOL).
        if (pendingBytes.length > 0 && pendingBytes[pendingBytes.length - 1] === 0x0d) {
          pendingBytes.pop();
        }
        flushRow(false);
        continue;
      }
      if (b === 0x0d) {
        // \r — peek next byte: if it's \n, defer to the \n handler above
        // (we push the \r here; the \n handler will pop it). If standalone,
        // treat as a line break right now.
        const nextByte = chunk.bytes[i + 1];
        const atChunkEnd = i === chunk.bytes.length - 1;
        if (!atChunkEnd && nextByte !== 0x0a) {
          // Standalone \r mid-chunk: line break now.
          flushRow(false);
          startRow(chunk, i + 1);
          continue;
        }
        // Otherwise: it's part of \r\n (or at chunk boundary, defer).
        if (!hasPending) startRow(chunk, i);
        pendingBytes.push(b);
        continue;
      }
      if (!hasPending) startRow(chunk, i);
      pendingBytes.push(b);
    }
  }
  // Trailing partial row (streaming data without a closing \n).
  flushRow(true);
  return rows;
}

/** Format a Date as HH:MM:SS.mmm in local time. */
export function formatAbsoluteTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const fff = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${fff}`;
}

/** Format seconds since session start as +SSS.SSSs. */
export function formatRelativeTime(ts: number, sessionStart: number): string {
  const elapsed = (ts - sessionStart) / 1000;
  return `+${elapsed.toFixed(3)}s`;
}

/** A display token for hex/ascii+hex rendering — a single byte, or a single
 *  decoded character spanning multiple bytes (UTF-8 multi-byte sequences).
 *
 *  In ascii+hex mode, the hex row renders `byteCount` cells (one per byte),
 *  and the ascii row renders ONE cell that visually spans `byteCount` grid
 *  columns — so a CJK character like "你" (3 bytes) takes 3 hex cells above
 *  but only 1 ascii cell below, with the cell stretched to 3-grid-column
 *  width. This is the alignment trick xterm cannot do.
 */
export interface ByteToken {
  /** Display character for the ascii row. "." for non-printable bytes;
   *  the actual character for printable ASCII and complete UTF-8 sequences. */
  char: string;
  /** How many bytes this token consumes (1 for ASCII, 2-4 for UTF-8). */
  byteCount: number;
  /** True if this token represents a complete UTF-8 multi-byte character
   *  (so its char is meaningful, not just a placeholder). */
  isMultiByte: boolean;
  /** Global byte offset of this token's first byte (tooltip lookup). */
  offset: number;
}

/** UTF-8 sequence length from the high nibble of the lead byte.
 *  Index = (leadByte >> 4). 0 = invalid/continuation byte (treat as 1 byte
 *  with "." display). 1 = ASCII (0x00-0x7F). 2/3/4 = multi-byte. */
const UTF8_LEN_FROM_NIBBLE = [1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 2, 2, 3, 4];

/** Split a row's bytes into display tokens for hex/ascii rendering.
 *
 *  Walks bytes honoring UTF-8 boundaries:
 *  - ASCII (< 0x80): 1 byte, char = printable-or-".".
 *  - UTF-8 lead (0xC0..): try to consume the full sequence; if it decodes,
 *    emit one token spanning N bytes with the decoded char; if incomplete at
 *    row end, fall back to per-byte "." tokens.
 *  - Stray continuation bytes / invalid sequences: per-byte ".".
 */
export function tokenizeBytes(bytes: Uint8Array, startOffset: number): ByteToken[] {
  const tokens: ByteToken[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) {
      // ASCII byte.
      tokens.push({
        char: b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".",
        byteCount: 1,
        isMultiByte: false,
        offset: startOffset + i,
      });
      i++;
      continue;
    }
    // Possible UTF-8 lead byte. Determine expected length from high nibble.
    const expected = UTF8_LEN_FROM_NIBBLE[b >> 4];
    if (expected >= 2 && i + expected <= bytes.length) {
      // Validate continuation bytes all start with 10xxxxxx.
      let valid = true;
      for (let j = 1; j < expected; j++) {
        if ((bytes[i + j] & 0xc0) !== 0x80) { valid = false; break; }
      }
      if (valid) {
        const ch = decoder.decode(bytes.subarray(i, i + expected));
        // On success ch is one character; if decoding produced the
        // replacement char, the sequence was malformed — fall through.
        if (ch.length > 0 && ch.charCodeAt(0) !== 0xfffd) {
          tokens.push({
            char: ch,
            byteCount: expected,
            isMultiByte: true,
            offset: startOffset + i,
          });
          i += expected;
          continue;
        }
      }
    }
    // Invalid or truncated — emit single-byte ".".
    tokens.push({
      char: ".",
      byteCount: 1,
      isMultiByte: false,
      offset: startOffset + i,
    });
    i++;
  }
  return tokens;
}
