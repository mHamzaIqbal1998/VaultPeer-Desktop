//! Core file-system operations for VaultPeer.
//!
//! The defining requirement (PRD FM-03) is *atomic* saves: a database write
//! must never leave a half-written, corrupt `.kdbx` on disk if the process is
//! killed mid-write. We achieve this by writing to a sibling temp file, syncing
//! it to durable storage, and then renaming it over the destination — `rename`
//! is atomic within a filesystem on all supported platforms.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use serde::Serialize;

use crate::error::{AppError, AppResult};

/// Metadata describing a file on disk, returned to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct FileMeta {
    pub path: String,
    pub size: u64,
    /// Last-modified time as Unix epoch milliseconds, or `None` if unavailable.
    pub modified: Option<u64>,
}

/// Read the entire contents of a file into memory.
pub fn read_file(path: &Path) -> AppResult<Vec<u8>> {
    Ok(fs::read(path)?)
}

/// Stat a file, returning its size and last-modified timestamp.
pub fn stat_file(path: &Path) -> AppResult<FileMeta> {
    let meta = fs::metadata(path)?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);

    let path_str = path.to_str().ok_or(AppError::NonUtf8Path)?.to_string();

    Ok(FileMeta {
        path: path_str,
        size: meta.len(),
        modified,
    })
}

/// Set a file's last-modified time to `mtime_ms` (Unix epoch milliseconds).
///
/// Used by P2P sync to stamp the local vault with the *logical* version
/// timestamp agreed with a peer (mirroring the server node's `fs.utimes`), so a
/// vault that's already in sync isn't perpetually re-pulled because its local
/// filesystem mtime lags the peer's content mtime.
pub fn set_file_mtime(path: &Path, mtime_ms: u64) -> AppResult<()> {
    let time = UNIX_EPOCH + Duration::from_millis(mtime_ms);
    let file = fs::OpenOptions::new().write(true).open(path)?;
    file.set_modified(time)?;
    Ok(())
}

/// Build the path of the temporary file used during an atomic write.
/// Lives in the same directory as the destination so the final `rename` stays
/// within one filesystem (a cross-device rename would fail / be non-atomic).
fn temp_path_for(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".vaultpeer.tmp");
    match dest.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join(name),
        _ => PathBuf::from(name),
    }
}

/// Atomically write `contents` to `dest`.
///
/// Steps: write a temp file → flush + fsync → fsync the parent dir → rename
/// over the destination. On any failure the temp file is cleaned up and the
/// original destination is left untouched.
pub fn write_file_atomic(dest: &Path, contents: &[u8]) -> AppResult<()> {
    // Ensure the destination directory exists.
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }

    let tmp = temp_path_for(dest);

    // Scoped so the file handle is dropped (closed) before we rename.
    let write_result = (|| -> AppResult<()> {
        let mut file = File::create(&tmp)?;
        file.write_all(contents)?;
        file.flush()?;
        // Ensure bytes hit durable storage before the rename.
        file.sync_all()?;
        Ok(())
    })();

    if let Err(e) = write_result {
        // Best-effort cleanup; ignore errors removing the temp file.
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }

    // Atomic replace. On Windows, std's rename uses MoveFileEx with
    // REPLACE_EXISTING semantics, so this overwrites an existing destination.
    if let Err(e) = fs::rename(&tmp, dest) {
        let _ = fs::remove_file(&tmp);
        return Err(e.into());
    }

    // Best-effort fsync of the parent directory so the rename itself is durable.
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            if let Ok(dir) = File::open(parent) {
                let _ = dir.sync_all();
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::time::SystemTime;

    /// Returns a unique scratch directory under the OS temp dir and ensures it
    /// exists. Each test gets its own folder so they can run in parallel.
    fn scratch_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = env::temp_dir().join(format!("vaultpeer-test-{tag}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn write_then_read_roundtrips() {
        let dir = scratch_dir("roundtrip");
        let path = dir.join("vault.kdbx");
        let data = b"\x03\xd9\xa2\x9a\x67\xfb\x4b\xb5 sample payload";

        write_file_atomic(&path, data).unwrap();
        let read_back = read_file(&path).unwrap();

        assert_eq!(read_back, data);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn atomic_write_overwrites_existing_file() {
        let dir = scratch_dir("overwrite");
        let path = dir.join("vault.kdbx");

        write_file_atomic(&path, b"first version").unwrap();
        write_file_atomic(&path, b"second, longer version of the file").unwrap();

        let read_back = read_file(&path).unwrap();
        assert_eq!(read_back, b"second, longer version of the file");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn atomic_write_leaves_no_temp_file_behind() {
        let dir = scratch_dir("notemp");
        let path = dir.join("vault.kdbx");

        write_file_atomic(&path, b"payload").unwrap();

        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".vaultpeer.tmp"))
            .collect();

        assert!(
            leftovers.is_empty(),
            "temp file should be renamed away, found: {leftovers:?}"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_creates_missing_parent_directories() {
        let dir = scratch_dir("mkdirs");
        let path = dir.join("nested").join("deeper").join("vault.kdbx");

        write_file_atomic(&path, b"data").unwrap();

        assert!(path.exists());
        assert_eq!(read_file(&path).unwrap(), b"data");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stat_reports_correct_size() {
        let dir = scratch_dir("stat");
        let path = dir.join("vault.kdbx");
        let data = vec![0u8; 4096];

        write_file_atomic(&path, &data).unwrap();
        let meta = stat_file(&path).unwrap();

        assert_eq!(meta.size, 4096);
        assert!(meta.modified.is_some());
        assert!(meta.path.ends_with("vault.kdbx"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn set_mtime_is_reflected_by_stat() {
        let dir = scratch_dir("mtime");
        let path = dir.join("vault.kdbx");
        write_file_atomic(&path, b"data").unwrap();

        // A fixed whole-second timestamp (epoch ms) so the FS preserves it.
        let target_ms: u64 = 1_700_000_000_000;
        set_file_mtime(&path, target_ms).unwrap();

        let meta = stat_file(&path).unwrap();
        let got = meta.modified.unwrap();
        // Allow a small tolerance for filesystem timestamp granularity.
        assert!(
            got.abs_diff(target_ms) < 2000,
            "expected ~{target_ms}, got {got}"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_missing_file_errors() {
        let dir = scratch_dir("missing");
        let path = dir.join("does-not-exist.kdbx");

        assert!(read_file(&path).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn temp_path_is_sibling_of_destination() {
        let dest = Path::new("/some/dir/vault.kdbx");
        let tmp = temp_path_for(dest);
        assert_eq!(tmp.parent(), dest.parent());
        assert_ne!(tmp, dest.to_path_buf());
    }
}
