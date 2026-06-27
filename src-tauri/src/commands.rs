//! Tauri command handlers — the IPC surface exposed to the React frontend.
//!
//! These are thin wrappers; real logic lives in [`crate::fs_ops`] so it can be
//! unit-tested without a running Tauri context.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::autotype::{self, AutoTypeTarget, TypeFields};
use crate::browser::{self, BrowserServer, ServerStatus};
use crate::crypto::{self, CreateOptions, DatabaseMetadata};
use crate::database::{
    self, AttachmentMeta, DatabaseTree, DbMetaSettings, EntryDetail, EntryInput, EntrySummary,
    HistoryItem, MaintenanceReport,
};
use crate::error::{AppError, AppResult};
use crate::fs_ops::{self, DirEntry, FileMeta};
use crate::import::{self, ColumnMapping, CsvPreview, ImportReport};
use crate::otp::{self, TotpCode};
use crate::search::{self, SearchFilters, SearchHit};
use crate::session::{OpenVault, VaultSession};
use crate::settings::{self, AppSettings, SettingsState};
use crate::sync::{self, MergeResult, SyncSnapshot, VaultFingerprint};
use crate::tray::{self, TrayEntry};

/// Hello-world sanity command (PLAN Phase 1).
#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {name}! VaultPeer's Rust core is online.")
}

/// Read a file's raw bytes. Returned as a JSON number array over IPC.
#[tauri::command]
pub fn read_file(path: String) -> AppResult<Vec<u8>> {
    fs_ops::read_file(&PathBuf::from(path))
}

/// Atomically write bytes to a file (temp file + rename).
#[tauri::command]
pub fn write_file(path: String, contents: Vec<u8>) -> AppResult<()> {
    fs_ops::write_file_atomic(&PathBuf::from(path), &contents)
}

/// Return size + modified-time metadata for a file.
#[tauri::command]
pub fn stat_file(path: String) -> AppResult<FileMeta> {
    fs_ops::stat_file(&PathBuf::from(path))
}

/// Set a file's last-modified time (Unix epoch milliseconds). Used by P2P sync
/// to adopt a peer's content-version timestamp (PLAN Phase 8).
#[tauri::command]
pub fn set_file_mtime(path: String, mtime_ms: f64) -> AppResult<()> {
    fs_ops::set_file_mtime(&PathBuf::from(path), mtime_ms.max(0.0) as u64)
}

/// List the immediate children of a directory (non-recursive). Used by the
/// backup retention pruner to enumerate existing `<filename>.<ts>.bak`
/// revisions in the user's chosen backup folder.
#[tauri::command]
pub fn list_dir(path: String) -> AppResult<Vec<DirEntry>> {
    fs_ops::list_dir(&PathBuf::from(path))
}

/// Delete a file. Missing files are treated as success so the backup pruner
/// doesn't choke on a file that disappeared between the `list_dir` and the
/// `remove_file`.
#[tauri::command]
pub fn delete_file(path: String) -> AppResult<()> {
    fs_ops::delete_file(&PathBuf::from(path))
}

// ── Phase 8: persisted P2P sync version clock ─────────────────────────────────
//
// The sync protocol identifies a vault version by an epoch-ms timestamp. Relying
// on the filesystem mtime is unreliable (truncation, cloud folders, WebView
// localStorage not surviving restarts), so — like the mobile app's SecureStore-
// backed clock — we persist the highest version we've converged to, per vault
// filename, in a small JSON file in the app-config dir.

fn sync_mtimes_path<R: Runtime>(app: &AppHandle<R>) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Other(format!("could not resolve app config dir: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("sync_mtimes.json"))
}

fn load_sync_mtimes<R: Runtime>(app: &AppHandle<R>) -> std::collections::HashMap<String, i64> {
    match sync_mtimes_path(app).and_then(|p| Ok(std::fs::read(p)?)) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => std::collections::HashMap::new(),
    }
}

/// Read the remembered converged version (epoch ms) for a vault, or 0 if none.
#[tauri::command]
pub fn sync_get_mtime(app: AppHandle, filename: String) -> i64 {
    load_sync_mtimes(&app).get(&filename).copied().unwrap_or(0)
}

/// Remember the converged version for a vault. Overwrites (not monotonic): the
/// value reflects the exact version we last converged to with a peer, mirroring
/// the mobile app's `recordRemoteApply`/`recordLocalWrite`. Using `max` here
/// would let our advertised version drift above the peer's, causing the peer to
/// perpetually pull back from us.
#[tauri::command]
pub fn sync_set_mtime(app: AppHandle, filename: String, mtime: f64) -> AppResult<()> {
    let value = mtime.max(0.0) as i64;
    let mut map = load_sync_mtimes(&app);
    map.insert(filename, value);

    let path = sync_mtimes_path(&app)?;
    let json = serde_json::to_vec(&map)
        .map_err(|e| AppError::Other(format!("could not serialize sync mtimes: {e}")))?;
    fs_ops::write_file_atomic(&path, &json)
}

