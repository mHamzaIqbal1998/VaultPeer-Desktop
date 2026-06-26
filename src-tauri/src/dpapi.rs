//! Shared DPAPI helpers for encrypting sensitive data at rest (Phase 11).
//!
//! Centralises the Windows Data Protection API calls previously inlined in
//! `biometric.rs`, adding **app-scoped entropy** so that another process running
//! as the same Windows user cannot trivially call `CryptUnprotectData` on blobs
//! lifted from VaultPeer's config directory.
//!
//! Legacy blobs created before Phase 11 (without entropy) are still accepted on
//! decrypt: the [`unprotect`] path tries with entropy first and falls back to
//! without, then re-encryption with entropy is done by the caller.
//!
//! Non-Windows builds get pass-through stubs (no encryption at rest) because the
//! app's primary desktop target is Windows; a future cross-platform release would
//! wire in macOS Keychain / libsecret here.

use crate::error::{AppError, AppResult};

/// App-scoped entropy mixed into every `CryptProtectData` / `CryptUnprotectData`
/// call. This is compiled into the binary — not a secret per se, but it prevents
/// a drive-by `CryptUnprotectData` one-liner from recovering the plaintext.
#[cfg(windows)]
const ENTROPY: &[u8] = b"VaultPeer-Desktop-dpapi-9f4e2a71c8b3d056e1a7f28b";

// ── Windows implementation ───────────────────────────────────────────────────

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };

    fn raw_protect(data: &[u8], entropy: Option<&[u8]>) -> AppResult<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let entropy_blob = entropy.map(|e| CRYPT_INTEGER_BLOB {
            cbData: e.len() as u32,
            pbData: e.as_ptr() as *mut u8,
        });
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        unsafe {
            CryptProtectData(
                &input,
                None,
                entropy_blob.as_ref().map(|b| b as *const _),
                None,
                None,
                0,
                &mut output,
            )
            .map_err(|e| AppError::Crypto(format!("DPAPI protect failed: {e}")))?;
            let slice = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
            let owned = slice.to_vec();
            let _ = windows::Win32::Foundation::LocalFree(windows::Win32::Foundation::HLOCAL(
                output.pbData as *mut core::ffi::c_void,
            ));
            Ok(owned)
        }
    }

    fn raw_unprotect(data: &[u8], entropy: Option<&[u8]>) -> AppResult<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let entropy_blob = entropy.map(|e| CRYPT_INTEGER_BLOB {
            cbData: e.len() as u32,
            pbData: e.as_ptr() as *mut u8,
        });
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        unsafe {
            CryptUnprotectData(
                &input,
                None,
                entropy_blob.as_ref().map(|b| b as *const _),
                None,
                None,
                0,
                &mut output,
            )
            .map_err(|e| AppError::Crypto(format!("DPAPI unprotect failed: {e}")))?;
            let slice = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
            let owned = slice.to_vec();
            let _ = windows::Win32::Foundation::LocalFree(windows::Win32::Foundation::HLOCAL(
                output.pbData as *mut core::ffi::c_void,
            ));
            Ok(owned)
        }
    }

    /// Encrypt bytes with DPAPI + app-scoped entropy.
    pub fn protect(data: &[u8]) -> AppResult<Vec<u8>> {
        raw_protect(data, Some(ENTROPY))
    }

    /// Decrypt bytes. Tries with app-scoped entropy first; falls back to
    /// no-entropy decryption for blobs created before Phase 11.
    pub fn unprotect(data: &[u8]) -> AppResult<Vec<u8>> {
        match raw_unprotect(data, Some(ENTROPY)) {
            Ok(plain) => Ok(plain),
            Err(_) => raw_unprotect(data, None),
        }
    }

    /// Encrypt a UTF-8 string, returning DPAPI ciphertext bytes.
    pub fn protect_string(s: &str) -> AppResult<Vec<u8>> {
        protect(s.as_bytes())
    }

    /// Decrypt DPAPI ciphertext bytes back to a UTF-8 string.
    pub fn unprotect_string(data: &[u8]) -> AppResult<String> {
        let bytes = unprotect(data)?;
        String::from_utf8(bytes)
            .map_err(|_| AppError::Crypto("DPAPI-decrypted data is not valid UTF-8".into()))
    }
}

#[cfg(windows)]
pub use imp::{protect, protect_string, unprotect, unprotect_string};

// ── Non-Windows stubs ─────────────────────────────────────────────────────────

#[cfg(not(windows))]
pub fn protect(data: &[u8]) -> AppResult<Vec<u8>> {
    Ok(data.to_vec())
}

#[cfg(not(windows))]
#[allow(dead_code)]
pub fn unprotect(data: &[u8]) -> AppResult<Vec<u8>> {
    Ok(data.to_vec())
}

#[cfg(not(windows))]
pub fn protect_string(s: &str) -> AppResult<Vec<u8>> {
    Ok(s.as_bytes().to_vec())
}

