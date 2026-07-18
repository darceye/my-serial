//! Per-session serial management: open/close/read/write, the read loop with
//! UTF-8 boundary decoding, and the auto-reconnect state machine.
//!
//! Each `Session` owns its `SerialPort`, a tokio task handle for the read loop,
//! live statistics, and the reconnect policy. The `SessionManager` is a single
//! `Arc<Mutex<HashMap>>` shared across Tauri commands.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serialport::{DataBits, FlowControl, Parity, StopBits};
use tauri::async_runtime::{self, JoinHandle};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::serial_io::decode_chunk;
use crate::types::{
    DataPayload, PortConfig, ReconnectConfig, SessionState, SessionStats, SignalPayload,
    SignalSet, Signals, StatusPayload,
};

/// Convert frontend string config into serialport enum values.
/// serialport 4.x's `Parity` only supports None/Odd/Even; "mark"/"space"
/// are rare legacy modes and fall back to None (logged) here.
fn build_port(config: &PortConfig) -> serialport::SerialPortBuilder {
    let data_bits = match config.data_bits {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        _ => DataBits::Eight,
    };
    let parity = match config.parity.as_str() {
        "even" => Parity::Even,
        "odd" => Parity::Odd,
        "mark" | "space" => {
            log::warn!(
                "Parity '{}' not supported by serialport 4.x, falling back to None",
                config.parity
            );
            Parity::None
        }
        _ => Parity::None,
    };
    let stop_bits = match config.stop_bits {
        2 => StopBits::Two,
        _ => StopBits::One,
    };
    let flow = match config.flow_control.as_str() {
        "software" => FlowControl::Software,
        "hardware" => FlowControl::Hardware,
        _ => FlowControl::None,
    };
    serialport::new(&config.port_name, config.baud_rate)
        .data_bits(data_bits)
        .parity(parity)
        .stop_bits(stop_bits)
        .flow_control(flow)
        .timeout(Duration::from_millis(10))
}

/// One serial session — exactly one open port plus its read loop.
pub struct Session {
    pub id: String,
    pub config: PortConfig,
    pub reconnect: ReconnectConfig,
    /// The currently open port + its write half (read half moved to the read thread).
    /// `None` when disconnected/reconnecting.
    port: Option<Box<dyn serialport::SerialPort>>,
    /// Handle to the read loop task; abort drops it.
    read_task: Option<JoinHandle<()>>,
    /// Cancellation signal for the read loop / reconnect watcher.
    cancel: Option<oneshot::Sender<()>>,
    pub state: SessionState,
    pub stats: SessionStats,
    connected_at: Option<Instant>,
    /// Track attempt count for the "Reconnecting N/Max" indicator.
    attempts: u32,
    /// Bytes received in the current rate window (for B/s calc).
    rx_window_bytes: u64,
    tx_window_bytes: u64,
    window_start: Instant,
}

impl Session {
    fn new(id: String, config: PortConfig, reconnect: ReconnectConfig) -> Self {
        Self {
            id,
            config,
            reconnect,
            port: None,
            read_task: None,
            cancel: None,
            state: SessionState::Disconnected,
            stats: SessionStats::default(),
            connected_at: None,
            attempts: 0,
            rx_window_bytes: 0,
            tx_window_bytes: 0,
            window_start: Instant::now(),
        }
    }

    /// Open the port, spawn the read loop, and emit a status event.
    /// `manager` is passed so the read loop can trigger reconnection directly
    /// when the device disappears (no event round-trip needed).
    fn open(&mut self, app: &AppHandle, manager: &SessionManager) -> Result<(), String> {
        // Open the port ONCE. Clone the handle for the read thread; keep the
        // original for writing. serialport::SerialPort::try_clone yields a second
        // handle to the same underlying OS file descriptor.
        let mut port = build_port(&self.config)
            .open()
            .map_err(|e| format!("open {}: {}", self.config.port_name, e))?;

        // Read input signals (CTS/DSR/CD/RI) right after open.
        emit_signals(app, &self.id, port.as_mut());

        // Clone for the reader; keep the original `port` as the writer.
        let mut reader = port
            .try_clone()
            .map_err(|e| format!("clone reader: {}", e))?;

        let (tx_cancel, rx_cancel) = oneshot::channel::<()>();
        let read_id = self.id.clone();
        let read_app = app.clone();
        let read_manager = manager.clone();

        let handle = async_runtime::spawn_blocking(move || {
            read_loop(read_app, read_id, reader.as_mut(), rx_cancel, read_manager);
        });

        self.cancel = Some(tx_cancel);
        self.read_task = Some(handle);
        self.port = Some(port);
        self.state = SessionState::Connected;
        self.connected_at = Some(Instant::now());
        self.attempts = 0;
        self.window_start = Instant::now();
        emit_status(app, &self.id, self.state, None, None, None);
        Ok(())
    }