// ── Phase 2: database cryptography & unlock ─────────────────────────────────
//
// Open/create/save are CPU-heavy (Argon2 by design) so they run on the blocking
// thread pool via `spawn_blocking`, keeping the UI thread responsive. The
// `VaultSession` mutex is only touched briefly on the calling thread.

fn join_err(e: tauri::Error) -> AppError {
    AppError::Other(format!("background task failed: {e}"))
}

/// Decrypt an existing `.kdbx`, store it in the session, and return its metadata.
#[tauri::command]
pub async fn unlock_database(
    path: String,
    password: Option<String>,
    key_file: Option<String>,
    session: State<'_, VaultSession>,
) -> AppResult<DatabaseMetadata> {
    let open_path = path.clone();
    let (db, key) = tauri::async_runtime::spawn_blocking(move || {
        crypto::open_database(&open_path, password.as_deref(), key_file.as_deref())
    })
    .await
    .map_err(join_err)??;

    let meta = crypto::metadata_from(&db, &path);
    session.set(OpenVault { db, key, path });
    Ok(meta)
}

/// Create a new `.kdbx` with the chosen settings, write it to disk atomically,
/// store it in the session, and return its metadata.
#[tauri::command]
pub async fn create_database(
    path: String,
    name: String,
    password: Option<String>,
    key_file: Option<String>,
    options: CreateOptions,
    session: State<'_, VaultSession>,
) -> AppResult<DatabaseMetadata> {
    let (db, key, bytes) = tauri::async_runtime::spawn_blocking(move || {
        let db = crypto::create_database(&name, &options);
        let key = crypto::build_key(password.as_deref(), key_file.as_deref())?;
        let bytes = crypto::serialize_database(&db, key.clone())?;
        Ok::<_, AppError>((db, key, bytes))
    })
    .await
    .map_err(join_err)??;

    fs_ops::write_file_atomic(Path::new(&path), &bytes)?;

    let meta = crypto::metadata_from(&db, &path);
    session.set(OpenVault { db, key, path });
    Ok(meta)
}

/// Re-serialize the open database and write it back to its file atomically.
#[tauri::command]
pub async fn save_database(session: State<'_, VaultSession>) -> AppResult<()> {
    // Snapshot what we need, then release the lock before the heavy work + await.
    let (db, key, path) = {
        let guard = session.0.lock().expect("vault session mutex poisoned");
        let vault = guard.as_ref().ok_or(AppError::NoOpenDatabase)?;
        (vault.db.clone(), vault.key.clone(), vault.path.clone())
    };

    let bytes =
        tauri::async_runtime::spawn_blocking(move || crypto::serialize_database(&db, key))
            .await
            .map_err(join_err)??;

    fs_ops::write_file_atomic(Path::new(&path), &bytes)?;
    Ok(())
}

/// Lock the vault: drop the decrypted database and zeroize the key from memory.
#[tauri::command]
pub fn lock_database(session: State<'_, VaultSession>) {
    session.clear();
}

/// Return the open database's metadata, or `None` if the vault is locked.
/// Lets the frontend re-sync its view after a reload or external lock event.
#[tauri::command]
pub fn vault_status(session: State<'_, VaultSession>) -> Option<DatabaseMetadata> {
    let guard = session.0.lock().expect("vault session mutex poisoned");
    guard
        .as_ref()
        .map(|v| crypto::metadata_from(&v.db, &v.path))
}

// ── Phase 3: entry & group management ───────────────────────────────────────
//
// These operate on the in-memory database and are cheap (no crypto), so they
// run synchronously on the calling thread while holding the session lock. The
// frontend marks the session dirty and re-fetches affected views; persistence
// still goes through `save_database`.

/// Borrow the open database immutably, or fail if the vault is locked.
fn with_db<T>(
    session: &VaultSession,
    f: impl FnOnce(&keepass::Database) -> AppResult<T>,
) -> AppResult<T> {
    let guard = session.0.lock().expect("vault session mutex poisoned");
    let vault = guard.as_ref().ok_or(AppError::NoOpenDatabase)?;
    f(&vault.db)
}

/// Borrow the open database mutably, or fail if the vault is locked.
fn with_db_mut<T>(
    session: &VaultSession,
    f: impl FnOnce(&mut keepass::Database) -> AppResult<T>,
) -> AppResult<T> {
    let mut guard = session.0.lock().expect("vault session mutex poisoned");
    let vault = guard.as_mut().ok_or(AppError::NoOpenDatabase)?;
    f(&mut vault.db)
}

/// Return the full group hierarchy of the open database.
#[tauri::command]
pub fn get_database_tree(session: State<'_, VaultSession>) -> AppResult<DatabaseTree> {
    with_db(&session, |db| Ok(database::database_tree(db)))
}

