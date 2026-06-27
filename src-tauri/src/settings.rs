//! Application settings persistence (PLAN Phase 7).
//!
//! Settings live in a single JSON file (`settings.json`) under the platform's
//! per-user app-config directory, so they survive restarts and stay separate
//! from any database. The canonical copy is held in [`SettingsState`] (Tauri-
//! managed) so both commands and the window-close handler can read it without
//! touching disk; [`save`] writes through to the file atomically.
//!
//! A `version` field on [`AppSettings`] drives forward migration: older files
//! are loaded with `serde(default)` filling any newly-added fields, then the
//! version is bumped on the next save. This keeps upgrades lossless.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::crypto::CreateOptions;
use crate::error::{AppError, AppResult};
use crate::sync::SyncConfig;

/// Current settings schema version. Bump when fields are added/changed so the
/// migration path in [`migrate`] has a hook.
/// v1: initial schema.
/// v2: TURN credentials are DPAPI-encrypted on disk (Phase 11 / SEC-06).
pub const SETTINGS_VERSION: u32 = 2;

/// Default password-generator preferences (mirrors the frontend
/// `GeneratorOptions`). Used to seed the generator tool / entry editor.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GeneratorDefaults {
    pub length: u32,
    pub uppercase: bool,
    pub lowercase: bool,
    pub digits: bool,
    pub symbols: bool,
    pub exclude_ambiguous: bool,
}

impl Default for GeneratorDefaults {
    fn default() -> Self {
        Self {
            length: 20,
            uppercase: true,
            lowercase: true,
            digits: true,
            symbols: true,
            exclude_ambiguous: false,
        }
    }
}

/// Customizable keyboard shortcuts for the in-app (webview) actions, stored as
/// human-readable accelerator strings like `"Ctrl+K"`. Global OS hotkeys
/// (auto-type) are registered natively and are not part of this map.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ShortcutBindings {
    pub search: String,
    pub lock: String,
    pub save: String,
    pub new_entry: String,
    pub generator: String,
    pub settings: String,
    pub copy_password: String,
    pub copy_username: String,
}

impl Default for ShortcutBindings {
    fn default() -> Self {
        Self {
            search: "Ctrl+K".into(),
            lock: "Ctrl+L".into(),
            save: "Ctrl+S".into(),
            new_entry: "Ctrl+N".into(),
            generator: "Ctrl+G".into(),
            settings: "Ctrl+,".into(),
            copy_password: "Ctrl+C".into(),
            copy_username: "Ctrl+B".into(),
        }
    }
}

/// Vault backup retention settings (mirrors the mobile/server-node behavior).
/// When a newer vault is pulled from a peer and overwrites the local file, the
/// previous revision is copied into `dir` as `<filename>.<mtime>.bak`, and old
/// revisions are pruned down to `retention`. The latest file always keeps the
/// original vault filename — only retained backups are renamed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BackupConfig {
    /// Whether backups are taken on each newer pull.
    pub enabled: bool,
    /// Number of previous revisions to retain (clamped to 1..=50 by the UI).
    pub retention: u32,
    /// Destination directory for backups (absolute path), or empty if unset.
    pub dir: String,
    /// Human-friendly directory name for display, or empty if unset.
    pub dir_name: String,
}

impl Default for BackupConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            retention: 3,
            dir: String::new(),
            dir_name: String::new(),
        }
    }
}

/// All persisted application settings (PRD §3.9 / SET-01..11). Serialized as
/// camelCase JSON; every field has a default so older files migrate cleanly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    /// Schema version of the persisted file (see [`SETTINGS_VERSION`]).
    pub version: u32,
    /// `"dark"`, `"light"`, or `"system"`. Mirrors the frontend theme store so
    /// the choice is captured in one place; the DOM is still driven client-side.
    pub theme: String,
    /// Seconds of inactivity before the vault auto-locks; `0` disables it.
    pub auto_lock_seconds: u64,
    /// Seconds before a copied secret is wiped from the clipboard; `0` disables.
    pub clipboard_clear_seconds: u64,
    /// Hide to the system tray on window close instead of quitting.
    pub minimize_to_tray: bool,
    /// Launch VaultPeer when the user signs in to Windows.
    pub start_with_windows: bool,
    /// Default password-generator preferences.
    pub generator: GeneratorDefaults,
    /// Default encryption settings pre-filled when creating a new database.
    pub default_create_options: CreateOptions,
    /// Customizable in-app keyboard shortcuts.
    pub shortcuts: ShortcutBindings,
    /// P2P synchronization configuration (signaling URL, ICE servers).
    pub sync: SyncConfig,
    /// Vault backup retention on pull (mirrors mobile/server node).
    pub backup: BackupConfig,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            theme: "system".into(),
            auto_lock_seconds: 600, // 10 minutes
            clipboard_clear_seconds: 30,
            minimize_to_tray: true,
            start_with_windows: false,
            generator: GeneratorDefaults::default(),
            default_create_options: CreateOptions::default(),
            shortcuts: ShortcutBindings::default(),
            sync: SyncConfig::default(),
            backup: BackupConfig::default(),
        }
    }
}