    fn close(&mut self, app: &AppHandle) {
        if let Some(cancel) = self.cancel.take() {
            let _ = cancel.send(());
        }
        if let Some(task) = self.read_task.take() {
            task.abort();
        }
        self.port = None;
        self.connected_at = None;
        self.state = SessionState::Disconnected;
        emit_status(app, &self.id, self.state, None, None, None);
    }

    /// Append bytes to be transmitted; update stats.
    pub fn write(&mut self, data: &[u8]) -> Result<(), String> {
        use std::io::Write;
        let port = self.port.as_mut().ok_or_else(|| "port not open".to_string())?;
        port.write_all(data).map_err(|e| e.to_string())?;
        port.flush().map_err(|e| e.to_string())?;
        self.stats.tx_bytes += data.len() as u64;
        self.tx_window_bytes += data.len() as u64;
        Ok(())
    }

    pub fn set_signals(&mut self, set: SignalSet) -> Result<(), String> {
        let port = self
            .port
            .as_mut()
            .ok_or_else(|| "port not open".to_string())?;
        if let Some(rts) = set.rts {
            port.write_request_to_send(rts).map_err(|e| e.to_string())?;
        }
        if let Some(dtr) = set.dtr {
            port.write_data_terminal_ready(dtr).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn read_signals(&mut self) -> Result<Signals, String> {
        let port = self
            .port
            .as_mut()
            .ok_or_else(|| "port not open".to_string())?;
        Ok(Signals {
            cts: port.read_clear_to_send().unwrap_or(false),
            dsr: port.read_data_set_ready().unwrap_or(false),
            cd: port.read_carrier_detect().unwrap_or(false),
            ri: port.read_ring_indicator().unwrap_or(false),
        })
    }

    /// Snapshot the current stats and recompute B/s rates.
    pub fn snapshot_stats(&mut self) -> SessionStats {
        if let Some(start) = self.connected_at {
            self.stats.duration_sec = start.elapsed().as_secs();
        }
        let elapsed = self.window_start.elapsed().as_secs_f64().max(0.001);
        self.stats.rx_rate = self.rx_window_bytes as f64 / elapsed;
        self.stats.tx_rate = self.tx_window_bytes as f64 / elapsed;
        self.stats
    }

    pub fn is_open(&self) -> bool {
        self.port.is_some()
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Some(cancel) = self.cancel.take() {
            let _ = cancel.send(());
        }
        if let Some(task) = self.read_task.take() {
            task.abort();
        }
    }
}

/// The blocking read loop, running on its own OS thread so it never stalls
/// the async runtime or the UI thread. On a fatal read error / EOF it asks
/// the SessionManager to start the reconnect state machine.
fn read_loop(
    app: AppHandle,
    session_id: String,
    reader: &mut dyn serialport::SerialPort,
    rx_cancel: oneshot::Receiver<()>,
    manager: SessionManager,
) {
    let mut buf = [0u8; 2048];
    let mut leftover: Vec<u8> = Vec::new();
    let mut cancel = rx_cancel;
    let mut error_kind: Option<&'static str> = None;
    use std::io::Read;
    loop {
        // Check for cancellation first (non-blocking).
        match cancel.try_recv() {
            Ok(()) => break,                    // explicit cancel
            Err(oneshot::error::TryRecvError::Empty) => {}
            Err(oneshot::error::TryRecvError::Closed) => break, // sender dropped
        }
        match reader.read(&mut buf) {
            Ok(0) => {
                log::info!("[{}] read EOF, device may be gone", session_id);
                error_kind = Some("eof");
                break;
            }
            Ok(n) => {
                leftover.extend_from_slice(&buf[..n]);
                let text = decode_chunk(&leftover);
                if text.is_empty() {
                    continue;
                }
                // We decoded up to the safe UTF-8 boundary; trim the leftover
                // by that many bytes and keep any residual tail.
                let consumed = crate::serial_io::utf8_safe_boundary(&leftover);
                leftover.drain(..consumed);
                let _ = app.emit(
                    "serial:data",
                    DataPayload {
                        session_id: session_id.clone(),
                        dir: "rx",
                        ts: now_ms(),
                        text,
                    },
                );
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(e) => {
                log::warn!("[{}] read error: {}", session_id, e);
                error_kind = Some("io");
                break;
            }
        }
    }
    // If we exited due to an error (not cancellation), trigger reconnection.
    if let Some(kind) = error_kind {
        manager.handle_read_error(&app, &session_id, kind);
    }
}

/// How many leading bytes of `buf` correspond to the decoded text? Equal to
/// the safe UTF-8 boundary (every byte up to it was consumed by `decode_chunk`).
#[allow(dead_code)]
fn utf8_consumed_bytes(buf: &[u8], _text_len: usize) -> usize {
    crate::serial_io::utf8_safe_boundary(buf)
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn emit_status(
    app: &AppHandle,
    id: &str,
    state: SessionState,
    attempts: Option<u32>,
    max: Option<u32>,
    msg: Option<String>,
) {
    let _ = app.emit(
        "serial:status",
        StatusPayload {
            session_id: id.to_string(),
            state,
            attempts,
            max_attempts: max,
            msg,
        },
    );
}

fn emit_signals(app: &AppHandle, id: &str, port: &mut dyn serialport::SerialPort) {
    let _ = app.emit(
        "serial:signal",
        SignalPayload {
            session_id: id.to_string(),
            cts: port.read_clear_to_send().unwrap_or(false),
            dsr: port.read_data_set_ready().unwrap_or(false),
            cd: port.read_carrier_detect().unwrap_or(false),
            ri: port.read_ring_indicator().unwrap_or(false),
        },
    );
}

// ---------- SessionManager ----------

/// Global registry of active sessions, shared across command handlers.
#[derive(Clone)]
pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn create(&self, id: String, config: PortConfig, reconnect: ReconnectConfig) {
        let session = Session::new(id, config, reconnect);
        self.sessions.lock().unwrap().insert(session.id.clone(), session);
    }

    pub fn open(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let mut guard = self.sessions.lock().unwrap();
        let session = guard.get_mut(id).ok_or_else(|| format!("session {} not found", id))?;
        session.open(app, self)
    }

    pub fn close(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let mut guard = self.sessions.lock().unwrap();
        let session = guard.get_mut(id).ok_or_else(|| format!("session {} not found", id))?;
        session.close(app);
        Ok(())
    }

    pub fn write(&self, id: &str, data: Vec<u8>) -> Result<(), String> {
        let mut guard = self.sessions.lock().unwrap();
        let session = guard.get_mut(id).ok_or_else(|| format!("session {} not found", id))?;
        session.write(&data)
    }

    pub fn set_signals(&self, id: &str, set: SignalSet) -> Result<(), String> {
        let mut guard = self.sessions.lock().unwrap();
        let session = guard.get_mut(id).ok_or_else(|| format!("session {} not found", id))?;
        session.set_signals(set)
    }

    pub fn read_signals(&self, id: &str) -> Result<Signals, String> {
        let mut guard = self.sessions.lock().unwrap();
        let session = guard.get_mut(id).ok_or_else(|| format!("session {} not found", id))?;
        session.read_signals()
    }

    pub fn remove(&self, id: &str) {
        self.sessions.lock().unwrap().remove(id);
    }

    pub fn snapshot_stats(&self, id: &str) -> Option<SessionStats> {
        let mut guard = self.sessions.lock().unwrap();
        guard.get_mut(id).map(|s| s.snapshot_stats())
    }

    /// Return a list of (session_id, state) for the frontend.
    pub fn list_states(&self) -> Vec<(String, SessionState)> {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .map(|(id, s)| (id.clone(), s.state))
            .collect()
    }

    /// Update a session's reconnect policy at runtime.
    pub fn set_reconnect(&self, id: &str, config: ReconnectConfig) -> Result<(), String> {
        let mut guard = self.sessions.lock().unwrap();
        let session = guard.get_mut(id).ok_or_else(|| format!("session {} not found", id))?;
        session.reconnect = config;
        Ok(())
    }

    /// Update a session's port config at runtime (used when the user picks a
    /// different port after the session was created with an empty placeholder).
    pub fn set_config(&self, id: &str, config: PortConfig) -> Result<(), String> {
        let mut guard = self.sessions.lock().unwrap();
        let session = guard.get_mut(id).ok_or_else(|| format!("session {} not found", id))?;
        session.config = config;
        Ok(())
    }

    /// Handle a read-error report from the read loop: attempt reconnection
    /// per the session's reconnect policy.
    pub fn handle_read_error(&self, app: &AppHandle, id: &str, kind: &str) {
        let reconnect_cfg = {
            let guard = self.sessions.lock().unwrap();
            match guard.get(id) {
                Some(s) => s.reconnect.clone(),
                None => return,
            }
        };

        if !reconnect_cfg.enabled {
            // No auto-reconnect: mark as lost and let the user reconnect manually.
            let mut guard = self.sessions.lock().unwrap();
            if let Some(s) = guard.get_mut(id) {
                s.close(app);
                s.state = SessionState::Lost;
                emit_status(app, id, SessionState::Lost, None, None, Some(kind.to_string()));
            }
            return;
        }

        // Begin the reconnect loop on a background task.
        let app_clone = app.clone();
        let id_clone = id.to_string();
        let manager = self.clone();
        async_runtime::spawn(async move {
            manager.run_reconnect(&app_clone, &id_clone).await;
        });
    }

    /// Reconnect loop: re-open the port every `interval_ms` until success or
    /// max attempts reached. Emits status events along the way.
    async fn run_reconnect(self, app: &AppHandle, id: &str) {
        let (interval, max_attempts) = {
            let guard = self.sessions.lock().unwrap();
            match guard.get(id) {
                Some(s) => (s.reconnect.interval_ms, s.reconnect.max_attempts),
                None => return,
            }
        };
        loop {
            // Mark reconnecting.
            {
                let mut guard = self.sessions.lock().unwrap();
                if let Some(s) = guard.get_mut(id) {
                    s.attempts += 1;
                    s.state = SessionState::Reconnecting;
                    emit_status(
                        app,
                        id,
                        SessionState::Reconnecting,
                        Some(s.attempts),
                        if max_attempts == 0 { None } else { Some(max_attempts) },
                        None,
                    );
                } else {
                    return;
                }
            }
            // Try to open.
            let result = self.open_quiet(app, id);
            if result.is_ok() {
                let _ = app.emit(
                    "serial:reconnected",
                    serde_json::json!({ "session_id": id }),
                );
                return;
            }
            // Check max attempts.
            if max_attempts != 0 {
                let attempts = {
                    let guard = self.sessions.lock().unwrap();
                    guard.get(id).map(|s| s.attempts).unwrap_or(0)
                };
                if attempts >= max_attempts {
                    let mut guard = self.sessions.lock().unwrap();
                    if let Some(s) = guard.get_mut(id) {
                        s.state = SessionState::Lost;
                        emit_status(
                            app,
                            id,
                            SessionState::Lost,
                            None,
                            None,
                            Some("max attempts reached".to_string()),
                        );
                    }
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(interval)).await;
        }
    }

    /// Like `open` but does not emit "connected" twice; used during reconnect.
    fn open_quiet(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        // First close any stale handle.
        {
            let mut guard = self.sessions.lock().unwrap();
            if let Some(s) = guard.get_mut(id) {
                if let Some(cancel) = s.cancel.take() {
                    let _ = cancel.send(());
                }
                if let Some(task) = s.read_task.take() {
                    task.abort();
                }
                s.port = None;
            }
        }
        self.open(app, id)
    }
}