/// List the entries directly contained in a group.
#[tauri::command]
pub fn list_entries(
    group_uuid: String,
    session: State<'_, VaultSession>,
) -> AppResult<Vec<EntrySummary>> {
    with_db(&session, |db| database::list_entries(db, &group_uuid))
}

/// Read the full contents of a single entry.
#[tauri::command]
pub fn get_entry(
    entry_uuid: String,
    session: State<'_, VaultSession>,
) -> AppResult<EntryDetail> {
    with_db(&session, |db| database::get_entry(db, &entry_uuid))
}

/// Create a new entry in a group and return its full detail.
#[tauri::command]
pub fn create_entry(
    group_uuid: String,
    entry: EntryInput,
    session: State<'_, VaultSession>,
) -> AppResult<EntryDetail> {
    with_db_mut(&session, |db| database::create_entry(db, &group_uuid, &entry))
}

/// Overwrite an existing entry's standard fields.
#[tauri::command]
pub fn update_entry(
    entry_uuid: String,
    entry: EntryInput,
    session: State<'_, VaultSession>,
) -> AppResult<EntryDetail> {
    with_db_mut(&session, |db| database::update_entry(db, &entry_uuid, &entry))
}

/// Delete an entry — soft delete to the recycle bin unless `permanent` is set.
#[tauri::command]
pub fn delete_entry(
    entry_uuid: String,
    permanent: bool,
    session: State<'_, VaultSession>,
) -> AppResult<()> {
    with_db_mut(&session, |db| {
        database::delete_entry(db, &entry_uuid, permanent)
    })
}

/// Move an entry into a different group.
#[tauri::command]
pub fn move_entry(
    entry_uuid: String,
    target_group_uuid: String,
    session: State<'_, VaultSession>,
) -> AppResult<()> {
    with_db_mut(&session, |db| {
        database::move_entry(db, &entry_uuid, &target_group_uuid)
    })
}

/// Create a new subgroup and return its UUID.
#[tauri::command]
pub fn create_group(
    parent_uuid: String,
    name: String,
    session: State<'_, VaultSession>,
) -> AppResult<String> {
    with_db_mut(&session, |db| database::create_group(db, &parent_uuid, &name))
}

/// Rename a group.
#[tauri::command]
pub fn rename_group(
    group_uuid: String,
    name: String,
    session: State<'_, VaultSession>,
) -> AppResult<()> {
    with_db_mut(&session, |db| database::rename_group(db, &group_uuid, &name))
}

/// Delete a group — soft delete to the recycle bin unless `permanent` is set.
#[tauri::command]
pub fn delete_group(
    group_uuid: String,
    permanent: bool,
    session: State<'_, VaultSession>,
) -> AppResult<()> {
    with_db_mut(&session, |db| {
        database::delete_group(db, &group_uuid, permanent)
    })
}

/// Move a group under a new parent (drag-and-drop reordering).
#[tauri::command]
pub fn move_group(
    group_uuid: String,
    target_group_uuid: String,
    session: State<'_, VaultSession>,
) -> AppResult<()> {
    with_db_mut(&session, |db| {
        database::move_group(db, &group_uuid, &target_group_uuid)
    })
}

// ── Phase 4: advanced entry features ─────────────────────────────────────────

/// Restore an entry from the recycle bin to its previous location.
#[tauri::command]
pub fn restore_entry(entry_uuid: String, session: State<'_, VaultSession>) -> AppResult<()> {
    with_db_mut(&session, |db| database::restore_entry(db, &entry_uuid))
}

/// Restore a group from the recycle bin to its previous location.
#[tauri::command]
pub fn restore_group(group_uuid: String, session: State<'_, VaultSession>) -> AppResult<()> {
    with_db_mut(&session, |db| database::restore_group(db, &group_uuid))
}

/// Permanently delete everything inside the recycle bin.
#[tauri::command]
pub fn empty_recycle_bin(session: State<'_, VaultSession>) -> AppResult<()> {
    with_db_mut(&session, database::empty_recycle_bin)
}

/// List an entry's binary attachments.
#[tauri::command]
pub fn list_attachments(
    entry_uuid: String,
    session: State<'_, VaultSession>,
) -> AppResult<Vec<AttachmentMeta>> {
    with_db(&session, |db| database::list_attachments(db, &entry_uuid))
}

/// Read the raw bytes of one of an entry's attachments by filename.
#[tauri::command]
pub fn get_attachment(
    entry_uuid: String,
    name: String,
    session: State<'_, VaultSession>,
) -> AppResult<Vec<u8>> {
    with_db(&session, |db| database::get_attachment(db, &entry_uuid, &name))
}

/// Attach a binary to an entry under the given filename; returns the new list.
#[tauri::command]
pub fn add_attachment(
    entry_uuid: String,
    name: String,
    data: Vec<u8>,
    session: State<'_, VaultSession>,
) -> AppResult<Vec<AttachmentMeta>> {
    with_db_mut(&session, |db| {
        database::add_attachment(db, &entry_uuid, &name, data)
    })
}

