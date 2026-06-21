//! Tauri command handlers — the IPC surface exposed to the React frontend.
//!
//! These are thin wrappers; real logic lives in [`crate::fs_ops`] so it can be
//! unit-tested without a running Tauri context.

use std::path::{Path, PathBuf};

use tauri::State;

use crate::crypto::{self, CreateOptions, DatabaseMetadata};
use crate::error::{AppError, AppResult};
use crate::fs_ops::{self, FileMeta};
use crate::session::{OpenVault, VaultSession};

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
