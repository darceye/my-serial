//! Shared data types crossing the Tauri IPC boundary.
//!
//! These mirror the TypeScript interfaces in src/lib/tauri/*.ts.

use serde::{Deserialize, Serialize};

/// Information returned by the Phase-0 smoke-test command.
#[derive(Debug, Clone, Serialize)]
pub struct AppInfo {
    pub name: &'static str,
    pub version: &'static str,
    pub rustc: &'static str,
}

/// A serial port discovered on the system.
#[derive(Debug, Clone, Serialize)]
pub struct PortInfo {
    /// OS port name, e.g. "COM3" or "/dev/ttyUSB0".
    pub name: String,
    /// Human-readable product / manufacturer description, if available.
    pub description: String,
    /// USB Vendor ID in hex, e.g. "0x1A86". Empty when not a USB device.
    pub vid: String,
    /// USB Product ID in hex, e.g. "0x7523". Empty when not a USB device.
    pub pid: String,
    /// Serial number string, if exposed by the device.
    pub serial_number: String,
}

/// Full serial port configuration requested by the frontend.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PortConfig {
    pub port_name: String,
    pub baud_rate: u32,
    /// 5, 6, 7, or 8.
    pub data_bits: u8,
    /// "none" | "even" | "odd" | "mark" | "space"
    pub parity: String,
    /// 1 or 2 (1.5 is rare and not supported by all backends).
    pub stop_bits: u8,
    /// "none" | "software" | "hardware"
    pub flow_control: String,
}

impl Default for PortConfig {
    fn default() -> Self {
        Self {
            port_name: String::new(),
            baud_rate: 115200,
            data_bits: 8,
            parity: "none".to_string(),
            stop_bits: 1,
            flow_control: "none".to_string(),
        }
    }
}

/// Automatic reconnect policy.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ReconnectConfig {
    pub enabled: bool,
    /// Milliseconds between attempts.
    pub interval_ms: u64,
    /// Max attempts; 0 = infinite.
    pub max_attempts: u32,
    /// "prompt" | "wait"
    pub on_port_gone: String,
}

impl Default for ReconnectConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_ms: 1000,
            max_attempts: 0,
            on_port_gone: "prompt".to_string(),
        }
    }
}

/// Connection state machine value, pushed to the frontend via events.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Lost,
}

impl SessionState {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionState::Disconnected => "disconnected",
            SessionState::Connecting => "connecting",
            SessionState::Connected => "connected",
            SessionState::Reconnecting => "reconnecting",
            SessionState::Lost => "lost",
        }
    }
}

/// Input/output control signal snapshot.
#[derive(Debug, Clone, Copy, Serialize, Default)]
pub struct Signals {
    pub cts: bool,
    pub dsr: bool,
    pub cd: bool,
    pub ri: bool,
}

/// Optional output signal overrides for `set_signals`.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct SignalSet {
    #[serde(default)]
    pub rts: Option<bool>,
    #[serde(default)]
    pub dtr: Option<bool>,
}

/// Per-session statistics snapshot.
#[derive(Debug, Clone, Copy, Serialize, Default)]
pub struct SessionStats {
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    /// Bytes per second, computed over a sliding window.
    pub rx_rate: f64,
    pub tx_rate: f64,
    /// Seconds since connect.
    pub duration_sec: u64,
    /// Number of IO errors encountered.
    pub errors: u64,
}

// ---------- Event payloads ----------

/// Payload for the `serial:data` event.
#[derive(Debug, Clone, Serialize)]
pub struct DataPayload {
    pub session_id: String,
    /// Direction: "rx" (received) or "tx" (sent, echoed).
    pub dir: &'static str,
    /// Epoch milliseconds.
    pub ts: i64,
    /// Decoded UTF-8 text (xterm.js renders ANSI escapes directly).
    pub text: String,
}

/// Payload for the `serial:status` event.
#[derive(Debug, Clone, Serialize)]
pub struct StatusPayload {
    pub session_id: String,
    pub state: SessionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempts: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_attempts: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub msg: Option<String>,
}

/// Payload for the `serial:signal` event.
#[derive(Debug, Clone, Serialize)]
pub struct SignalPayload {
    pub session_id: String,
    pub cts: bool,
    pub dsr: bool,
    pub cd: bool,
    pub ri: bool,
}

/// Payload for the `serial:stats` event.
#[derive(Debug, Clone, Serialize)]
pub struct StatsPayload {
    pub session_id: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub rx_rate: f64,
    pub tx_rate: f64,
    pub duration_sec: u64,
    pub errors: u64,
}

/// Payload for the `serial:ports_changed` event.
#[derive(Debug, Clone, Serialize)]
pub struct PortsChangedPayload {
    pub added: Vec<String>,
    pub removed: Vec<String>,
}