/// Remove one of an entry's attachments by filename; returns the new list.
#[tauri::command]
pub fn remove_attachment(
    entry_uuid: String,
    name: String,
    session: State<'_, VaultSession>,
) -> AppResult<Vec<AttachmentMeta>> {
    with_db_mut(&session, |db| {
        database::remove_attachment(db, &entry_uuid, &name)
    })
}

/// List an entry's historical snapshots (newest first).
#[tauri::command]
pub fn get_entry_history(
    entry_uuid: String,
    session: State<'_, VaultSession>,
) -> AppResult<Vec<HistoryItem>> {
    with_db(&session, |db| database::get_entry_history(db, &entry_uuid))
}

/// Restore an entry to one of its historical snapshots.
#[tauri::command]
pub fn restore_entry_history(
    entry_uuid: String,
    index: usize,
    session: State<'_, VaultSession>,
) -> AppResult<EntryDetail> {
    with_db_mut(&session, |db| {
        database::restore_entry_history(db, &entry_uuid, index)
    })
}

/// Delete a single historical snapshot from an entry.
#[tauri::command]
pub fn delete_entry_history(
    entry_uuid: String,
    index: usize,
    session: State<'_, VaultSession>,
) -> AppResult<()> {
    with_db_mut(&session, |db| {
        database::delete_entry_history(db, &entry_uuid, index)
    })
}

/// Every distinct tag used across the database (for autocomplete / filtering).
#[tauri::command]
pub fn all_tags(session: State<'_, VaultSession>) -> AppResult<Vec<String>> {
    with_db(&session, |db| Ok(database::all_tags(db)))
}

// ── Phase 5: password generator & OTP ────────────────────────────────────────

/// Generate the current TOTP code for an entry's stored OTP value (an
/// `otpauth://` URI or a bare base32 secret), with the timing the UI needs to
/// drive a countdown. Pure compute — no session/database access required.
#[tauri::command]
pub fn generate_totp(otp: String) -> AppResult<TotpCode> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| AppError::Other(format!("system clock error: {e}")))?
        .as_secs();
    otp::current_code(&otp, now)
}

// ── Phase 6: search, clipboard & auto-type ───────────────────────────────────

/// Fuzzy-search the open database across all searchable fields, returning
/// ranked hits with group context and a match snippet (SRC-01/02/03).
#[tauri::command]
pub fn search_database(
    query: String,
    filters: SearchFilters,
    session: State<'_, VaultSession>,
) -> AppResult<Vec<SearchHit>> {
    with_db(&session, |db| Ok(search::search(db, &query, &filters)))
}

/// The most-recently-modified entries across the vault (for the tray menu).
#[tauri::command]
pub fn recent_entries(
    limit: usize,
    session: State<'_, VaultSession>,
) -> AppResult<Vec<EntrySummary>> {
    with_db(&session, |db| Ok(search::recent_entries(db, limit)))
}

/// Rebuild the tray's recent-entries quick-access section (PLAN Phase 6).
#[tauri::command]
pub fn set_tray_recent(app: AppHandle, entries: Vec<TrayEntry>) -> AppResult<()> {
    tray::set_recent_entries(&app, &entries).map_err(|e| AppError::Other(e.to_string()))
}

/// Copy text to the clipboard, excluding it from clipboard history / cloud sync
/// (CLP-03). Windows-only; the frontend falls back to the Web Clipboard API
/// when this errors (non-Windows, or if the OS call fails).
#[tauri::command]
pub fn copy_clipboard(text: String) -> AppResult<()> {
    crate::clipboard::copy_protected(&text)
}

/// Build the field values + custom sequence (if any) for an entry's auto-type.
fn fields_for_entry(detail: &EntryDetail) -> (TypeFields, Option<String>) {
    let totp = if detail.otp.trim().is_empty() {
        String::new()
    } else {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        otp::current_code(&detail.otp, now)
            .map(|c| c.code)
            .unwrap_or_default()
    };
    let custom_seq = detail
        .custom_fields
        .iter()
        .find(|f| f.key.eq_ignore_ascii_case(autotype::SEQUENCE_FIELD))
        .map(|f| f.value.clone())
        .filter(|s| !s.trim().is_empty());

    let fields = TypeFields {
        username: detail.username.clone(),
        password: detail.password.clone(),
        title: detail.title.clone(),
        url: detail.url.clone(),
        totp,
    };
    (fields, custom_seq)
}

/// Status pushed to the frontend after an auto-type attempt so the UI can show
/// feedback (`typed`/`error`) or open the fallback entry picker (`pick`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutoTypeStatus {
    /// One of "typed", "error", "pick".
    kind: String,
    message: String,
    window_title: String,
    selective: bool,
}

/// Event channel for auto-type feedback (listened to by the frontend).
const AUTOTYPE_EVENT: &str = "vault://autotype";

