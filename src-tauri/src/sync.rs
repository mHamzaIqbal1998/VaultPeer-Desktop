//! P2P synchronization core (PLAN Phase 8).
//!
//! The transport — WebRTC peer connections and the WebSocket signaling
//! handshake — runs in the WebView's native, audited WebRTC stack on the
//! frontend (see `src/lib/webrtc.ts`). That keeps the Rust binary small (no
//! ~300-crate `webrtc-rs` dependency, preserving the "single small binary"
//! value proposition) and lets the desktop and the React-based mobile app share
//! one JS sync protocol.
//!
//! Rust owns the parts it is best at and that must never touch the wire in the
//! clear: producing the **encrypted** `.kdbx` snapshot that travels over the
//! (already DTLS-encrypted) data channel, and applying a received snapshot via
//! the KeePass-compatible three-way merge (`keepass::Database::merge`, which
//! resolves conflicts by UUID with newer-modification-wins and preserves entry
//! history). The decrypted vault is never serialized to anything but KDBX, and
//! never leaves the backend.
//!
//! None of these functions touch Tauri, so the merge logic is unit-testable.

use std::io::Cursor;

use keepass::{
    config::{KdfConfig, OuterCipherConfig},
    Database, DatabaseKey,
};
use serde::{Deserialize, Serialize};

use crate::crypto;
use crate::error::{AppError, AppResult};

/// A single ICE server (STUN/TURN) used to establish the peer connection
/// (PRD SYN-07). `urls` is one or more `stun:`/`turn:` URLs; `username` and
/// `credential` are only needed for authenticated TURN servers.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IceServerConfig {
    pub urls: Vec<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub credential: Option<String>,
}

/// Persisted P2P sync configuration (lives inside `AppSettings`). Defaults to a
/// public STUN server and no signaling URL (the user supplies their own, or
/// points at the same server their mobile app uses).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncConfig {
    /// `ws(s)://…` URL of the signaling server used to exchange offers/answers.
    pub signaling_url: String,
    /// ICE servers for NAT traversal (STUN for discovery, TURN as relay).
    pub ice_servers: Vec<IceServerConfig>,
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            signaling_url: String::new(),
            ice_servers: vec![IceServerConfig {
                urls: vec!["stun:stun.l.google.com:19302".to_string()],
                username: None,
                credential: None,
            }],
        }
    }
}

/// A lightweight description of a vault's current state, exchanged between peers
/// before any bytes are transferred so each side can decide whether a sync is
/// needed (PRD SYN-05: metadata exchange — timestamps, checksums).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultFingerprint {
    pub name: Option<String>,
    pub entry_count: usize,
    pub group_count: usize,
    /// Most-recent entry/group modification time across the vault, epoch millis.
    pub latest_modified: Option<i64>,
    /// FNV-1a checksum over the entries' UUIDs + modification times, so two
    /// vaults that differ produce different fingerprints without leaking content.
    pub checksum: String,
}

/// The encrypted vault bytes plus the fingerprint describing them, returned to
/// the frontend to be chunked and sent over the data channel (SYN-04).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSnapshot {
    /// Encrypted `.kdbx` bytes, serialized with the current session key.
    pub bytes: Vec<u8>,
    pub fingerprint: VaultFingerprint,
}

/// The outcome of merging a received snapshot into the open vault (SYN-05).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    /// Objects (entries/groups) that existed only on the remote and were added.
    pub created: usize,
    /// Objects whose contents were updated from the (newer) remote version.
    pub updated: usize,
    /// Objects relocated to a different group as a result of the merge.
    pub location_updated: usize,
    /// Objects removed because the remote recorded them as deleted.
    pub deleted: usize,
    /// Non-fatal merge warnings (e.g. ambiguous history ordering).
    pub warnings: Vec<String>,
    /// Whether the merge changed anything (so the frontend knows to save).
    pub changed: bool,
    /// The vault's fingerprint after the merge.
    pub fingerprint: VaultFingerprint,
}

