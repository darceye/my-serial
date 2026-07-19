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

/** Which control bytes / sequences trigger a line break. */
export type CharBreak = "nul" | "lf" | "cr" | "crlf" | "etx";

/** A user-configurable set of line-break rules. All four rule families may be
 *  enabled simultaneously; the engine breaks at whichever fires first while
 *  walking bytes left-to-right.
 *
 *  - `charBreaks`: control bytes that end a line. The bytes themselves are
 *    CONSUMED (not kept in row.bytes) in ascii mode, but PRESERVED (shown as
 *    0d/0a in the hex view) in hex / ascii+hex mode. CRLF is a special case:
 *    when enabled, a 0x0d followed immediately by 0x0a is treated as one
 *    break (in ascii mode the 0x0d is dropped, the 0x0a ends the line).
 *  - `customBreaks`: arbitrary byte sequences; matched greedily and CONSUMED
 *    the same way as charBreaks.
 *  - `breakEveryNBytes`: hard byte-count cap per row. 0 disables. In hex /
 *    ascii+hex mode this also acts as the hex-dump row width.
 *  - `breakOnIdleMs`: if two consecutive non-system chunks arrive more than
 *    this many ms apart, the first chunk's trailing row is closed before the
 *    new chunk starts. 0 disables. */
export interface LineBreakRules {
  charBreaks: CharBreak[];
  customBreaks: { enabled: boolean; sequences: Uint8Array[] };
  breakEveryNBytes: number;
  breakOnIdleMs: number;
}

/** Rules that reproduce the pre-configurable behaviour:
 *  ascii  → split on \n + standalone \r, with CRLF collapsing to one break,
 *  hex    → fixed 16-byte rows, no char breaks. */
export const DEFAULT_LINE_BREAK_RULES: LineBreakRules = {
  charBreaks: ["crlf", "lf", "cr"],
  customBreaks: { enabled: false, sequences: [] },
  breakEveryNBytes: HEX_BYTES_PER_ROW, // only applied in hex / ascii+hex
  breakOnIdleMs: 0,
};

/** Parse a single custom-break line. Format determines interpretation:
 *  - "ascii": interpret common backslash escapes (\r \n \t \0 \\ \xNN) and
 *    otherwise treat each char as its UTF-8 byte(s).
 *  - "hex":   extract hex byte pairs (whitespace/comma separated), e.g.
 *    "0d 0a" or "0d,0a" or "0d0a".
 *  Returns an empty Uint8Array if nothing valid could be parsed. */
export function parseCustomBreakLine(line: string, format: "ascii" | "hex"): Uint8Array {
  if (format === "hex") {
    const cleaned = line.replace(/0x/gi, "").replace(/[^0-9a-fA-F]/g, " ");
    const parts = cleaned.split(/\s+/).filter((s) => s.length > 0);
    const out: number[] = [];
    for (const p of parts) {
      // Allow odd-length runs by zero-prefixing the leading nibble.
      const padded = p.length % 2 === 0 ? p : "0" + p;
      for (let k = 0; k < padded.length; k += 2) {
        const v = parseInt(padded.slice(k, k + 2), 16);
        if (!Number.isNaN(v)) out.push(v);
      }
    }
    return new Uint8Array(out);
  }
  // ascii: walk the string interpreting escapes; otherwise UTF-8 encode.
  const out: number[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "\\" && i + 1 < line.length) {
      const next = line[i + 1];
      const map: Record<string, number> = {
        r: 0x0d, n: 0x0a, t: 0x09, "0": 0x00, "\\": 0x5c, b: 0x08, f: 0x0c, v: 0x0b, a: 0x07,
      };
      if (next === "x" && i + 3 < line.length) {
        const hex = line.slice(i + 2, i + 4);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out.push(parseInt(hex, 16));
          i += 4;
          continue;
        }
      }
      if (next in map) { out.push(map[next]); i += 2; continue; }
      // Unknown escape: keep the backslash literally.
      out.push(0x5c);
      i++;
      continue;
    }
    // Plain char → UTF-8 encode.
    for (const b of new TextEncoder().encode(ch)) out.push(b);
    i++;
  }
  return new Uint8Array(out);
}

/** Parse a multi-line custom-break textarea into a list of non-empty sequences. */
export function parseCustomBreakInput(text: string, format: "ascii" | "hex"): Uint8Array[] {
  const seqs: Uint8Array[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const seq = parseCustomBreakLine(trimmed, format);
    if (seq.length > 0) seqs.push(seq);
  }
  return seqs;
}