fn emit_status<R: Runtime>(
    app: &AppHandle<R>,
    kind: &str,
    message: &str,
    window_title: &str,
    selective: bool,
) {
    let _ = app.emit(
        AUTOTYPE_EVENT,
        AutoTypeStatus {
            kind: kind.to_string(),
            message: message.to_string(),
            window_title: window_title.to_string(),
            selective,
        },
    );
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn entry_label(detail: &EntryDetail) -> String {
    if detail.title.trim().is_empty() {
        "(no title)".to_string()
    } else {
        detail.title.clone()
    }
}

/// Drive a global-hotkey auto-type: capture the focused window, match it to an
/// entry and type into it, or fall back to a picker — emitting status to the UI
/// throughout (ATY-01/03/04). Errors are reported, never swallowed silently.
pub fn handle_global_autotype<R: Runtime>(app: &AppHandle<R>, selective: bool) {
    let session = app.state::<VaultSession>();
    let target = app.state::<AutoTypeTarget>();

    // Capture the foreground window *before* anything can steal focus.
    let (window, title) = match autotype::foreground_window() {
        Ok(v) => v,
        Err(e) => {
            emit_status(app, "error", &e.to_string(), "", selective);
            return;
        }
    };
    *target.0.lock().expect("autotype target mutex poisoned") = Some(window);

    // Resolve a matching entry while briefly holding the session lock.
    let matched: AppResult<Option<EntryDetail>> = {
        let guard = session.0.lock().expect("vault session mutex poisoned");
        match guard.as_ref() {
            None => Err(AppError::NoOpenDatabase),
            Some(vault) => match search::match_entry_for_window(&vault.db, &title) {
                Some(eid) => {
                    database::get_entry(&vault.db, &eid.uuid().to_string()).map(Some)
                }
                None => Ok(None),
            },
        }
    };

    match matched {
        Err(_) => {
            // Vault is locked — surface the window so the user can unlock.
            show_main_window(app);
            emit_status(app, "error", "Unlock a database to use auto-type.", &title, selective);
        }
        Ok(Some(detail)) => {
            let (fields, custom_seq) = fields_for_entry(&detail);
            let seq = if selective {
                autotype::PASSWORD_ONLY_SEQUENCE.to_string()
            } else {
                custom_seq.unwrap_or_else(|| autotype::DEFAULT_SEQUENCE.to_string())
            };
            match autotype::type_sequence(&autotype::parse_sequence(&seq, &fields)) {
                Ok(()) => emit_status(
                    app,
                    "typed",
                    &format!("Auto-typed “{}”", entry_label(&detail)),
                    &title,
                    selective,
                ),
                Err(e) => {
                    show_main_window(app);
                    emit_status(app, "error", &e.to_string(), &title, selective);
                }
            }
        }
        Ok(None) => {
            // No entry matched the window — let the user pick one.
            show_main_window(app);
            emit_status(app, "pick", "", &title, selective);
        }
    }
}

/// Trigger window-matched auto-type for whatever window is focused (ATY-01).
/// Feedback is delivered via the `vault://autotype` event.
#[tauri::command]
pub fn auto_type(selective: bool, app: AppHandle) -> AppResult<()> {
    handle_global_autotype(&app, selective);
    Ok(())
}

/// Auto-type a chosen entry into the window captured at hotkey time — used by
/// the fallback picker. Re-focuses that window, then replays the sequence.
#[tauri::command]
pub async fn auto_type_to_window(
    entry_uuid: String,
    selective: bool,
    app: AppHandle,
    session: State<'_, VaultSession>,
    target: State<'_, AutoTypeTarget>,
) -> AppResult<()> {
    let detail = with_db(&session, |db| database::get_entry(db, &entry_uuid))?;
    let (fields, custom_seq) = fields_for_entry(&detail);
    let seq = if selective {
        autotype::PASSWORD_ONLY_SEQUENCE.to_string()
    } else {
        custom_seq.unwrap_or_else(|| autotype::DEFAULT_SEQUENCE.to_string())
    };
    let actions = autotype::parse_sequence(&seq, &fields);
    let window = *target.0.lock().expect("autotype target mutex poisoned");

    // Hide our window so the captured target regains focus, then type into it.
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        autotype::focus_and_type(window.unwrap_or(0), &actions)
    })
    .await
    .map_err(join_err)?
}

/// Auto-type a specific entry: hide our window so the prior app regains focus,
/// then replay the entry's sequence into it (in-app "Auto-Type" action).
#[tauri::command]
pub async fn auto_type_entry(
    entry_uuid: String,
    app: AppHandle,
    session: State<'_, VaultSession>,
) -> AppResult<()> {
    let detail = with_db(&session, |db| database::get_entry(db, &entry_uuid))?;
    let (fields, custom_seq) = fields_for_entry(&detail);
    let seq = custom_seq.unwrap_or_else(|| autotype::DEFAULT_SEQUENCE.to_string());
    let actions = autotype::parse_sequence(&seq, &fields);

    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }

    tauri::async_runtime::spawn_blocking(move || {
        // Give the focus a moment to return to the target window.
        std::thread::sleep(std::time::Duration::from_millis(400));
        autotype::type_sequence(&actions)
    })
    .await
    .map_err(join_err)?
}

