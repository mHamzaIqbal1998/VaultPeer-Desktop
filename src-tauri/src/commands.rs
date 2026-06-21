//! Tauri command handlers — the IPC surface exposed to the React frontend.
//!
//! These are thin wrappers; real logic lives in [`crate::fs_ops`] so it can be
//! unit-tested without a running Tauri context.

use std::path::PathBuf;

use crate::error::AppResult;
use crate::fs_ops::{self, FileMeta};

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
