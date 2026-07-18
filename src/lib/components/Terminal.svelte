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
      // ASCII mode: optionally strip color, normalize EOL, prefix timestamps.
      let out = colorParse ? text : text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
      if (eolMode !== "raw") {
        const target = eolMode;
        out = out.replace(/\r\n|\r|\n/g, target === "\n" ? "\n" : "\r\n");
        // xterm needs \r to return carriage before \n, so normalize to \r\n.
        out = out.replace(/\n/g, "\r\n").replace(/\r\r\n/g, "\r\n");
      }
      if (timestamp !== "off") {
        // Insert prefix at the start of each line.
        out = out
          .split(/(\r?\n)/)
          .map((seg, i) =>
            /\r?\n/.test(seg) || seg === ""
              ? seg
              : (atLineStart ? linePrefix() : "") + seg,
          )
          .join("");
        // Recompute atLineStart: true if out ended with newline.
        atLineStart = /\r?\n$/.test(out);
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
      convertEol: false,
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
    fit.fit();

    // Pipe backend data into the terminal (batched).
    unlistenData = await onData(sessionId, (p) => {
      if (onRxChunk) onRxChunk(p.ts, p.text);
      if (!paused) enqueue(p.text);
    });

    // On reconnect, write a visual divider so the user sees the gap.
    unlistenReconnected = await onReconnected(sessionId, () => {
      term.write("\r\n\x1b[33m―― 已重新连接 / reconnected ――\x1b[0m\r\n");
    });

    // Refit on container resize.
    ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* terminal not yet ready */
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

<div bind:this={container} class="h-full w-full overflow-hidden"></div>

<style>
  :global(.xterm) {
    height: 100%;
    padding: 4px 6px;
  }
  :global(.xterm-viewport) {
    overflow-y: auto;
    scrollbar-width: thin;
  }
</style>
