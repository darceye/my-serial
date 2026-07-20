import { invoke } from "@tauri-apps/api/core";

/**
 * Frontend bindings for Rust commands exposed via Tauri IPC.
 * Signatures mirror the `#[tauri::command]` fns in src-tauri/src/commands.rs.
 */

export interface AppInfo {
  name: string;
  version: string;
  rustc: string;
}

export interface PortInfo {
  name: string;
  description: string;
  vid: string;
  pid: string;
  serial_number: string;
}

export interface PortConfig {
  port_name: string;
  baud_rate: number;
  data_bits: number; // 5,6,7,8
  parity: "none" | "even" | "odd" | "mark" | "space";
  stop_bits: number; // 1 or 2
  flow_control: "none" | "software" | "hardware";
}

export interface ReconnectConfig {
  enabled: boolean;
  interval_ms: number;
  max_attempts: number; // 0 = infinite
  on_port_gone: "prompt" | "wait";
}

export interface Signals {
  cts: boolean;
  dsr: boolean;
  cd: boolean;
  ri: boolean;
}

export interface SignalSet {
  rts?: boolean;
  dtr?: boolean;
}

export const DEFAULT_CONFIG: PortConfig = {
  port_name: "",
  baud_rate: 115200,
  data_bits: 8,
  parity: "none",
  stop_bits: 1,
  flow_control: "none",
};

export const DEFAULT_RECONNECT: ReconnectConfig = {
  enabled: true,
  interval_ms: 1000,
  max_attempts: 0,
  on_port_gone: "prompt",
};

/** Common baud rate presets for the dropdown. 74880 is the ESP8266 boot-log
 *  baud rate. */
export const BAUD_PRESETS = [
  9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600,
];

export async function getAppInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("get_app_info");
}

export async function listPorts(): Promise<PortInfo[]> {
  return invoke<PortInfo[]>("list_ports");
}

export async function createSession(
  config: PortConfig,
  reconnect?: ReconnectConfig,
): Promise<string> {
  return invoke<string>("create_session", { config, reconnect });
}

export async function openPort(
  sessionId: string,
  config?: PortConfig,
  reconnect?: ReconnectConfig,
): Promise<void> {
  await invoke("open_port", { sessionId, config, reconnect });
}

export async function closePort(sessionId: string): Promise<void> {
  await invoke("close_port", { sessionId });
}

export async function writeData(sessionId: string, data: number[]): Promise<void> {
  await invoke("write_data", { sessionId, data });
}

export async function setSignals(sessionId: string, signals: SignalSet): Promise<void> {
  await invoke("set_signals", { sessionId, signals });
}

export async function getSignals(sessionId: string): Promise<Signals> {
  return invoke<Signals>("get_signals", { sessionId });
}

export async function destroySession(sessionId: string): Promise<void> {
  await invoke("destroy_session", { sessionId });
}

export async function configureReconnect(
  sessionId: string,
  config: ReconnectConfig,
): Promise<void> {
  await invoke("configure_reconnect", { sessionId, config });
}

// ---------- User config (config.toml) ----------
// Mirrors the Rust structs in src-tauri/src/config.rs. All fields optional /
// defaulted on the Rust side so partial files parse cleanly.

export type SuffixKind = "none" | "cr" | "lf" | "space" | "etx" | "nul" | "custom";
export type SendMode = "ascii" | "hex";

export interface SendPanelConfig {
  append_suffix: boolean;
  suffix_kind: SuffixKind | string;
  suffix_custom_ascii: boolean;
  suffix_custom_input: string;
  mode: SendMode | string;
  loop_send: boolean;
  loop_interval: number;
}

/** Wire-format default for a tab's send-panel config. Single source of truth —
 *  re-exported by the session store so UI defaults and config migration agree. */
export const DEFAULT_SEND_PANEL: SendPanelConfig = {
  append_suffix: true,
  suffix_kind: "lf",
  suffix_custom_ascii: true,
  suffix_custom_input: "",
  mode: "ascii",
  loop_send: false,
  loop_interval: 1000,
};

export interface ConfigHistoryEntry {
  text: string;
  mode: SendMode | string;
}

export interface TabConfig {
  config: PortConfig;
  reconnect: ReconnectConfig;
  display_mode: string;
  timestamp: string;
  color_parse: boolean;
  paused: boolean;
  line_char_breaks: string[];
  custom_break_enabled: boolean;
  custom_break_input: string;
  custom_break_format: string;
  break_every_n_bytes: number;
  break_on_idle_ms: number;
  show_non_printable: boolean;
  logging: boolean;
  send: SendPanelConfig;
  history: ConfigHistoryEntry[];
}

export interface AppConfig {
  theme?: string;
  locale?: string;
  tabs: TabConfig[];
  active_tab_index?: number;
}

export async function loadConfig(): Promise<AppConfig> {
  return invoke<AppConfig>("load_config");
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await invoke("save_config", { config });
}
