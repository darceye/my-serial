import { writable, derived, get } from "svelte/store";
import type {
  PortConfig,
  PortInfo,
  ReconnectConfig,
  Signals,
} from "$lib/tauri/commands";
import { DEFAULT_CONFIG, DEFAULT_RECONNECT } from "$lib/tauri/commands";
import type { SessionState } from "$lib/tauri/events";
import type { DataChunk, ChunkDir } from "$lib/services/rx-buffer";
import type { CharBreak } from "$lib/services/line-slice";

/** One tab's UI-side state. */
export interface TabSession {
  id: string;
  title: string;
  config: PortConfig;
  reconnect: ReconnectConfig;
  state: SessionState;
  /** Attempt counter while reconnecting. */
  attempts: number;
  maxAttempts: number;
  signals: Signals;
  rxBytes: number;
  txBytes: number;
  rxRate: number;
  txRate: number;
  connectedAt: number | null;
  errors: number;
  /** Pre-typed send history (most-recent-first). */
  history: string[];
  /** Pause scrolling the terminal (display-only concern, but kept here so it
   * survives re-renders and is per-tab). */
  paused: boolean;
  /** Display rendering options. */
  displayMode: "ascii" | "hex" | "ascii+hex";
  timestamp: "off" | "absolute" | "relative";
  colorParse: boolean;
  /** Configurable line-break rules. */
  lineCharBreaks: CharBreak[];
  customBreakEnabled: boolean;
  /** Raw UI text for the custom break sequence(s), one per line. */
  customBreakInput: string;
  /** How to interpret customBreakInput: "ascii" (literal/escaped text) or "hex". */
  customBreakFormat: "ascii" | "hex";
  /** Force a line break every N bytes (0 = off). In hex/ascii+hex this also
   *  sets the hex-dump row width when no other rules are active. */
  breakEveryNBytes: number;
  /** Force a line break if two chunks arrive more than this many ms apart (0 = off). */
  breakOnIdleMs: number;
  /** Show non-printable bytes as Unicode Control Pictures glyphs (␀␊␍…) instead of "." */
  showNonPrintable: boolean;
  /** Whether to append every RX/TX chunk to a log file. */
  logging: boolean;
  /** In-memory ring buffer of recent chunks for export. Stores raw bytes +
   *  decoded text + per-chunk timestamp + direction. Capped at RECORDED_MAX
   *  entries (older entries dropped). */
  recorded: DataChunk[];
}

export interface Tab {
  sessionId: string;
  label: string;
}

export const tabs = writable<Tab[]>([]);
export const activeSessionId = writable<string | null>(null);

/** Map sessionId -> live state. */
export const sessions = writable<Record<string, TabSession>>({});

export const ports = writable<PortInfo[]>([]);

/** The active tab's session object (derived). */
export const activeSession = derived(
  [activeSessionId, sessions],
  ([$id, $sessions]) => ($id ? $sessions[$id] ?? null : null),
);

let seq = 0;

export function makeTabTitle(config: PortConfig, n: number): string {
  return config.port_name || `Tab ${n}`;
}

export function createTabRecord(sessionId: string, config: PortConfig, reconnect: ReconnectConfig): TabSession {
  seq += 1;
  return {
    id: sessionId,
    title: makeTabTitle(config, seq),
    config: { ...config },
    reconnect: { ...reconnect },
    state: "disconnected",
    attempts: 0,
    maxAttempts: 0,
    signals: { cts: false, dsr: false, cd: false, ri: false },
    rxBytes: 0,
    txBytes: 0,
    rxRate: 0,
    txRate: 0,
    connectedAt: null,
    errors: 0,
    history: [],
    paused: false,
    displayMode: "ascii",
    timestamp: "off",
    colorParse: true,
    lineCharBreaks: ["crlf", "lf", "cr"],
    customBreakEnabled: false,
    customBreakInput: "",
    customBreakFormat: "ascii",
    breakEveryNBytes: 0,
    breakOnIdleMs: 0,
    showNonPrintable: false,
    logging: false,
    recorded: [],
  };
}

/** Max chunks kept in memory for export (older entries are dropped). */
const RECORDED_MAX = 5000;

/** Append a chunk to the session's recorded ring buffer.
 *
 *  IMPORTANT: `ts` is the timestamp of when the data was received (from the
 *  backend's `serial:data` event for RX, or `Date.now()` at send time for TX).
 *  Previously this function overwrote the passed timestamp with `Date.now()`,
 *  losing the backend's more accurate RX timestamp — that bug is now fixed. */
export function recordChunk(id: string, dir: ChunkDir, bytes: Uint8Array, text: string, ts: number) {
  sessions.update((s) => {
    if (!s[id]) return s;
    const cur = s[id];
    // Compute the offset of this new chunk within the recorded buffer.
    const lastChunk = cur.recorded[cur.recorded.length - 1];
    const offset = lastChunk ? lastChunk.offset + lastChunk.bytes.length : 0;
    const chunk: DataChunk = {
      ts,
      dir,
      // Copy bytes so callers can reuse their source buffer.
      bytes: bytes.length === 0 ? new Uint8Array(0) : new Uint8Array(bytes),
      text,
      offset,
    };
    const recorded = [...cur.recorded, chunk];
    if (recorded.length > RECORDED_MAX) recorded.splice(0, recorded.length - RECORDED_MAX);
    return { ...s, [id]: { ...cur, recorded } };
  });
}

export function patchSession(id: string, patch: Partial<TabSession>) {
  sessions.update((s) => {
    if (!s[id]) return s;
    return { ...s, [id]: { ...s[id], ...patch } };
  });
}

export function addTxBytes(id: string, n: number) {
  sessions.update((s) => {
    if (!s[id]) return s;
    const cur = s[id];
    return { ...s, [id]: { ...cur, txBytes: cur.txBytes + n } };
  });
}

export function addRxBytes(id: string, n: number) {
  sessions.update((s) => {
    if (!s[id]) return s;
    const cur = s[id];
    return { ...s, [id]: { ...cur, rxBytes: cur.rxBytes + n } };
  });
}

export function pushHistory(id: string, text: string) {
  sessions.update((s) => {
    if (!s[id]) return s;
    const cur = s[id];
    const next = [text, ...cur.history.filter((h) => h !== text)].slice(0, 20);
    return { ...s, [id]: { ...cur, history: next } };
  });
}

/** UI theme. */
export type Theme = "dark" | "light";
export const theme = writable<Theme>(
  (localStorage.getItem("myserial.theme") as Theme) || "dark",
);
theme.subscribe((v) => {
  localStorage.setItem("myserial.theme", v);
  document.documentElement.classList.toggle("light", v === "light");
});

/** Convenience accessor. */
export function getActiveConfig(): PortConfig {
  const id = get(activeSessionId);
  if (!id) return { ...DEFAULT_CONFIG };
  const s = get(sessions)[id];
  return s ? { ...s.config } : { ...DEFAULT_CONFIG };
}
