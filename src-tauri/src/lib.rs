//! MySerial — Rust backend entry point.
//!
//! Phase 0: only exposes a smoke-test command (`get_app_info`) so the frontend
//! can verify that the Tauri IPC bridge is alive. Serial functionality lands
//! in Phase 1 (see docs/ARCHITECTURE.md).

mod commands;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                // Open devtools automatically in dev for faster iteration.
                if let Some(win) = app.get_webview_window("main") {
                    win.open_devtools();
                }
            }
            log::info!("MySerial backend started");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![commands::get_app_info])
        .run(tauri::generate_context!())
        .expect("error while running MySerial application");
}
