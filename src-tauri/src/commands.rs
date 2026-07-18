//! Tauri command handlers.
//!
//! Each `#[tauri::command]` here is callable from the frontend via
//! `invoke("name", args)` — see src/lib/tauri/commands.ts for the typed wrappers.

use serde::Serialize;

/// Information returned by the Phase-0 smoke-test command.
#[derive(Serialize)]
pub struct AppInfo {
    pub name: &'static str,
    pub version: &'static str,
    pub rustc: &'static str,
}

/// Smoke-test command: confirms the Rust↔frontend IPC bridge is wired up.
///
/// Frontend calls `invoke<AppInfo>("get_app_info")`.
#[tauri::command]
pub fn get_app_info() -> AppInfo {
    AppInfo {
        name: env!("CARGO_PKG_NAME"),
        version: env!("CARGO_PKG_VERSION"),
        rustc: env!("RUSTC_VERSION"),
    }
}
