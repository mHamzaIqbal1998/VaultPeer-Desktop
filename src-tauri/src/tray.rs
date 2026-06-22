//! System tray icon + context menu (PLAN Phase 1, extended in Phase 6).
//!
//! Provides "Show / Hide", a dynamic "recent entries" quick-access section,
//! "Lock Database", and "Quit". Left-clicking the tray icon toggles the main
//! window. The recent-entries section is rebuilt on demand from the frontend
//! via [`set_recent_entries`]; clicking one emits [`COPY_ENTRY_EVENT`] so the
//! webview can copy that entry's password to the clipboard.

use serde::Deserialize;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime,
};

/// Event emitted to the frontend when the user picks "Lock Database".
pub const LOCK_EVENT: &str = "vault://lock";

/// Event emitted (with the entry UUID as payload) when the user clicks a recent
/// entry in the tray; the frontend copies that entry's password.
pub const COPY_ENTRY_EVENT: &str = "vault://tray-entry";

/// Menu-item id prefix for a recent-entry quick-access item.
const ENTRY_PREFIX: &str = "entry:";

/// The tray icon's stable id, used to look it up for menu rebuilds.
const TRAY_ID: &str = "main-tray";

/// A recent entry surfaced in the tray quick-access section.
#[derive(Debug, Clone, Deserialize)]
pub struct TrayEntry {
    pub uuid: String,
    pub title: String,
}

/// Build and attach the tray icon to the running app.
pub fn create_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = build_menu(app, &[])?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("VaultPeer")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            match id {
                "show" => show_main_window(app),
                "lock" => {
                    show_main_window(app);
                    let _ = app.emit(LOCK_EVENT, ());
                }
                "quit" => app.exit(0),
                _ if id.starts_with(ENTRY_PREFIX) => {
                    let uuid = id.trim_start_matches(ENTRY_PREFIX).to_string();
                    show_main_window(app);
                    let _ = app.emit(COPY_ENTRY_EVENT, uuid);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

/// Rebuild the tray menu with the given recent entries (pass an empty slice to
/// clear them, e.g. on lock). A no-op if the tray icon isn't present.
pub fn set_recent_entries<R: Runtime>(app: &AppHandle<R>, entries: &[TrayEntry]) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let menu = build_menu(app, entries)?;
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}

/// Assemble the tray context menu, optionally including a recent-entries block.
fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    entries: &[TrayEntry],
) -> tauri::Result<Menu<R>> {
    let show = MenuItem::with_id(app, "show", "Show VaultPeer", true, None::<&str>)?;
    let lock = MenuItem::with_id(app, "lock", "Lock Database", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::new(app)?;
    menu.append(&show)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    if !entries.is_empty() {
        let header = MenuItem::with_id(app, "recent-header", "Copy password", false, None::<&str>)?;
        menu.append(&header)?;
        for entry in entries {
            let label = truncate(&entry.title, 40);
            let item = MenuItem::with_id(
                app,
                format!("{ENTRY_PREFIX}{}", entry.uuid),
                label,
                true,
                None::<&str>,
            )?;
            menu.append(&item)?;
        }
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }

    menu.append(&lock)?;
    menu.append(&quit)?;
    Ok(menu)
}

/// Truncate a label for the tray, appending an ellipsis when shortened.
fn truncate(s: &str, max: usize) -> String {
    let mut out: String = s.chars().take(max).collect();
    if s.chars().count() > max {
        out.push('…');
    }
    if out.trim().is_empty() {
        "(no title)".to_string()
    } else {
        out
    }
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn toggle_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}
