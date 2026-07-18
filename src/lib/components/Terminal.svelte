<script lang="ts" module>
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { SearchAddon } from "@xterm/addon-search";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import type { Terminal as XTerm } from "@xterm/xterm";

  export type { XTerm };
</script>

<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import {
    onData,
    onReconnected,
  } from "$lib/tauri/events";
  import { theme } from "$lib/stores/session";
  import { get } from "svelte/store";

  /** Session this terminal renders. */
  export let sessionId: string;
  /** When true, incoming data is buffered but not written (pause scroll). */
  export let paused = false;
  /** Whether to interpret ANSI color escapes (R1 toggle). */
  export let colorParse = true;
  /** Display mode: ascii | hex | ascii+hex. */
  export let displayMode: "ascii" | "hex" | "ascii+hex" = "ascii";
  /** Timestamp prefix mode. */
  export let timestamp: "off" | "absolute" | "relative" = "off";
  /** Line ending normalization for display. */
  export let eolMode: "raw" | "\n" | "\r\n" = "raw";
  /** Optional callback fired for every RX chunk — used by App for logging/export. */
  export let onRxChunk: ((ts: number, text: string) => void) | null = null;

  let container: HTMLDivElement;
  let term: Terminal;
  let fit: FitAddon;
  let search: SearchAddon;
  let unlistenData: (() => void) | null = null;
  let unlistenReconnected: (() => void) | null = null;
  let ro: ResizeObserver | null = null;

  /** Pending writes batched via requestAnimationFrame for high-throughput. */
  let pending = "";
  let rafId: number | null = null;
  /** Byte accumulator for hex modes (resets on newline). */
  let hexLineBytes: number[] = [];
  /** Epoch when terminal first received data (for relative timestamps). */
  let sessionStart: number | null = null;
  /** Whether the next write starts a new logical line (for timestamp prefix). */
  let atLineStart = true;

  function flush() {
    rafId = null;
    if (!pending) return;
    term.write(pending);
    pending = "";
  }

  /** Format a byte buffer as a hex/ascii line. */
  function formatHexLine(bytes: number[], includeAscii: boolean): string {
    const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");
    if (!includeAscii) return hex + "\r\n";
    const ascii = bytes
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
      .join("");
    const pad = " ".repeat(Math.max(0, 48 - hex.length));
    return `${hex}${pad}  |${ascii}|\r\n`;
  }

  /** Compute the timestamp prefix for a new line, if enabled. */
  function linePrefix(): string {
    if (timestamp === "off") return "";
    const now = Date.now();
    if (timestamp === "absolute") {
      const d = new Date(now);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      const ss = String(d.getSeconds()).padStart(2, "0");
      const fff = String(d.getMilliseconds()).padStart(3, "0");
      return `\x1b[90m${hh}:${mm}:${ss}.${fff} \x1b[0m`;
    }
    // relative
    if (sessionStart === null) sessionStart = now;
    const elapsed = ((now - sessionStart) / 1000).toFixed(3);
    return `\x1b[90m+${elapsed}s \x1b[0m`;
  }

  function enqueue(text: string) {
    if (sessionStart === null) sessionStart = Date.now();

    if (displayMode === "ascii") {
      // ASCII mode. We normalize ALL line endings to a single \n first, then
      // let xterm's convertEol handle \n → \r\n. This prevents the double-newline
      // bug: a device sending "hello\r\n" would otherwise become "hello\r\r\n"
      // (the explicit \r plus convertEol's \r) producing phantom blank lines.
      let out = colorParse ? text : text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
      out = out.replace(/\r\n|\r/g, "\n");
      if (timestamp !== "off") {
        // Insert a prefix at the start of each logical line. We split on \n
        // (keeping it) and prepend the prefix to non-empty segments when we're
        // at a line start.
        const parts = out.split("\n");
        const rebuilt: string[] = [];
        for (let i = 0; i < parts.length; i++) {
          const seg = parts[i];
          if (seg !== "") {
            if (atLineStart) rebuilt.push(linePrefix());
            rebuilt.push(seg);
            atLineStart = false;
          }
          // A \n was originally between this and the next part (unless last).
          if (i < parts.length - 1) {
            rebuilt.push("\n");
            atLineStart = true;
          }
        }
        out = rebuilt.join("");
      }
      pending += out;
    } else {
      // Hex mode: accumulate bytes, flush each line on \n.
      const bytes = Array.from(new TextEncoder().encode(text));
      for (const b of bytes) {
        hexLineBytes.push(b);
        if (b === 0x0a) {
          const includeAscii = displayMode === "ascii+hex";
          pending += (atLineStart ? linePrefix() : "") + formatHexLine(hexLineBytes, includeAscii);
          hexLineBytes = [];
          atLineStart = true;
        } else {
          atLineStart = false;
        }
      }
    }

    if (rafId === null) {
      rafId = requestAnimationFrame(flush);
    }
  }

  function buildOptions() {
    const dark = get(theme) === "dark";
    return {
      fontFamily:
        '"Cascadia Code", "Consolas", "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 10000,
      // Treat a lone \n as \r\n so device output that only sends LF still
      // returns the cursor to column 0 (otherwise it keeps writing at the
      // current column, which visually looks like phantom blank lines).
      convertEol: true,
      allowProposedApi: true,
      theme: dark
        ? {
            background: "#1e1e1e",
            foreground: "#cccccc",
            cursor: "#ffffff",
            selectionBackground: "#264f78",
            black: "#000000",
            red: "#cd3131",
            green: "#0dbc79",
            yellow: "#e5e510",
            blue: "#2472c8",
            magenta: "#bc3fbc",
            cyan: "#11a8cd",
            white: "#e5e5e5",
            brightBlack: "#666666",
            brightRed: "#f14c4c",
            brightGreen: "#23d18b",
            brightYellow: "#f5f543",
            brightBlue: "#3b8eea",
            brightMagenta: "#d670d6",
            brightCyan: "#29b8db",
            brightWhite: "#ffffff",
          }
        : {
            background: "#ffffff",
            foreground: "#1e1e1e",
            cursor: "#1e1e1e",
            selectionBackground: "#add6ff",
          },
    };
  }

  onMount(async () => {
    term = new Terminal(buildOptions());
    fit = new FitAddon();
    search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon());
    term.open(container);

    // Robust initial fit: wait for the container to have a non-zero size,
    // then fit. We retry a few frames because flex layout + absolute fill
    // may take more than one paint to settle.
    const tryFit = (retries: number) => {
      const rect = container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        try {
          fit.fit();
          term.focus();
          return;
        } catch {
          /* fall through to retry */
        }
      }
      if (retries > 0) {
        requestAnimationFrame(() => tryFit(retries - 1));
      }
    };
    // Double-RAF: first frame lays out, second frame dimensions are stable.
    requestAnimationFrame(() => requestAnimationFrame(() => tryFit(5)));

    // Pipe backend data into the terminal (batched).
    unlistenData = await onData(sessionId, (p) => {
      if (onRxChunk) onRxChunk(p.ts, p.text);
      if (!paused) enqueue(p.text);
    });

    // On reconnect, write a visual divider so the user sees the gap.
    unlistenReconnected = await onReconnected(sessionId, () => {
      // Use single \n (convertEol handles carriage return) to avoid blank lines.
      term.write("\n\x1b[33m―― 已重新连接 / reconnected ――\x1b[0m\n");
    });

    // Refit on container resize, debounced. We track the last measured size and
    // only refit when it actually changed, so internal xterm DOM mutations
    // (which don't affect the absolute-positioned container) can't cause
    // fit/write races that mis-size the terminal.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let lastW = 0;
    let lastH = 0;
    ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.round(entry.contentRect.width);
        const h = Math.round(entry.contentRect.height);
        if (w === lastW && h === lastH) continue;
        lastW = w;
        lastH = h;
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          try {
            fit.fit();
          } catch {
            /* terminal not yet ready */
          }
        }, 50);
      }
    });
    ro.observe(container);

    // Refit on theme change.
    const unsubTheme = theme.subscribe(() => {
      if (term) {
        term.options.theme = buildOptions().theme;
      }
    });
    // Store unsub for cleanup.
    cleanupTheme = unsubTheme;
  });

  let cleanupTheme: (() => void) | null = null;

  onDestroy(() => {
    unlistenData?.();
    unlistenReconnected?.();
    cleanupTheme?.();
    ro?.disconnect();
    if (rafId !== null) cancelAnimationFrame(rafId);
    term?.dispose();
  });

  /** Public API: clear the terminal. */
  export function clear() {
    term?.reset();
  }

  /** Public API: write text directly (used for "tx echo"). */
  export function writeText(text: string) {
    enqueue(text);
  }

  /** Public API: focus the terminal. */
  export function focus() {
    term?.focus();
  }

  /** Public API: fit to container (call after showing a hidden tab). */
  export function fitToContainer() {
    try {
      fit?.fit();
      term?.focus();
    } catch {
      /* ignore */
    }
  }
</script>

<div bind:this={container} class="terminal-container"></div>

<style>
  /* Absolute fill the `relative` parent so the container has a concrete
     pixel size BEFORE xterm's FitAddon measures it on mount. Without this,
     flex layout can report height 0 during the mount tick and xterm renders
     only a tiny block in the corner. */
  .terminal-container {
    position: absolute;
    inset: 0;
    overflow: hidden;
    /* NO padding anywhere on or inside .terminal-container. xterm's FitAddon
       measures clientWidth/clientHeight and divides by cell size to get rows
       and cols. Any padding (on this box or on .xterm) introduces a mismatch
       between measured size and actual render area, which produces phantom
       scroll-area height and mis-sized rows. Keep it zero-padding. */
  }
  :global(.xterm),
  :global(.xterm-screen),
  :global(.xterm-rows),
  :global(.xterm-viewport) {
    padding: 0 !important;
  }
  :global(.xterm-viewport) {
    overflow-y: auto;
    scrollbar-width: thin;
  }
</style>
