//! In-memory vault session (PLAN Phase 2).
//!
//! Holds the single currently-unlocked database for the lifetime of the unlock.
//! The decrypted [`Database`] and the [`DatabaseKey`] are kept here so the app
//! can re-save without re-prompting; locking drops both, and `DatabaseKey`
//! zeroizes its secrets on drop.
//!
//! A single-vault model matches the desktop UX (one open database at a time).

use std::sync::Mutex;

use keepass::{Database, DatabaseKey};

/// The currently-open vault: its decrypted contents, the key it was unlocked
/// with, and where it lives on disk.
pub struct OpenVault {
    pub db: Database,
    pub key: DatabaseKey,
    pub path: String,
}

/// Tauri-managed state wrapping the optional open vault behind a mutex.
#[derive(Default)]
pub struct VaultSession(pub Mutex<Option<OpenVault>>);

impl VaultSession {
    /// Replace the open vault (called after a successful unlock/create).
    pub fn set(&self, vault: OpenVault) {
        *self.0.lock().expect("vault session mutex poisoned") = Some(vault);
    }

    /// Drop the open vault, clearing decrypted data and the key from memory.
    pub fn clear(&self) {
        *self.0.lock().expect("vault session mutex poisoned") = None;
    }

    /// Whether a database is currently unlocked. Reserved for auto-lock (Phase 7).
    #[allow(dead_code)]
    pub fn is_unlocked(&self) -> bool {
        self.0
            .lock()
            .expect("vault session mutex poisoned")
            .is_some()
    }
}