/// Tauri-managed canonical settings, guarded by a mutex.
#[derive(Default)]
pub struct SettingsState(pub Mutex<AppSettings>);

/// Resolve the path to `settings.json` inside the app-config directory, creating
/// the directory if needed.
fn settings_path<R: Runtime>(app: &AppHandle<R>) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Other(format!("could not resolve app config dir: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("settings.json"))
}

/// Apply forward migrations to a freshly-deserialized settings value, returning
/// `true` if anything changed (so the caller can persist the upgrade).
fn migrate(settings: &mut AppSettings) -> bool {
    let mut changed = false;
    // Future schema bumps add their migration steps here, keyed on the loaded
    // `version`. v0/unset → v1 currently needs no field transforms because
    // `serde(default)` already backfills new fields.
    if settings.version < SETTINGS_VERSION {
        settings.version = SETTINGS_VERSION;
        changed = true;
    }
    changed
}

/// Load settings from disk, falling back to defaults when the file is absent or
/// unreadable/corrupt (a corrupt file should never block the app from starting).
/// DPAPI-encrypted fields (TURN credentials) are decrypted transparently.
/// Migrates and rewrites the file when the on-disk schema is older.
pub fn load<R: Runtime>(app: &AppHandle<R>) -> AppSettings {
    let path = match settings_path(app) {
        Ok(p) => p,
        Err(_) => return AppSettings::default(),
    };

    let mut settings = match std::fs::read(&path) {
        Ok(bytes) => {
            // Parse to Value first so we can decrypt DPAPI-protected fields
            // (TURN credentials) before deserializing to the typed struct.
            let mut val: serde_json::Value = match serde_json::from_slice(&bytes) {
                Ok(v) => v,
                Err(_) => return AppSettings::default(),
            };
            crate::dpapi::unprotect_settings_secrets(&mut val);
            serde_json::from_value(val).unwrap_or_default()
        }
        Err(_) => AppSettings::default(),
    };

    if migrate(&mut settings) {
        // Best-effort: a failed rewrite just means we migrate again next launch.
        let _ = write_to_disk(app, &settings);
    }
    settings
}

/// Serialize settings to the config file atomically (temp file + rename).
/// Sensitive fields (TURN credentials) are DPAPI-encrypted before writing.
fn write_to_disk<R: Runtime>(app: &AppHandle<R>, settings: &AppSettings) -> AppResult<()> {
    let path = settings_path(app)?;
    let mut val = serde_json::to_value(settings)
        .map_err(|e| AppError::Other(format!("could not serialize settings: {e}")))?;
    crate::dpapi::protect_settings_secrets(&mut val);
    let json = serde_json::to_vec_pretty(&val)
        .map_err(|e| AppError::Other(format!("could not serialize settings: {e}")))?;
    crate::fs_ops::write_file_atomic(&path, &json)
}

/// Persist the given settings: update the in-memory canonical copy and write the
/// file. The version is normalized to the current schema on every save.
pub fn save<R: Runtime>(
    app: &AppHandle<R>,
    state: &SettingsState,
    mut settings: AppSettings,
) -> AppResult<()> {
    settings.version = SETTINGS_VERSION;
    write_to_disk(app, &settings)?;
    *state.0.lock().expect("settings mutex poisoned") = settings;
    Ok(())
}

/// Snapshot the current in-memory settings.
pub fn current(state: &SettingsState) -> AppSettings {
    state.0.lock().expect("settings mutex poisoned").clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_sane() {
        let s = AppSettings::default();
        assert_eq!(s.version, SETTINGS_VERSION);
        assert!(s.minimize_to_tray);
        assert_eq!(s.clipboard_clear_seconds, 30);
        assert_eq!(s.generator.length, 20);
        assert_eq!(s.shortcuts.search, "Ctrl+K");
    }

    #[test]
    fn missing_fields_backfill_from_default() {
        // An older/minimal file with only a couple of fields must still load,
        // with every absent field defaulted (forward-compatible migration).
        let json = r#"{ "theme": "dark", "autoLockSeconds": 120 }"#;
        let s: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(s.theme, "dark");
        assert_eq!(s.auto_lock_seconds, 120);
        // Untouched fields fall back to defaults.
        assert!(s.minimize_to_tray);
        assert_eq!(s.clipboard_clear_seconds, 30);
        assert_eq!(s.shortcuts.lock, "Ctrl+L");
    }

    #[test]
    fn migrate_bumps_old_version() {
        let mut s = AppSettings {
            version: 0,
            ..Default::default()
        };
        assert!(migrate(&mut s));
        assert_eq!(s.version, SETTINGS_VERSION);
        // Already-current settings need no migration.
        assert!(!migrate(&mut s));
    }

    #[test]
    fn round_trips_through_json() {
        let s = AppSettings::default();
        let bytes = serde_json::to_vec(&s).unwrap();
        let back: AppSettings = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back.auto_lock_seconds, s.auto_lock_seconds);
        assert_eq!(back.default_create_options.kdf, s.default_create_options.kdf);
    }
}
