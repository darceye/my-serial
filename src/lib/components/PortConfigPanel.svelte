<script lang="ts">
  import { _ } from "svelte-i18n";
  import { RefreshCw, Plug, Plug2, Repeat } from "@lucide/svelte";
  import type { PortConfig, PortInfo, ReconnectConfig } from "$lib/tauri/commands";
  import { BAUD_PRESETS } from "$lib/tauri/commands";

  export let config: PortConfig;
  export let reconnect: ReconnectConfig;
  export let ports: PortInfo[];
  export let connected: boolean;
  export let reconnecting: boolean;
  export let onRefresh: () => void;
  export let onConnect: () => void;
  export let onDisconnect: () => void;

  function portLabel(p: PortInfo): string {
    const bits = [p.name];
    if (p.description) bits.push(p.description);
    if (p.vid) bits.push(`${p.vid}:${p.pid}`);
    return bits.join(" — ");
  }

  // The preset <select> is uncontrolled: it stays on its placeholder so the
  // dropdown always lists every preset. Selecting one writes through to
  // config.baud_rate and snaps back to the placeholder, leaving the text
  // input free for custom rates (a <datalist> would filter options by the
  // typed text, which prevented switching back to other presets).
  let baudPreset = "";
  function applyBaudPreset(e: Event) {
    const v = Number((e.currentTarget as HTMLSelectElement).value);
    if (v > 0) config.baud_rate = v;
    baudPreset = "";
  }
</script>

