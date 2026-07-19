<script lang="ts">
  import { _ } from "svelte-i18n";
  import { Send, History, Repeat, Hexagon } from "@lucide/svelte";
  import type { HistoryEntry } from "$lib/stores/session";
  import { parseCustomBreakLine } from "$lib/services/line-slice";

  export let connected: boolean;
  export let history: HistoryEntry[];
  /** Called with the byte array to transmit + the raw text + mode (for history). */
  export let onSend: (payload: { bytes: number[]; text: string; mode: "ascii" | "hex" }) => void;

  /** Input box contents (raw user text, before parsing). */
  let text = "";
  /** Whether to append a suffix after the payload. */
  let appendSuffix = true;
  /** Which preset suffix to append, or "custom" for a user-defined sequence. */
  let suffixKind: "none" | "cr" | "lf" | "space" | "etx" | "nul" | "custom" = "lf";
  let suffixCustomAscii = true;
  let suffixCustomInput = "";
  /** Input mode: ascii text or hex bytes. */
  let mode: "ascii" | "hex" = "ascii";
  let loopSend = false;
  let loopInterval = 1000;
  let loopTimer: ReturnType<typeof setInterval> | null = null;

  // Re-export `mode` as `hexMode` alias for template readability.
  $: hexMode = mode === "hex";

  /** Decode the suffix selection into the byte sequence to append. */
  function suffixBytes(): number[] {
    if (!appendSuffix) return [];
    switch (suffixKind) {
      case "none": return [];
      case "cr": return [0x0d];
      case "lf": return [0x0a];
      case "space": return [0x20];
      case "etx": return [0x03];
      case "nul": return [0x00];
      case "custom": {
        if (!suffixCustomInput.trim()) return [];
        const seq = parseCustomBreakLine(
          suffixCustomInput,
          suffixCustomAscii ? "ascii" : "hex",
        );
        return Array.from(seq);
      }
      // Legacy preset value — default selection; map below.
      default: return [];
    }
  }

  /** Parse the input box contents into a byte array, or null if invalid. */
  function parseInput(input: string): number[] | null {
    if (hexMode) {
      // Tokens are space-separated hex pairs (auto-spaced by the input filter).
      // Also tolerate commas / missing spaces for pasted content.
      const tokens = input.split(/[\s,]+/).filter(Boolean);
      const bytes: number[] = [];
      for (const t of tokens) {
        const n = parseInt(t.replace(/^0x/i, ""), 16);
        if (Number.isNaN(n) || n < 0 || n > 255) return null;
        bytes.push(n);
      }
      return bytes;
    }
    // Text mode: encode UTF-8 (handles 中文).
    const enc = new TextEncoder();
    return Array.from(enc.encode(input));
  }

  function doSend() {
    const parsed = parseInput(text);
    if (!parsed || parsed.length === 0) return;
    const bytes = [...parsed, ...suffixBytes()];
    onSend({ bytes, text, mode });
  }

  function sendNow() {
    if (!connected) return;
    doSend();
  }

  function toggleLoop() {
    if (!connected) return;
    loopSend = !loopSend;
    if (loopSend) {
      doSend(); // immediate first send
      loopTimer = setInterval(() => {
        if (loopSend) doSend();
      }, loopInterval);
    } else if (loopTimer) {
      clearInterval(loopTimer);
      loopTimer = null;
    }
  }

  /** Click a history entry: restore both text and mode. Does NOT auto-send —
   *  the user reviews then clicks Send. */
  function recall(item: HistoryEntry) {
    text = item.text;
    mode = item.mode;
  }

  /** Normalize hex input: strip every non-hex char, then group into pairs
   *  separated by single spaces ("41420a" / "41 42 0a"). */
  function normalizeHex(raw: string): string {
    const cleaned = raw.replace(/[^0-9a-fA-F]/g, "");
    // If there's an odd nibble, keep it so the user can finish typing; the
    // trailing single nibble won't parse but the visible pair grouping still
    // makes intent obvious.
    const pairs: string[] = [];
    for (let i = 0; i < cleaned.length; i += 2) {
      pairs.push(cleaned.slice(i, i + 2));
    }
    return pairs.join(" ");
  }

  /** Toggle between ascii and hex modes, converting the current input box
   *  contents to the new mode so nothing is lost on the switch:
   *  - ascii → hex: UTF-8 encode the text, render each byte as 2 hex digits
   *    separated by spaces.
   *  - hex → ascii: parse the hex pairs to bytes, UTF-8 decode, then strip
   *    non-printable characters (control bytes < 0x20 except \t, and DEL).
   *    Bytes that don't form valid UTF-8 are dropped. */
  function toggleMode() {
    if (mode === "ascii") {
      const utf8 = Array.from(new TextEncoder().encode(text));
      text = utf8.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
      mode = "hex";
    } else {
      // hex → ascii
      const tokens = text.split(/[\s,]+/).filter(Boolean);
      const bytes: number[] = [];
      for (const t of tokens) {
        const n = parseInt(t.replace(/^0x/i, ""), 16);
        if (!Number.isNaN(n) && n >= 0 && n <= 255) bytes.push(n);
      }
      const decoded = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
      // Keep only printable characters (and tab); drop control bytes & DEL.
      text = decoded.replace(/[^\x20-\x7E\t]/g, "");
      mode = "ascii";
    }
  }

  /** Intercept keystrokes in hex mode: only allow hex chars, spaces, backspace,
   *  arrows, etc. Let the input event normalize the value afterwards. */
  function onHexKeyDown(e: KeyboardEvent) {
    // Always allow: backspace, delete, arrows, home/end, tab, enter, modifiers.
    const allowed =
      e.ctrlKey || e.metaKey || e.altKey ||
      ["Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
       "Home", "End", "Tab", "Enter"].includes(e.key);
    if (allowed) return;
    // Allow a single hex nibble or an existing space.
    if (/^[0-9a-fA-F]$/.test(e.key)) return;
    if (e.key === " ") return;
    // Block everything else.
    e.preventDefault();
  }

  /** After any input change in hex mode, re-normalize spacing. */
  function onHexInput(e: Event) {
    const ta = e.currentTarget as HTMLTextAreaElement;
    const normalized = normalizeHex(ta.value);
    if (normalized !== ta.value) {
      // Preserve caret position relative to the end (common for auto-format).
      const tail = ta.value.length - ta.selectionStart;
      text = normalized;
      // Restore caret in a microtask after Svelte updates the binding.
      queueMicrotask(() => {
        ta.selectionStart = ta.selectionEnd = Math.max(0, normalized.length - tail);
      });
    } else {
      text = normalized;
    }
  }

  $: if (!connected && loopSend) {
    loopSend = false;
    if (loopTimer) {
      clearInterval(loopTimer);
      loopTimer = null;
    }
  }
