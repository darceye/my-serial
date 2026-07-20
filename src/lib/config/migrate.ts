/**
 * Bridge between the persisted `AppConfig` (config.toml) and the live Svelte
 * stores. Two directions:
 *
 *  - `applyConfig`: take a freshly-loaded config and push it into the stores,
 *    recreating tabs with their saved settings.
 *  - `collectConfig`: snapshot the current stores back into an `AppConfig`
 *    ready to be written to disk.
 *
 * The Rust side is intentionally dumb (pure (de)serialisation); all knowledge
 * of which UI fields map to which config fields lives here.
 */

import { get } from "svelte/store";
import type { CharBreak } from "$lib/services/line-slice";
import {
  sessions,
  tabs,
  activeSessionId,
  createTabRecord,
  type TabSession,
  type HistoryEntry,
} from "$lib/stores/session";
import { theme } from "$lib/stores/session";
import { locale } from "$lib/i18n";
import {
  createSession,
  DEFAULT_CONFIG,
  DEFAULT_RECONNECT,
  DEFAULT_SEND_PANEL,
  type AppConfig,
  type TabConfig,
  type PortConfig,
  type ReconnectConfig,
  type SendPanelConfig,
} from "$lib/tauri/commands";

/** Default theme if the config doesn't specify one. */
const DEFAULT_THEME = "dark";

/** Coerce an unknown-ish value from config into a CharBreak, falling back to
 *  the app default set on failure. Keeps a stable display order. */
const DEFAULT_CHAR_BREAKS: CharBreak[] = ["crlf", "lf", "cr"];
function coerceCharBreaks(raw: string[] | undefined): CharBreak[] {
  if (!raw || !Array.isArray(raw) || raw.length === 0) return [...DEFAULT_CHAR_BREAKS];
  const valid: CharBreak[] = ["nul", "lf", "cr", "crlf", "etx"];
  const filtered = raw.filter((v): v is CharBreak => valid.includes(v as CharBreak));
  // Preserve the canonical display order regardless of save order.
  return valid.filter((v) => filtered.includes(v));
}

/** Merge a saved PortConfig onto the app default so missing/partial fields
 *  fall back sensibly rather than becoming undefined. */
function mergePortConfig(saved: Partial<PortConfig> | undefined): PortConfig {
  return { ...DEFAULT_CONFIG, ...(saved ?? {}) };
}
function mergeReconnectConfig(saved: Partial<ReconnectConfig> | undefined): ReconnectConfig {
  return { ...DEFAULT_RECONNECT, ...(saved ?? {}) };
}
function mergeSendConfig(saved: Partial<SendPanelConfig> | undefined): SendPanelConfig {
  return { ...DEFAULT_SEND_PANEL, ...(saved ?? {}) };
}

/** Apply a loaded config: push theme/locale into stores and rebuild tabs.
 *
 *  Returns the list of session ids that were created (so the caller can wire
 *  up per-session event subscriptions) and the sessionId that should be
 *  active, or `null` if no tabs were restored (caller should create a fresh
 *  tab in that case). */
