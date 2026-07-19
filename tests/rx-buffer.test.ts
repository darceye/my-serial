/**
 * Hand-rolled unit tests for RxBuffer. No test framework dependency — run via
 * `npx tsx`. For a personal tool, this is lighter than pulling in vitest.
 *
 * Run from project root:
 *   npx tsx tests/rx-buffer.test.ts
 */
import { RxBuffer, DEFAULT_MAX_BYTES } from "../src/lib/services/rx-buffer";

let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}

function eq<T>(actual: T, expected: T, msg: string): void {
  assert(actual === expected, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

function bytes(...arr: number[]): Uint8Array {
  return new Uint8Array(arr);
}

function test(name: string, fn: () => void): void {
  console.log(`• ${name}`);
  try {
    fn();
  } catch (e) {
    fail++;
    console.error(`  ✗ threw: ${(e as Error).message}`);
  }
}

console.log("RxBuffer tests\n");

test("empty buffer", () => {
  const b = new RxBuffer();
  eq(b.chunks.length, 0, "no chunks initially");
  eq(b.totalByteCount, 0, "totalByteCount 0");
  eq(b.streamLength, 0, "streamLength 0");
  eq(b.chunkAt(0) === null, true, "chunkAt(0) null when empty");
});

test("single push — offset starts at 0", () => {
  const b = new RxBuffer();
  const c = b.push(1000, "rx", bytes(0x41, 0x42, 0x43), "ABC");
  eq(c.offset, 0, "first chunk offset = 0");
  eq(c.dir, "rx", "dir preserved");
  eq(c.bytes.length, 3, "bytes length");
  eq(c.text, "ABC", "text preserved");
  eq(b.totalByteCount, 3, "totalByteCount after one push");
  eq(b.streamLength, 3, "streamLength after one push");
});

test("push mutates input array defensively", () => {
  const b = new RxBuffer();
  const src = bytes(1, 2, 3);
  b.push(1000, "rx", src, "...");
  src[0] = 99;
  eq(b.chunks[0].bytes[0], 1, "buffer copied; mutation invisible");
});

test("multiple pushes — offsets accumulate", () => {
  const b = new RxBuffer();
  b.push(1, "rx", bytes(1, 2), "a");
  b.push(2, "rx", bytes(3, 4, 5), "b");
  b.push(3, "tx", bytes(6), "c");
  eq(b.chunks[0].offset, 0, "chunk0 offset 0");
  eq(b.chunks[1].offset, 2, "chunk1 offset 2");
  eq(b.chunks[2].offset, 5, "chunk2 offset 5");
  eq(b.streamLength, 6, "streamLength = sum of bytes");
  eq(b.totalByteCount, 6, "totalByteCount = sum");
});

test("chunkAt — middle lookup", () => {
  const b = new RxBuffer();
  b.push(1, "rx", bytes(1, 2, 3), "abc");
  b.push(2, "rx", bytes(4, 5), "de");
  b.push(3, "rx", bytes(6, 7, 8, 9), "fghi");
  // chunk0 = offsets 0,1,2 ; chunk1 = 3,4 ; chunk2 = 5,6,7,8
  eq(b.chunkAt(0)!.text, "abc", "byte 0 in chunk0");
  eq(b.chunkAt(2)!.text, "abc", "byte 2 in chunk0");
  eq(b.chunkAt(3)!.text, "de", "byte 3 in chunk1");
  eq(b.chunkAt(4)!.text, "de", "byte 4 in chunk1");
  eq(b.chunkAt(5)!.text, "fghi", "byte 5 in chunk2");
  eq(b.chunkAt(8)!.text, "fghi", "byte 8 in chunk2 (last)");
});

test("chunkAt — out of range returns null", () => {
  const b = new RxBuffer();
  b.push(1, "rx", bytes(1, 2, 3), "abc");
  eq(b.chunkAt(-1) === null, true, "negative offset null");
  eq(b.chunkAt(3) === null, true, "offset == streamLength null");
  eq(b.chunkAt(99) === null, true, "way out of range null");
});

test("chunkAt — handles interleaved 0-byte system chunks", () => {
  const b = new RxBuffer();
  b.push(1, "rx", bytes(1, 2), "ab");
  b.pushSystem(2, "--- reconnected ---");
  b.push(3, "rx", bytes(3, 4), "cd");
  // offsets: chunk0=0,1 ; chunk1(system, 0 bytes)=2 ; chunk2=2,3
  eq(b.chunkAt(0)!.text, "ab", "byte 0 in rx chunk");
  eq(b.chunkAt(1)!.text, "ab", "byte 1 in rx chunk");
  // byte 2 falls in chunk2 (chunk1 has no bytes)
  eq(b.chunkAt(2)!.text, "cd", "byte 2 skips 0-byte system chunk");
  eq(b.chunkAt(3)!.text, "cd", "byte 3 in rx chunk");
});

test("clear — resets everything", () => {
  const b = new RxBuffer();
  b.push(1, "rx", bytes(1, 2, 3), "abc");
  b.push(2, "tx", bytes(4), "d");
  b.clear();
  eq(b.chunks.length, 0, "no chunks after clear");
  eq(b.totalByteCount, 0, "totalByteCount 0");
  eq(b.streamLength, 0, "streamLength 0 (reset, not preserved)");
});

test("eviction — oldest dropped when over capacity", () => {
  const b = new RxBuffer(10); // tiny cap
  b.push(1, "rx", bytes(1, 2, 3, 4), "abcd");   // 4 bytes, offset 0
  b.push(2, "rx", bytes(5, 6, 7, 8), "efgh");   // 4 bytes, offset 4 → total 8
  eq(b.chunks.length, 2, "both fit at 8/10");
  b.push(3, "rx", bytes(9, 10), "ij");          // +2 → total 10, still fits
  eq(b.chunks.length, 3, "still 3 at exactly 10/10");
  b.push(4, "rx", bytes(11), "k");              // +1 → total 11, evict chunk0
  eq(b.chunks.length, 3, "evicted oldest, kept 3");
  eq(b.chunks[0].text, "efgh", "oldest now is efgh");
  eq(b.chunks[0].offset, 4, "evicted chunk's offset preserved on survivors");
  eq(b.totalByteCount, 7, "totalByteCount reduced (8+1-4=5? no, 4+2+1=7)");
});

test("eviction — never drops the single newest chunk", () => {
  const b = new RxBuffer(3); // cap smaller than one chunk
  b.push(1, "rx", bytes(1, 2, 3, 4, 5, 6), "abcdef"); // 6 bytes, exceeds cap
  eq(b.chunks.length, 1, "kept the one chunk despite exceeding cap");
  eq(b.totalByteCount, 6, "totalByteCount exceeds cap (allowed for last)");
});

test("eviction — chunkAt still resolves via preserved offsets", () => {
  const b = new RxBuffer(8);
  b.push(1, "rx", bytes(1, 2, 3, 4), "abcd"); // offset 0
  b.push(2, "rx", bytes(5, 6, 7, 8), "efgh"); // offset 4
  b.push(3, "rx", bytes(9, 10), "ij");        // offset 8 → evict chunk0
  eq(b.chunks[0].offset, 4, "survivor offset preserved");
  // byte offset 4 is still valid (maps to chunk1 which survived)
  eq(b.chunkAt(4)!.text, "efgh", "offset 4 resolves after eviction");
  // byte offset 0 was evicted — chunkAt returns null gracefully
  eq(b.chunkAt(0) === null, true, "evicted offset 0 returns null");
});

test("DEFAULT_MAX_BYTES is 2MB", () => {
  eq(DEFAULT_MAX_BYTES, 2 * 1024 * 1024, "default cap = 2MB");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
