//! KDBX cryptography (PLAN Phase 2).
//!
//! Thin, testable wrappers over the [`keepass`] crate covering the three
//! operations the unlock/create flow needs: open an existing database, create a
//! new one with chosen encryption settings, and serialize a database back to
//! KDBX bytes. The actual Argon2/AES/ChaCha20 work lives in `keepass`; this
//! module's job is to translate to/from the frontend's shapes and to map the
//! crate's rich error tree onto our [`AppError`].
//!
//! None of these functions touch Tauri, so they can be unit-tested directly.

use std::fs::File;
use std::path::Path;

use keepass::{
    config::{CompressionConfig, DatabaseConfig, KdfConfig, OuterCipherConfig},
    Database, DatabaseKey,
};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Program name recorded in the database's `<Generator>` metadata field.
const GENERATOR: &str = "VaultPeerDesktop";

/// Human-facing summary of a database's configuration and contents, returned to
/// the frontend after a successful open/create (PLAN: "database metadata
/// display"). Serialized as camelCase to read naturally from TypeScript.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseMetadata {
    /// Absolute path on disk the database was opened from / created at.
    pub path: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub generator: Option<String>,
    /// Format version, e.g. `"KDBX4.1"` or `"KDBX3.1"`.
    pub version: String,
    /// Outer (file) cipher, e.g. `"AES-256"`, `"ChaCha20"`, `"Twofish"`.
    pub outer_cipher: String,
    /// Inner (protected-field) cipher, e.g. `"ChaCha20"`, `"Salsa20"`.
    pub inner_cipher: String,
    /// Compression of the inner stream, `"GZip"` or `"None"`.
    pub compression: String,
    /// KDF family, e.g. `"Argon2id"`, `"Argon2d"`, `"AES-KDF"`.
    pub kdf: String,
    /// Argon2 iterations / AES rounds (the iteration count, whatever the family).
    pub kdf_iterations: u64,
    /// Argon2 memory in KiB; `None` for AES-KDF.
    pub kdf_memory_kib: Option<u64>,
    /// Argon2 degree of parallelism; `None` for AES-KDF.
    pub kdf_parallelism: Option<u32>,
    /// Number of entries across all groups.
    pub entry_count: usize,
    /// Number of groups, excluding the implicit root group.
    pub group_count: usize,
}

/// Encryption settings chosen by the user when creating a database. All fields
/// are optional from the frontend's perspective; [`Default`] supplies sensible,
/// roughly-one-second-unlock values (PRD ENC-05 calibration lands in Phase 7).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CreateOptions {
    /// `"argon2id"` (default), `"argon2d"`, or `"aes"`.
    pub kdf: String,
    /// `"aes256"` (default), `"chacha20"`, or `"twofish"`.
    pub cipher: String,
    /// Argon2 memory budget in MiB.
    pub kdf_memory_mib: u64,
    /// Argon2 iteration count.
    pub kdf_iterations: u64,
    /// Argon2 degree of parallelism.
    pub kdf_parallelism: u32,
    /// AES-KDF transform rounds (used only when `kdf == "aes"`).
    pub aes_rounds: u64,
    /// `"gzip"` (default) or `"none"`.
    pub compression: String,
}

impl Default for CreateOptions {
    fn default() -> Self {
        Self {
            // Argon2d (not Argon2id) + AES-256 is the format every VaultPeer node
            // reads: the mobile app (kdbxweb) and the storage node all open it,
            // and it's what P2P sync normalizes to. Keeping the on-disk default
            // here means a desktop-created vault is natively cross-compatible.
            kdf: "argon2d".to_string(),
            cipher: "aes256".to_string(),
            kdf_memory_mib: 64,
            kdf_iterations: 10,
            kdf_parallelism: 4,
            aes_rounds: 100_000,
            compression: "gzip".to_string(),
        }
    }
}

