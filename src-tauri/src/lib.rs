//! VaultPeerDesktop — Rust core library.
//!
//! `run()` is the shared entrypoint invoked by `main.rs` (desktop) and is kept
//! library-side so it can also back a future mobile target.

mod autostart;
mod autotype;
mod biometric;
mod clipboard;
mod commands;
mod crypto;
mod database;
mod error;
mod export;
mod fs_ops;
mod otp;
mod search;
mod session;
mod settings;
mod sync;
mod tray;

use tauri::{Manager, WindowEvent};

use crate::session::VaultSession;
use crate::settings::SettingsState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Global auto-type hotkeys (PLAN Phase 6): Ctrl+Alt+A types the matched
    // entry; Ctrl+Alt+P types only its password (selective). Ctrl+Alt+P is used
    // instead of Ctrl+Shift+A because browsers grab the latter (Chrome's
    // "Search tabs"), which blocks the global registration.
    #[cfg(desktop)]
    let autotype_shortcut = tauri_plugin_global_shortcut::Shortcut::new(
        Some(tauri_plugin_global_shortcut::Modifiers::CONTROL | tauri_plugin_global_shortcut::Modifiers::ALT),
        tauri_plugin_global_shortcut::Code::KeyA,
    );
    #[cfg(desktop)]
    let selective_shortcut = tauri_plugin_global_shortcut::Shortcut::new(
        Some(tauri_plugin_global_shortcut::Modifiers::CONTROL | tauri_plugin_global_shortcut::Modifiers::ALT),
        tauri_plugin_global_shortcut::Code::KeyP,
    );

    let mut builder = tauri::Builder::default()
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
        // Native WebSocket for P2P sync signaling (Phase 8) — see Cargo.toml.
        .plugin(tauri_plugin_websocket::init());

    // The global-shortcut plugin is desktop-only; its handler dispatches
    // auto-type for the currently-focused window (works even when the app is
    // hidden/unfocused, which is the whole point of system-wide hotkeys).
    // `Shortcut` is `Copy`, so the `move` handler copies these in while the
    // originals remain available for registration in `setup` below.
    #[cfg(desktop)]
    {
        builder = builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        return;
                    }
                    let selective = shortcut == &selective_shortcut;
                    if shortcut == &autotype_shortcut || selective {
                        commands::handle_global_autotype(app, selective);
                    }
                })
                .build(),
        );
    }

    builder
        // Holds the single unlocked database for the session (Phase 2).
        .manage(VaultSession::default())
        // Remembers the window focused at auto-type hotkey time (Phase 6).
        .manage(autotype::AutoTypeTarget::default())
        // Application settings, loaded from disk during setup (Phase 7).
        .manage(SettingsState::default())
        .setup(move |app| {
            tray::create_tray(app.handle())?;

            // Load persisted settings into the managed state so the close
            // handler and commands can read them without hitting disk (Phase 7).
            let loaded = settings::load(app.handle());
            *app.state::<SettingsState>()
                .0
                .lock()
                .expect("settings mutex poisoned") = loaded;
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                // Registration can fail if another app already owns the combo;
                // that's non-fatal (auto-type just won't fire on that hotkey),
                // but log it so the cause isn't a mystery.
                if let Err(e) = app.global_shortcut().register(autotype_shortcut) {
                    eprintln!("[vaultpeer] could not register Ctrl+Alt+A (auto-type): {e}");
                }
                if let Err(e) = app.global_shortcut().register(selective_shortcut) {
                    eprintln!(
                        "[vaultpeer] could not register Ctrl+Alt+P (selective auto-type): {e} \
                         — another app likely owns this combo"
                    );
                }
            }
            Ok(())
        })
        // On the close button: hide to the tray when "minimize to tray" is on
        // (the default — the app is then exited via the tray's "Quit" item), or
        // let the window close (quitting the app) when the user has turned it
        // off (PLAN Phase 7 / SET-04).
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let minimize_to_tray = window
                        .app_handle()
                        .try_state::<SettingsState>()
                        .map(|s| {
                            s.0.lock()
                                .map(|g| g.minimize_to_tray)
                                .unwrap_or(true)
                        })
                        .unwrap_or(true);
                    if minimize_to_tray {
                        let _ = window.hide();
                        api.prevent_close();
                    }
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
            commands::search_database,
            commands::recent_entries,
            commands::set_tray_recent,
            commands::auto_type,
            commands::auto_type_entry,
            commands::auto_type_to_window,
            commands::copy_clipboard,
            commands::get_settings,
            commands::save_settings,
            commands::get_autostart,
            commands::set_autostart,
            commands::kdf_benchmark,
            commands::get_db_settings,
            commands::update_db_settings,
            commands::db_maintenance,
            commands::export_database,
            commands::biometric_available,
            commands::biometric_is_enrolled,
            commands::biometric_enroll,
            commands::biometric_unlock,
            commands::biometric_forget,
            commands::sync_fingerprint,
            commands::sync_export_snapshot,
            commands::sync_merge_snapshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running VaultPeer");
}
