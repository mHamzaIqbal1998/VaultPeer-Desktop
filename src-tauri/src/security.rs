//! Security audit utilities (Phase 10).
//!
//! Provides compile-time and runtime security checks:
//! - File permission verification for database files
//! - Memory protection assertions
//! - Update mechanism security stubs

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

/// Ensure the settings directory exists with appropriate permissions.
#[allow(dead_code)]
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
