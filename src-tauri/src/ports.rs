//! Serial port enumeration and hot-plug monitoring.
//!
//! `list_ports` is a synchronous snapshot. `start_port_watcher` spawns a
//! background task that diffs the port set every 500ms and emits
//! `serial:ports_changed` when devices appear or disappear (USB-CDC plug/unplug).

use std::collections::HashSet;
use std::time::Duration;

use serialport::SerialPortType;
use tauri::{AppHandle, async_runtime, Emitter};

use crate::types::{PortInfo, PortsChangedPayload};

/// Enumerate all currently available serial ports.
pub fn enumerate() -> Vec<PortInfo> {
    match serialport::available_ports() {
        Ok(ports) => ports
            .into_iter()
            .map(|p| {
                let (description, vid, pid, serial_number) = match &p.port_type {
                    SerialPortType::UsbPort(usb) => (
                        format!(
                            "{} {}",
                            usb.product.as_deref().unwrap_or("USB Serial"),
                            usb.manufacturer.as_deref().unwrap_or("")
                        )
                        .trim()
                        .to_string(),
                        format!("0x{:04X}", usb.vid),
                        format!("0x{:04X}", usb.pid),
                        usb.serial_number.clone().unwrap_or_default(),
                    ),
                    SerialPortType::PciPort => ("PCI Serial".to_string(), String::new(), String::new(), String::new()),
                    SerialPortType::BluetoothPort => ("Bluetooth Serial".to_string(), String::new(), String::new(), String::new()),
                    SerialPortType::Unknown => ("Unknown".to_string(), String::new(), String::new(), String::new()),
                };
                PortInfo {
                    name: p.port_name,
                    description,
                    vid,
                    pid,
                    serial_number,
                }
            })
            .collect(),
        Err(e) => {
            log::warn!("Failed to enumerate serial ports: {}", e);
            Vec::new()
        }
    }
}

/// Spawn a background task that watches for port additions/removals and
/// emits `serial:ports_changed`. Runs for the entire app lifetime.
///
/// Uses `tauri::async_runtime::spawn` (Tauri's managed Tokio runtime) so it
/// works from the synchronous `setup` hook.
pub fn start_watcher(app: AppHandle) {
    async_runtime::spawn(async move {
        let mut last: HashSet<String> = enumerate()
            .into_iter()
            .map(|p| p.name)
            .collect();
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let current: HashSet<String> = enumerate()
                .into_iter()
                .map(|p| p.name)
                .collect();
            if current == last {
                continue;
            }
            let added: Vec<String> = current.difference(&last).cloned().collect();
            let removed: Vec<String> = last.difference(&current).cloned().collect();
            last = current;
            if !added.is_empty() || !removed.is_empty() {
                log::debug!(
                    "ports changed: +{:?} -{:?}",
                    added,
                    removed
                );
                let _ = app.emit(
                    "serial:ports_changed",
                    PortsChangedPayload { added, removed },
                );
            }
        }
    });
}
