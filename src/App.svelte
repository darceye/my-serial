<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { _ } from "svelte-i18n";
  import { locale } from "$lib/i18n";
  import {
    Languages,
    Plus,
    X,
    Eraser,
    Trash2,
    Sun,
    Moon,
  } from "@lucide/svelte";

  import {
    activeSessionId,
    activeSession,
    sessions,
    tabs,
    ports,
    theme,
    createTabRecord,
    patchSession,
    addTxBytes,
    addRxBytes,
    pushHistory,
    recordChunk,
  } from "$lib/stores/session";

  import {
    listPorts,
    createSession,
    openPort,
    closePort,
    writeData,
    destroySession,
    DEFAULT_CONFIG,
    DEFAULT_RECONNECT,
    type PortConfig,
  } from "$lib/tauri/commands";
  import { appendLog, exportLines, type ExportFormat } from "$lib/services/recorder";
  import type { CharBreak } from "$lib/services/line-slice";
  import {
    onStatus,
    onSignal,
    onPortsChanged,
  } from "$lib/tauri/events";

  import PortConfigPanel from "$lib/components/PortConfigPanel.svelte";
  import SendPanel from "$lib/components/SendPanel.svelte";
  import StatusBar from "$lib/components/StatusBar.svelte";
  import OutputView from "$lib/components/OutputView.svelte";

  let termRefs: Record<string, OutputView> = {};
  const unlistenFns: (() => void)[] = [];
  // Per-session event unsubscribers.
  const sessionUnsubs: Record<string, (() => void)[]> = {};

  $: active = $activeSession;

  onMount(async () => {
    document.documentElement.classList.toggle("light", $theme === "light");
    await refreshPorts();
    // Start with one tab.
    await newTab();
    // Global ports-changed listener.
    unlistenFns.push(await onPortsChanged(async () => { await refreshPorts(); }));
  });

  onDestroy(() => {
    unlistenFns.forEach((f) => f());
    Object.values(sessionUnsubs).flat().forEach((f) => f());
  });

  async function refreshPorts() {
    ports.set(await listPorts());
  }

  async function newTab(config?: PortConfig) {
    const cfg = config ?? { ...DEFAULT_CONFIG };
    const rc = { ...DEFAULT_RECONNECT };
    const sid = await createSession(cfg, rc);
    const rec = createTabRecord(sid, cfg, rc);
    sessions.update((s) => ({ ...s, [sid]: rec }));
    tabs.update((t) => [...t, { sessionId: sid, label: rec.title }]);
    activeSessionId.set(sid);
    await subscribeSession(sid);
    // Focus terminal after render.
    setTimeout(() => termRefs[sid]?.fitToContainer(), 50);
  }

  async function subscribeSession(sid: string) {
    sessionUnsubs[sid] = [
      await onStatus(sid, (p) => {
        patchSession(sid, {
          state: p.state,
          attempts: p.attempts ?? 0,
          maxAttempts: p.max_attempts ?? 0,
          connectedAt: p.state === "connected" ? Date.now() : null,
        });
      }),
      await onSignal(sid, (p) => {
        sessions.update((s) => {
          if (!s[sid]) return s;
          return { ...s, [sid]: { ...s[sid], signals: { cts: p.cts, dsr: p.dsr, cd: p.cd, ri: p.ri } } };
        });
      }),
    ];
  }

  async function closeTab(sid: string) {
    // Clean up session on backend.
    try { await destroySession(sid); } catch { /* ignore */ }
    // Unsubscribe events.
    sessionUnsubs[sid]?.forEach((f) => f());
    delete sessionUnsubs[sid];
    delete termRefs[sid];
    // Update stores.
    sessions.update((s) => { const n = { ...s }; delete n[sid]; return n; });
    tabs.update((t) => {
      const filtered = t.filter((x) => x.sessionId !== sid);
      if ($activeSessionId === sid) {
        activeSessionId.set(filtered[0]?.sessionId ?? null);
      }
      return filtered;
    });
    // If no tabs left, create a fresh one.
    if (getTabs().length === 0) {
      await newTab();
    }
  }

  function getTabs() {
    let t: { sessionId: string; label: string }[] = [];
    const unsub = tabs.subscribe((v) => (t = v));
    unsub();
    return t;
  }

  async function onConnect() {
    const sid = $activeSessionId;
    if (!sid) return;
    const s = $sessions[sid];
    if (!s) return;
    if (!s.config.port_name) {
      alert($_("config.portPlaceholder"));
      return;
    }
    patchSession(sid, { state: "connecting" });
    try {
      // Push the LATEST config + reconnect policy to the backend at connect
      // time — the session was created with an empty placeholder port_name.
      await openPort(sid, s.config, s.reconnect);
    } catch (e) {
      patchSession(sid, { state: "disconnected" });
      console.error("connect failed", e);
      alert(`${$_("toast.connectFailed", { values: { msg: String(e) } })}`);
    }
  }

  async function onDisconnect() {
    const sid = $activeSessionId;
    if (!sid) return;
    try { await closePort(sid); } catch (e) { console.error(e); }
  }

  async function onSend(bytes: number[]) {
    const sid = $activeSessionId;
    if (!sid) return;
    try {
      await writeData(sid, bytes);
      addTxBytes(sid, bytes.length);
      const byteArr = new Uint8Array(bytes);
      const decoded = new TextDecoder().decode(byteArr);
      // Echo sent bytes into the output view — the native renderer colors
      // tx chunks via its dir-tx class, no ANSI wrapping needed.
      termRefs[sid]?.writeText(decoded);
      if (bytes.length > 0) pushHistory(sid, decoded.replace(/[\r\n]+$/, ""));
      // Record for export + optional file logging. Use send time as ts.
      const now = Date.now();
      recordChunk(sid, "tx", byteArr, decoded, now);
      const s = $sessions[sid];
      if (s?.logging) appendLog(sid, { ts: now, dir: "tx", text: decoded });
    } catch (e) {
      console.error("write failed", e);
      alert(`${$_("toast.writeFailed", { values: { msg: String(e) } })}`);
    }
  }

  function onClearTerminal() {
    const sid = $activeSessionId;
    if (!sid) return;
    termRefs[sid]?.clear();
  }

  /** Called by OutputView for every RX chunk — records for export + optional
   *  file logging. Uses the backend's chunk timestamp (p.ts) for accurate
   *  receive-time tracking, NOT Date.now() at processing time. */
  function handleRxChunk(sid: string, ts: number, text: string) {
    const bytes = new TextEncoder().encode(text);
    recordChunk(sid, "rx", bytes, text, ts);
    // Bump the RX byte counter for the status bar.
    addRxBytes(sid, bytes.length);
    const s = $sessions[sid];
    if (s?.logging) {
      appendLog(sid, { ts, dir: "rx", text });
    }
  }

  async function exportCurrent(format: ExportFormat) {
    const sid = $activeSessionId;
    if (!sid) return;
    const s = $sessions[sid];
    if (!s || s.recorded.length === 0) {
      alert("No data to export");
      return;
    }
    try {
      const path = await exportLines(sid, s.recorded, format);
      alert(`${$_("toast.exported", { values: { path } })}`);
    } catch (e) {
      alert(`${$_("toast.exportFailed", { values: { msg: String(e) } })}`);
    }
  }

  function toggleLogging() {
    const sid = $activeSessionId;
    if (!sid) return;
    const s = $sessions[sid];
    patchSession(sid, { logging: !s.logging });
  }

  /** Toggle a single char-break kind (nul/lf/cr/crlf/etx) on/off. */
  function toggleCharBreak(kind: CharBreak) {
    const sid = $activeSessionId;
    if (!sid) return;
    const s = $sessions[sid];
    const set = new Set(s.lineCharBreaks);
    if (set.has(kind)) set.delete(kind); else set.add(kind);
    // Preserve a stable display order.
    const order: CharBreak[] = ["nul", "lf", "cr", "crlf", "etx"];
    patchSession(sid, { lineCharBreaks: order.filter((k) => set.has(k)) });
  }

  function toggleLocale() {
    locale.update((v) => (v === "zh-CN" ? "en-US" : "zh-CN"));
  }

  function toggleTheme() {
    theme.update((v) => (v === "dark" ? "light" : "dark"));
  }

  /** Global keyboard shortcuts (active only when not typing in an input). */
  function onGlobalKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    const typing =
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable;
    if (typing) return;
    if (e.ctrlKey && e.key === "l") {
      e.preventDefault();
      onClearTerminal();
    } else if (e.ctrlKey && e.shiftKey && (e.key === "n" || e.key === "N")) {
      e.preventDefault();
      newTab();
    } else if (e.ctrlKey && e.key === "Tab") {
      e.preventDefault();
      const list = getTabs();
      if (list.length > 1) {
        const idx = list.findIndex((t) => t.sessionId === $activeSessionId);
        const next = list[(idx + 1) % list.length];
        activeSessionId.set(next.sessionId);
      }
    }
  }