// ── Phase 7: settings & preferences ──────────────────────────────────────────

/// Return the current application settings (PRD §3.9).
#[tauri::command]
pub fn get_settings(state: State<'_, SettingsState>) -> AppSettings {
    settings::current(&state)
}

/// Persist application settings to disk and update the in-memory canonical copy.
/// The window-close handler reads `minimize_to_tray` from this same state, so a
/// save takes effect immediately.
#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    state: State<'_, SettingsState>,
    settings: AppSettings,
) -> AppResult<()> {
    settings::save(&app, &state, settings)
}

/// Whether VaultPeer is registered to launch when the user signs in (SET-05).
#[tauri::command]
pub fn get_autostart() -> bool {
    crate::autostart::is_enabled()
}

/// Enable/disable launch-on-login. Windows-only; errors elsewhere so the UI can
/// surface that it's unsupported.
#[tauri::command]
pub fn set_autostart(enabled: bool) -> AppResult<()> {
    crate::autostart::set_enabled(enabled)
}

/// Calibrate Argon2 iterations for a target unlock time (PRD ENC-05: "Calculate
/// for 1.0s"). Pure compute, run off the UI thread.
#[tauri::command]
pub async fn kdf_benchmark(
    memory_mib: u64,
    parallelism: u32,
    target_secs: f64,
    argon2id: bool,
) -> AppResult<u64> {
    tauri::async_runtime::spawn_blocking(move || {
        crypto::benchmark_kdf_iterations(memory_mib, parallelism, target_secs, argon2id)
    })
    .await
    .map_err(join_err)?
}

/// The open database's encryption + recycle-bin/history settings, for the
/// Database Settings tab.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbSettings {
    /// Current KDF / cipher / compression configuration.
    encryption: CreateOptions,
    /// Recycle-bin and history-retention settings.
    meta: DbMetaSettings,
}

/// Read the open database's encryption and recycle-bin/history settings.
#[tauri::command]
pub fn get_db_settings(session: State<'_, VaultSession>) -> AppResult<DbSettings> {
    with_db(&session, |db| {
        Ok(DbSettings {
            encryption: crypto::current_create_options(db),
            meta: database::read_db_meta_settings(db),
        })
    })
}

/// Apply new encryption and recycle-bin/history settings to the open database.
/// Changes are in-memory; the frontend marks the session dirty and saves to
/// re-encrypt the file with the new parameters.
#[tauri::command]
pub fn update_db_settings(
    encryption: CreateOptions,
    meta: DbMetaSettings,
    session: State<'_, VaultSession>,
) -> AppResult<()> {
    with_db_mut(&session, |db| {
        crypto::apply_create_options(db, &encryption);
        database::apply_db_meta_settings(db, &meta)
    })
}

/// Trim entry histories to the configured retention limits ("Database
/// maintenance / cleanup").
#[tauri::command]
pub fn db_maintenance(session: State<'_, VaultSession>) -> AppResult<MaintenanceReport> {
    with_db_mut(&session, database::maintenance_cleanup)
}

/// Produce an unencrypted export of the open database in `"csv"` or `"xml"`
/// format (PRD UN-06). The frontend warns the user, then writes the returned
/// text to a chosen file.
#[tauri::command]
pub fn export_database(format: String, session: State<'_, VaultSession>) -> AppResult<String> {
    with_db(&session, |db| match format.to_lowercase().as_str() {
        "xml" => Ok(crate::export::to_xml(db)),
        "csv" => Ok(crate::export::to_csv(db)),
        "json" => crate::export::to_json(db),
        other => Err(AppError::InvalidOperation(format!(
            "unsupported export format: {other}"
        ))),
    })
}

// ── Phase 7: Windows Hello biometric quick-unlock (UN-02/UN-03) ───────────────

/// Whether Windows Hello (or its PIN fallback) is available on this machine.
#[tauri::command]
pub fn biometric_available() -> bool {
    crate::biometric::available()
}

/// Whether a database already has a stored biometric quick-unlock credential.
#[tauri::command]
pub fn biometric_is_enrolled(app: AppHandle, path: String) -> bool {
    crate::biometric::is_enrolled(&app, &path)
}

/// Enroll the open database for quick-unlock: prompt Windows Hello, then store
/// the master password DPAPI-protected for this user. Runs off the UI thread
/// because the Hello prompt blocks.
#[tauri::command]
pub async fn biometric_enroll(
    app: AppHandle,
    path: String,
    password: String,
) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || crate::biometric::enroll(&app, &path, &password))
        .await
        .map_err(join_err)?
}

