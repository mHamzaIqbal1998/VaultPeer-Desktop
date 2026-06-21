//! VaultPeerDesktop — Rust core library.
//!
//! `run()` is the shared entrypoint invoked by `main.rs` (desktop) and is kept
//! library-side so it can also back a future mobile target.

mod commands;
mod error;
mod fs_ops;
mod tray;

use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Ensure a second launch focuses the existing window instead of
        // opening a duplicate (PLAN Phase 1: single instance).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            tray::create_tray(app.handle())?;
            Ok(())
        })
        // Hide the window to the tray instead of quitting on the close button.
        // The app is fully exited via the tray's "Quit" item.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::greet,
            commands::read_file,
            commands::write_file,
            commands::stat_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running VaultPeer");
}