/// Build a [`DatabaseKey`] from an optional password and optional key-file path.
/// At least one component must be present or the open/create will fail.
pub fn build_key(password: Option<&str>, key_file: Option<&str>) -> AppResult<DatabaseKey> {
    let mut key = DatabaseKey::new();
    if let Some(pw) = password {
        key = key.with_password(pw);
    }
    if let Some(path) = key_file {
        let mut f = File::open(Path::new(path))?;
        key = key
            .with_keyfile(&mut f)
            .map_err(|e| AppError::Crypto(format!("key file error: {e}")))?;
    }
    Ok(key)
}

/// Map a [`keepass::db::DatabaseOpenError`] onto our error type, collapsing the
/// many wrong-credential paths (KDBX3/KDBX4 HMAC mismatch, empty key, etc.) into
/// a single non-revealing [`AppError::InvalidCredentials`].
fn map_open_error(err: keepass::error::DatabaseOpenError) -> AppError {
    let msg = err.to_string();
    let lower = msg.to_lowercase();
    if lower.contains("incorrect key")
        || lower.contains("no components")
        || lower.contains("invalid keyfile")
    {
        AppError::InvalidCredentials
    } else {
        AppError::Crypto(msg)
    }
}

/// Decrypt and parse a KDBX database from disk, returning the in-memory database
/// alongside the key used (so the session can later re-save without re-prompting).
pub fn open_database(
    path: &str,
    password: Option<&str>,
    key_file: Option<&str>,
) -> AppResult<(Database, DatabaseKey)> {
    let key = build_key(password, key_file)?;
    let mut file = File::open(Path::new(path))?;
    let db = Database::open(&mut file, key.clone()).map_err(map_open_error)?;
    Ok((db, key))
}

fn outer_cipher_from(name: &str) -> OuterCipherConfig {
    match name.to_lowercase().as_str() {
        "chacha20" => OuterCipherConfig::ChaCha20,
        "twofish" => OuterCipherConfig::Twofish,
        _ => OuterCipherConfig::AES256,
    }
}

fn compression_from(name: &str) -> CompressionConfig {
    match name.to_lowercase().as_str() {
        "none" => CompressionConfig::None,
        _ => CompressionConfig::GZip,
    }
}

fn kdf_from(opts: &CreateOptions) -> KdfConfig {
    // keepass-rs stores the Argon2 `M` parameter in **bytes** (it derives the
    // argon2 `mem_cost` KiB as `memory / 1024`), and so does the KDBX spec /
    // kdbxweb. So convert MiB → bytes here. (Previously this multiplied by only
    // 1024, configuring 1024× too little memory — a "64 MiB" vault ran with 64
    // KiB, which is both weak and why mobile displayed "64 KiB".)
    let memory = opts.kdf_memory_mib.saturating_mul(1024 * 1024); // MiB -> bytes
    match opts.kdf.to_lowercase().as_str() {
        "aes" => KdfConfig::Aes {
            rounds: opts.aes_rounds,
        },
        "argon2d" => KdfConfig::Argon2 {
            iterations: opts.kdf_iterations,
            memory,
            parallelism: opts.kdf_parallelism,
            version: argon2::Version::Version13,
        },
        // Default and "argon2id" both land here.
        _ => KdfConfig::Argon2id {
            iterations: opts.kdf_iterations,
            memory,
            parallelism: opts.kdf_parallelism,
            version: argon2::Version::Version13,
        },
    }
}

/// Create a fresh in-memory KDBX4 database with the chosen name and settings.
/// The database is not written to disk here — callers serialize + persist it.
pub fn create_database(name: &str, options: &CreateOptions) -> Database {
    let mut config = DatabaseConfig::default();
    config.outer_cipher_config = outer_cipher_from(&options.cipher);
    config.compression_config = compression_from(&options.compression);
    config.kdf_config = kdf_from(options);

    let mut db = Database::with_config(config);
    db.meta.database_name = Some(name.to_string());
    db.meta.generator = Some(GENERATOR.to_string());

    // Seed a couple of starter groups so a brand-new vault isn't an empty void.
    // Entry/group management proper arrives in Phase 3.
    {
        let mut root = db.root_mut();
        root.name = name.to_string();
        root.add_group().edit(|g| g.name = "General".into());
        root.add_group().edit(|g| g.name = "Internet".into());
    }

    db
}