/// Unlock a database via Windows Hello: prompt, decrypt the stored password, and
/// load the database into the session (mirrors [`unlock_database`]).
#[tauri::command]
pub async fn biometric_unlock(
    app: AppHandle,
    path: String,
    session: State<'_, VaultSession>,
) -> AppResult<DatabaseMetadata> {
    let unlock_path = path.clone();
    let app_for_hello = app.clone();
    let (db, key) = tauri::async_runtime::spawn_blocking(move || {
        let password = crate::biometric::unlock(&app_for_hello, &unlock_path)?;
        crypto::open_database(&unlock_path, Some(&password), None)
    })
    .await
    .map_err(join_err)??;

    let meta = crypto::metadata_from(&db, &path);
    session.set(OpenVault { db, key, path });
    Ok(meta)
}

/// Remove a database's stored quick-unlock credential.
#[tauri::command]
pub fn biometric_forget(app: AppHandle, path: String) -> AppResult<()> {
    crate::biometric::forget(&app, &path)
}

// ── Phase 8: P2P synchronization ──────────────────────────────────────────────
//
// The WebRTC transport + signaling run in the WebView (see `src/lib/webrtc.ts`);
// these commands provide the encrypted snapshot to send and apply a received one
// via the KeePass merge. Serialize/merge are CPU-heavy (re-encryption) so they
// run on the blocking pool, mirroring the unlock/save commands.

/// A lightweight description of the open vault's current state, exchanged with a
/// peer before any bytes transfer so each side can skip an unnecessary sync.
#[tauri::command]
pub fn sync_fingerprint(session: State<'_, VaultSession>) -> AppResult<VaultFingerprint> {
    with_db(&session, |db| Ok(sync::fingerprint(db)))
}

/// Serialize the open vault to encrypted KDBX bytes (with the session key) plus
/// its fingerprint, for chunked transfer over the data channel (SYN-04).
#[tauri::command]
pub async fn sync_export_snapshot(session: State<'_, VaultSession>) -> AppResult<SyncSnapshot> {
    let (db, key) = {
        let guard = session.0.lock().expect("vault session mutex poisoned");
        let vault = guard.as_ref().ok_or(AppError::NoOpenDatabase)?;
        (vault.db.clone(), vault.key.clone())
    };
    tauri::async_runtime::spawn_blocking(move || sync::export_snapshot(&db, key))
        .await
        .map_err(join_err)?
}

/// Merge a received encrypted snapshot into the open vault (SYN-05). Tries the
/// session key first, falling back to `password` if the peer's vault uses a
/// different master password. The merged database is written back into the
/// session; the frontend marks the session dirty and saves to persist it.
#[tauri::command]
pub async fn sync_merge_snapshot(
    bytes: Vec<u8>,
    password: Option<String>,
    session: State<'_, VaultSession>,
) -> AppResult<MergeResult> {
    let (mut db, key) = {
        let guard = session.0.lock().expect("vault session mutex poisoned");
        let vault = guard.as_ref().ok_or(AppError::NoOpenDatabase)?;
        (vault.db.clone(), vault.key.clone())
    };

    let (db, result) = tauri::async_runtime::spawn_blocking(move || {
        let result = sync::merge_snapshot(&mut db, key, &bytes, password.as_deref())?;
        Ok::<_, AppError>((db, result))
    })
    .await
    .map_err(join_err)??;

    // Write the merged database back into the session (the vault may have been
    // locked while the merge ran; only apply if it's still open).
    {
        let mut guard = session.0.lock().expect("vault session mutex poisoned");
        match guard.as_mut() {
            Some(vault) => vault.db = db,
            None => return Err(AppError::NoOpenDatabase),
        }
    }
    Ok(result)
}

// ── Phase 9: import / export & browser integration ────────────────────────────

/// Analyse CSV text against the open database: detect the source format, suggest
/// a column mapping, and flag rows that duplicate existing entries (IMP-01). When
/// `mapping` is provided the preview reflects the user's adjustments instead.
#[tauri::command]
pub fn import_csv_preview(
    text: String,
    mapping: Option<ColumnMapping>,
    session: State<'_, VaultSession>,
) -> AppResult<CsvPreview> {
    with_db(&session, |db| import::preview_csv(db, &text, mapping))
}

/// Import CSV rows into a group under the given mapping; optionally skipping
/// duplicates. The frontend marks the session dirty and saves to persist.
#[tauri::command]
pub fn import_csv_apply(
    text: String,
    mapping: ColumnMapping,
    group_uuid: String,
    skip_duplicates: bool,
    session: State<'_, VaultSession>,
) -> AppResult<ImportReport> {
    with_db_mut(&session, |db| {
        import::import_csv(db, &text, &mapping, &group_uuid, skip_duplicates)
    })
}

