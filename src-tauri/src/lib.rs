//! MySerial — Rust backend entry point.
//!
//! Wires up: Tauri plugins, the SessionManager shared state, port hot-plug
//! watcher, and the read-error listener that drives the reconnect state machine.

mod commands;
mod config;
mod ports;
mod serial_io;
mod session;
mod types;

use tauri::Manager;

use crate::session::SessionManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(SessionManager::new())
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                if let Some(win) = app.get_webview_window("main") {
                    win.open_devtools();
                }
            }

            // Start the USB-CDC hot-plug watcher.
            ports::start_watcher(app.handle().clone());

            // Note: read-loop error handling drives reconnection directly via
            // the SessionManager clone handed to each read thread — no global
            // event listener needed.

            log::info!("MySerial backend started");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_info,
            commands::list_ports,
            commands::create_session,
            commands::open_port,
            commands::close_port,
            commands::write_data,
            commands::set_signals,
            commands::get_signals,
            commands::destroy_session,
            commands::configure_reconnect,
            commands::load_config,
            commands::save_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MySerial application");
}
