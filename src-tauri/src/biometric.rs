//! Windows Hello biometric quick-unlock (PLAN Phase 7 / PRD UN-02, UN-03).
//!
//! Lets a user "enroll" a database so it can later be unlocked after a Windows
//! Hello check (fingerprint / face / PIN) instead of retyping the master
//! password. The master password is never stored in the clear: it is encrypted
//! with the Windows Data Protection API (DPAPI, `CryptProtectData`), which ties
//! the ciphertext to the current user account, and the Hello prompt
//! (`UserConsentVerifier`) gates each unlock.
//!
//! The encrypted blobs live in `quickunlock.json` under the app-config dir,
//! keyed by absolute database path. Everything here is Windows-only; the
//! non-Windows build gets stubs so the rest of the app still compiles.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::error::{AppError, AppResult};

/// The on-disk store of DPAPI-protected master passwords, keyed by database path.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Store {
    /// Map of absolute database path → DPAPI ciphertext bytes.
    entries: HashMap<String, Vec<u8>>,
}

fn store_path<R: Runtime>(app: &AppHandle<R>) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Other(format!("could not resolve app config dir: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("quickunlock.json"))
}

fn load_store<R: Runtime>(app: &AppHandle<R>) -> Store {
    match store_path(app).and_then(|p| Ok(std::fs::read(p)?)) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Store::default(),
    }
}

fn save_store<R: Runtime>(app: &AppHandle<R>, store: &Store) -> AppResult<()> {
    let path = store_path(app)?;
    let json = serde_json::to_vec_pretty(store)
        .map_err(|e| AppError::Other(format!("could not serialize quick-unlock store: {e}")))?;
    crate::fs_ops::write_file_atomic(&path, &json)
}

/// Whether the given database has a stored quick-unlock credential.
pub fn is_enrolled<R: Runtime>(app: &AppHandle<R>, db_path: &str) -> bool {
    load_store(app).entries.contains_key(db_path)
}

/// Remove any stored credential for a database (used on disable / failure).
pub fn forget<R: Runtime>(app: &AppHandle<R>, db_path: &str) -> AppResult<()> {
    let mut store = load_store(app);
    if store.entries.remove(db_path).is_some() {
        save_store(app, &store)?;
    }
    Ok(())
}

// ── Windows implementation ───────────────────────────────────────────────────

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::core::HSTRING;
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };

    /// Whether Windows Hello (or a PIN fallback) is configured and available.
    pub fn available() -> bool {
        match UserConsentVerifier::CheckAvailabilityAsync().and_then(|op| op.get()) {
            Ok(a) => a == UserConsentVerifierAvailability::Available,
            Err(_) => false,
        }
    }

    /// Prompt the user for a Windows Hello verification, returning Ok(()) only on
    /// a successful (verified) check.
    ///
    /// The app window is minimized before the prompt so the system UWP dialog
    /// (PIN / fingerprint / face) appears in the foreground instead of behind it.
    fn verify<R: Runtime>(app: &AppHandle<R>, message: &str) -> AppResult<()> {
        let window = app.get_webview_window("main");
        if let Some(ref w) = window {
            let _ = w.minimize();
        }

        let op = UserConsentVerifier::RequestVerificationAsync(&HSTRING::from(message))
            .map_err(|e| AppError::Other(format!("Windows Hello unavailable: {e}")))?;
        let result = op
            .get()
            .map_err(|e| AppError::Other(format!("Windows Hello prompt failed: {e}")))?;

        if let Some(ref w) = window {
            let _ = w.unminimize();
            let _ = w.set_focus();
        }

        if result == UserConsentVerificationResult::Verified {
            Ok(())
        } else {
            Err(AppError::Other("Windows Hello verification was not completed.".into()))
        }
    }

    /// DPAPI-encrypt `data` for the current user account.
    fn protect(data: &[u8]) -> AppResult<Vec<u8>> {
        let mut input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        unsafe {
            CryptProtectData(&mut input, None, None, None, None, 0, &mut output)
                .map_err(|e| AppError::Crypto(format!("DPAPI protect failed: {e}")))?;
            let slice = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
            let owned = slice.to_vec();
            // The buffer was allocated by LocalAlloc inside CryptProtectData.
            let _ = windows::Win32::Foundation::LocalFree(windows::Win32::Foundation::HLOCAL(
                output.pbData as *mut core::ffi::c_void,
            ));
            Ok(owned)
        }
    }

    /// DPAPI-decrypt a blob previously produced by [`protect`].
    fn unprotect(data: &[u8]) -> AppResult<Vec<u8>> {
        let mut input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        unsafe {
            CryptUnprotectData(&mut input, None, None, None, None, 0, &mut output)
                .map_err(|e| AppError::Crypto(format!("DPAPI unprotect failed: {e}")))?;
            let slice = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
            let owned = slice.to_vec();
            let _ = windows::Win32::Foundation::LocalFree(windows::Win32::Foundation::HLOCAL(
                output.pbData as *mut core::ffi::c_void,
            ));
            Ok(owned)
        }
    }

    /// Enroll a database: verify with Hello, then store the DPAPI-protected
    /// master password.
    pub fn enroll<R: Runtime>(app: &AppHandle<R>, db_path: &str, password: &str) -> AppResult<()> {
        verify(app, "Confirm it's you to enable quick unlock for this vault")?;
        let blob = protect(password.as_bytes())?;
        let mut store = load_store(app);
        store.entries.insert(db_path.to_string(), blob);
        save_store(app, &store)
    }

    /// Unlock a database: verify with Hello, then return the decrypted master
    /// password for the unlock flow.
    pub fn unlock<R: Runtime>(app: &AppHandle<R>, db_path: &str) -> AppResult<String> {
        let store = load_store(app);
        let blob = store
            .entries
            .get(db_path)
            .ok_or_else(|| AppError::NotFound("no quick-unlock credential for this vault".into()))?
            .clone();
        verify(app, "Verify your identity to unlock your vault")?;
        let bytes = unprotect(&blob)?;
        String::from_utf8(bytes)
            .map_err(|_| AppError::Crypto("stored credential was corrupt".into()))
    }
}

#[cfg(windows)]
pub use imp::available;

/// Enroll a database for biometric quick-unlock (Windows-only).
#[cfg(windows)]
pub fn enroll<R: Runtime>(app: &AppHandle<R>, db_path: &str, password: &str) -> AppResult<()> {
    imp::enroll(app, db_path, password)
}

/// Unlock via biometric quick-unlock, returning the master password (Windows-only).
#[cfg(windows)]
pub fn unlock<R: Runtime>(app: &AppHandle<R>, db_path: &str) -> AppResult<String> {
    imp::unlock(app, db_path)
}

// ── Non-Windows stubs ─────────────────────────────────────────────────────────

#[cfg(not(windows))]
pub fn available() -> bool {
    false
}

#[cfg(not(windows))]
pub fn enroll<R: Runtime>(_app: &AppHandle<R>, _db_path: &str, _password: &str) -> AppResult<()> {
    Err(AppError::Other(
        "Windows Hello is only available on Windows.".into(),
    ))
}

#[cfg(not(windows))]
pub fn unlock<R: Runtime>(_app: &AppHandle<R>, _db_path: &str) -> AppResult<String> {
    Err(AppError::Other(
        "Windows Hello is only available on Windows.".into(),
    ))
}