#[cfg(not(windows))]
pub fn unprotect_string(data: &[u8]) -> AppResult<String> {
    String::from_utf8(data.to_vec())
        .map_err(|_| AppError::Crypto("data is not valid UTF-8".into()))
}

// ── Settings field-level encryption helpers ───────────────────────────────────

/// Encrypt TURN credential / username fields inside a serialized settings JSON
/// value before writing to disk. Plaintext strings are replaced with
/// `{"__dpapi": [byte_array]}` objects.
pub fn protect_settings_secrets(val: &mut serde_json::Value) {
    protect_ice_server_fields(val);
}

/// Decrypt TURN credential / username fields in a settings JSON value after
/// reading from disk. `{"__dpapi": [...]}` objects are replaced with the
/// recovered plaintext strings; plain strings pass through unchanged.
pub fn unprotect_settings_secrets(val: &mut serde_json::Value) {
    unprotect_ice_server_fields(val);
}

fn protect_ice_server_fields(val: &mut serde_json::Value) {
    let servers = match val
        .pointer_mut("/sync/iceServers")
        .and_then(|v| v.as_array_mut())
    {
        Some(arr) => arr,
        None => return,
    };
    for server in servers.iter_mut() {
        let obj = match server.as_object_mut() {
            Some(o) => o,
            None => continue,
        };
        let to_encrypt: Vec<(String, Vec<u8>)> = ["credential", "username"]
            .iter()
            .filter_map(|&field| {
                let plain = obj.get(field)?.as_str()?;
                if plain.is_empty() {
                    return None;
                }
                protect(plain.as_bytes())
                    .ok()
                    .map(|blob| (field.to_string(), blob))
            })
            .collect();
        for (field, blob) in to_encrypt {
            obj.insert(field, serde_json::json!({ "__dpapi": blob }));
        }
    }
}

fn unprotect_ice_server_fields(val: &mut serde_json::Value) {
    let servers = match val
        .pointer_mut("/sync/iceServers")
        .and_then(|v| v.as_array_mut())
    {
        Some(arr) => arr,
        None => return,
    };
    for server in servers.iter_mut() {
        let obj = match server.as_object_mut() {
            Some(o) => o,
            None => continue,
        };
        let to_decrypt: Vec<(String, String)> = ["credential", "username"]
            .iter()
            .filter_map(|&field| {
                let dpapi_arr = obj.get(field)?.get("__dpapi")?.as_array()?;
                let bytes: Vec<u8> = dpapi_arr
                    .iter()
                    .filter_map(|v| v.as_u64().map(|n| n as u8))
                    .collect();
                unprotect_string(&bytes)
                    .ok()
                    .map(|s| (field.to_string(), s))
            })
            .collect();
        for (field, plain) in to_decrypt {
            obj.insert(field, serde_json::Value::String(plain));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protect_unprotect_round_trips() {
        let data = b"secret-master-password-123";
        let encrypted = protect(data).unwrap();
        let decrypted = unprotect(&encrypted).unwrap();
        assert_eq!(decrypted, data);
    }

    #[test]
    fn protect_string_round_trips() {
        let secret = "my-secret-token-abc-123";
        let encrypted = protect_string(secret).unwrap();
        let decrypted = unprotect_string(&encrypted).unwrap();
        assert_eq!(decrypted, secret);
    }

    #[test]
    fn settings_secrets_round_trip() {
        let mut val = serde_json::json!({
            "sync": {
                "iceServers": [
                    {
                        "urls": ["stun:stun.l.google.com:19302"],
                        "username": null,
                        "credential": null
                    },
                    {
                        "urls": ["turn:my-server.com:3478"],
                        "username": "myuser",
                        "credential": "mysecretpassword"
                    }
                ]
            }
        });

        protect_settings_secrets(&mut val);

        // On Windows the credential/username should be encrypted objects;
        // on non-Windows they stay as strings (pass-through stubs).
        #[cfg(windows)]
        {
            let cred = &val["sync"]["iceServers"][1]["credential"];
            assert!(cred.get("__dpapi").is_some(), "credential should be encrypted");
            let user = &val["sync"]["iceServers"][1]["username"];
            assert!(user.get("__dpapi").is_some(), "username should be encrypted");
        }

        unprotect_settings_secrets(&mut val);

        assert_eq!(val["sync"]["iceServers"][1]["credential"], "mysecretpassword");
        assert_eq!(val["sync"]["iceServers"][1]["username"], "myuser");
        // Null / empty fields should be untouched.
        assert!(val["sync"]["iceServers"][0]["credential"].is_null());
    }

    #[test]
    fn empty_string_is_not_encrypted() {
        let mut val = serde_json::json!({
            "sync": {
                "iceServers": [{
                    "urls": ["stun:x"],
                    "username": "",
                    "credential": ""
                }]
            }
        });

        protect_settings_secrets(&mut val);

        assert_eq!(val["sync"]["iceServers"][0]["username"], "");
        assert_eq!(val["sync"]["iceServers"][0]["credential"], "");
    }
}
