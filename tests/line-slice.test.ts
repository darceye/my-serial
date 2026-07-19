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
  parseCustomBreakLine,
  parseCustomBreakInput,
  type LineBreakRules,
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
// Hex mode now applies the same default rules as ascii (charBreaks LF/CR/CRLF
// + breakEveryN=16). So binary data containing 0x0a/0x0d DOES break rows,
// and break bytes are PRESERVED in row.bytes (hex dump shows 0d 0a).

test("slice hex — breakEveryN=16 with no break chars → 16-byte rows", () => {
  // 20 printable bytes (no LF/CR/NUL/ETX) → 2 rows (16 + 4)
  const arr = Array.from({ length: 20 }, (_, i) => 0x41 + i); // 'A'..'T'
  const chunks = [mkChunk(1000, "rx", arr, 0, "")];
  const rows = sliceIntoRows(chunks, "hex");
  eq(rows.length, 2, "2 hex rows");
  eq(rows[0].bytes.length, 16, "row 0 = 16 bytes");
  eq(rows[1].bytes.length, 4, "row 1 = 4 bytes");
  eq(rows[1].startOffset, 16, "row 1 offset = 16");
});

test("slice hex — default LF/CR breaks split rows AND preserve break bytes", () => {
  // bytes with embedded \n: A \n B → 2 rows (A\n) and (B). The \n is preserved.
  const chunks = [mkChunk(1000, "rx", [0x41, 0x0a, 0x42], 0, "")];
  const rows = sliceIntoRows(chunks, "hex");
  eq(rows.length, 2, "2 rows (LF breaks hex under default rules)");
  eq(rows[0].bytes.length, 2, "row 0 = A + LF (break byte preserved)");
  eq(rows[0].bytes[1], 0x0a, "LF preserved in hex");
  eq(rows[1].bytes.length, 1, "row 1 = B");
});

test("slice hex — no rules → fixed 16-byte rows, breaks ignored", () => {
  // Empty rules + breakEveryN omitted → fall back to HEX_BYTES_PER_ROW (16).
  const arr = Array.from({ length: 20 }, (_, i) => i); // includes 0x0a/0x0d
  const chunks = [mkChunk(1000, "rx", arr, 0, "")];
  const rows = sliceIntoRows(chunks, "hex", rules({}));
  eq(rows.length, 2, "2 rows (no char breaks, fixed 16)");
  eq(rows[0].bytes.length, 16, "row 0 = 16");
});

// === sliceIntoRows (ascii+hex mode) ===
// ascii+hex shares the engine with pure hex; break bytes preserved in row.bytes.

test("slice ascii+hex — uses 16-byte rows like hex mode", () => {
  // 20 printable bytes (no break chars) → 2 rows (16 + 4)
  const arr = Array.from({ length: 20 }, (_, i) => 0x41 + i);
  const chunks = [mkChunk(1000, "rx", arr, 0, "")];
  const rows = sliceIntoRows(chunks, "ascii+hex");
  eq(rows.length, 2, "2 rows");
  eq(rows[0].bytes.length, 16, "row 0 = 16 bytes");
  eq(rows[0].mode, "ascii+hex", "mode tag");
});

