<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { _ } from "svelte-i18n";
  import { AnsiUp } from "ansi_up";
  import { onData, onReconnected } from "$lib/tauri/events";
  import { theme } from "$lib/stores/session";
  import { RxBuffer, type DataChunk } from "$lib/services/rx-buffer";
  import {
    sliceIntoRows,
    tokenizeBytes,
    formatAbsoluteTime,
    formatRelativeTime,
    parseCustomBreakInput,
    type Row,
    type ByteToken,
    type CharBreak,
    type LineBreakRules,
  } from "$lib/services/line-slice";

  /** Session this view renders. */
  export let sessionId: string;
  /** When true, incoming data is dropped (not buffered) — pause scroll.
   *  Logging callback still fires for the parent. */
  export let paused = false;
  /** Whether to interpret ANSI color escapes (R1 toggle). */
  export let colorParse = true;
  /** Display mode: ascii | hex | ascii+hex. */
  export let displayMode: "ascii" | "hex" | "ascii+hex" = "ascii";
  /** Timestamp prefix mode. */
  export let timestamp: "off" | "absolute" | "relative" = "off";
  /** Configurable line-break rules. */
  export let lineCharBreaks: CharBreak[] = ["crlf", "lf", "cr"];
  export let customBreakEnabled = false;
  export let customBreakInput = "";
  export let customBreakFormat: "ascii" | "hex" = "ascii";
  export let breakEveryNBytes = 0;
  export let breakOnIdleMs = 0;
  export let showNonPrintable = false;
  /** Optional callback fired for every RX chunk — used by App for logging/export. */
  export let onRxChunk: ((ts: number, text: string) => void) | null = null;

  // --- Core buffer + reactive row slicing -----------------------------------

  /** The per-session chunk buffer. Lives for the component's lifetime; cleared
   *  only on explicit user "clear". */
  const buffer = new RxBuffer();

  /** Version counter — bumped on every buffer mutation so Svelte reactivity
   *  picks up changes (RxBuffer is a plain class, not a store). */
  let bufferVersion = 0;
  const bump = () => { bufferVersion++; };

  /** Epoch of the first received byte (for relative timestamps). */
  let sessionStart: number | null = null;

  /** Build the LineBreakRules object from the current props. Recomputed when
   *  any rule-related prop changes. */
  let lineRules: LineBreakRules;
  $: lineRules = {
    charBreaks: lineCharBreaks,
    customBreaks: {
      enabled: customBreakEnabled,
      sequences: customBreakEnabled ? parseCustomBreakInput(customBreakInput, customBreakFormat) : [],
    },
    breakEveryNBytes,
    breakOnIdleMs,
  };

  /** Slice chunks into rows whenever buffer, displayMode, or any line-break
   *  rule changes. This re-runs on every push (bump) and on config change.
   *  For very large buffers this is O(n) — capped at ~2MB of bytes / O(few-
   *  thousand) rows, which is cheap. */
  $: bufferVersion, displayMode, lineRules, (rows = sliceIntoRows(buffer.chunks, displayMode, lineRules));

  /** Rows produced by the slicer. */
  let rows: Row[] = [];

  // --- Virtual scroll state -------------------------------------------------

  /** Pixel height of a single rendered row. ascii/hex = 1 line;
   *  ascii+hex = 2 lines (hex on top, ascii below). */
  let rowHeight = 20;
  $: rowHeight = displayMode === "ascii+hex" ? 40 : 20;

  let viewportEl: HTMLDivElement | null = null;
  /** The outer .output-root container. The tooltip is rendered as a child of
   *  this (NOT of the scrolling .viewport) so it stays anchored to the visible
   *  panel regardless of scroll position. */
  let outputRootEl: HTMLDivElement | null = null;
  let scrollTop = 0;
  let viewportHeight = 600;

  /** Auto-scroll to bottom when new data arrives, unless user has scrolled up. */
  let autoScroll = true;

  /** Index of first visible row. */
  $: visibleStart = Math.max(0, Math.floor(scrollTop / rowHeight) - 2);
  /** Number of rows to render (visible + small overscan buffer). */
  $: visibleCount = Math.ceil(viewportHeight / rowHeight) + 8;
  $: visibleEnd = Math.min(rows.length, visibleStart + visibleCount);
  $: visibleRows = rows.slice(visibleStart, visibleEnd);

  /** Total scroll height in px. */
  $: totalHeight = rows.length * rowHeight;

  // --- Event wiring ---------------------------------------------------------

  let unlistenData: (() => void) | null = null;
  let unlistenReconnected: (() => void) | null = null;
  let cleanupTheme: (() => void) | null = null;

  /** AnsiUp is stateful (tracks open color sequences across calls). We keep
   *  one instance per OutputView for the lifetime of the buffer, and replace
   *  it on clear() so colors reset alongside the data. */
  let ansi = new AnsiUp();

  onMount(async () => {
    unlistenData = await onData(sessionId, (p) => {
      // Always fire logging callback (even when paused) so export + file log
      // keep recording.
      if (onRxChunk) onRxChunk(p.ts, p.text);
      if (paused) return;
      // The backend already decoded to UTF-8 text; re-encode to bytes so
      // hex view / byte offsets / tooltips have accurate per-byte data.
      const bytes = new TextEncoder().encode(p.text);
      if (sessionStart === null) sessionStart = p.ts;
      buffer.push(p.ts, "rx", bytes, p.text);
      bump();
      maybeAutoScroll();
    });

    unlistenReconnected = await onReconnected(sessionId, () => {
      buffer.pushSystem(Date.now(), "―― 已重新连接 / reconnected ――");
      bump();
      maybeAutoScroll();
    });

    // Live theme switching — we re-render ANSI spans via {@html}, so the
    // theme-dependent bits come from CSS variables, not from re-running ansi.
    // We just need to trigger a re-render when theme flips so bright-black
    // timestamp prefixes pick up the new foreground color.
    cleanupTheme = theme.subscribe(() => {
      bump();
    });
  });

  onDestroy(() => {
    unlistenData?.();
    unlistenReconnected?.();
    cleanupTheme?.();
  });

  /** Append the auto-scroll if user hasn't scrolled away from the bottom. */
  function maybeAutoScroll() {
    if (!autoScroll || !viewportEl) return;
    // Defer to next frame so the new row has been laid out.
    requestAnimationFrame(() => {
      if (viewportEl) viewportEl.scrollTop = viewportEl.scrollHeight;
    });
  }

  /** Track user scroll: if they scroll away from bottom, disable auto-scroll;
   *  re-enable when they return to bottom. */
  function onScroll() {
    if (!viewportEl) return;
    scrollTop = viewportEl.scrollTop;
    const distanceFromBottom =
      viewportEl.scrollHeight - viewportEl.scrollTop - viewportEl.clientHeight;
    autoScroll = distanceFromBottom < rowHeight * 2;
  }

  // --- Tooltip (hover a character to see receive time + byte info) ---------

  /** One line of integer interpretation shown in the hover tooltip. */
  interface IntLine {
    /** "U8" | "I8" | "U16" | "I16" | "U32" | "I32"; "" on a BE continuation row. */
    type: string;
    /** "" for single-byte types; "LE" / "BE" for 16/32-bit. */
    endian: string;
    /** Unsigned hex representation of the bytes, e.g. "0x4241". */
    hex: string;
    /** Signed (I*) or unsigned (U*) decimal value. */
    dec: string;
  }

  /** Current tooltip state, or null when hidden. */
  let tooltip: {
    /** Final left/top (output-root space), assigned by the clamp reactive
     *  statement once the tooltip box has been measured. */
    x: number;
    y: number;
    /** Cursor position in output-root space (set on mousemove). */
    px: number;
    py: number;
    /** Visible viewport bounds in output-root space (set on mousemove). */
    visLeft: number;
    visTop: number;
    visRight: number;
    visBottom: number;
    byteOffset: number;
    ts: number;
    dir: string;
    rawBytes: string;
    decoded: string;
    ints: IntLine[];
  } | null = null;

  /** Measured rendered tooltip box (updated via bind:clientWidth/Height on the
   *  tooltip element). Used for edge-flip clamping so the box never overflows
   *  the visible panel, regardless of how tall the integer table is. */
  let tooltipW = 0;
  let tooltipH = 0;

  // Clamp the tooltip inside the visible viewport once we have a real
  // measurement. Re-runs whenever the tooltip changes, the cursor moves
  // (px/py/vis* mutate together via assignment to `tooltip`), or the measured
  // size updates after the first paint.
  $: if (tooltip) {
    const TT_W = tooltipW || 260;
    const TT_H = tooltipH || 60;
    let x = tooltip.px + 14;
    if (x + TT_W > tooltip.visRight - 4) x = tooltip.px - TT_W - 14;
    x = Math.max(tooltip.visLeft + 4, Math.min(x, tooltip.visRight - TT_W - 4));
    let y = tooltip.py + 16;
    if (y + TT_H > tooltip.visBottom - 4) y = tooltip.py - TT_H - 10;
    y = Math.max(tooltip.visTop + 4, Math.min(y, tooltip.visBottom - TT_H - 4));
    tooltip.x = x;
    tooltip.y = y;
  }

  /** Find the row that contains `byteOffset`, via binary search over the
   *  reactive `rows` array. Returns null when out of range.
   *
   *  Why rows (not buffer.chunkAt): each Row pre-concatenates its bytes
   *  ACROSS chunk boundaries (a 16-byte hex row may be assembled from several
   *  small RX reads). chunkAt would only see one read's worth of bytes, so an
   *  I32 parse starting at a row's first byte could be capped at 1-2 bytes
   *  even though the row visibly holds 16. Reading from the row guarantees the
   *  full contiguous byte span is available for the integer interpretation. */
  function rowAtOffset(off: number): Row | null {
    if (rows.length === 0) return null;
    let lo = 0, hi = rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (rows[mid].startOffset <= off) lo = mid;
      else hi = mid - 1;
    }
    const r = rows[lo];
    return off >= r.startOffset && off < r.startOffset + r.bytes.length ? r : null;
  }

  /** Event-delegated mousemove: find the closest ancestor with a
   *  data-byte-offset, look up its owning row, show tooltip.
   *  This avoids attaching listeners to each <span>. */
  function onMouseMove(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    const cell = target?.closest("[data-byte-offset]") as HTMLElement | null;
    if (!cell || !viewportEl || !outputRootEl) {
      tooltip = null;
      return;
    }
    const offsetAttr = cell.dataset.byteOffset;
    if (offsetAttr == null) { tooltip = null; return; }
    const byteOffset = parseInt(offsetAttr, 10);
    const row = rowAtOffset(byteOffset);
    if (!row) { tooltip = null; return; }

    // Byte offset of the cursor within the row. From here we read up to 4
    // CONTIGUOUS bytes — independent of where the underlying RX chunks were
    // split — for both the "raw bytes" field and the integer table.
    const inRow = byteOffset - row.startOffset;
    const showCount = Math.min(4, row.bytes.length - inRow);
    const slice = row.bytes.subarray(inRow, inRow + showCount);
    const rawBytes = Array.from(slice)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    const decoded = decodeWithControlPictures(slice);

    // Position tooltip. The tooltip lives OUTSIDE the scrolling .viewport
    // (it's a sibling, in .output-root), so its coordinates must be in the
    // .output-root's coordinate space. We anchor to the visible viewport
    // rect — getBoundingClientRect() returns viewport-relative (screen)
    // coords that do NOT shift with scroll, which is exactly what we want:
    // without this, the absolute-positioned tooltip would be treated as part
    // of the scrollable content and drift upward off-screen as the user
    // scrolls down (the original bug).
    const rect = viewportEl.getBoundingClientRect();
    const rootRect = outputRootEl.getBoundingClientRect();
    // Pointer position relative to .output-root.
    const px = e.clientX - rootRect.left;
    const py = e.clientY - rootRect.top;
    // Visible viewport bounds, in .output-root space.
    const visLeft = rect.left - rootRect.left;
    const visTop = rect.top - rootRect.top;
    const visRight = visLeft + rect.width;
    const visBottom = rect.top + rect.height - rootRect.top;

    tooltip = {
      x: 0,
      y: 0,
      // Pointer-relative bounds captured now; the actual clamp runs in the
      // reactive statement below, AFTER the tooltip DOM has measured its real
      // size (the integer table height varies with how many bytes/rows are
      // available, so a fixed estimate would under-count and let the box
      // overflow the panel into the send area — the original bottom-clip bug).
      px,
      py,
      visLeft,
      visTop,
      visRight,
      visBottom,
      byteOffset,
      ts: row.ts,
      dir: row.dir,
      rawBytes,
      decoded,
      ints: parseIntLines(slice),
    };
  }

  function onMouseLeave() {
    tooltip = null;
  }

  // --- Integer interpretation (tooltip table) ------------------------------

  /** Build the integer-parsing lines for the hover tooltip from the bytes
   *  starting at the hovered offset (up to 4 available).
   *
   *  Coverage rules:
   *   - 8-bit  types (U8 / I8) only need 1 byte  → always shown.
   *   - 16-bit types (U16 / I16) need 2 bytes    → shown when ≥ 2 remain.
   *   - 32-bit types (U32 / I32) need 4 bytes    → shown when ≥ 4 remain.
   *  16/32-bit values are shown in BOTH little-endian and big-endian, since
   *  serial protocols vary; 8-bit values are byte-order-independent. */
  function parseIntLines(bytes: Uint8Array): IntLine[] {
    const lines: IntLine[] = [];
    if (bytes.length === 0) return lines;

    // DataView over a fresh copy so little/big-endian getInt* work directly.
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);

    // --- 8-bit (byte order doesn't apply) ---
    const b0 = bytes[0];
    const u8 = b0;
    const i8 = b0 < 0x80 ? b0 : b0 - 0x100;
    lines.push({ type: "U8", endian: "", hex: hexOf(bytes, 1), dec: String(u8) });
    lines.push({ type: "I8", endian: "", hex: hexOf(bytes, 1), dec: String(i8) });

    // --- 16-bit (need ≥ 2 bytes) ---
    if (bytes.length >= 2) {
      const hex16 = hexOf(bytes, 2);
      // Little-endian
      const u16le = dv.getUint16(0, true);
      const i16le = dv.getInt16(0, true);
      // Big-endian
      const u16be = dv.getUint16(0, false);
      const i16be = dv.getInt16(0, false);
      lines.push({ type: "U16", endian: "LE", hex: hex16, dec: String(u16le) });
      lines.push({ type: "U16", endian: "BE", hex: hex16, dec: String(u16be) });
      lines.push({ type: "I16", endian: "LE", hex: hex16, dec: String(i16le) });
      lines.push({ type: "I16", endian: "BE", hex: hex16, dec: String(i16be) });
    }

    // --- 32-bit (need ≥ 4 bytes) ---
    if (bytes.length >= 4) {
      const hex32 = hexOf(bytes, 4);
      const u32le = dv.getUint32(0, true);
      const i32le = dv.getInt32(0, true);
      const u32be = dv.getUint32(0, false);
      const i32be = dv.getInt32(0, false);
      lines.push({ type: "U32", endian: "LE", hex: hex32, dec: String(u32le) });
      lines.push({ type: "U32", endian: "BE", hex: hex32, dec: String(u32be) });
      lines.push({ type: "I32", endian: "LE", hex: hex32, dec: String(i32le) });
      lines.push({ type: "I32", endian: "BE", hex: hex32, dec: String(i32be) });
    }

    return lines;
  }

  /** Format the first `n` bytes as an uppercase 0x-prefixed hex string. */
  function hexOf(bytes: Uint8Array, n: number): string {
    let s = "0x";
    for (let i = 0; i < n; i++) s += bytes[i].toString(16).padStart(2, "0").toUpperCase();
    return s;
  }

  /** Decode a byte slice for the tooltip's "decoded" field. UTF-8 decode is
   *  best-effort (invalid sequences fall back to U+FFFD). Each byte that would
   *  render invisibly — C0/C1 control bytes, DEL, and a literal space — is
   *  shown via its Unicode "Control Pictures" symbol (␀..␟, ␡ for DEL, ␣ for
   *  space) so the user can see exactly what byte is there instead of a blank. */
  function decodeWithControlPictures(bytes: Uint8Array): string {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch {
      text = "";
    }
    let out = "";
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      // Single-byte controls 0x00-0x1F → U+2400 + cp (␀ ␁ … ␟).
      if (cp >= 0x00 && cp <= 0x1f) out += String.fromCodePoint(0x2400 + cp);
      // DEL (0x7f) → U+2421 (␡).
      else if (cp === 0x7f) out += String.fromCodePoint(0x2421);
      // Literal space (0x20) → U+2423 (␣) so it isn't collapsed to nothing.
      else if (cp === 0x20) out += String.fromCodePoint(0x2423);
      else out += ch;
    }
    return out.length > 0 ? out : ".";
  }

  // --- Row rendering helpers ------------------------------------------------

  /** Build the timestamp prefix HTML for a row (empty when timestamp === "off"). */
  function timestampPrefix(row: Row): string {
    if (timestamp === "off") return "";
    const start = sessionStart ?? row.ts;
    const formatted =
      timestamp === "absolute"
        ? formatAbsoluteTime(row.ts)
        : formatRelativeTime(row.ts, start);
    // Bright-black ANSI → consumed by ansi_up → produces gray span.
    return `\x1b[90m${formatted} \x1b[0m`;
  }

  /** Render a row's text content as HTML (with ANSI colors when enabled). */
  function renderRowHtml(row: Row): string {
    if (row.dir === "system") {
      // System marker: render as plain yellow text (no ANSI processing).
      return `<span class="sys-marker">${escapeHtml(row.text)}</span>`;
    }
    const prefix = timestampPrefix(row);
    let body = row.text;
    if (!colorParse) {
      // Strip CSI sequences (colors/cursor). Keep the visible text.
      body = body.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
      return prefix
        ? `<span class="ts-prefix">${escapeHtml(stripAnsi(prefix))}</span>${escapeHtml(body)}`
        : `<span class="dir-${row.dir}">${escapeHtml(body)}</span>`;
    }
    // Color path: run the whole (prefix + body) through ansi_up so the
    // bright-black timestamp color and the body colors both render.
    // Wrap body in a dir-classed span AFTER ansi processing — ansi_up emits
    // its own spans with inline color styles, so we can't easily wrap them.
    // Instead, prepend a per-dir class marker via a no-op ANSI sequence is
    // not possible; use a wrapper span and let ansi_up's inner spans inherit.
    const wrapped = `${prefix}${body}`;
    const html = ansi.ansi_to_html(wrapped);
    return `<span class="dir-${row.dir}">${html}</span>`;
  }

  /** Strip ANSI escape sequences from a string. */
  function stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  }

  /** HTML-escape a plain string (for the no-color path). */
  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/ /g, "&nbsp;"); // preserve whitespace in pre-formatted text
  }

  // --- Hex / ascii+hex rendering -------------------------------------------

  /** Tokenize a row's bytes for ascii-row rendering.
   *
   *  No caching: previously this was memoized by row.startOffset, but in
   *  ascii mode a streaming row keeps the same startOffset while its byte
   *  length grows (e.g. "e" → "ex" → "exa" ...), so the cache returned a
   *  stale 1-token result. tokenizeBytes on 16 bytes is sub-microsecond
   *  and only runs for visible rows (~50), so recomputing is cheaper than
   *  getting the cache invalidation right. */
  function rowTokens(row: Row): ByteToken[] {
    return tokenizeBytes(row.bytes, row.startOffset, showNonPrintable);
  }

  /** Build hex cell HTML for a single byte. */
  function hexCellHtml(b: number): string {
    return b.toString(16).padStart(2, "0");
  }

  /** Build the complete hex row HTML (one <span> per byte, with data-offset
   *  for hover tooltip). */
  function hexRowHtml(row: Row): string {
    const cells: string[] = [];
    for (let i = 0; i < row.bytes.length; i++) {
      const off = row.startOffset + i;
      cells.push(
        `<span class="hx-cell" data-byte-offset="${off}">${hexCellHtml(row.bytes[i])}</span>`,
      );
    }
    return cells.join(" ");
  }

  /** Build the ascii row HTML from tokens. Each token renders as ONE <span>
   *  with explicit width = byteCount * (cell width). Multi-byte tokens (CJK)
   *  thus stretch to align under their N hex cells above. */
  function asciiRowHtml(row: Row): string {
    const tokens = rowTokens(row);
    const cells: string[] = [];
    for (const tk of tokens) {
      // Width: 1 byte = 3ch (matches hex "XX " cell). Multi-byte token spans
      // byteCount cells. We also need the inter-cell space (byteCount - 1).
      // Total chars = byteCount * 3 (XX+space) - 1 (no trailing space).
      const widthCh = tk.byteCount * 3 - 1;
      const escaped = escapeHtml(tk.char).replace(/&nbsp;/g, " ");
      const displayChar = escaped === " " ? "&nbsp;" : escaped;
      cells.push(
        `<span class="hx-ascii-cell" data-byte-offset="${tk.offset}" style="width:${widthCh}ch;display:inline-block;text-align:center">${displayChar}</span> `,
      );
    }
    return cells.join("");
  }

  // --- Public API (called by parent via bind:this) --------------------------

  /** Clear the entire buffer. */
  export function clear() {
    buffer.clear();
    sessionStart = null;
    ansi = new AnsiUp();
    bump();
  }

  /** Echo transmitted bytes into the view (in tx color). */
  export function writeText(text: string) {
    if (sessionStart === null) sessionStart = Date.now();
    const bytes = new TextEncoder().encode(text);
    buffer.push(Date.now(), "tx", bytes, text);
    bump();
    maybeAutoScroll();
  }

  /** Focus hook (kept for API compatibility). The native view has no input
   *  cursor, so this is a no-op; selection/scroll work without focus. */
  export function focus() {
    /* no-op */
  }

  /** Refit hook — kept for API compatibility with parent. Native view needs
   *  no fit logic; just re-measure viewport. */
  export function fitToContainer() {
    if (viewportEl) viewportHeight = viewportEl.clientHeight;
  }

  // --- Ruler ticks ---------------------------------------------------------

  /** Tick marks for the byte-offset ruler. One tick per 4 bytes (compact but
   *  readable for 16-byte-wide rows). Each tick's `xCh` is the horizontal
   *  position in `ch` units (matching the hex cell width: each byte = 3ch). */
  const RULER_TICK_EVERY = 4;
  $: rulerTicks = (() => {
    if (displayMode === "ascii") return [];
    const ticks: { xCh: number; label: string }[] = [];
    // Show ticks across one 16-byte row (the row wraps after 16).
    for (let i = 0; i <= 16; i += RULER_TICK_EVERY) {
      // Each byte occupies 3ch ("XX "). Tick i sits at i*3 ch.
      ticks.push({ xCh: i * 3, label: String(i) });
    }
    return ticks;
  })();
