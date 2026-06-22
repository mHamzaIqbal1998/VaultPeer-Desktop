//! Tauri command handlers — the IPC surface exposed to the React frontend.
//!
//! These are thin wrappers; real logic lives in [`crate::fs_ops`] so it can be
//! unit-tested without a running Tauri context.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::autotype::{self, AutoTypeTarget, TypeFields};
use crate::crypto::{self, CreateOptions, DatabaseMetadata};
use crate::database::{
    self, AttachmentMeta, DatabaseTree, EntryDetail, EntryInput, EntrySummary, HistoryItem,
};
use crate::error::{AppError, AppResult};
use crate::fs_ops::{self, FileMeta};
use crate::otp::{self, TotpCode};
use crate::search::{self, SearchFilters, SearchHit};
use crate::session::{OpenVault, VaultSession};
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
