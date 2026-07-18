import { invoke } from "@tauri-apps/api/core";

/**
 * Frontend bindings for Rust commands exposed via Tauri IPC.
 * Keep the signatures here in sync with the `#[tauri::command]` fns
 * in src-tauri/src/commands.rs.
 */

/** App version info returned by the Rust backend. */
export interface AppInfo {
  name: string;
  version: string;
  rustc: string;
}

/** Probe the Rust backend to confirm IPC works (used by the Phase-0 shell). */
export async function getAppInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("get_app_info");
}