<div class="flex flex-shrink-0 flex-wrap items-end gap-x-4 gap-y-2 border-b border-surface-border p-3">
  <!-- Port -->
  <label class="flex flex-col gap-1">
    <span class="text-xs text-fg-soft">{$_("config.port")}</span>
    <select
      bind:value={config.port_name}
      disabled={connected || reconnecting}
      class="min-w-[200px] rounded border border-surface-border bg-surface px-2 py-1.5 text-sm disabled:opacity-50"
    >
      {#if ports.length === 0}
        <option value="">{$_("boot.noPorts")}</option>
      {/if}
      {#each ports as p (p.name)}
        <option value={p.name}>{portLabel(p)}</option>
      {/each}
    </select>
  </label>

  <button
    type="button"
    on:click={onRefresh}
    disabled={connected}
    class="mb-0.5 flex items-center gap-1 rounded border border-surface-border bg-surface px-2 py-1.5 text-sm hover:bg-surface-hover disabled:opacity-40"
    title={$_("common.refresh")}
  >
    <RefreshCw size={14} />
  </button>

  <!-- Baud rate: free-text input for custom rates + an adjacent preset
       dropdown that always lists every preset (no live filtering, so any
       preset can be picked at any time regardless of what's typed).
       The caret <div> is purely visual; a transparent <select> overlays it
       to capture the click and pop the native picker. The <select> itself
       is never visible, so the chosen value can't bleed into the layout —
       on change we snap it back to the empty placeholder, which means the
       dropdown reopens with the full list every time. -->
  <label class="flex flex-col gap-1">
    <span class="text-xs text-fg-soft">{$_("config.baudRate")}</span>
    <div class="flex">
      <input
        type="number"
        bind:value={config.baud_rate}
        disabled={connected || reconnecting}
        class="baud-input w-24 rounded-l border border-r-0 border-surface-border bg-surface px-2 py-1.5 text-sm tabular-nums disabled:opacity-50"
      />
      <div
        class="relative flex items-center rounded-r border border-surface-border bg-surface px-2 py-1.5 text-xs text-fg-soft"
        class:opacity-50={connected || reconnecting}
      >
        <span aria-hidden="true">▾</span>
        <select
          value={baudPreset}
          on:change={applyBaudPreset}
          disabled={connected || reconnecting}
          title={$_("config.baudPresets")}
          class="absolute inset-0 cursor-pointer border-0 bg-transparent p-0 text-xs opacity-0"
        >
          <option value=""></option>
          {#each BAUD_PRESETS as b}<option value={b}>{b}</option>{/each}
        </select>
      </div>
    </div>
  </label>

  <!-- Data bits -->
  <label class="flex flex-col gap-1">
    <span class="text-xs text-fg-soft">{$_("config.dataBits")}</span>
    <select
      bind:value={config.data_bits}
      disabled={connected || reconnecting}
      class="rounded border border-surface-border bg-surface px-2 py-1.5 text-sm disabled:opacity-50"
    >
      {#each [5, 6, 7, 8] as d}<option value={d}>{d}</option>{/each}
    </select>
  </label>

  <!-- Parity -->
  <label class="flex flex-col gap-1">
    <span class="text-xs text-fg-soft">{$_("config.parity")}</span>
    <select
      bind:value={config.parity}
      disabled={connected || reconnecting}
      class="rounded border border-surface-border bg-surface px-2 py-1.5 text-sm disabled:opacity-50"
    >
      <option value="none">{$_("config.parityNone")}</option>
      <option value="even">{$_("config.parityEven")}</option>
      <option value="odd">{$_("config.parityOdd")}</option>
      <option value="mark">{$_("config.parityMark")}</option>
      <option value="space">{$_("config.paritySpace")}</option>
    </select>
  </label>

  <!-- Stop bits -->
  <label class="flex flex-col gap-1">
    <span class="text-xs text-fg-soft">{$_("config.stopBits")}</span>
    <select
      bind:value={config.stop_bits}
      disabled={connected || reconnecting}
      class="rounded border border-surface-border bg-surface px-2 py-1.5 text-sm disabled:opacity-50"
    >
      <option value={1}>1</option>
      <option value={2}>2</option>
    </select>
  </label>

  <!-- Flow control -->
  <label class="flex flex-col gap-1">
    <span class="text-xs text-fg-soft">{$_("config.flowControl")}</span>
    <select
      bind:value={config.flow_control}
      disabled={connected || reconnecting}
      class="rounded border border-surface-border bg-surface px-2 py-1.5 text-sm disabled:opacity-50"
    >
      <option value="none">{$_("config.flowNone")}</option>
      <option value="software">{$_("config.flowSoftware")}</option>
      <option value="hardware">{$_("config.flowHardware")}</option>
    </select>
  </label>

  <!-- Connect / Disconnect -->
  <div class="mb-0.5">
    {#if connected}
      <button
        type="button"
        on:click={onDisconnect}
        class="flex items-center gap-1.5 rounded-md bg-red-600/90 px-4 py-1.5 text-sm font-medium text-fg-on hover:bg-red-600"
      >
        <Plug2 size={15} />
        {$_("common.disconnect")}
      </button>
    {:else}
      <button
        type="button"
        on:click={onConnect}
        disabled={reconnecting || !config.port_name}
        class="flex items-center gap-1.5 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-40"
      >
        <Plug size={15} />
        {#if reconnecting}{$_("status.reconnecting")}{:else}{$_("common.connect")}{/if}
      </button>
    {/if}
  </div>

  <!-- Auto-reconnect config -->
  <div class="mb-0.5 flex items-center gap-2 border-l border-surface-border pl-4 text-xs">
    <label class="flex items-center gap-1.5" title={$_("menu.autoReconnect")}>
      <input type="checkbox" bind:checked={reconnect.enabled} />
      <Repeat size={13} />
      {$_("menu.autoReconnect")}
    </label>
    {#if reconnect.enabled}
      <label class="flex items-center gap-1">
        {$_("send.loopInterval")}
        <input
          type="number"
          bind:value={reconnect.interval_ms}
          min="100"
          step="100"
          class="w-20 rounded border border-surface-border bg-surface px-1.5 py-0.5"
        />
        ms
      </label>
      <label class="flex items-center gap-1">
        max
        <input
          type="number"
          bind:value={reconnect.max_attempts}
          min="0"
          class="w-16 rounded border border-surface-border bg-surface px-1.5 py-0.5"
          title="0 = infinite"
        />
        (0=∞)
      </label>
    {/if}
  </div>
</div>

<style>
  /* Hide the native +/- spinner buttons on the baud-rate number input. */
  .baud-input::-webkit-inner-spin-button,
  .baud-input::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .baud-input {
    -moz-appearance: textfield;
    appearance: textfield;
  }
</style>
