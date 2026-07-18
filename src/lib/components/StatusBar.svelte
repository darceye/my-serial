<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { _ } from "svelte-i18n";
  import type { TabSession } from "$lib/stores/session";

  export let session: TabSession;

  let now = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    timer = setInterval(() => (now = Date.now()), 1000);
  });
  onDestroy(() => {
    if (timer) clearInterval(timer);
  });

  $: durationSec = session.connectedAt ? Math.floor((now - session.connectedAt) / 1000) : 0;

  function fmtBytes(n: number): string {
    if (n < 1024) return `${n}`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
    return `${(n / 1024 / 1024).toFixed(2)}M`;
  }

  function fmtDuration(sec: number): string {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  $: stateColor =
    session.state === "connected"
      ? "bg-green-500"
      : session.state === "reconnecting"
        ? "bg-yellow-500 animate-pulse"
        : session.state === "connecting"
          ? "bg-blue-500 animate-pulse"
          : session.state === "lost"
            ? "bg-red-500"
            : "bg-gray-600";

  $: stateLabel = (() => {
    switch (session.state) {
      case "connected": return $_("status.connected");
      case "connecting": return $_("status.connecting");
      case "reconnecting":
        return session.maxAttempts > 0
          ? $_("status.reconnectAttempts", { values: { n: session.attempts, max: session.maxAttempts } })
          : $_("status.reconnectInfinite", { values: { n: session.attempts } });
      case "lost": return $_("status.lost");
      default: return $_("status.disconnected");
    }
  })();
</script>

<div class="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-surface-border bg-surface px-3 py-1.5 text-xs text-gray-300">
  <!-- Connection state -->
  <div class="flex items-center gap-1.5">
    <span class="inline-block h-2 w-2 rounded-full {stateColor}"></span>
    <span>{stateLabel}</span>
  </div>

  {#if session.state === "connected" || session.state === "reconnecting"}
    <!-- RX / TX -->
    <span>↓ {fmtBytes(session.rxBytes)} <span class="text-gray-500">({session.rxRate.toFixed(0)} {$_("stats.bytesPerSec")})</span></span>
    <span>↑ {fmtBytes(session.txBytes)} <span class="text-gray-500">({session.txRate.toFixed(0)} {$_("stats.bytesPerSec")})</span></span>
    {#if session.connectedAt}
      <span>⏱ {fmtDuration(durationSec)}</span>
    {/if}

    <!-- Signals -->
    <div class="flex items-center gap-2 pl-2">
      <span class="text-gray-500">RTS/DTR</span>
    </div>
    <div class="flex items-center gap-1.5">
      <span>CTS</span><span class="font-mono {session.signals.cts ? 'text-green-400' : 'text-gray-600'}">●</span>
      <span>DSR</span><span class="font-mono {session.signals.dsr ? 'text-green-400' : 'text-gray-600'}">●</span>
      <span>CD</span><span class="font-mono {session.signals.cd ? 'text-green-400' : 'text-gray-600'}">●</span>
      <span>RI</span><span class="font-mono {session.signals.ri ? 'text-green-400' : 'text-gray-600'}">●</span>
    </div>
  {/if}
</div>
