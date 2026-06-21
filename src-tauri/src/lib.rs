//! VaultPeerDesktop — Rust core library.
//!
//! `run()` is the shared entrypoint invoked by `main.rs` (desktop) and is kept
//! library-side so it can also back a future mobile target.

mod commands;
mod crypto;
mod database;
mod error;
mod fs_ops;
mod otp;
mod session;
mod tray;

use tauri::{Manager, WindowEvent};

use crate::session::VaultSession;

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
        // Holds the single unlocked database for the session (Phase 2).
        .manage(VaultSession::default())
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
            commands::unlock_database,
            commands::create_database,
            commands::save_database,
            commands::lock_database,
            commands::vault_status,
            commands::get_database_tree,
            commands::list_entries,
            commands::get_entry,
            commands::create_entry,
            commands::update_entry,
            commands::delete_entry,
            commands::move_entry,
            commands::create_group,
            commands::rename_group,
            commands::delete_group,
            commands::move_group,
            commands::restore_entry,
            commands::restore_group,
            commands::empty_recycle_bin,
            commands::list_attachments,
            commands::get_attachment,
            commands::add_attachment,
            commands::remove_attachment,
            commands::get_entry_history,
            commands::restore_entry_history,
            commands::delete_entry_history,
            commands::all_tags,
            commands::generate_totp,
        ])
        .run(tauri::generate_context!())
        .expect("error while running VaultPeer");
}
