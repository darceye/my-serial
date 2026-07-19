<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { AnsiUp } from "ansi_up";
  import { onData, onReconnected } from "$lib/tauri/events";
  import { theme } from "$lib/stores/session";
  import { RxBuffer, type DataChunk } from "$lib/services/rx-buffer";
  import {
    sliceIntoRows,
    tokenizeBytes,
    formatAbsoluteTime,
    formatRelativeTime,
    type Row,
    type ByteToken,
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

  /** Slice chunks into rows whenever buffer or displayMode changes.
   *  This re-runs on every push (bump) and on mode switch. For very large
   *  buffers this is O(n) — capped at ~2MB of bytes / O(few-thousand) rows,
   *  which is cheap. */
  $: bufferVersion, displayMode, (rows = sliceIntoRows(buffer.chunks, displayMode));

  /** Rows produced by the slicer. */
  let rows: Row[] = [];

  // --- Virtual scroll state -------------------------------------------------

  /** Pixel height of a single rendered row. ascii/hex = 1 line;
   *  ascii+hex = 2 lines (hex on top, ascii below). */
  let rowHeight = 20;
  $: rowHeight = displayMode === "ascii+hex" ? 40 : 20;

  let viewportEl: HTMLDivElement | null = null;
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

  /** Current tooltip state, or null when hidden. */
  let tooltip: {
    x: number;
    y: number;
    byteOffset: number;
    ts: number;
    dir: string;
    rawBytes: string;
    decoded: string;
  } | null = null;

  /** Event-delegated mousemove: find the closest ancestor with a
   *  data-byte-offset, look up its owning chunk, show tooltip.
   *  This avoids attaching listeners to each <span>. */
  function onMouseMove(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    const cell = target?.closest("[data-byte-offset]") as HTMLElement | null;
    if (!cell || !viewportEl) {
      tooltip = null;
      return;
    }
    const offsetAttr = cell.dataset.byteOffset;
    if (offsetAttr == null) { tooltip = null; return; }
    const byteOffset = parseInt(offsetAttr, 10);
    const chunk = buffer.chunkAt(byteOffset);
    if (!chunk) { tooltip = null; return; }

    // Byte offset within the chunk.
    const inChunk = byteOffset - chunk.offset;
    // Collect up to 4 bytes starting here (for the "raw bytes" tooltip field).
    const showCount = Math.min(4, chunk.bytes.length - inChunk);
    const rawBytes = Array.from(chunk.bytes.subarray(inChunk, inChunk + showCount))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    // Decode the same slice for the "decoded" field (best-effort).
    let decoded = ".";
    try {
      const dec = new TextDecoder("utf-8", { fatal: false }).decode(
        chunk.bytes.subarray(inChunk, inChunk + showCount),
      );
      decoded = dec.length > 0 ? dec : ".";
    } catch { /* keep "." */ }

    // Position tooltip near the cursor, clamped to viewport.
    const rect = viewportEl.getBoundingClientRect();
    tooltip = {
      x: Math.min(e.clientX - rect.left + 12, rect.width - 240),
      y: Math.min(e.clientY - rect.top + 12, rect.height - 100),
      byteOffset,
      ts: chunk.ts,
      dir: chunk.dir,
      rawBytes,
      decoded,
    };
  }

  function onMouseLeave() {
    tooltip = null;
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
    return tokenizeBytes(row.bytes, row.startOffset);
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

<div class="output-root">
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

    {#if tooltip}
      <div class="tooltip" style="left: {tooltip.x}px; top: {tooltip.y}px;">
        <div class="tt-row"><span class="tt-k">接收时间</span><span class="tt-v">{formatAbsoluteTime(tooltip.ts)}</span></div>
        <div class="tt-row"><span class="tt-k">方向</span><span class="tt-v tt-dir-{tooltip.dir}">{tooltip.dir.toUpperCase()}</span></div>
        <div class="tt-row"><span class="tt-k">字节偏移</span><span class="tt-v">{tooltip.byteOffset} (0x{tooltip.byteOffset.toString(16).toUpperCase()})</span></div>
        <div class="tt-row"><span class="tt-k">原始字节</span><span class="tt-v">{tooltip.rawBytes}</span></div>
        <div class="tt-row"><span class="tt-k">解码</span><span class="tt-v">{tooltip.decoded}</span></div>
      </div>
    {/if}
  </div>
</div>

<style>
  .output-root {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: var(--output-bg, #1e1e1e);
    color: var(--output-fg, #cccccc);
  }
  :global(.light) .output-root {
    --output-bg: #ffffff;
    --output-fg: #1e1e1e;
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
    min-width: 180px;
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
</style>