/// Cheap, non-cryptographic FNV-1a over a byte slice, rendered as hex. Used only
/// to tell "same vault state" from "different vault state" for the UI; it is not
/// a security primitive.
fn fnv1a_hex(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// Compute a fingerprint of the open database. The checksum folds in each
/// entry's UUID and last-modification time so any divergence is detectable.
pub fn fingerprint(db: &Database) -> VaultFingerprint {
    let mut latest: Option<i64> = None;
    let mut digest_input: Vec<u8> = Vec::new();

    // Stable, order-independent material: collect (uuid, modified) and sort.
    let mut rows: Vec<(String, i64)> = Vec::new();
    // Walk every entry in the database via the group tree.
    fn walk(db: &Database, gid: keepass::db::GroupId, rows: &mut Vec<(String, i64)>) {
        if let Some(group) = db.group(gid) {
            for eid in group.entry_ids() {
                if let Some(e) = db.entry(eid) {
                    let m = e
                        .times
                        .last_modification
                        .map(|d| d.and_utc().timestamp_millis())
                        .unwrap_or(0);
                    rows.push((eid.uuid().to_string(), m));
                }
            }
            let child_ids: Vec<_> = group.group_ids().collect();
            for cid in child_ids {
                walk(db, cid, rows);
            }
        }
    }
    walk(db, db.root().id(), &mut rows);
    rows.sort();

    for (uuid, modified) in &rows {
        digest_input.extend_from_slice(uuid.as_bytes());
        digest_input.extend_from_slice(&modified.to_le_bytes());
        if *modified > 0 {
            latest = Some(latest.map_or(*modified, |cur| cur.max(*modified)));
        }
    }

    VaultFingerprint {
        name: db.meta.database_name.clone(),
        entry_count: db.num_entries(),
        group_count: db.num_groups().saturating_sub(1),
        latest_modified: latest,
        checksum: fnv1a_hex(&digest_input),
    }
}

/// Serialize the open database to encrypted KDBX bytes with the session key, for
/// transfer to a peer.
///
/// The bytes are emitted with the **Argon2d** KDF rather than Argon2id when the
/// vault uses Argon2id: Argon2id's KDF UUID is rejected as "bad KDF" by older
/// KeePass / `kdbxweb` builds (e.g. the mobile app), while Argon2d is recognized
/// by every implementation and is equally strong. This only affects the copy
/// sent over the wire — the local on-disk vault keeps whatever KDF the user
/// chose. (keepass-rs always writes KDBX 4.1, which is broadly compatible; only
/// the KDF needs adapting for older readers.)
pub fn export_snapshot(db: &Database, key: DatabaseKey) -> AppResult<SyncSnapshot> {
    let fingerprint = fingerprint(db);
    let mut export_db = db.clone();

    // Normalize the KDF to **Argon2d** for maximum reader compatibility. Two
    // incompatibilities are fixed here, both of which surface on the peer as a
    // generic "bad KDF":
    //   • Argon2id's UUID is rejected by older KeePass / `kdbxweb` builds.
    //   • keepass-rs writes a non-standard KDBX4 AES-KDF UUID (7c02bb82…) that
    //     `kdbxweb` / the mobile app don't recognize at all.
    // Argon2d (UUID ef636ddf…) is recognized by every implementation. The local
    // on-disk vault keeps whatever KDF the user chose — only the wire copy
    // changes. Argon2d vaults pass through unchanged.
    export_db.config.kdf_config = match export_db.config.kdf_config {
        // Already Argon2d — keep as-is.
        KdfConfig::Argon2 {
            iterations,
            memory,
            parallelism,
            version,
        } => KdfConfig::Argon2 {
            iterations,
            memory,
            parallelism,
            version,
        },
        // Argon2id → Argon2d, preserving the cost parameters.
        KdfConfig::Argon2id {
            iterations,
            memory,
            parallelism,
            version,
        } => KdfConfig::Argon2 {
            iterations,
            memory,
            parallelism,
            version,
        },
        // AES-KDF (or any other variant) → Argon2d with ~1s-unlock defaults
        // (64 MiB, 10 passes, parallelism 4).
        _ => KdfConfig::Argon2 {
            iterations: 10,
            memory: 64 * 1024,
            parallelism: 4,
            version: argon2::Version::Version13,
        },
    };

    // Cipher: Twofish → AES-256. `kdbxweb` (and thus the mobile app) only
    // supports AES-256 and ChaCha20, so a Twofish vault would be unreadable.
    // AES-256 and ChaCha20 are passed through unchanged.
    if matches!(export_db.config.outer_cipher_config, OuterCipherConfig::Twofish) {
        export_db.config.outer_cipher_config = OuterCipherConfig::AES256;
    }

    let bytes = crypto::serialize_database(&export_db, key)?;
    Ok(SyncSnapshot { fingerprint, bytes })
}

/// Parse a received snapshot. Tries the current session key first (the common
/// case: the user's own devices share one master password); if that fails and a
/// password was supplied, falls back to a key built from it.
fn open_remote(
    bytes: &[u8],
    session_key: DatabaseKey,
    password: Option<&str>,
) -> AppResult<Database> {
    match Database::open(&mut Cursor::new(bytes), session_key) {
        Ok(db) => Ok(db),
        Err(first) => match password {
            Some(pw) => {
                let key = crypto::build_key(Some(pw), None)?;
                Database::open(&mut Cursor::new(bytes), key)
                    .map_err(|_| AppError::InvalidCredentials)
            }
            // No fallback password and the shared key didn't fit: most likely the
            // peer's vault uses a different master password.
            None => Err(AppError::Crypto(format!(
                "could not decrypt the peer's vault with the current key: {first}. \
                 The peer may use a different master password."
            ))),
        },
    }
}

/// Make a remote entry strictly newer than the local one so a merge tie resolves
/// in the remote's favour (the user pushed it, so it should win).
fn break_entry_tie(remote: &mut Database, base: &Database, eid: keepass::db::EntryId) {
    let local_t = base.entry(eid).and_then(|e| e.times.last_modification);
    if let Some(mut e) = remote.entry_mut(eid) {
        let cur = e.times.last_modification;
        let floor = [local_t, cur].into_iter().flatten().max();
        let next = floor
            .map(|t| t + chrono::Duration::seconds(1))
            .unwrap_or_else(keepass::db::Times::now);
        e.times.last_modification = Some(next);
    }
}

/// As [`break_entry_tie`], for a group.
fn break_group_tie(remote: &mut Database, base: &Database, gid: keepass::db::GroupId) {
    let local_t = base.group(gid).and_then(|g| g.times.last_modification);
    if let Some(mut g) = remote.group_mut(gid) {
        let cur = g.times.last_modification;
        let floor = [local_t, cur].into_iter().flatten().max();
        let next = floor
            .map(|t| t + chrono::Duration::seconds(1))
            .unwrap_or_else(keepass::db::Times::now);
        g.times.last_modification = Some(next);
    }
}

/// Merge a received encrypted snapshot into `local`, resolving conflicts via the
/// KeePass merge algorithm (newer-modification-wins, history-preserving).
///
/// KeePass's merge refuses to choose when an entry/group exists on both sides
/// with the **same** modification time but diverged contents (a peer edited it
/// without advancing the timestamp). Rather than abort the whole sync, we break
/// such ties in favour of the **incoming** copy (the user pushed it) by nudging
/// its timestamp one second past the local one, then retry. Each tie is resolved
/// once, so the loop is bounded by the number of conflicting objects.
pub fn merge_snapshot(
    local: &mut Database,
    session_key: DatabaseKey,
    bytes: &[u8],
    password: Option<&str>,
) -> AppResult<MergeResult> {
    use keepass::db::merge::{MergeError, MergeEventType};

    // Merge into a throwaway clone each attempt: a failed merge can leave the
    // destination partially mutated, so we only commit a clean result.
    let base = local.clone();
    let mut remote = open_remote(bytes, session_key, password)?;

    let mut guard = 0usize;
    let (merged, log) = loop {
        guard += 1;
        if guard > 10_000 {
            return Err(AppError::Crypto(
                "merge aborted: too many conflicting objects".into(),
            ));
        }
        let mut candidate = base.clone();
        match candidate.merge(&remote) {
            Ok(log) => break (candidate, log),
            Err(MergeError::EntryModificationTimeNotUpdated(eid)) => {
                break_entry_tie(&mut remote, &base, eid);
            }
            Err(MergeError::GroupModificationTimeNotUpdated(gid)) => {
                break_group_tie(&mut remote, &base, gid);
            }
            Err(e) => return Err(AppError::Crypto(format!("merge failed: {e}"))),
        }
    };

    let mut result = MergeResult::default();
    for event in &log.events {
        match event.event_type {
            MergeEventType::Created => result.created += 1,
            MergeEventType::Updated => result.updated += 1,
            MergeEventType::LocationUpdated => result.location_updated += 1,
            MergeEventType::Deleted => result.deleted += 1,
            // `MergeEventType` is `#[non_exhaustive]`; ignore future kinds.
            _ => {}
        }
    }
    result.warnings = log.warnings.clone();
    result.changed = !log.events.is_empty();
    result.fingerprint = fingerprint(&merged);
    *local = merged;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use keepass::db::fields;

    fn fast_db(name: &str) -> Database {
        crypto::create_database(
            name,
            &crypto::CreateOptions {
                kdf: "argon2id".into(),
                cipher: "aes256".into(),
                kdf_memory_mib: 8,
                kdf_iterations: 1,
                kdf_parallelism: 1,
                aes_rounds: 1000,
                compression: "gzip".into(),
            },
        )
    }

    fn key() -> DatabaseKey {
        crypto::build_key(Some("shared-master-pw"), None).unwrap()
    }

    #[test]
    fn fingerprint_changes_when_an_entry_is_added() {
        let mut db = fast_db("Vault");
        let fp1 = fingerprint(&db);

        let gid = db.root().id();
        db.group_mut(gid)
            .unwrap()
            .add_entry()
            .edit(|e| e.set_unprotected(fields::TITLE, "New"));
        let fp2 = fingerprint(&db);

        assert_ne!(fp1.checksum, fp2.checksum);
        assert_eq!(fp2.entry_count, fp1.entry_count + 1);
    }

    #[test]
    fn merge_pulls_in_a_remote_only_entry() {
        // local: empty starter vault. remote: same vault + one extra entry.
        let mut local = fast_db("Vault");
        let mut remote = local.clone();
        let gid = remote.root().id();
        remote
            .group_mut(gid)
            .unwrap()
            .add_entry()
            .edit(|e| e.set_unprotected(fields::TITLE, "Remote Entry"));

        let bytes = crypto::serialize_database(&remote, key()).unwrap();
        let before = local.num_entries();
        let result = merge_snapshot(&mut local, key(), &bytes, None).unwrap();

        assert!(result.changed);
        assert_eq!(result.created, 1);
        assert_eq!(local.num_entries(), before + 1);
    }

    #[test]
    fn merge_of_identical_vault_is_a_noop() {
        let mut local = fast_db("Vault");
        let remote = local.clone();
        let bytes = crypto::serialize_database(&remote, key()).unwrap();

        let result = merge_snapshot(&mut local, key(), &bytes, None).unwrap();
        assert!(!result.changed);
        assert_eq!(result.created, 0);
        assert_eq!(result.updated, 0);
    }

    #[test]
    fn wrong_password_snapshot_is_rejected() {
        let mut local = fast_db("Vault");
        let remote = fast_db("Vault");
        // Serialize the remote under a DIFFERENT master password.
        let other_key = crypto::build_key(Some("different-pw"), None).unwrap();
        let bytes = crypto::serialize_database(&remote, other_key).unwrap();

        // No fallback password supplied → decryption with the session key fails.
        let err = merge_snapshot(&mut local, key(), &bytes, None).unwrap_err();
        assert!(matches!(err, AppError::Crypto(_)));
    }

    #[test]
    fn export_downgrades_argon2id_to_argon2d_for_the_wire() {
        // A default vault is Argon2id; the exported bytes must parse as Argon2d
        // so older readers (mobile / old kdbxweb) accept the KDF.
        let db = fast_db("Vault"); // argon2id
        assert!(matches!(db.config.kdf_config, KdfConfig::Argon2id { .. }));

        let snap = export_snapshot(&db, key()).unwrap();
        let reopened = Database::open(&mut Cursor::new(&snap.bytes), key()).unwrap();
        assert!(
            matches!(reopened.config.kdf_config, KdfConfig::Argon2 { .. }),
            "exported snapshot should use Argon2d, got {:?}",
            reopened.config.kdf_config
        );
        // The local vault is untouched.
        assert!(matches!(db.config.kdf_config, KdfConfig::Argon2id { .. }));
    }

    #[test]
    fn export_converts_aes_kdf_to_argon2d() {
        // keepass-rs writes a non-standard KDBX4 AES-KDF UUID that other readers
        // reject; the exported snapshot must use Argon2d instead.
        let opts = crypto::CreateOptions {
            kdf: "aes".into(),
            cipher: "aes256".into(),
            kdf_memory_mib: 64,
            kdf_iterations: 10,
            kdf_parallelism: 4,
            aes_rounds: 30_000,
            compression: "gzip".into(),
        };
        let db = crypto::create_database("Vault", &opts);
        assert!(matches!(db.config.kdf_config, KdfConfig::Aes { .. }));

        let snap = export_snapshot(&db, key()).unwrap();
        let reopened = Database::open(&mut Cursor::new(&snap.bytes), key()).unwrap();
        assert!(matches!(reopened.config.kdf_config, KdfConfig::Argon2 { .. }));
        // Local vault still AES-KDF.
        assert!(matches!(db.config.kdf_config, KdfConfig::Aes { .. }));
    }

    #[test]
    fn merge_breaks_same_mtime_divergence_in_favor_of_remote() {
        // Fixed whole-second timestamp so the serialize round-trip preserves it
        // exactly and both sides genuinely tie.
        let fixed = chrono::DateTime::from_timestamp(1_700_000_000, 0)
            .unwrap()
            .naive_utc();

        let mut local = fast_db("Vault");
        let gid = local.root().id();
        let eid = local
            .group_mut(gid)
            .unwrap()
            .add_entry()
            .edit(|e| e.set_unprotected(fields::TITLE, "Local"))
            .id();
        {
            let mut e = local.entry_mut(eid).unwrap();
            e.times.last_modification = Some(fixed);
        }

        // Remote: same entry UUID + same mtime, but diverged content.
        let mut remote = local.clone();
        {
            let mut e = remote.entry_mut(eid).unwrap();
            e.set_unprotected(fields::TITLE, "Remote");
            e.times.last_modification = Some(fixed);
        }

        let bytes = crypto::serialize_database(&remote, key()).unwrap();

        // Without tie-breaking this returns Err; with it, the remote wins.
        let result = merge_snapshot(&mut local, key(), &bytes, None).unwrap();
        assert!(result.changed);
        assert_eq!(local.entry(eid).unwrap().get(fields::TITLE), Some("Remote"));
    }
}
