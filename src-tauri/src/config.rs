//! User configuration persistence.
//!
//! Stores UI / session defaults as TOML in the per-user app config dir
//! (`app_config_dir()` → on Windows: `%APPDATA%\com.myserial.app\config.toml`).
//!
//! Design notes:
//! - The Rust side is intentionally thin: it only (de)serialises a plain data
//!   structure and reads/writes the file. Aggregation of live UI state and
//!   distribution back into stores happens entirely in the frontend.
//! - Every field is `#[serde(default)]` so older config files (or a partially
//!   hand-edited one) parse without error — missing fields fall back to the
//!   struct's `Default` impl.
//! - Writes go to `config.toml.tmp` then `rename`d into place for an atomic
//!   swap, so a crash mid-write cannot leave a half-written file.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::types::{PortConfig, ReconnectConfig};

const CONFIG_FILENAME: &str = "config.toml";

/// Top-level config file model. Mirrors the frontend `AppConfig` interface.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AppConfig {
    /// "dark" | "light".
    #[serde(default)]
    pub theme: Option<String>,
    /// "zh-CN" | "en-US".
    #[serde(default)]
    pub locale: Option<String>,
    /// One entry per tab to restore on startup. Empty = fresh single-tab start.
    #[serde(default)]
    pub tabs: Vec<TabConfig>,
    /// Index into `tabs` of the tab that was active when the app closed.
    #[serde(default)]
    pub active_tab_index: Option<usize>,
}

/// Per-tab persisted state. Mirrors the frontend `TabConfig` interface.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TabConfig {
    #[serde(default)]
    pub config: PortConfig,
    #[serde(default)]
    pub reconnect: ReconnectConfig,

    // Display settings.
    /// "ascii" | "hex" | "ascii+hex".
    #[serde(default)]
    pub display_mode: String,
    /// "off" | "absolute" | "relative".
    #[serde(default)]
    pub timestamp: String,
    #[serde(default)]
    pub color_parse: bool,
    #[serde(default)]
    pub paused: bool,

    // Line-break rules.
    #[serde(default)]
    pub line_char_breaks: Vec<String>,
    #[serde(default)]
    pub custom_break_enabled: bool,
    #[serde(default)]
    pub custom_break_input: String,
    /// "ascii" | "hex".
    #[serde(default)]
    pub custom_break_format: String,
    #[serde(default)]
    pub break_every_n_bytes: u64,
    #[serde(default)]
    pub break_on_idle_ms: u64,
    #[serde(default)]
    pub show_non_printable: bool,
    #[serde(default)]
    pub logging: bool,

    /// Send-panel settings (suffix / mode / loop), kept on the tab so each
    /// tab remembers its own send configuration.
    #[serde(default)]
    pub send: SendPanelConfig,

    /// Send history, most-recent-first. Capped at 100 entries by the frontend.
    #[serde(default)]
    pub history: Vec<HistoryEntrySer>,
}

/// Send-panel state lifted out of the component so it can be persisted per-tab.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SendPanelConfig {
    #[serde(default)]
    pub append_suffix: bool,
    /// "none" | "cr" | "lf" | "space" | "etx" | "nul" | "custom".
    #[serde(default)]
    pub suffix_kind: String,
    #[serde(default)]
    pub suffix_custom_ascii: bool,
    #[serde(default)]
    pub suffix_custom_input: String,
    /// "ascii" | "hex".
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub loop_send: bool,
    #[serde(default)]
    pub loop_interval: u64,
}

/// One send-history entry. Mirrors frontend `HistoryEntry`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct HistoryEntrySer {
    pub text: String,
    /// "ascii" | "hex".
    pub mode: String,
}

/// Resolve the config file path, creating the parent dir if needed.
fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("failed to resolve app config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create config dir {:?}: {e}", dir))?;
    Ok(dir.join(CONFIG_FILENAME))
}

/// Load the config. Returns `Default` (i.e. a fresh start) if the file is
/// missing or fails to parse — never propagates an error, so a corrupt config
/// file cannot prevent the app from starting.
pub fn load(app: &AppHandle) -> AppConfig {
    let path = match config_path(app) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("could not resolve config path: {e}");
            return AppConfig::default();
        }
    };

    let contents = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // First run — no config yet. Silent default.
            return AppConfig::default();
        }
        Err(e) => {
            log::warn!("could not read {:?}: {e}", path);
            return AppConfig::default();
        }
    };

    match toml::from_str::<AppConfig>(&contents) {
        Ok(cfg) => cfg,
        Err(e) => {
            log::warn!("could not parse {:?}: {e} — falling back to defaults", path);
            AppConfig::default()
        }
    }
}

/// Save the config atomically (write `.tmp`, then rename).
pub fn save(app: &AppHandle, cfg: &AppConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let toml_str =
        toml::to_string_pretty(cfg).map_err(|e| format!("failed to serialize config: {e}"))?;

    let tmp = path.with_extension("toml.tmp");
    fs::write(&tmp, toml_str).map_err(|e| format!("failed to write {:?}: {e}", tmp))?;
    // `rename` on the same filesystem is atomic on Windows (REPLACE_EXISTING).
    fs::rename(&tmp, &path)
        .map_err(|e| format!("failed to rename {:?} → {:?}: {e}", tmp, path))?;
    Ok(())
}