/**
 * Slice chunks into rows according to the display mode + line-break rules.
 *
 * ascii: splits on configured char/custom breaks across chunk boundaries.
 * Break bytes are NOT included in row.bytes — the row is the visible text.
 * A trailing partial line is kept so streaming data shows immediately.
 *
 * hex / ascii+hex: rows up to `breakEveryNBytes` wide (default 16). Configured
 * char/custom breaks also apply, but the break bytes are PRESERVED in row.bytes
 * so the hex view still shows 0d 0a and the ascii row stays aligned.
 */
export function sliceIntoRows(
  chunks: DataChunk[],
  mode: "ascii" | "hex" | "ascii+hex",
  rules: LineBreakRules = DEFAULT_LINE_BREAK_RULES,
): Row[] {
  if (mode === "ascii") return sliceAsciiRows(chunks, rules);
  return sliceHexRows(chunks, mode, rules);
}

/** Hex / ascii+hex mode: up to `rules.breakEveryNBytes`-byte rows (default 16).
 *  All bytes (including \r, \n) are preserved in row.bytes so the hex view
 *  shows control characters. row.mode reflects the caller's mode so the
 *  renderer knows whether to also draw the ascii line. */
function sliceHexRows(
  chunks: DataChunk[],
  mode: "hex" | "ascii+hex",
  rules: LineBreakRules,
): Row[] {
  const rowWidth = rules.breakEveryNBytes > 0 ? rules.breakEveryNBytes : HEX_BYTES_PER_ROW;
  const rows: Row[] = [];
  let buffer: number[] = [];
  let rowStartOffset = 0;
  let rowDir: ChunkDir = "rx";
  let rowTs = 0;
  let started = false;

  const flush = () => {
    if (buffer.length === 0) return;
    const bytes = new Uint8Array(buffer);
    // Decode for the ascii row. Use lossy decode so stray bytes don't crash;
    // the ascii renderer replaces non-printables with "." anyway.
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    rows.push({
      mode,
      startOffset: rowStartOffset,
      bytes,
      text,
      dir: rowDir,
      ts: rowTs,
      partial: false,
    });
    buffer = [];
    started = false;
  };

  const cr = compileRules(rules);
  const hasCharBreaks = cr.wantNUL || cr.wantLF || cr.wantCR || cr.wantCRLF || cr.wantETX;
  const hasCustomBreaks = cr.customSeqs.length > 0;
  const hasBreaks = hasCharBreaks || hasCustomBreaks;

  // Flatten non-system chunks into runs for cross-chunk break matching.
  const runs: { chunk: DataChunk; start: number; len: number }[] = [];
  for (const c of chunks) {
    if (c.dir === "system") continue;
    if (c.bytes.length > 0) runs.push({ chunk: c, start: 0, len: c.bytes.length });
  }
  const runOf = (chunk: DataChunk) => runs.find((r) => r.chunk === chunk) ?? null;

  const byteAt = (runIdx: number, byteIdx: number): number | undefined => {
    if (runIdx >= runs.length) return undefined;
    const r = runs[runIdx];
    if (byteIdx >= r.len) return undefined;
    return r.chunk.bytes[r.start + byteIdx];
  };

  const breakLenAt = (runIdx: number, byteIdx: number): number => {
    const b = byteAt(runIdx, byteIdx);
    if (b === undefined) return 0;
    if (hasCustomBreaks) {
      for (const sq of cr.customSeqs) {
        let ok = true;
        for (let k = 0; k < sq.length; k++) {
          let ri = runIdx, bi = byteIdx + k;
          while (bi >= runs[ri].len) { bi -= runs[ri].len; ri++; if (ri >= runs.length) { ok = false; break; } }
          if (!ok) break;
          if (runs[ri].chunk.bytes[runs[ri].start + bi] !== sq[k]) { ok = false; break; }
        }
        if (ok) return sq.length;
      }
    }
    if (cr.wantCRLF && b === 0x0d) {
      const next = byteAt(runIdx, byteIdx + 1);
      if (next === 0x0a) return 2;
    }
    if (cr.wantLF && b === 0x0a) return 1;
    if (cr.wantCR && b === 0x0d) return 1;
    if (cr.wantNUL && b === 0x00) return 1;
    if (cr.wantETX && b === 0x03) return 1;
    return 0;
  };

  const advance = (runIdx: number, byteIdx: number, n: number): { runIdx: number; byteIdx: number } => {
    let ri = runIdx, bi = byteIdx + n;
    while (ri < runs.length && bi >= runs[ri].len) { bi -= runs[ri].len; ri++; }
    return { runIdx: ri, byteIdx: bi };
  };

  let curRun = 0;
  let curByte = 0;
  let prevNonSystemTs: number | null = null;

  for (const chunk of chunks) {
    if (chunk.dir === "system") {
      flush();
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

    if (cr.breakOnIdleMs > 0 && prevNonSystemTs !== null
        && chunk.ts - prevNonSystemTs > cr.breakOnIdleMs) {
      flush();
    }
    prevNonSystemTs = chunk.ts;

    const myRun = runOf(chunk);
    if (!myRun) continue;
    const myRunIdx = runs.indexOf(myRun);

    while (curRun < runs.length && curRun <= myRunIdx) {
      if (curRun > myRunIdx) break;
      const r = runs[curRun];
      if (!started) {
        rowStartOffset = r.chunk.offset + r.start + curByte;
        rowDir = r.chunk.dir;
        rowTs = r.chunk.ts;
        started = true;
        buffer = [];
      }
      // Check for a break at the cursor BEFORE pushing the byte. In hex mode
      // the break bytes are PRESERVED, so we push them then flush.
      const blen = hasBreaks ? breakLenAt(curRun, curByte) : 0;
      if (blen > 0) {
        // Append the break bytes (all of them, even if cross-chunk).
        for (let k = 0; k < blen; k++) {
          const cur = advance(curRun, curByte, k);
          if (cur.runIdx >= runs.length) break;
          const rr = runs[cur.runIdx];
          buffer.push(rr.chunk.bytes[rr.start + cur.byteIdx]);
        }
        flush();
        const adv = advance(curRun, curByte, blen);
        curRun = adv.runIdx; curByte = adv.byteIdx;
        continue;
      }
      buffer.push(r.chunk.bytes[r.start + curByte]);
      if (buffer.length >= rowWidth) flush();
      const adv = advance(curRun, curByte, 1);
      curRun = adv.runIdx; curByte = adv.byteIdx;
    }
  }
  flush();
  return rows;
}

/** Ascii mode: split on line boundaries across chunks. */
function sliceAsciiRows(chunks: DataChunk[], rules: LineBreakRules): Row[] {
  const rows: Row[] = [];
  // Pending row state — accumulates across chunks until a break arrives.
  let pendingBytes: number[] = [];
  let pendingStartOffset = 0;
  let pendingDir: ChunkDir = "rx";
  let pendingTs = 0;
  let hasPending = false;

  const startRow = (offset: number, dir: ChunkDir, ts: number) => {
    pendingStartOffset = offset;
    pendingDir = dir;
    pendingTs = ts;
    pendingBytes = [];
    hasPending = true;
  };

  const flushRow = (partial: boolean) => {
    if (!hasPending) return;
    const bytes = new Uint8Array(pendingBytes);
    // Decode the row's bytes as UTF-8 (rows may split a multi-byte char if
    // the device sends a break mid-character; from_utf8_lossy handles it
    // gracefully with the replacement char).
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    rows.push({
      mode: "ascii",
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

  const cr = compileRules(rules);
  const hasCharBreaks = cr.wantNUL || cr.wantLF || cr.wantCR || cr.wantCRLF || cr.wantETX;
  const hasCustomBreaks = cr.customSeqs.length > 0;
  const hasBreaks = hasCharBreaks || hasCustomBreaks;

  // Flatten non-system chunks into a linear byte cursor: a list of
  // { chunk, start, len } runs that we walk with (runIdx, byteIdx). This lets
  // CRLF / custom-sequence breaks span chunk boundaries naturally.
  const runs: { chunk: DataChunk; start: number; len: number }[] = [];
  for (const c of chunks) {
    if (c.dir === "system") continue;
    if (c.bytes.length > 0) runs.push({ chunk: c, start: 0, len: c.bytes.length });
  }
  // System chunks keep their original positions so we can interleave markers.
  // Build a parallel list of "events" in original order: either a system
  // marker emission, or a break-check at a run boundary for breakOnIdleMs.
  // Easiest: iterate chunks in order, but skip-ahead through runs.
  const runOf = (chunk: DataChunk) => runs.find((r) => r.chunk === chunk) ?? null;

  /** Byte at global run-cursor (runIdx, byteIdx). Returns undefined past end. */
  const byteAt = (runIdx: number, byteIdx: number): number | undefined => {
    if (runIdx >= runs.length) return undefined;
    const r = runs[runIdx];
    if (byteIdx >= r.len) return undefined;
    return r.chunk.bytes[r.start + byteIdx];
  };

  /** Try to consume a break at (runIdx, byteIdx). Returns break length (>0)
   *  if a break (char or custom) starts here, else 0. Supports cross-chunk. */
  const breakLenAt = (runIdx: number, byteIdx: number): number => {
    const b = byteAt(runIdx, byteIdx);
    if (b === undefined) return 0;
    // Custom sequences (may span chunks).
    if (hasCustomBreaks) {
      for (const sq of cr.customSeqs) {
        let ok = true;
        for (let k = 0; k < sq.length; k++) {
          // Walk the cursor forward k bytes.
          let ri = runIdx, bi = byteIdx + k;
          while (bi >= runs[ri].len) { bi -= runs[ri].len; ri++; if (ri >= runs.length) { ok = false; break; } }
          if (!ok) break;
          if (runs[ri].chunk.bytes[runs[ri].start + bi] !== sq[k]) { ok = false; break; }
        }
        if (ok) return sq.length;
      }
    }
    // CRLF (highest priority among char breaks; 2 bytes, may span chunks).
    if (cr.wantCRLF && b === 0x0d) {
      const next = byteAt(runIdx, byteIdx + 1);
      if (next === 0x0a) return 2;
    }
    // Single-byte char breaks.
    if (cr.wantLF && b === 0x0a) return 1;
    if (cr.wantCR && b === 0x0d) return 1;
    if (cr.wantNUL && b === 0x00) return 1;
    if (cr.wantETX && b === 0x03) return 1;
    return 0;
  };

  /** Advance a (runIdx, byteIdx) cursor by `n` bytes, crossing run boundaries.
   *  Returns the new {runIdx, byteIdx}; if it runs off the end, runIdx=runs.length. */
  const advance = (runIdx: number, byteIdx: number, n: number): { runIdx: number; byteIdx: number } => {
    let ri = runIdx, bi = byteIdx + n, riOut = ri;
    while (ri < runs.length && bi >= runs[ri].len) { bi -= runs[ri].len; ri++; riOut = ri; }
    return { runIdx: ri, byteIdx: bi };
  };

  // Walk chunks in original order so system markers and idle breaks interleave
  // correctly. We maintain a global cursor into `runs` so each chunk's bytes
  // are visited exactly once even when breaks span boundaries.
  let curRun = 0;       // index into runs[] of the next unprocessed byte
  let curByte = 0;      // byte index within runs[curRun]
  let prevNonSystemTs: number | null = null;

  for (const chunk of chunks) {
    if (chunk.dir === "system") {
      flushRow(false);
      if (chunk.text) {
        rows.push({
          mode: "ascii",
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

    // breakOnIdleMs: close the trailing row if this chunk arrived late.
    if (cr.breakOnIdleMs > 0 && prevNonSystemTs !== null
        && chunk.ts - prevNonSystemTs > cr.breakOnIdleMs) {
      flushRow(false);
    }
    prevNonSystemTs = chunk.ts;

    // Sync the cursor to this chunk's first run (handles cross-chunk breaks
    // that already consumed some of this chunk's bytes).
    const myRun = runOf(chunk);
    if (!myRun) continue;
    const myRunIdx = runs.indexOf(myRun);

    // Process every byte of this chunk that hasn't been consumed by a prior
    // cross-chunk break. We loop until the cursor moves past this chunk's run.
    while (curRun < runs.length && curRun <= myRunIdx) {
      // If cursor is on a later run already, this chunk is fully consumed.
      if (curRun > myRunIdx) break;
      // Start a row here if needed.
      if (!hasPending) {
        const r = runs[curRun];
        startRow(r.chunk.offset + r.start + curByte, r.chunk.dir, r.chunk.ts);
      }
      // Check for a break at the cursor.
      let blen = hasBreaks ? breakLenAt(curRun, curByte) : 0;
      if (blen > 0) {
        // Break immediately — flush whatever was pending (may be empty if the
        // break is at row start; that yields an empty row, which is correct
        // for blank lines, but we suppress rows with zero bytes AND a break
        // at start since they would render as empty lines).
        flushRow(false);
        const adv = advance(curRun, curByte, blen);
        curRun = adv.runIdx; curByte = adv.byteIdx;
        continue;
      }
      // No break here: append the byte and apply breakEveryNBytes.
      const r = runs[curRun];
      pendingBytes.push(r.chunk.bytes[r.start + curByte]);
      if (cr.breakEveryN > 0 && pendingBytes.length >= cr.breakEveryN) {
        flushRow(false);
      }
      const adv = advance(curRun, curByte, 1);
      curRun = adv.runIdx; curByte = adv.byteIdx;
    }
  }
  // Trailing partial row (streaming data without a closing break).
  flushRow(true);
  return rows;
}

/** Compiled, fast-to-check form of LineBreakRules. Built once per slice call. */
interface CompiledRules {
  wantNUL: boolean;
  wantLF: boolean;
  wantCR: boolean;
  wantCRLF: boolean;
  wantETX: boolean;
  customSeqs: Uint8Array[];        // non-empty length-1+ sequences only
  maxCustomLen: number;            // longest customSeqs length (0 if none)
  breakEveryN: number;             // 0 = off
  breakOnIdleMs: number;           // 0 = off
}

function compileRules(rules: LineBreakRules): CompiledRules {
  const s = new Set(rules.charBreaks);
  const customSeqs = rules.customBreaks.enabled
    ? rules.customBreaks.sequences.filter((sq) => sq.length > 0)
    : [];
  return {
    wantNUL: s.has("nul"),
    wantLF: s.has("lf"),
    wantCR: s.has("cr"),
    wantCRLF: s.has("crlf"),
    wantETX: s.has("etx"),
    customSeqs,
    maxCustomLen: customSeqs.reduce((m, sq) => Math.max(m, sq.length), 0),
    breakEveryN: rules.breakEveryNBytes > 0 ? rules.breakEveryNBytes : 0,
    breakOnIdleMs: rules.breakOnIdleMs > 0 ? rules.breakOnIdleMs : 0,
  };
}

/** Try to match any custom break sequence at byte offset `i` of `bytes`.
 *  Returns the matched sequence's length, or 0 if no match.
 *  `maxLen` bounds the scan window (caller passes cr.maxCustomLen). */
function matchCustomBreakAt(
  bytes: Uint8Array,
  i: number,
  customSeqs: Uint8Array[],
): number {
  for (const sq of customSeqs) {
    if (i + sq.length > bytes.length) continue;
    let ok = true;
    for (let k = 0; k < sq.length; k++) {
      if (bytes[i + k] !== sq[k]) { ok = false; break; }
    }
    if (ok) return sq.length;
  }
  return 0;
}


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
 *
 *  `showNonPrintable`: when true, replace non-printable bytes with their
 *  Unicode Control Pictures glyph instead of "." — NUL→␀, LF→␊, CR→␍,
 *  ETX→␃, DEL→␡, and other C0 controls via U+2400+offset. Invalid bytes
 *  (>= 0x80 not part of a valid UTF-8 sequence) become ␙ (U+2419).
 */
export function tokenizeBytes(
  bytes: Uint8Array,
  startOffset: number,
  showNonPrintable = false,
): ByteToken[] {
  const tokens: ByteToken[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: false });
  /** Render a non-printable byte as either "." or a Control Pictures glyph. */
  const glyph = (b: number): string => {
    if (!showNonPrintable) return ".";
    if (b === 0x7f) return "\u2421";        // ␡ Symbol For Delete
    if (b < 0x20) return String.fromCharCode(0x2400 + b); // ␀..␟
    return ".";                              // other high bytes (shouldn't reach)
  };
  /** Glyph for an invalid/high byte that isn't valid UTF-8 (>= 0x80). */
  const invalidGlyph = (): string => showNonPrintable ? "\u2419" : "."; // ␙
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) {
      // ASCII byte.
      tokens.push({
        char: b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : glyph(b),
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
    // Invalid or truncated — emit single-byte placeholder.
    tokens.push({
      char: invalidGlyph(),
      byteCount: 1,
      isMultiByte: false,
      offset: startOffset + i,
    });
    i++;
  }
  return tokens;
}