/// Preview a KDBX import (merge) without mutating the open vault — reports how
/// many entries/groups would be created/updated (IMP-02 + preview). Heavy
/// (decryption) so it runs off the UI thread.
#[tauri::command]
pub async fn import_kdbx_preview(
    bytes: Vec<u8>,
    password: Option<String>,
    key_file: Option<String>,
    session: State<'_, VaultSession>,
) -> AppResult<MergeResult> {
    let db = {
        let guard = session.0.lock().expect("vault session mutex poisoned");
        guard.as_ref().ok_or(AppError::NoOpenDatabase)?.db.clone()
    };
    tauri::async_runtime::spawn_blocking(move || {
        import::preview_kdbx(&db, &bytes, password.as_deref(), key_file.as_deref())
    })
    .await
    .map_err(join_err)?
}

/// Import a KDBX file by merging it into the open vault (IMP-02). The merged
/// database is written back into the session; the frontend saves to persist.
#[tauri::command]
pub async fn import_kdbx_apply(
    bytes: Vec<u8>,
    password: Option<String>,
    key_file: Option<String>,
    session: State<'_, VaultSession>,
) -> AppResult<MergeResult> {
    let mut db = {
        let guard = session.0.lock().expect("vault session mutex poisoned");
        guard.as_ref().ok_or(AppError::NoOpenDatabase)?.db.clone()
    };
    let (db, result) = tauri::async_runtime::spawn_blocking(move || {
        let result = import::import_kdbx(&mut db, &bytes, password.as_deref(), key_file.as_deref())?;
        Ok::<_, AppError>((db, result))
    })
    .await
    .map_err(join_err)??;

    {
        let mut guard = session.0.lock().expect("vault session mutex poisoned");
        match guard.as_mut() {
            Some(vault) => vault.db = db,
            None => return Err(AppError::NoOpenDatabase),
        }
    }
    Ok(result)
}

/// Export the open vault to a fresh `.kdbx` at `path` under the chosen encryption
/// settings and (possibly different) master password / key file (EXP / KDBX
/// export with different encryption settings). Heavy → off the UI thread.
#[tauri::command]
pub async fn export_kdbx(
    path: String,
    options: CreateOptions,
    password: Option<String>,
    key_file: Option<String>,
    session: State<'_, VaultSession>,
) -> AppResult<()> {
    let db = {
        let guard = session.0.lock().expect("vault session mutex poisoned");
        guard.as_ref().ok_or(AppError::NoOpenDatabase)?.db.clone()
    };
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        crate::export::export_kdbx(&db, &options, password.as_deref(), key_file.as_deref())
    })
    .await
    .map_err(join_err)??;

    fs_ops::write_file_atomic(Path::new(&path), &bytes)
}

/// Rank vault entries whose URL matches a page URL, for in-app credential
/// suggestions (BRW-03). Returns lightweight summaries (no secrets).
#[tauri::command]
pub fn match_url(
    url: String,
    limit: usize,
    session: State<'_, VaultSession>,
) -> AppResult<Vec<EntrySummary>> {
    with_db(&session, |db| {
        Ok(browser::matching_entry_ids(db, &url)
            .into_iter()
            .take(limit)
            .filter_map(|id| db.entry(id).map(|e| database::entry_summary(&e, e.parent().id())))
            .collect())
    })
}

/// Current status of the localhost browser-integration HTTP server (BRW-02).
#[tauri::command]
pub fn browser_server_status(server: State<'_, BrowserServer>) -> ServerStatus {
    server.status()
}

/// Start the localhost browser-integration server. A token is generated when one
/// isn't supplied; the default port is 7796 (BRW-02). Bound to `127.0.0.1` only.
#[tauri::command]
pub fn browser_server_start(
    app: AppHandle,
    server: State<'_, BrowserServer>,
    port: Option<u16>,
    token: Option<String>,
) -> AppResult<ServerStatus> {
    let token = token.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| {
        format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        )
    });
    server.start(&app, port.unwrap_or(7796), token)
}

/// Stop the browser-integration server (BRW-02).
#[tauri::command]
pub fn browser_server_stop(app: AppHandle, server: State<'_, BrowserServer>) {
    server.stop(&app);
}

/// Write a ready-to-load browser extension + native-messaging host manifest into
/// `dir` (BRW-01 / browser extension manifest). Uses this executable's path in
/// the native-host manifest.
#[tauri::command]
pub fn export_browser_extension(dir: String) -> AppResult<()> {
    let exe = std::env::current_exe()
        .map_err(|e| AppError::Other(format!("could not resolve executable path: {e}")))?;
    browser::write_extension_bundle(&dir, &exe.to_string_lossy())
}

/// Register the native-messaging host manifest so Chrome/Edge can launch the
/// host (Windows-only; errors elsewhere with guidance) (BRW-01).
#[tauri::command]
pub fn register_native_host(manifest_path: String) -> AppResult<()> {
    browser::register_native_host(&manifest_path)
}