</script>

<svelte:window on:beforeunload={() => { if (loopTimer) clearInterval(loopTimer); }} />

<div class="flex flex-shrink-0 flex-col gap-2 border-t border-surface-border bg-surface-card p-3">
  <div class="flex items-center gap-2 text-xs text-fg-soft">
    <Send size={13} />
    <span>{$_("send.title")}</span>
  </div>

  <textarea style="width:100%;"
    bind:value={text}
    on:keydown={(e) => {
      if (hexMode) onHexKeyDown(e);
      // Ctrl+Enter or Enter (when not multiline) sends.
      if ((e.ctrlKey && e.key === "Enter") || (e.key === "Enter" && !e.shiftKey && !loopSend)) {
        e.preventDefault();
        sendNow();
      }
    }}
    on:input={(e) => { if (hexMode) onHexInput(e); }}
    placeholder={hexMode ? $_("send.hexHint") : $_("send.placeholder")}
    rows="2"
    spellcheck="false"
    autocomplete="off"
    autocapitalize="off"
    class="w-full resize-y rounded border border-surface-border bg-surface px-2 py-1.5 font-mono text-sm focus:border-accent focus:outline-none"
  ></textarea>

  <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
    <label class="flex items-center gap-1.5">
      <input type="checkbox" bind:checked={appendSuffix} />
      {$_("send.appendChar")}
    </label>
    <select bind:value={suffixKind} disabled={!appendSuffix} class="rounded border border-surface-border bg-surface px-1.5 py-0.5">
      <option value={"none"}>{$_("send.suffixNone")}</option>
      <option value={"cr"}>{$_("send.suffixCR")}</option>
      <option value={"lf"}>{$_("send.suffixLF")}</option>
      <option value={"space"}>{$_("send.suffixSpace")}</option>
      <option value={"etx"}>{$_("send.suffixETX")}</option>
      <option value={"nul"}>{$_("send.suffixNUL")}</option>
      <option value={"custom"}>{$_("send.suffixCustom")}</option>
    </select>
    {#if suffixKind === "custom" && appendSuffix}
      <select bind:value={suffixCustomAscii} class="rounded border border-surface-border bg-surface px-1 py-0.5" title={$_("send.customFormat")}>
        <option value={true}>{$_("send.customAscii")}</option>
        <option value={false}>{$_("send.customHex")}</option>
      </select>
      <input
        type="text"
        bind:value={suffixCustomInput}
        placeholder={suffixCustomAscii ? $_("send.suffixCustomPhAscii") : $_("send.suffixCustomPhHex")}
        class="w-36 rounded border border-surface-border bg-surface px-1.5 py-0.5 font-mono"
      />
    {/if}

    <label class="flex items-center gap-1.5" title={$_("send.hexHint")}>
      <input type="checkbox" checked={hexMode} on:change={toggleMode} />
      <Hexagon size={13} />
      {$_("send.hexMode")}
    </label>

    <label class="flex items-center gap-1.5">
      <input type="checkbox" bind:checked={loopSend} on:change={toggleLoop} disabled={!connected} />
      <Repeat size={13} />
      {$_("send.loop")}
      <input
        type="number"
        bind:value={loopInterval}
        min="50"
        step="100"
        class="w-20 rounded border border-surface-border bg-surface px-1.5 py-0.5"
      />
      ms
    </label>

    <div class="flex-1"></div>

    <button
      type="button"
      on:click={sendNow}
      disabled={!connected || !text.trim()}
      class="flex items-center gap-1.5 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-40"
    >
      <Send size={14} />
      {$_("common.send")}
    </button>
  </div>

  {#if history.length > 0}
    <div class="flex items-start gap-2 pt-1">
      <History size={13} class="mt-0.5 shrink-0 text-fg-mute" />
      <div class="flex flex-wrap gap-1.5">
        {#each history as item, i (`${item.mode}:${item.text}:${i}`)}
          <button
            type="button"
            on:click={() => recall(item)}
            class="flex max-w-[240px] items-center gap-1 rounded border border-surface-border bg-surface px-2 py-0.5 font-mono text-xs hover:bg-surface-hover"
            title={item.text}
          >
            <span class="rounded bg-surface-hover px-1 text-[10px] uppercase text-fg-soft">{item.mode === "hex" ? "HEX" : "ASC"}</span>
            <span class="truncate">{item.text}</span>
          </button>
        {/each}
      </div>
    </div>
  {/if}
</div>
