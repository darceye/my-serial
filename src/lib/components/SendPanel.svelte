<script lang="ts">
  import { _ } from "svelte-i18n";
  import { Send, History, Repeat, Hexagon } from "@lucide/svelte";

  export let connected: boolean;
  export let history: string[];
  /** Called with the byte array to transmit. */
  export let onSend: (bytes: number[]) => void;

  let text = "";
  let appendNewline = true;
  let newline: "none" | "\n" | "\r" | "\r\n" = "\r\n";
  let hexMode = false;
  let loopSend = false;
  let loopInterval = 1000;
  let loopTimer: ReturnType<typeof setInterval> | null = null;

  function parseInput(input: string): number[] | null {
    if (hexMode) {
      // Accept "41 42 0A" or "0x41,0x42". Tolerate spaces/commas.
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

  function appendEol(bytes: number[]): number[] {
    if (!appendNewline) return bytes;
    const eol = newline === "none" ? "" : newline;
    return [...bytes, ...Array.from(eol).map((c) => c.charCodeAt(0))];
  }

  function doSend() {
    const parsed = parseInput(text);
    if (!parsed || parsed.length === 0) return;
    const bytes = appendEol(parsed);
    onSend(bytes);
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

  function resend(item: string) {
    text = item;
    sendNow();
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

<div class="flex flex-col gap-2 border-t border-surface-border bg-surface-card p-3">
  <div class="flex items-center gap-2 text-xs text-gray-400">
    <Send size={13} />
    <span>{$_("send.title")}</span>
  </div>

  <textarea
    bind:value={text}
    on:keydown={(e) => {
      // Ctrl+Enter or Enter (when not multiline) sends.
      if ((e.ctrlKey && e.key === "Enter") || (e.key === "Enter" && !e.shiftKey && !loopSend)) {
        e.preventDefault();
        sendNow();
      }
    }}
    placeholder={hexMode ? $_("send.hexHint") : $_("send.placeholder")}
    rows="2"
    class="w-full resize-y rounded border border-surface-border bg-surface px-2 py-1.5 font-mono text-sm focus:border-accent focus:outline-none"
  ></textarea>

  <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
    <label class="flex items-center gap-1.5">
      <input type="checkbox" bind:checked={appendNewline} />
      {$_("send.appendNewline")}
    </label>
    <select bind:value={newline} disabled={!appendNewline} class="rounded border border-surface-border bg-surface px-1.5 py-0.5">
      <option value={"none"}>{$_("send.newlineNone")}</option>
      <option value={"\n"}>{$_("send.newlineLF")}</option>
      <option value={"\r"}>{$_("send.newlineCR")}</option>
      <option value={"\r\n"}>{$_("send.newlineCRLF")}</option>
    </select>

    <label class="flex items-center gap-1.5" title={$_("send.hexHint")}>
      <input type="checkbox" bind:checked={hexMode} />
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
      <History size={13} class="mt-0.5 shrink-0 text-gray-500" />
      <div class="flex flex-wrap gap-1.5">
        {#each history as item, i (item + i)}
          <button
            type="button"
            on:click={() => resend(item)}
            disabled={!connected}
            class="max-w-[200px] truncate rounded border border-surface-border bg-surface px-2 py-0.5 font-mono text-xs hover:bg-surface-hover disabled:opacity-40"
            title={item}
          >
            {item}
          </button>
        {/each}
      </div>
    </div>
  {/if}
</div>