</script>

<svelte:window on:keydown={onGlobalKey} />

<main class="flex h-screen w-screen flex-col overflow-hidden bg-surface text-gray-100">
  <!-- Title bar -->
  <header class="flex flex-shrink-0 items-center justify-between border-b border-surface-border px-3 py-2">
    <div class="flex items-center gap-2">
      <h1 class="text-sm font-semibold tracking-wide">MySerial</h1>
      <span class="text-xs text-gray-500">·</span>
      <span class="text-xs text-gray-400">{$_("app.subtitle")}</span>
    </div>
    <div class="flex items-center gap-1">
      <button
        class="rounded p-1.5 hover:bg-surface-hover"
        on:click={toggleLocale}
        title={$_("menu.language")}
      >
        <Languages size={16} />
      </button>
      <button
        class="rounded p-1.5 hover:bg-surface-hover"
        on:click={toggleTheme}
        title={$_("menu.theme")}
      >
        {#if $theme === "dark"}<Sun size={16} />{:else}<Moon size={16} />{/if}
      </button>
    </div>
  </header>

  <!-- Tab strip -->
  <nav class="flex flex-shrink-0 items-stretch gap-px overflow-x-auto border-b border-surface-border bg-surface-card">
    {#each $tabs as tab (tab.sessionId)}
      <div
        class="group flex cursor-pointer items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors
          {$activeSessionId === tab.sessionId
            ? 'border-accent bg-surface text-white'
            : 'border-transparent text-gray-400 hover:bg-surface-hover'}"
        role="tab"
        tabindex="0"
        on:click={() => {
          activeSessionId.set(tab.sessionId);
          setTimeout(() => termRefs[tab.sessionId]?.fitToContainer(), 50);
        }}
        on:keydown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activeSessionId.set(tab.sessionId);
          }
        }}
      >
        <span>{$sessions[tab.sessionId]?.title ?? tab.label}</span>
        <span
          class="inline-block h-1.5 w-1.5 rounded-full
            {$sessions[tab.sessionId]?.state === 'connected' ? 'bg-green-500'
            : $sessions[tab.sessionId]?.state === 'reconnecting' ? 'bg-yellow-500'
            : $sessions[tab.sessionId]?.state === 'lost' ? 'bg-red-500'
            : 'bg-gray-600'}"
        ></span>
        <button
          type="button"
          class="ml-1 rounded p-0.5 opacity-0 hover:bg-surface-border group-hover:opacity-100"
          on:click|stopPropagation={() => closeTab(tab.sessionId)}
          aria-label={$_("common.close")}
        >
          <X size={12} />
        </button>
      </div>
    {/each}
    <button
      class="flex items-center px-3 text-gray-400 hover:bg-surface-hover hover:text-white"
      on:click={() => newTab()}
      title={$_("common.newTab")}
    >
      <Plus size={16} />
    </button>
  </nav>

  {#if active}
    <!-- Port config -->
    <PortConfigPanel
      config={active.config}
      reconnect={active.reconnect}
      ports={$ports}
      connected={active.state === "connected"}
      reconnecting={active.state === "reconnecting" || active.state === "connecting"}
      onRefresh={refreshPorts}
      onConnect={onConnect}
      onDisconnect={onDisconnect}
    />

    <!-- Terminal + toolbar. Flex column: controls strip on top (shrink-0),
         terminal pane fills the rest. The pane itself is `relative` so the
         inner Terminal (absolute inset-0) gets a concrete pixel size before
         xterm's FitAddon runs. -->
    <section class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <!-- Display controls strip -->
      <div class="flex flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-surface-border bg-surface-card/60 px-3 py-1 text-xs">
        <label class="flex items-center gap-1">
          <span class="text-gray-400">{$_("display.mode")}:</span>
          <select
            class="rounded border border-surface-border bg-surface px-1.5 py-0.5"
            value={active.displayMode}
            on:change={(e) => patchSession(active.id, { displayMode: e.currentTarget.value as "ascii" | "hex" | "ascii+hex" })}
          >
            <option value="ascii">{$_("display.ascii")}</option>
            <option value="hex">{$_("display.hex")}</option>
            <option value="ascii+hex">{$_("display.asciiHex")}</option>
          </select>
        </label>
        <label class="flex items-center gap-1">
          <span class="text-gray-400">{$_("display.timestamp")}:</span>
          <select
            class="rounded border border-surface-border bg-surface px-1.5 py-0.5"
            value={active.timestamp}
            on:change={(e) => patchSession(active.id, { timestamp: e.currentTarget.value as "off" | "absolute" | "relative" })}
          >
            <option value="off">{$_("display.tsOff")}</option>
            <option value="absolute">{$_("display.tsAbsolute")}</option>
            <option value="relative">{$_("display.tsRelative")}</option>
          </select>
        </label>
        <label class="flex items-center gap-1">
          <input
            type="checkbox"
            checked={active.colorParse}
            on:change={(e) => patchSession(active.id, { colorParse: e.currentTarget.checked })}
          />
          <span class="text-gray-400">{$_("menu.colorParse")}</span>
        </label>
        <label class="flex items-center gap-1">
          <input
            type="checkbox"
            checked={active.paused}
            on:change={(e) => patchSession(active.id, { paused: e.currentTarget.checked })}
          />
          <span class="text-gray-400">{$_("common.pause")}</span>
        </label>

        <!-- Line-break rules -->
        <span class="text-gray-500">|</span>
        <span class="text-gray-400">{$_("display.lineBreakChars")}:</span>
        {#each [["nul", "display.lbNul"], ["lf", "display.lbLf"], ["cr", "display.lbCr"], ["crlf", "display.lbCrlf"], ["etx", "display.lbEtx"]] as [kind, key]}
          <label class="flex items-center gap-1">
            <input
              type="checkbox"
              checked={active.lineCharBreaks.includes(kind as CharBreak)}
              on:change={() => toggleCharBreak(kind as CharBreak)}
            />
            <span class="text-gray-400">{$_(key)}</span>
          </label>
        {/each}
        <label class="flex items-center gap-1">
          <input
            type="checkbox"
            checked={active.customBreakEnabled}
            on:change={(e) => patchSession(active.id, { customBreakEnabled: e.currentTarget.checked })}
          />
          <span class="text-gray-400">{$_("display.customBreak")}:</span>
          <select
            class="rounded border border-surface-border bg-surface px-1 py-0.5"
            value={active.customBreakFormat}
            on:change={(e) => patchSession(active.id, { customBreakFormat: e.currentTarget.value as "ascii" | "hex" })}
            title={$_("display.customBreakFormat")}
          >
            <option value="ascii">{$_("display.customAscii")}</option>
            <option value="hex">{$_("display.customHex")}</option>
          </select>
          <input
            type="text"
            class="w-28 rounded border border-surface-border bg-surface px-1.5 py-0.5 font-mono"
            value={active.customBreakInput}
            placeholder={active.customBreakFormat === "hex"
              ? $_("display.customPlaceholderHex")
              : $_("display.customPlaceholderAscii")}
            on:change={(e) => patchSession(active.id, { customBreakInput: e.currentTarget.value })}
          />
        </label>
        <label class="flex items-center gap-1">
          <span class="text-gray-400">{$_("display.breakEveryN")}:</span>
          <input
            type="number"
            min="0"
            class="w-14 rounded border border-surface-border bg-surface px-1.5 py-0.5"
            value={active.breakEveryNBytes}
            title={$_("display.breakEveryNHint")}
            on:change={(e) => patchSession(active.id, { breakEveryNBytes: Math.max(0, e.currentTarget.valueAsNumber || 0) })}
          />
        </label>
        <label class="flex items-center gap-1">
          <span class="text-gray-400">{$_("display.breakOnIdle")}:</span>
          <input
            type="number"
            min="0"
            class="w-16 rounded border border-surface-border bg-surface px-1.5 py-0.5"
            value={active.breakOnIdleMs}
            title={$_("display.breakOnIdleHint")}
            on:change={(e) => patchSession(active.id, { breakOnIdleMs: Math.max(0, e.currentTarget.valueAsNumber || 0) })}
          />
          <span class="text-gray-500">ms</span>
        </label>
        <label class="flex items-center gap-1">
          <input
            type="checkbox"
            checked={active.showNonPrintable}
            on:change={(e) => patchSession(active.id, { showNonPrintable: e.currentTarget.checked })}
          />
          <span class="text-gray-400">{$_("display.showNonPrintable")}</span>
        </label>

        <div class="flex-1"></div>
        <label class="flex items-center gap-1">
          <input type="checkbox" checked={active.logging} on:change={toggleLogging} />
          <span class="text-gray-400">{$_("menu.log")}</span>
        </label>
        <div class="flex items-center gap-1">
          <span class="text-gray-400">{$_("common.export")}:</span>
          <button class="rounded bg-surface px-1.5 py-0.5 hover:bg-surface-hover" on:click={() => exportCurrent("txt")}>txt</button>
          <button class="rounded bg-surface px-1.5 py-0.5 hover:bg-surface-hover" on:click={() => exportCurrent("csv")}>csv</button>
          <button class="rounded bg-surface px-1.5 py-0.5 hover:bg-surface-hover" on:click={() => exportCurrent("hex")}>hex</button>
        </div>
        <button
          class="flex items-center gap-1 rounded bg-surface px-2 py-0.5 text-gray-300 hover:bg-surface-hover"
          on:click={onClearTerminal}
          title={$_("common.clear")}
        >
          <Eraser size={12} />
          {$_("common.clear")}
        </button>
      </div>

      <!-- All tabs' output views are mounted simultaneously; inactive tabs
           are hidden via display:none. Each OutputView is created only once
           → its chunk buffer and virtual-scroll state survive tab switches
           → switching is instant and never loses history. -->
      <div class="relative min-h-0 flex-1 overflow-hidden">
        {#each $tabs as tab (tab.sessionId)}
          <div
            class="absolute inset-0"
            style:display={$activeSessionId === tab.sessionId ? "block" : "none"}
          >
            <OutputView
              bind:this={termRefs[tab.sessionId]}
              sessionId={tab.sessionId}
              paused={$sessions[tab.sessionId]?.paused ?? false}
              colorParse={$sessions[tab.sessionId]?.colorParse ?? true}
              displayMode={$sessions[tab.sessionId]?.displayMode ?? "ascii"}
              timestamp={$sessions[tab.sessionId]?.timestamp ?? "off"}
              lineCharBreaks={$sessions[tab.sessionId]?.lineCharBreaks ?? ["crlf", "lf", "cr"]}
              customBreakEnabled={$sessions[tab.sessionId]?.customBreakEnabled ?? false}
              customBreakInput={$sessions[tab.sessionId]?.customBreakInput ?? ""}
              customBreakFormat={$sessions[tab.sessionId]?.customBreakFormat ?? "ascii"}
              breakEveryNBytes={$sessions[tab.sessionId]?.breakEveryNBytes ?? 0}
              breakOnIdleMs={$sessions[tab.sessionId]?.breakOnIdleMs ?? 0}
              showNonPrintable={$sessions[tab.sessionId]?.showNonPrintable ?? false}
              onRxChunk={(ts, text) => handleRxChunk(tab.sessionId, ts, text)}
            />
          </div>
        {/each}
      </div>
    </section>

    <!-- Send panel -->
    <SendPanel
      connected={active.state === "connected"}
      history={active.history}
      onSend={onSend}
    />

    <!-- Status bar -->
    <StatusBar session={active} />
  {:else}
    <div class="flex flex-1 items-center justify-center text-gray-500">
      <button
        class="flex items-center gap-2 rounded-md bg-surface-card px-4 py-2 hover:bg-surface-hover"
        on:click={() => newTab()}
      >
        <Plus size={16} />
        {$_("common.newTab")}
      </button>
    </div>
  {/if}
</main>

<style>
  nav::-webkit-scrollbar { height: 4px; }
</style>