export async function applyConfig(
  cfg: AppConfig,
): Promise<{ createdIds: string[]; activeId: string | null }> {
  // --- Global settings ---
  if (cfg.theme) {
    theme.set((cfg.theme as "dark" | "light"));
  }
  if (cfg.locale) {
    locale.set(cfg.locale);
  }

  // --- Tabs ---
  // Clear anything currently in the stores (the onMount default tab, etc.)
  // before rebuilding from the saved set.
  sessions.set({});
  tabs.set([]);

  if (!cfg.tabs || cfg.tabs.length === 0) {
    return { createdIds: [], activeId: null };
  }

  const createdIds: string[] = [];
  let activeId: string | null = null;
  const activeIndex = cfg.active_tab_index ?? 0;
  const clampedActive = Math.max(0, Math.min(activeIndex, cfg.tabs.length - 1));

  for (let i = 0; i < cfg.tabs.length; i++) {
    const t = cfg.tabs[i];
    const port = mergePortConfig(t.config);
    const reconnect = mergeReconnectConfig(t.reconnect);
    // Create the backend session with the persisted port config. The port is
    // NOT auto-opened — the user must click Connect (safer than auto-opening
    // a device that may no longer be present).
    const sid = await createSession(port, reconnect);
    createdIds.push(sid);
    const rec = createTabRecord(sid, port, reconnect);

    // Overlay persisted display / break / send / history settings onto the
    // fresh record. We mutate the record in place, then write it into the
    // store directly — patchSession() would silently no-op here because the
    // session doesn't exist in the store yet (it only adds sessions via
    // sessions.update, which patchSession deliberately does not do).
    rec.displayMode = (t.display_mode as TabSession["displayMode"]) || rec.displayMode;
    rec.timestamp = (t.timestamp as TabSession["timestamp"]) || rec.timestamp;
    rec.colorParse = t.color_parse ?? rec.colorParse;
    rec.paused = t.paused ?? rec.paused;
    rec.lineCharBreaks = coerceCharBreaks(t.line_char_breaks);
    rec.customBreakEnabled = t.custom_break_enabled ?? rec.customBreakEnabled;
    rec.customBreakInput = t.custom_break_input ?? rec.customBreakInput;
    rec.customBreakFormat = (t.custom_break_format as TabSession["customBreakFormat"]) || rec.customBreakFormat;
    rec.breakEveryNBytes = t.break_every_n_bytes ?? rec.breakEveryNBytes;
    rec.breakOnIdleMs = t.break_on_idle_ms ?? rec.breakOnIdleMs;
    rec.showNonPrintable = t.show_non_printable ?? rec.showNonPrintable;
    rec.logging = t.logging ?? rec.logging;
    rec.send = mergeSendConfig(t.send);
    rec.history = (t.history ?? []).slice(0, 100).map((h) => ({
      text: String(h.text ?? ""),
      mode: (h.mode === "hex" ? "hex" : "ascii"),
    })) as HistoryEntry[];

    sessions.update((s) => ({ ...s, [sid]: rec }));
    tabs.update((list) => [...list, { sessionId: sid, label: rec.title }]);

    if (i === clampedActive) {
      activeId = sid;
    }
  }

  if (activeId) {
    activeSessionId.set(activeId);
  }
  return { createdIds, activeId };
}

/** Snapshot the live stores into an AppConfig ready for saving. */
export function collectConfig(): AppConfig {
  const $tabs = get(tabs);
  const $sessions = get(sessions);
  const $activeId = get(activeSessionId);

  const tabConfigs: TabConfig[] = $tabs.map((tab) => {
    const s = $sessions[tab.sessionId];
    // If a session vanished somehow, serialise a minimal default tab so the
    // count stays consistent with what the user saw.
    if (!s) {
      return {
        config: { ...DEFAULT_CONFIG },
        reconnect: { ...DEFAULT_RECONNECT },
        display_mode: "ascii",
        timestamp: "off",
        color_parse: true,
        paused: false,
        line_char_breaks: ["crlf", "lf", "cr"],
        custom_break_enabled: false,
        custom_break_input: "",
        custom_break_format: "ascii",
        break_every_n_bytes: 0,
        break_on_idle_ms: 0,
        show_non_printable: false,
        logging: false,
        send: { ...DEFAULT_SEND_PANEL },
        history: [],
      };
    }
    return {
      config: { ...s.config },
      reconnect: { ...s.reconnect },
      display_mode: s.displayMode,
      timestamp: s.timestamp,
      color_parse: s.colorParse,
      paused: s.paused,
      line_char_breaks: [...s.lineCharBreaks],
      custom_break_enabled: s.customBreakEnabled,
      custom_break_input: s.customBreakInput,
      custom_break_format: s.customBreakFormat,
      break_every_n_bytes: s.breakEveryNBytes,
      break_on_idle_ms: s.breakOnIdleMs,
      show_non_printable: s.showNonPrintable,
      logging: s.logging,
      send: { ...s.send },
      history: s.history.map((h) => ({ text: h.text, mode: h.mode })),
    };
  });

  const activeIndex = Math.max(
    0,
    $tabs.findIndex((t) => t.sessionId === $activeId),
  );

  return {
    theme: get(theme),
    locale: get(locale),
    tabs: tabConfigs,
    active_tab_index: $tabs.length > 0 ? activeIndex : undefined,
  };
}
