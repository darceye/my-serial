/**
 * Chunk-level byte buffer for the native serial output viewer.
 *
 * Replaces xterm.js's flat-string-write model. Each received/transmitted chunk
 * keeps its own timestamp + direction + raw bytes + decoded text + global byte
 * offset, so the viewer can:
 *  - render hex/ascii views from the same bytes,
 *  - show per-character receive time by binary-searching the owning chunk,
 *  - align a horizontal ruler to byte offsets.
 *
 * Capacity is bounded by total bytes (default 2MB). When exceeded, oldest
 * chunks are dropped wholesale (offsets of surviving chunks are preserved,
 * so older tooltips still resolve correctly within the remaining window).
 */

/** Direction of a data chunk. "system" is used for non-data markers like the
 *  reconnect divider line. */
export type ChunkDir = "rx" | "tx" | "system";

/** One data block: raw bytes + metadata, retained for the lifetime of the
 *  buffer (subject to the byte cap). */
export interface DataChunk {
  /** Epoch milliseconds — the moment this chunk was received/sent.
   *  Shared by all bytes in this chunk (chunk-level granularity). */
  ts: number;
  /** Direction. Determines rendering color. */
  dir: ChunkDir;
  /** Raw bytes. For "system" chunks this may be empty. */
  bytes: Uint8Array;
  /** UTF-8 decoded text (precomputed for ascii mode rendering). */
  text: string;
  /** This chunk's starting byte offset within the global byte stream.
   *  Stable: even after older chunks are evicted, this is NOT recomputed,
   *  so a cached byte offset still resolves to the right chunk-relative
   *  position via `chunkAt`. */
  offset: number;
}

/** Default capacity: 2MB of raw bytes (~2M ASCII chars, less for CJK). */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export class RxBuffer {
  /** Live chunk list, oldest first. Mutated only via push/clear. */
  chunks: DataChunk[] = [];

  private _totalBytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number = DEFAULT_MAX_BYTES) {
    this.maxBytes = maxBytes;
  }

  /** Total bytes currently in the buffer. */
  get totalByteCount(): number {
    return this._totalBytes;
  }

  /** Highest byte offset + 1 (i.e., where the next byte will go).
   *  Unlike totalByteCount, this is NOT reset by eviction — it monotonically
   *  increases across the session lifetime. */
  get streamLength(): number {
    if (this.chunks.length === 0) return 0;
    const last = this.chunks[this.chunks.length - 1];
    return last.offset + last.bytes.length;
  }

  /** Append a chunk. `bytes` is copied into a fresh Uint8Array so callers
   *  can safely mutate or reuse their source buffer afterward.
   *
   *  Returns the inserted chunk (with its assigned offset). */
  push(ts: number, dir: ChunkDir, bytes: Uint8Array, text: string): DataChunk {
    const copy = bytes.length === 0 ? new Uint8Array(0) : new Uint8Array(bytes);
    const offset = this.streamLength;
    const chunk: DataChunk = { ts, dir, bytes: copy, text, offset };
    this.chunks.push(chunk);
    this._totalBytes += copy.length;
    this.evictIfNeeded();
    return chunk;
  }

  /** Convenience for system markers (reconnect dividers, etc.) — no bytes. */
  pushSystem(ts: number, text: string): DataChunk {
    return this.push(ts, "system", new Uint8Array(0), text);
  }

  /** Remove all chunks and reset counters. streamLength resets to 0 too. */
  clear(): void {
    this.chunks = [];
    this._totalBytes = 0;
  }

  /** Find the chunk that owns `byteOffset` in the global stream.
   *  Returns null if the offset is out of range (< 0 or >= streamLength),
   *  or if the buffer is empty.
   *
   *  Uses binary search: O(log n) for large buffers. */
  chunkAt(byteOffset: number): DataChunk | null {
    if (byteOffset < 0 || this.chunks.length === 0) return null;
    // Fast path: offset is beyond everything we have.
    const last = this.chunks[this.chunks.length - 1];
    if (byteOffset >= last.offset + last.bytes.length) return null;

    let lo = 0;
    let hi = this.chunks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      const c = this.chunks[mid];
      if (c.offset <= byteOffset) lo = mid;
      else hi = mid - 1;
    }
    const found = this.chunks[lo];
    // Verify the offset actually falls within this chunk's byte range.
    if (byteOffset >= found.offset && byteOffset < found.offset + found.bytes.length) {
      return found;
    }
    // Edge case: offset falls in a gap (shouldn't happen since chunks are
    // contiguous, but system chunks have 0 bytes). Walk forward.
    for (let i = lo + 1; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      if (byteOffset >= c.offset && byteOffset < c.offset + c.bytes.length) {
        return c;
      }
    }
    return null;
  }

  /** Drop oldest chunks until totalBytes <= maxBytes. Never drops the single
   *  newest chunk even if it alone exceeds the cap (so a very large line
   *  still renders). Offsets of surviving chunks are NOT adjusted. */
  private evictIfNeeded(): void {
    while (this._totalBytes > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this._totalBytes -= dropped.bytes.length;
    }
  }
}