</script>

<div class="output-root" bind:this={outputRootEl}>
  {#if displayMode !== "ascii"}
    <!-- Byte-offset ruler. Sits above the scroll area, fixed height. Only
         meaningful in hex modes where bytes have fixed cell widths. -->
    <div class="ruler" aria-hidden="true">
      <span class="ruler-label">offset</span>
      <span class="ruler-ticks">
        {#each rulerTicks as tick}
          <span class="tick" style="left: {tick.xCh}ch;">{tick.label}</span>
        {/each}
      </span>
    </div>
  {/if}

  <div
    bind:this={viewportEl}
    class="viewport"
    on:scroll={onScroll}
    on:mousemove={onMouseMove}
    on:mouseleave={onMouseLeave}
    role="log"
    aria-live="polite"
  >
    <div class="spacer" style="height: {totalHeight}px;">
      <div
        class="rows-layer"
        style="transform: translateY({visibleStart * rowHeight}px);"
      >
        {#each visibleRows as row, i (visibleStart + i)}
          <div
            class="row"
            class:row-text={displayMode === "ascii" || row.dir === "system"}
            style="height: {rowHeight}px;"
          >
            {#if row.dir === "system"}
              <span class="sys-marker">{row.text}</span>
            {:else if displayMode === "hex"}
              {@html hexRowHtml(row)}
            {:else if displayMode === "ascii+hex"}
              <div class="hex-line">{@html hexRowHtml(row)}</div>
              <div class="ascii-line">{@html asciiRowHtml(row)}</div>
            {:else}
              {@html renderRowHtml(row)}
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </div>

  {#if tooltip}
    <!-- Tooltip is a child of .output-root, NOT of the scrolling .viewport.
         This keeps it anchored to the visible panel: its absolute coords are
         resolved against .output-root (which doesn't scroll), so it no longer
         drifts off-screen as the user scrolls down through the content.
         clientWidth/clientHeight are bound so the clamp reactive statement can
         use the REAL measured size (the integer-table height varies with how
         many bytes/rows are available) instead of a fixed estimate. -->
    <div
      class="tooltip"
      style="left: {tooltip.x}px; top: {tooltip.y}px;"
      bind:clientWidth={tooltipW}
      bind:clientHeight={tooltipH}
    >
      <div class="tt-row"><span class="tt-k">{$_("tooltip.rxTime")}</span><span class="tt-v">{formatAbsoluteTime(tooltip.ts)}</span></div>
      <div class="tt-row"><span class="tt-k">{$_("tooltip.dir")}</span><span class="tt-v tt-dir-{tooltip.dir}">{tooltip.dir.toUpperCase()}</span></div>
      <div class="tt-row"><span class="tt-k">{$_("tooltip.byteOffset")}</span><span class="tt-v">{tooltip.byteOffset} (0x{tooltip.byteOffset.toString(16).toUpperCase()})</span></div>
      <div class="tt-row"><span class="tt-k">{$_("tooltip.rawBytes")}</span><span class="tt-v">{tooltip.rawBytes}</span></div>
      <div class="tt-row"><span class="tt-k">{$_("tooltip.decoded")}</span><span class="tt-v">{tooltip.decoded}</span></div>
      {#if tooltip.ints.length > 0}
        <div class="tt-ints">
          <div class="tt-ints-h">
            <span>{$_("tooltip.type")}</span><span>{$_("tooltip.endian")}</span><span>{$_("tooltip.hex")}</span><span>{$_("tooltip.decimal")}</span>
          </div>
          {#each tooltip.ints as line}
            <div class="tt-ints-r">
              <span class="tt-ints-t">{line.type}</span>
              <span class="tt-ints-e">{line.endian || "—"}</span>
              <span class="tt-ints-hex">{line.hex}</span>
              <span class="tt-ints-dec">{line.dec}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .output-root {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    /* Theme colors come from the global --c-terminal-* tokens (defined on
       :root and flipped under html.light in src/styles/app.css), so the
       output pane switches theme together with the rest of the window —
       no separate fallback chain that could desync from the toggle. */
    background: var(--c-terminal-bg);
    color: var(--c-terminal-fg);
  }

  /* Byte-offset ruler (hex modes only). */
  .ruler {
    flex: 0 0 auto;
    height: 22px;
    display: flex;
    align-items: center;
    border-bottom: 1px solid rgba(128, 128, 128, 0.2);
    background: rgba(128, 128, 128, 0.05);
    font-family: "Cascadia Code", "Consolas", "Courier New", monospace;
    font-size: 11px;
    color: rgba(180, 180, 180, 0.7);
    padding: 0 8px;
    user-select: none;
  }
  .ruler-label {
    flex: 0 0 auto;
    margin-right: 8px;
    opacity: 0.7;
  }
  .ruler-ticks {
    position: relative;
    height: 100%;
    flex: 1 1 auto;
  }
  .tick {
    position: absolute;
    top: 4px;
    transform: translateX(-50%);
    font-variant-numeric: tabular-nums;
  }

  .viewport {
    flex: 1 1 auto;
    position: relative;
    overflow: auto;
    font-family: "Cascadia Code", "Consolas", "Courier New", monospace;
    font-size: 13px;
    line-height: 20px;
    /* min-height 0 lets flex shrink this below content size. */
    min-height: 0;
  }

  /* The spacer reserves the full scrollable height; the rows-layer is
     absolutely positioned within it and translated to the visible window. */
  .spacer {
    position: relative;
    min-height: 100%;
    width: 100%;
  }
  .rows-layer {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    will-change: transform;
  }

  .row {
    padding: 0 8px;
    box-sizing: border-box;
    overflow: hidden;
    /* Subtle stripe for readability on dense logs. */
  }
  /* ASCII text-stream mode: preserve whitespace and line structure in the
     rendered HTML. Hex modes do NOT get this — they use inline-block cells
     whose alignment is broken by `white-space: pre` (it prevents the cells
     from laying out normally and can collapse the ascii line). */
  .row.row-text {
    white-space: pre;
  }
  .row:nth-child(odd) {
    background: rgba(255, 255, 255, 0.02);
  }

  /* TX echo: blue-ish tint to distinguish from RX. */
  :global(.dir-tx) {
    color: #569cd6;
  }
  :global(.light) :global(.dir-tx) {
    color: #0550ae;
  }

  /* Reconnect / system markers. */
  :global(.sys-marker) {
    color: #dcdcaa;
    font-style: italic;
  }
  :global(.light) :global(.sys-marker) {
    color: #9a6a00;
  }

  /* Timestamp prefix (no-color mode only; in color mode ansi_up handles it). */
  :global(.ts-prefix) {
    color: #808080;
    user-select: none;
  }

  /* Hex cell (one byte) — fixed 2ch width. inline-block + vertical-align:top
     keeps the line height at exactly line-height (20px); without it, the
     default baseline alignment inflates the row and pushes the ascii line
     below out of the 40px row clip region (overflow:hidden on .row). */
  :global(.hx-cell) {
    color: #ce9178;
    display: inline-block;
    width: 2ch;
    text-align: center;
    vertical-align: top;
  }
  :global(.light) :global(.hx-cell) {
    color: #a05a1e;
  }

  /* ASCII cell under hex — width matches the byte count it spans.
     MUST be inline-block, otherwise width:Nch is ignored (inline elements
     don't accept width) and CJK chars collapse instead of stretching to
     align under their multi-byte hex sequence. */
  :global(.hx-ascii-cell) {
    color: #9cdcfe;
    display: inline-block;
    text-align: center;
    vertical-align: top;
  }
  :global(.light) :global(.hx-ascii-cell) {
    color: #1f6feb;
  }

  .hex-line {
    line-height: 20px;
  }
  .ascii-line {
    line-height: 20px;
    color: #9cdcfe;
  }

  /* Thin scrollbar. */
  .viewport::-webkit-scrollbar {
    width: 10px;
    height: 10px;
  }
  .viewport::-webkit-scrollbar-thumb {
    background: rgba(128, 128, 128, 0.4);
    border-radius: 5px;
  }
  .viewport::-webkit-scrollbar-thumb:hover {
    background: rgba(128, 128, 128, 0.7);
  }

  /* Hover tooltip showing per-byte receive time + info. */
  .tooltip {
    position: absolute;
    z-index: 10;
    background: rgba(40, 40, 40, 0.96);
    color: #e0e0e0;
    border: 1px solid rgba(128, 128, 128, 0.5);
    border-radius: 4px;
    padding: 6px 8px;
    font-size: 11px;
    line-height: 1.5;
    pointer-events: none;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
    /* Width is tuned to match the TT_W/TT_H constants used in onMouseMove for
       edge-flip clamping, so the tooltip never overflows the visible area. */
    width: 260px;
    max-width: 260px;
    backdrop-filter: blur(4px);
  }
  :global(.light) .tooltip {
    background: rgba(255, 255, 255, 0.98);
    color: #333;
    border-color: rgba(0, 0, 0, 0.2);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  }
  .tt-row {
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  .tt-k {
    color: rgba(180, 180, 180, 0.8);
    flex: 0 0 56px;
    font-size: 10px;
    text-transform: uppercase;
  }
  :global(.light) .tt-k {
    color: #666;
  }
  .tt-v {
    font-family: "Cascadia Code", "Consolas", monospace;
    word-break: break-all;
  }
  :global(.light) .tt-v {
    color: #1e1e1e;
  }
  .tt-dir-rx { color: #4ec9b0; }
  .tt-dir-tx { color: #569cd6; }
  .tt-dir-system { color: #dcdcaa; }

  /* Integer interpretation table inside the tooltip. */
  .tt-ints {
    margin-top: 6px;
    border-top: 1px solid rgba(128, 128, 128, 0.4);
    padding-top: 6px;
  }
  :global(.light) .tt-ints {
    border-top-color: rgba(0, 0, 0, 0.15);
  }
  .tt-ints-h,
  .tt-ints-r {
    display: grid;
    grid-template-columns: 34px 42px 70px 1fr;
    column-gap: 8px;
    align-items: baseline;
    font-size: 10px;
    line-height: 1.6;
  }
  .tt-ints-h {
    color: rgba(180, 180, 180, 0.8);
    text-transform: uppercase;
    margin-bottom: 2px;
  }
  :global(.light) .tt-ints-h {
    color: #666;
  }
  .tt-ints-r {
    font-family: "Cascadia Code", "Consolas", monospace;
  }
  .tt-ints-t {
    color: #569cd6;
    font-weight: 600;
  }
  :global(.light) .tt-ints-t {
    color: #0550ae;
  }
  .tt-ints-e {
    color: #c586c0;
  }
  :global(.light) .tt-ints-e {
    color: #9a3a8e;
  }
  .tt-ints-hex {
    color: #ce9178;
  }
  :global(.light) .tt-ints-hex {
    color: #a05a1e;
  }
  .tt-ints-dec {
    color: #b5cea8;
    word-break: break-all;
  }
  :global(.light) .tt-ints-dec {
    color: #1e7a3a;
  }
</style>
