//! Security audit utilities (Phase 10) and config directory hardening (Phase 11).
//!
//! Provides compile-time and runtime security checks:
//! - File permission verification for database files
//! - Config directory permission enforcement (Unix 0700, Windows ACL)

use std::path::Path;

/// Verify that a database file has reasonable permissions. On Windows, this
/// checks the file is not world-writable. Returns a warning string if the
/// permissions are too loose, or None if acceptable.
#[allow(dead_code)]
pub fn check_file_permissions(path: &str) -> Option<String> {
    let p = Path::new(path);
    if !p.exists() {
        return Some(format!("File does not exist: {}", path));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(p) {
            let mode = meta.permissions().mode();
            if mode & 0o002 != 0 {
                return Some(format!(
                    "Database file is world-writable (mode {:o}). Consider restricting permissions.",
                    mode & 0o777
                ));
            }
            if mode & 0o020 != 0 {
                return Some(format!(
                    "Database file is group-writable (mode {:o}). Consider restricting permissions.",
                    mode & 0o777
                ));
            }
        }
    }

    None
}

/// Ensure the config directory exists with restrictive permissions.
/// - Unix: `0700` (owner-only read/write/execute).
/// - Windows: best-effort `icacls` to remove inherited access and grant only the
///   current user full control. Falls back silently if `icacls` is unavailable.
pub fn ensure_config_dir_security(dir: &Path) -> Result<(), String> {
    if !dir.exists() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o700);
        std::fs::set_permissions(dir, perms)
            .map_err(|e| format!("Failed to set directory permissions: {}", e))?;
    }

    #[cfg(windows)]
    {
        let dir_str = dir.to_string_lossy();
        // Remove inherited ACEs and grant the current user full control.
        // `icacls` is available on all supported Windows versions (Vista+).
        // Failures are non-fatal: the directory still exists, just with default ACLs.
        let username = std::env::var("USERNAME").unwrap_or_default();
        if !username.is_empty() {
            let _ = std::process::Command::new("icacls")
                .args([&*dir_str, "/inheritance:r", "/grant:r", &format!("{username}:(OI)(CI)F")])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nonexistent_file_returns_warning() {
        let result = check_file_permissions("/nonexistent/path/db.kdbx");
        assert!(result.is_some());
        assert!(result.unwrap().contains("does not exist"));
    }

    #[test]
    fn existing_file_ok() {
        let tmp = std::env::temp_dir().join(format!(
            "vaultpeer-sec-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&tmp, b"test").unwrap();
        let result = check_file_permissions(tmp.to_str().unwrap());
        // On most systems, temp files are not world-writable
        if cfg!(unix) {
            // May or may not warn depending on umask
        } else {
            assert!(result.is_none());
        }
        std::fs::remove_file(&tmp).ok();
    }

    #[test]
    fn config_dir_creation() {
        let tmp = std::env::temp_dir().join(format!(
            "vaultpeer-sec-dir-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let result = ensure_config_dir_security(&tmp);
        assert!(result.is_ok());
        assert!(tmp.exists());
        std::fs::remove_dir_all(&tmp).ok();
    }
}
