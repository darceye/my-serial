//! Tauri command handlers. Each `#[tauri::command]` is callable from the
//! frontend via `invoke("name", args)` — see src/lib/tauri/commands.ts.

use tauri::{AppHandle, State};

use crate::config::AppConfig;
use crate::ports;
use crate::session::SessionManager;
use crate::types::{
    AppInfo, PortConfig, PortInfo, ReconnectConfig, SignalSet, Signals,
};

/// Smoke-test command from Phase 0: confirms the IPC bridge works.
#[tauri::command]
pub fn get_app_info() -> AppInfo {
    AppInfo {
        name: env!("CARGO_PKG_NAME"),
        version: env!("CARGO_PKG_VERSION"),
        rustc: env!("RUSTC_VERSION"),
    }
}

/// Enumerate all currently available serial ports.
#[tauri::command]
pub fn list_ports() -> Vec<PortInfo> {
    ports::enumerate()
}

/// Create a new session (without opening the port yet). Returns the new id.
#[tauri::command]
pub fn create_session(
    manager: State<'_, SessionManager>,
    config: PortConfig,
    reconnect: Option<ReconnectConfig>,
) -> String {
    let id = format!("sess_{}", uuid_v4_short());
    manager.create(id.clone(), config, reconnect.unwrap_or_default());
    id
}

/// Open the port for an existing session and start the read loop.
/// Accepts an optional `config` so the frontend can push the latest port
/// settings at connect time (the session was created with a placeholder
/// empty port_name before the user picked a device).
#[tauri::command]
pub fn open_port(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    session_id: String,
    config: Option<PortConfig>,
    reconnect: Option<ReconnectConfig>,
) -> Result<(), String> {
    if let Some(cfg) = config {
        manager.set_config(&session_id, cfg)?;
    }
    if let Some(rc) = reconnect {
        manager.set_reconnect(&session_id, rc)?;
    }
    manager.open(&app, &session_id)
}

/// Close the port for a session (keeps the session record).
#[tauri::command]
pub fn close_port(app: AppHandle, manager: State<'_, SessionManager>, session_id: String) -> Result<(), String> {
    manager.close(&app, &session_id)
}

/// Write bytes to a session's port.
#[tauri::command]
pub fn write_data(manager: State<'_, SessionManager>, session_id: String, data: Vec<u8>) -> Result<(), String> {
    manager.write(&session_id, data)
}

/// Set output control signals (RTS / DTR).
#[tauri::command]
pub fn set_signals(manager: State<'_, SessionManager>, session_id: String, signals: SignalSet) -> Result<(), String> {
    manager.set_signals(&session_id, signals)
}

/// Read current input signal state.
#[tauri::command]
pub fn get_signals(manager: State<'_, SessionManager>, session_id: String) -> Result<Signals, String> {
    manager.read_signals(&session_id)
}

/// Remove a session entirely (used when closing a tab).
#[tauri::command]
pub fn destroy_session(app: AppHandle, manager: State<'_, SessionManager>, session_id: String) -> Result<(), String> {
    let _ = manager.close(&app, &session_id);
    manager.remove(&session_id);
    Ok(())
}

/// Update a session's reconnect policy at runtime.
#[tauri::command]
pub fn configure_reconnect(
    manager: State<'_, SessionManager>,
    session_id: String,
    config: ReconnectConfig,
) -> Result<(), String> {
    // Reconnect config is stored on the Session; mutate via a dedicated accessor.
    manager.set_reconnect(&session_id, config)
}

/// Load the persisted user config. Returns defaults on first run or if the
/// file is missing/corrupt — never errors, so the frontend can always apply
/// the result directly.
#[tauri::command]
pub fn load_config(app: AppHandle) -> AppConfig {
    crate::config::load(&app)
}

/// Persist the user config atomically.
#[tauri::command]
pub fn save_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    crate::config::save(&app, &config)
}

/// Tiny non-UUID id generator (avoids pulling the uuid crate just for this).
fn uuid_v4_short() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // Mix in thread id for uniqueness across concurrent calls.
    let tid = std::thread::current().id();
    let tid_hash = format!("{:?}", tid)
        .bytes()
        .fold(0u64, |acc, b| acc.wrapping_mul(31).wrapping_add(b as u64));
    format!("{:016x}{:08x}", nanos as u64, tid_hash as u32)
}
