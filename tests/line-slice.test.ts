/**
 * Hand-rolled unit tests for the line-slice module.
 *
 * Run from project root:
 *   npx tsx tests/line-slice.test.ts
 */
import {
  sliceIntoRows,
  tokenizeBytes,
  formatAbsoluteTime,
  formatRelativeTime,
} from "../src/lib/services/line-slice";
import type { DataChunk } from "../src/lib/services/rx-buffer";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); }
}
function eq<T>(actual: T, expected: T, msg: string): void {
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function bytes(...arr: number[]): Uint8Array { return new Uint8Array(arr); }
function test(name: string, fn: () => void): void {
  console.log(`• ${name}`);
  try { fn(); } catch (e) {
    fail++; console.error(`  ✗ threw: ${(e as Error).message}`);
  }
}

function mkChunk(ts: number, dir: "rx" | "tx", arr: number[], offset: number, text = ""): DataChunk {
  return { ts, dir, bytes: bytes(...arr), text, offset };
}

console.log("line-slice tests\n");

// === tokenizeBytes ===

test("tokenize — pure ASCII", () => {
  const t = tokenizeBytes(bytes(0x41, 0x42, 0x43), 0);
  eq(t.length, 3, "3 tokens for 3 ASCII bytes");
  eq(t[0].char, "A", "token 0 = A");
  eq(t[0].byteCount, 1, "token 0 = 1 byte");
  eq(t[0].isMultiByte, false, "token 0 not multibyte");
  eq(t[2].offset, 2, "token 2 offset = 2");
});

test("tokenize — non-printable ASCII → '.'", () => {
  const t = tokenizeBytes(bytes(0x00, 0x1f, 0x7f), 100);
  eq(t[0].char, ".", "NUL → .");
  eq(t[1].char, ".", "0x1f → .");
  eq(t[2].char, ".", "DEL → .");
  eq(t[0].offset, 100, "offset passed through");
});

test("tokenize — UTF-8 multi-byte (Chinese '你' = E4 BD A0)", () => {
  const t = tokenizeBytes(bytes(0xe4, 0xbd, 0xa0), 0);
  eq(t.length, 1, "3 bytes → 1 token");
  eq(t[0].char, "你", "decoded to 你");
  eq(t[0].byteCount, 3, "byteCount = 3");
  eq(t[0].isMultiByte, true, "isMultiByte = true");
  eq(t[0].offset, 0, "offset = 0");
});

test("tokenize — mixed ASCII + CJK", () => {
  // "Hi你" = H i 你(E4 BD A0)
  const t = tokenizeBytes(bytes(0x48, 0x69, 0xe4, 0xbd, 0xa0), 10);
  eq(t.length, 3, "3 tokens: H, i, 你");
  eq(t[0].char, "H", "H");
  eq(t[1].char, "i", "i");
  eq(t[2].char, "你", "你");
  eq(t[2].byteCount, 3, "你 spans 3 bytes");
  eq(t[2].offset, 12, "你 offset = 10 + 2");
});

test("tokenize — 4-byte emoji (😀 = F0 9F 98 80)", () => {
  const t = tokenizeBytes(bytes(0xf0, 0x9f, 0x98, 0x80), 0);
  eq(t.length, 1, "4 bytes → 1 token");
  eq(t[0].char, "😀", "decoded emoji");
  eq(t[0].byteCount, 4, "spans 4 bytes");
});

test("tokenize — truncated UTF-8 (lead byte at end)", () => {
  // E4 BD at end (incomplete 你) → 2 single-byte "."
  const t = tokenizeBytes(bytes(0xe4, 0xbd), 0);
  eq(t.length, 2, "2 fallback tokens");
  eq(t[0].char, ".", "first byte → .");
  eq(t[0].byteCount, 1, "single byte");
  eq(t[0].isMultiByte, false, "not multibyte");
});

test("tokenize — stray continuation byte", () => {
  // A0 alone (no lead) → single "."
  const t = tokenizeBytes(bytes(0xa0), 0);
  eq(t.length, 1, "1 token");
  eq(t[0].char, ".", "→ .");
});

test("tokenize — invalid lead (0xFE, 0xFF never valid)", () => {
  const t = tokenizeBytes(bytes(0xfe, 0xff), 0);
  eq(t.length, 2, "2 tokens, each 1 byte");
  eq(t[0].char, ".", "0xfe → .");
});

// === sliceIntoRows (ascii mode) ===

test("slice ascii — single chunk single line", () => {
  const chunks = [mkChunk(1000, "rx", [0x41, 0x42, 0x43], 0, "ABC")];
  const rows = sliceIntoRows(chunks, "ascii");
  eq(rows.length, 1, "1 row (partial, no \\n)");
  eq(rows[0].text, "ABC", "text = ABC");
  eq(rows[0].partial, true, "partial = true");
  eq(rows[0].dir, "rx", "dir = rx");
  eq(rows[0].ts, 1000, "ts = 1000");
});

test("slice ascii — \\n line breaks", () => {
  // "A\nB\n" → 2 rows: A, B
  const chunks = [mkChunk(1000, "rx", [0x41, 0x0a, 0x42, 0x0a], 0, "A\nB\n")];
  const rows = sliceIntoRows(chunks, "ascii");
  eq(rows.length, 2, "2 rows");
  eq(rows[0].text, "A", "row 0 = A");
  eq(rows[0].partial, false, "row 0 not partial (has \\n)");
  eq(rows[1].text, "B", "row 1 = B");
});

test("slice ascii — CRLF collapsed (\\r dropped)", () => {
  // "A\r\nB" → row A (CRLF), partial row B
  const chunks = [mkChunk(1000, "rx", [0x41, 0x0d, 0x0a, 0x42], 0, "A\r\nB")];
  const rows = sliceIntoRows(chunks, "ascii");
  eq(rows.length, 2, "2 rows");
  eq(rows[0].text, "A", "row 0 = A (\\r dropped)");
  eq(rows[0].bytes.length, 1, "row 0 bytes = just A");
});

test("slice ascii — bare \\r is a line break", () => {
  // "A\rB" (no \n) → rows: A, B
  const chunks = [mkChunk(1000, "rx", [0x41, 0x0d, 0x42], 0, "A\rB")];
  const rows = sliceIntoRows(chunks, "ascii");
  eq(rows.length, 2, "2 rows");
  eq(rows[0].text, "A", "row 0 = A");
  eq(rows[1].text, "B", "row 1 = B");
});

test("slice ascii — line spans multiple chunks", () => {
  // chunk0 = "AB", chunk1 = "CD\n" → one row "ABCD" (not partial)
  const chunks = [
    mkChunk(1000, "rx", [0x41, 0x42], 0, "AB"),
    mkChunk(2000, "rx", [0x43, 0x44, 0x0a], 2, "CD\n"),
  ];
  const rows = sliceIntoRows(chunks, "ascii");
  eq(rows.length, 1, "1 row (merged across chunks)");
  eq(rows[0].text, "ABCD", "row = ABCD");
  eq(rows[0].ts, 1000, "ts from first chunk");
  eq(rows[0].bytes.length, 4, "4 bytes total");
});

test("slice ascii — system marker becomes its own row", () => {
  const chunks = [
    mkChunk(1000, "rx", [0x41, 0x0a], 0, "A\n"),
    { ts: 1500, dir: "system", bytes: new Uint8Array(0), text: "--- reconnect ---", offset: 2 },
    mkChunk(2000, "rx", [0x42, 0x0a], 2, "B\n"),
  ];
  const rows = sliceIntoRows(chunks, "ascii");
  eq(rows.length, 3, "3 rows: A, marker, B");
  eq(rows[1].dir, "system", "row 1 is system");
  eq(rows[1].text, "--- reconnect ---", "marker text");
});

// === sliceIntoRows (hex mode) ===

test("slice hex — 16-byte rows regardless of content", () => {
  // 20 bytes → 2 rows (16 + 4)
  const arr = Array.from({ length: 20 }, (_, i) => i);
  const chunks = [mkChunk(1000, "rx", arr, 0, "")];
  const rows = sliceIntoRows(chunks, "hex");
  eq(rows.length, 2, "2 hex rows");
  eq(rows[0].bytes.length, 16, "row 0 = 16 bytes");
  eq(rows[1].bytes.length, 4, "row 1 = 4 bytes");
  eq(rows[1].startOffset, 16, "row 1 offset = 16");
});

test("slice hex — newlines in content ignored", () => {
  // bytes with embedded \n still flow as one hex row until 16
  const chunks = [mkChunk(1000, "rx", [0x41, 0x0a, 0x42], 0, "")];
  const rows = sliceIntoRows(chunks, "hex");
  eq(rows.length, 1, "1 row (\\n doesn't break hex)");
  eq(rows[0].bytes.length, 3, "3 bytes");
});

// === sliceIntoRows (ascii+hex mode) ===
// ascii+hex shares the 16-byte-row slicer with pure hex, but must also fill
// row.text for the ascii line and preserve ALL bytes (including \r \n).

test("slice ascii+hex — uses 16-byte rows like hex mode", () => {
  // 20 bytes → 2 rows (16 + 4)
  const arr = Array.from({ length: 20 }, (_, i) => i);
  const chunks = [mkChunk(1000, "rx", arr, 0, "")];
  const rows = sliceIntoRows(chunks, "ascii+hex");
  eq(rows.length, 2, "2 rows");
  eq(rows[0].bytes.length, 16, "row 0 = 16 bytes");
  eq(rows[0].mode, "ascii+hex", "mode tag");
});

test("slice ascii+hex — preserves \\r\\n bytes (shows 0d 0a in hex)", () => {
  // "Hi\r\n" = 48 69 0d 0a — all 4 bytes must appear in row.bytes
  const chunks = [mkChunk(1000, "rx", [0x48, 0x69, 0x0d, 0x0a], 0, "Hi\r\n")];
  const rows = sliceIntoRows(chunks, "ascii+hex");
  eq(rows.length, 1, "1 row");
  eq(rows[0].bytes.length, 4, "all 4 bytes preserved");
  eq(rows[0].bytes[2], 0x0d, "byte 2 = 0x0d (CR)");
  eq(rows[0].bytes[3], 0x0a, "byte 3 = 0x0a (LF)");
});

test("slice ascii+hex — row.text is decoded for ascii line rendering", () => {
  // ascii+hex rows need text populated so the ascii row can render.
  const chunks = [mkChunk(1000, "rx", [0x41, 0x42, 0x43], 0, "ABC")];
  const rows = sliceIntoRows(chunks, "ascii+hex");
  eq(rows[0].text, "ABC", "text decoded");
});

// === time formatting ===

test("formatAbsoluteTime — HH:MM:SS.mmm", () => {
  // Use a fixed timestamp: 2024-01-15 14:23:05.007 UTC.
  // Local time varies by TZ, so just check the format.
  const s = formatAbsoluteTime(Date.UTC(2024, 0, 15, 14, 23, 5, 7));
  ok(/^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(s), `format matches HH:MM:SS.mmm: ${s}`);
});

test("formatRelativeTime — +seconds.sss", () => {
  const s = formatRelativeTime(1500, 1000);
  eq(s, "+0.500s", "500ms = +0.500s");
  const s2 = formatRelativeTime(61000, 1000);
  eq(s2, "+60.000s", "60s = +60.000s");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