/// Read an open database's current encryption configuration into the
/// [`CreateOptions`] shape, so the Database Settings tab can display and edit it
/// (PLAN Phase 7). Argon2 memory is reported in MiB to match the create dialog.
pub fn current_create_options(db: &Database) -> CreateOptions {
    let mut opts = CreateOptions::default();

    match &db.config.kdf_config {
        KdfConfig::Aes { rounds } => {
            opts.kdf = "aes".into();
            opts.aes_rounds = *rounds;
        }
        KdfConfig::Argon2 {
            iterations,
            memory,
            parallelism,
            ..
        } => {
            opts.kdf = "argon2d".into();
            opts.kdf_iterations = *iterations;
            // `memory` is stored in bytes (see `kdf_from`); report MiB.
            opts.kdf_memory_mib = (*memory / (1024 * 1024)).max(1);
            opts.kdf_parallelism = *parallelism;
        }
        KdfConfig::Argon2id {
            iterations,
            memory,
            parallelism,
            ..
        } => {
            opts.kdf = "argon2id".into();
            opts.kdf_iterations = *iterations;
            opts.kdf_memory_mib = (*memory / (1024 * 1024)).max(1);
            opts.kdf_parallelism = *parallelism;
        }
        _ => {}
    }

    opts.cipher = match db.config.outer_cipher_config {
        OuterCipherConfig::ChaCha20 => "chacha20",
        OuterCipherConfig::Twofish => "twofish",
        _ => "aes256",
    }
    .into();

    opts.compression = match db.config.compression_config {
        CompressionConfig::None => "none",
        _ => "gzip",
    }
    .into();

    opts
}

/// Overwrite an open database's encryption configuration from [`CreateOptions`]
/// (PLAN Phase 7: change default KDF/cipher/compression of the current vault).
/// Fresh KDF salts and cipher IVs are generated by `keepass` at save time, so
/// re-saving after this re-encrypts the database with the new parameters.
pub fn apply_create_options(db: &mut Database, options: &CreateOptions) {
    db.config.outer_cipher_config = outer_cipher_from(&options.cipher);
    db.config.compression_config = compression_from(&options.compression);
    db.config.kdf_config = kdf_from(options);
}

/// Benchmark a single Argon2 derivation with the given memory/parallelism and
/// return the iteration count that lands closest to `target_secs` (PRD ENC-05:
/// "Calculate for 1.0s"). Measures `time_cost = 1` and scales linearly, since
/// Argon2's cost is roughly linear in the number of passes.
pub fn benchmark_kdf_iterations(
    memory_mib: u64,
    parallelism: u32,
    target_secs: f64,
    argon2id: bool,
) -> AppResult<u64> {
    let mem_cost = (memory_mib.saturating_mul(1024)).clamp(8, u32::MAX as u64) as u32;
    let config = argon2::Config {
        ad: &[],
        hash_length: 32,
        lanes: parallelism.max(1),
        mem_cost,
        secret: &[],
        thread_mode: argon2::ThreadMode::Parallel,
        time_cost: 1,
        variant: if argon2id {
            argon2::Variant::Argon2id
        } else {
            argon2::Variant::Argon2d
        },
        version: argon2::Version::Version13,
    };

    let pwd = b"vaultpeer-benchmark-password";
    let salt = b"vaultpeer-bench-salt-0123456789a"; // >= 8 bytes required

    let start = std::time::Instant::now();
    argon2::hash_raw(pwd, salt, &config)
        .map_err(|e| AppError::Crypto(format!("KDF benchmark failed: {e}")))?;
    let one_pass = start.elapsed().as_secs_f64().max(1e-6);

    let iterations = (target_secs / one_pass).round() as i64;
    Ok(iterations.clamp(1, 10_000) as u64)
}

/// Serialize a database to KDBX bytes (KDBX4 only — the only writable format in
/// `keepass`). The caller is responsible for the atomic write to disk.
pub fn serialize_database(db: &Database, key: DatabaseKey) -> AppResult<Vec<u8>> {
    let mut buffer = Vec::new();
    db.save(&mut buffer, key)
        .map_err(|e| AppError::Crypto(format!("failed to serialize database: {e}")))?;
    Ok(buffer)
}