test("slice ascii+hex — preserves \\r\\n bytes (shows 0d 0a in hex)", () => {
  // "Hi\r\n" = 48 69 0d 0a — default rules (crlf) trigger ONE break; all 4
  // bytes (including 0d 0a) are preserved in row.bytes.
  const chunks = [mkChunk(1000, "rx", [0x48, 0x69, 0x0d, 0x0a], 0, "Hi\r\n")];
  const rows = sliceIntoRows(chunks, "ascii+hex");
  eq(rows.length, 1, "1 row (CRLF consumed as one break, bytes kept)");
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

// === configurable line-break rules ===

function rules(partial: Partial<LineBreakRules>): LineBreakRules {
  return {
    charBreaks: partial.charBreaks ?? [],
    customBreaks: partial.customBreaks ?? { enabled: false, sequences: [] },
    breakEveryNBytes: partial.breakEveryNBytes ?? 0,
    breakOnIdleMs: partial.breakOnIdleMs ?? 0,
  };
}

test("rules ascii — NUL char break", () => {
  // "A\x00B" with nul break → rows A, B
  const chunks = [mkChunk(1000, "rx", [0x41, 0x00, 0x42], 0, "")];
  const r = rules({ charBreaks: ["nul"] });
  const rows = sliceIntoRows(chunks, "ascii", r);
  eq(rows.length, 2, "2 rows split on NUL");
  eq(rows[0].text, "A", "row 0 = A");
  eq(rows[1].text, "B", "row 1 = B");
  eq(rows[0].bytes.length, 1, "NUL byte consumed (not in row.bytes)");
});

test("rules ascii — ETX char break", () => {
  const chunks = [mkChunk(1000, "rx", [0x41, 0x03, 0x42], 0, "")];
  const r = rules({ charBreaks: ["etx"] });
  const rows = sliceIntoRows(chunks, "ascii", r);
  eq(rows.length, 2, "2 rows split on ETX");
  eq(rows[0].text, "A", "row 0 = A");
});

test("rules ascii — CRLF enabled collapses pair (no empty line)", () => {
  // "A\r\nB" with only crlf → 2 rows A, B (one break for the pair)
  const chunks = [mkChunk(1000, "rx", [0x41, 0x0d, 0x0a, 0x42], 0, "")];
  const r = rules({ charBreaks: ["crlf"] });
  const rows = sliceIntoRows(chunks, "ascii", r);
  eq(rows.length, 2, "CRLF = one break → 2 rows");
  eq(rows[0].text, "A", "row 0 = A");
  eq(rows[1].text, "B", "row 1 = B");
});

test("rules ascii — only CRLF: bare LF is NOT a break", () => {
  // "A\nB" with only crlf → LF kept as byte, 1 row
  const chunks = [mkChunk(1000, "rx", [0x41, 0x0a, 0x42], 0, "")];
  const r = rules({ charBreaks: ["crlf"] });
  const rows = sliceIntoRows(chunks, "ascii", r);
  eq(rows.length, 1, "LF kept (no break)");
  eq(rows[0].bytes.length, 3, "LF preserved in row.bytes");
});

test("rules ascii — only LF: bare CR is NOT a break", () => {
  // "A\rB" with only lf → CR kept as byte
  const chunks = [mkChunk(1000, "rx", [0x41, 0x0d, 0x42], 0, "")];
  const r = rules({ charBreaks: ["lf"] });
  const rows = sliceIntoRows(chunks, "ascii", r);
  eq(rows.length, 1, "CR kept (no break)");
  eq(rows[0].bytes.length, 3, "CR preserved");
});

test("rules ascii — default rules reproduce legacy behavior", () => {
  // "A\r\nB\nC" → A, B, C
  const chunks = [mkChunk(1000, "rx", [0x41, 0x0d, 0x0a, 0x42, 0x0a, 0x43], 0, "")];
  const r = rules({ charBreaks: ["crlf", "lf", "cr"] });
  const rows = sliceIntoRows(chunks, "ascii", r);
  eq(rows.length, 3, "3 rows: A, B, C");
  eq(rows[0].text, "A", "A");
  eq(rows[1].text, "B", "B");
  eq(rows[2].text, "C", "C (partial)");
});

test("rules ascii — custom break sequence (single byte)", () => {
  // "A|B" with custom "|" (0x7c)
  const chunks = [mkChunk(1000, "rx", [0x41, 0x7c, 0x42], 0, "")];
  const r = rules({ customBreaks: { enabled: true, sequences: [bytes(0x7c)] } });
  const rows = sliceIntoRows(chunks, "ascii", r);
  eq(rows.length, 2, "split on '|'");
  eq(rows[0].text, "A", "A");
  eq(rows[1].text, "B", "B");
});

test("rules ascii — custom multi-byte break", () => {
  // "AENDB" with custom "END" (0x45 0x4e 0x44)
  const chunks = [mkChunk(1000, "rx", [0x41, 0x45, 0x4e, 0x44, 0x42], 0, "")];
  const r = rules({ customBreaks: { enabled: true, sequences: [bytes(0x45, 0x4e, 0x44)] } });
  const rows = sliceIntoRows(chunks, "ascii", r);
  eq(rows.length, 2, "split on END");
  eq(rows[0].text, "A", "A");
  eq(rows[1].text, "B", "B");
});

test("rules ascii — custom break spanning chunk boundary", () => {
  // chunk0 = "AE", chunk1 = "NDB" — custom "END" splits across boundary
  const chunks = [
    mkChunk(1000, "rx", [0x41, 0x45], 0, ""),
    mkChunk(2000, "rx", [0x4e, 0x44, 0x42], 2, ""),
  ];
  const r = rules({ customBreaks: { enabled: true, sequences: [bytes(0x45, 0x4e, 0x44)] } });
  const rows = sliceIntoRows(chunks, "ascii", r);
  eq(rows.length, 2, "cross-chunk END splits");
  eq(rows[0].text, "A", "row 0 = A");
  eq(rows[1].text, "B", "row 1 = B");
});

test("rules ascii — breakEveryNBytes splits long run", () => {
  // 10 bytes, N=4 → rows of 4,4,2
  const arr = Array.from({ length: 10 }, (_, i) => 0x41 + (i % 26));
  const chunks = [mkChunk(1000, "rx", arr, 0, "")];
  const r = rules({ breakEveryNBytes: 4 });
  const rows = sliceIntoRows(chunks, "ascii", r);
  eq(rows.length, 3, "3 rows: 4+4+2");
  eq(rows[0].bytes.length, 4, "row 0 = 4");
  eq(rows[1].bytes.length, 4, "row 1 = 4");
  eq(rows[2].bytes.length, 2, "row 2 = 2");
});

test("rules ascii — breakOnIdleMs splits across silent gap", () => {
  // chunk0 ts=1000, chunk1 ts=3000 (gap 2000ms, threshold 500ms)
  const chunks = [
    mkChunk(1000, "rx", [0x41, 0x42], 0, ""),
    mkChunk(3000, "rx", [0x43, 0x44], 2, ""),
  ];
  const r = rules({ breakOnIdleMs: 500 });
  const rows = sliceIntoRows(chunks, "ascii", r);
  eq(rows.length, 2, "split by idle gap");
  eq(rows[0].text, "AB", "row 0 = AB");
  eq(rows[1].text, "CD", "row 1 = CD");
});

test("rules ascii — combined: char break + breakEveryN", () => {
  // "ABCDEFG\nHIJKLMN" with lf + N=3 → rows: ABC, DEF, G (flushed by \n), HIJ, KLM, N
  const chunks = [mkChunk(1000, "rx", [0x41,0x42,0x43,0x44,0x45,0x46,0x47,0x0a,0x48,0x49,0x4a,0x4b,0x4c,0x4d,0x4e], 0, "")];
  const r = rules({ charBreaks: ["lf"], breakEveryNBytes: 3 });
  const rows = sliceIntoRows(chunks, "ascii", r);
  eq(rows.length, 6, "6 rows");
  eq(rows[0].text, "ABC", "ABC");
  eq(rows[2].text, "G", "G (flushed by \\n)");
  eq(rows[5].text, "N", "N partial");
});

// === configurable rules: hex / ascii+hex modes ===
// In hex modes, break bytes are PRESERVED in row.bytes.

test("rules hex — LF break preserves 0x0a in row.bytes", () => {
  const chunks = [mkChunk(1000, "rx", [0x41, 0x0a, 0x42], 0, "")];
  const r = rules({ charBreaks: ["lf"] });
  const rows = sliceIntoRows(chunks, "hex", r);
  eq(rows.length, 2, "2 rows");
  eq(rows[0].bytes.length, 2, "A + LF");
  eq(rows[0].bytes[1], 0x0a, "LF preserved");
});

test("rules hex — custom break preserved as bytes", () => {
  // "A|B" with custom "|"
  const chunks = [mkChunk(1000, "rx", [0x41, 0x7c, 0x42], 0, "")];
  const r = rules({ customBreaks: { enabled: true, sequences: [bytes(0x7c)] } });
  const rows = sliceIntoRows(chunks, "hex", r);
  eq(rows.length, 2, "2 rows");
  eq(rows[0].bytes.length, 2, "A + |");
  eq(rows[0].bytes[1], 0x7c, "| preserved");
});

test("rules hex — breakEveryN splits into N-byte rows", () => {
  // 10 bytes, N=4 → 4+4+2
  const arr = Array.from({ length: 10 }, (_, i) => 0x41 + i);
  const chunks = [mkChunk(1000, "rx", arr, 0, "")];
  const r = rules({ breakEveryNBytes: 4 });
  const rows = sliceIntoRows(chunks, "hex", r);
  eq(rows.length, 3, "3 rows");
  eq(rows[0].bytes.length, 4, "row 0 = 4");
  eq(rows[2].bytes.length, 2, "row 2 = 2");
});

test("rules hex — breakOnIdleMs splits across silent gap", () => {
  const chunks = [
    mkChunk(1000, "rx", [0x41, 0x42], 0, ""),
    mkChunk(3000, "rx", [0x43, 0x44], 2, ""),
  ];
  const r = rules({ breakOnIdleMs: 500 });
  const rows = sliceIntoRows(chunks, "hex", r);
  eq(rows.length, 2, "split by idle");
  eq(rows[0].bytes.length, 2, "AB");
  eq(rows[1].bytes.length, 2, "CD");
});

// === custom-break parsing ===

test("parseCustomBreakLine — ascii literal text", () => {
  const s = parseCustomBreakLine("AB", "ascii");
  eq(s.length, 2, "2 bytes");
  eq(s[0], 0x41, "A");
  eq(s[1], 0x42, "B");
});

test("parseCustomBreakLine — ascii escapes \\r\\n", () => {
  const s = parseCustomBreakLine("\\r\\n", "ascii");
  eq(s.length, 2, "2 bytes for \\r\\n");
  eq(s[0], 0x0d, "CR");
  eq(s[1], 0x0a, "LF");
});

test("parseCustomBreakLine — ascii \\xNN hex escape", () => {
  const s = parseCustomBreakLine("\\x1b", "ascii");
  eq(s.length, 1, "1 byte");
  eq(s[0], 0x1b, "ESC");
});

test("parseCustomBreakLine — ascii UTF-8 char", () => {
  const s = parseCustomBreakLine("你", "ascii");
  eq(s.length, 3, "3 UTF-8 bytes");
  eq(s[0], 0xe4, "lead byte");
});

test("parseCustomBreakLine — hex space/comma separated", () => {
  const s = parseCustomBreakLine("0d 0a", "hex");
  eq(s.length, 2, "2 bytes");
  eq(s[0], 0x0d, "CR");
  eq(s[1], 0x0a, "LF");
});

test("parseCustomBreakLine — hex with 0x prefix and commas", () => {
  const s = parseCustomBreakLine("0x1b,0x0a", "hex");
  eq(s.length, 2, "2 bytes");
  eq(s[0], 0x1b, "ESC");
  eq(s[1], 0x0a, "LF");
});

test("parseCustomBreakInput — multi-line → multiple sequences", () => {
  const seqs = parseCustomBreakInput("\\r\\n\nEND", "ascii");
  eq(seqs.length, 2, "2 sequences");
  eq(seqs[0].length, 2, "CRLF");
  eq(seqs[1].length, 3, "END");
  eq(seqs[1][0], 0x45, "E");
});



test("tokenize — showNonPrintable: NUL/LF/CR/ETX → Control Pictures", () => {
  const t = tokenizeBytes(bytes(0x00, 0x0a, 0x0d, 0x03), 0, true);
  eq(t[0].char, "\u2400", "NUL → ␀");
  eq(t[1].char, "\u240a", "LF → ␊");
  eq(t[2].char, "\u240d", "CR → ␍");
  eq(t[3].char, "\u2403", "ETX → ␃");
});

test("tokenize — showNonPrintable: DEL (0x7f) → ␡", () => {
  const t = tokenizeBytes(bytes(0x7f), 0, true);
  eq(t[0].char, "\u2421", "DEL → ␡");
});

test("tokenize — showNonPrintable: stray high byte → ␙", () => {
  const t = tokenizeBytes(bytes(0xa0), 0, true);
  eq(t[0].char, "\u2419", "invalid byte → ␙");
});

test("tokenize — showNonPrintable=false keeps '.' default", () => {
  const t = tokenizeBytes(bytes(0x00, 0x7f), 0, false);
  eq(t[0].char, ".", "NUL → . when off");
  eq(t[1].char, ".", "DEL → . when off");
});

test("tokenize — showNonPrintable: printable ASCII unaffected", () => {
  const t = tokenizeBytes(bytes(0x41, 0x42), 0, true);
  eq(t[0].char, "A", "A unchanged");
  eq(t[1].char, "B", "B unchanged");
});

// === time formatting ===

test("formatAbsoluteTime — HH:MM:SS.mmm", () => {  // Use a fixed timestamp: 2024-01-15 14:23:05.007 UTC.
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