/// Derive the frontend-facing metadata summary from an open database.
pub fn metadata_from(db: &Database, path: &str) -> DatabaseMetadata {
    let (kdf, kdf_iterations, kdf_memory_kib, kdf_parallelism) = match &db.config.kdf_config {
        KdfConfig::Aes { rounds } => ("AES-KDF".to_string(), *rounds, None, None),
        KdfConfig::Argon2 {
            iterations,
            memory,
            parallelism,
            ..
        } => (
            "Argon2d".to_string(),
            *iterations,
            // `memory` is bytes (see `kdf_from`); report KiB to match the field name.
            Some(*memory / 1024),
            Some(*parallelism),
        ),
        KdfConfig::Argon2id {
            iterations,
            memory,
            parallelism,
            ..
        } => (
            "Argon2id".to_string(),
            *iterations,
            Some(*memory / 1024),
            Some(*parallelism),
        ),
        _ => ("Unknown".to_string(), 0, None, None),
    };

    let outer_cipher = match db.config.outer_cipher_config {
        OuterCipherConfig::AES256 => "AES-256",
        OuterCipherConfig::Twofish => "Twofish",
        OuterCipherConfig::ChaCha20 => "ChaCha20",
        _ => "Unknown",
    }
    .to_string();

    let inner_cipher = match db.config.inner_cipher_config {
        keepass::config::InnerCipherConfig::Plain => "Plain",
        keepass::config::InnerCipherConfig::Salsa20 => "Salsa20",
        keepass::config::InnerCipherConfig::ChaCha20 => "ChaCha20",
        _ => "Unknown",
    }
    .to_string();

    let compression = match db.config.compression_config {
        CompressionConfig::None => "None",
        CompressionConfig::GZip => "GZip",
        _ => "Unknown",
    }
    .to_string();

    DatabaseMetadata {
        path: path.to_string(),
        name: db.meta.database_name.clone(),
        description: db.meta.database_description.clone(),
        generator: db.meta.generator.clone(),
        version: db.config.version.to_string(),
        outer_cipher,
        inner_cipher,
        compression,
        kdf,
        kdf_iterations,
        kdf_memory_kib,
        kdf_parallelism,
        entry_count: db.num_entries(),
        // `num_groups()` counts the implicit root; present the user-meaningful count.
        group_count: db.num_groups().saturating_sub(1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fast KDF settings so tests don't spend a second per save. Correctness of
    /// the crypto round-trip doesn't depend on the work factor.
    fn fast_opts(kdf: &str, cipher: &str) -> CreateOptions {
        CreateOptions {
            kdf: kdf.to_string(),
            cipher: cipher.to_string(),
            kdf_memory_mib: 8,
            kdf_iterations: 1,
            kdf_parallelism: 1,
            aes_rounds: 1000,
            compression: "gzip".to_string(),
        }
    }

    fn roundtrip(kdf: &str, cipher: &str, password: &str) -> Database {
        let db = create_database("Test Vault", &fast_opts(kdf, cipher));
        let key = build_key(Some(password), None).unwrap();
        let bytes = serialize_database(&db, key).unwrap();
        Database::open(&mut bytes.as_slice(), build_key(Some(password), None).unwrap()).unwrap()
    }

    #[test]
    fn argon2id_aes256_roundtrips() {
        let db = roundtrip("argon2id", "aes256", "correct horse");
        assert_eq!(db.meta.database_name.as_deref(), Some("Test Vault"));
        let meta = metadata_from(&db, "/tmp/x.kdbx");
        assert_eq!(meta.kdf, "Argon2id");
        assert_eq!(meta.outer_cipher, "AES-256");
    }

    #[test]
    fn argon2d_chacha20_roundtrips() {
        let db = roundtrip("argon2d", "chacha20", "hunter2");
        let meta = metadata_from(&db, "/tmp/x.kdbx");
        assert_eq!(meta.kdf, "Argon2d");
        assert_eq!(meta.outer_cipher, "ChaCha20");
    }

    #[test]
    fn aes_kdf_twofish_roundtrips() {
        let db = roundtrip("aes", "twofish", "s3cret");
        let meta = metadata_from(&db, "/tmp/x.kdbx");
        assert_eq!(meta.kdf, "AES-KDF");
        assert_eq!(meta.outer_cipher, "Twofish");
        assert_eq!(meta.kdf_memory_kib, None);
    }

    #[test]
    fn wrong_password_is_invalid_credentials() {
        let db = create_database("Vault", &fast_opts("argon2id", "aes256"));
        let bytes = serialize_database(&db, build_key(Some("right"), None).unwrap()).unwrap();
        let err = Database::open(&mut bytes.as_slice(), build_key(Some("wrong"), None).unwrap())
            .map_err(map_open_error)
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidCredentials));
    }

    #[test]
    fn open_database_reads_from_disk() {
        let dir = std::env::temp_dir().join(format!(
            "vaultpeer-crypto-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("disk.kdbx");

        let db = create_database("Disk Vault", &fast_opts("argon2id", "aes256"));
        let bytes = serialize_database(&db, build_key(Some("pw"), None).unwrap()).unwrap();
        std::fs::write(&path, &bytes).unwrap();

        let (opened, _key) = open_database(path.to_str().unwrap(), Some("pw"), None).unwrap();
        assert_eq!(opened.meta.database_name.as_deref(), Some("Disk Vault"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn keyfile_plus_password_roundtrips() {
        let db = create_database("KeyfileVault", &fast_opts("argon2id", "aes256"));

        // A 32-byte binary key file is consumed verbatim by keepass.
        let dir = std::env::temp_dir().join(format!(
            "vaultpeer-kf-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let kf = dir.join("vault.key");
        std::fs::write(&kf, vec![7u8; 32]).unwrap();
        let kf_str = kf.to_str().unwrap();

        let bytes = serialize_database(&db, build_key(Some("pw"), Some(kf_str)).unwrap()).unwrap();
        let reopened = Database::open(
            &mut bytes.as_slice(),
            build_key(Some("pw"), Some(kf_str)).unwrap(),
        );
        assert!(reopened.is_ok());

        // Wrong: password only (missing the key file) must fail.
        let pw_only = Database::open(&mut bytes.as_slice(), build_key(Some("pw"), None).unwrap())
            .map_err(map_open_error);
        assert!(matches!(pw_only, Err(AppError::InvalidCredentials)));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn argon2_memory_is_stored_in_bytes_and_reads_back_in_mib() {
        // A "64 MiB" setting must configure 64 MiB of Argon2 memory (stored as
        // bytes in the KDF dict), not 64 KiB — and must read back as 64 MiB.
        let opts = CreateOptions {
            kdf: "argon2d".into(),
            cipher: "aes256".into(),
            kdf_memory_mib: 64,
            kdf_iterations: 1,
            kdf_parallelism: 1,
            aes_rounds: 1000,
            compression: "gzip".into(),
        };
        let db = create_database("Mem", &opts);
        // Stored memory is bytes: 64 MiB = 67108864.
        match &db.config.kdf_config {
            KdfConfig::Argon2 { memory, .. } => assert_eq!(*memory, 64 * 1024 * 1024),
            other => panic!("expected Argon2d, got {other:?}"),
        }
        // Reads back as 64 MiB for the settings editor, and 65536 KiB for metadata.
        assert_eq!(current_create_options(&db).kdf_memory_mib, 64);
        assert_eq!(metadata_from(&db, "/x.kdbx").kdf_memory_kib, Some(65536));
    }

    #[test]
    fn create_seeds_starter_groups() {
        let db = create_database("Seeded", &fast_opts("argon2id", "aes256"));
        // root + General + Internet
        assert_eq!(db.num_groups(), 3);
        let meta = metadata_from(&db, "/tmp/x.kdbx");
        assert_eq!(meta.group_count, 2);
    }
}
