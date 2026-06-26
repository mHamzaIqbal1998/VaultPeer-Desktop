//! Emergency database export (PLAN Phase 7 / PRD UN-06).
//!
//! Produces an **unencrypted** dump of every entry — the caller must warn the
//! user before writing it to disk. Two formats are offered: CSV (spreadsheet-
//! friendly, the lingua franca of password-manager migration) and a simple XML
//! document. Entries living in the recycle bin are skipped so trashed
//! credentials aren't resurrected into a plaintext file.

use keepass::{db::fields, Database, DatabaseKey};
use serde::Serialize;

use crate::crypto::{self, CreateOptions};
use crate::database::{group_name_and_path, is_in_recycle_bin};
use crate::error::AppResult;

/// One exported row, already resolved to plain strings.
struct Row {
    group: String,
    title: String,
    username: String,
    password: String,
    url: String,
    notes: String,
    otp: String,
}

/// Collect exportable rows (everything outside the recycle bin).
fn rows(db: &Database) -> Vec<Row> {
    db.iter_all_entries()
        .filter(|e| !is_in_recycle_bin(db, e.parent().id()))
        .map(|e| {
            let (_name, path) = group_name_and_path(db, e.parent().id());
            Row {
                group: path,
                title: e.get(fields::TITLE).unwrap_or_default().to_string(),
                username: e.get(fields::USERNAME).unwrap_or_default().to_string(),
                password: e.get(fields::PASSWORD).unwrap_or_default().to_string(),
                url: e.get(fields::URL).unwrap_or_default().to_string(),
                notes: e.get(fields::NOTES).unwrap_or_default().to_string(),
                otp: e.get(fields::OTP).unwrap_or_default().to_string(),
            }
        })
        .collect()
}

/// Quote a single CSV field per RFC 4180: wrap in quotes when it contains a
/// comma, quote, CR or LF, doubling any embedded quotes.
fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Render the database as CSV (header row + one row per entry).
pub fn to_csv(db: &Database) -> String {
    let mut out = String::from("Group,Title,Username,Password,URL,Notes,TOTP\r\n");
    for r in rows(db) {
        let line = [
            &r.group, &r.title, &r.username, &r.password, &r.url, &r.notes, &r.otp,
        ]
        .iter()
        .map(|f| csv_field(f))
        .collect::<Vec<_>>()
        .join(",");
        out.push_str(&line);
        out.push_str("\r\n");
    }
    out
}

/// Escape the five XML predefined entities for safe element text.
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Render the database as a simple XML document.
pub fn to_xml(db: &Database) -> String {
    let mut out = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<VaultPeerExport>\n");
    for r in rows(db) {
        out.push_str("  <Entry>\n");
        for (tag, val) in [
            ("Group", &r.group),
            ("Title", &r.title),
            ("Username", &r.username),
            ("Password", &r.password),
            ("URL", &r.url),
            ("Notes", &r.notes),
            ("TOTP", &r.otp),
        ] {
            out.push_str(&format!("    <{tag}>{}</{tag}>\n", xml_escape(val)));
        }
        out.push_str("  </Entry>\n");
    }
    out.push_str("</VaultPeerExport>\n");
    out
}

// ── JSON export (PLAN Phase 9 / EXP-02) ───────────────────────────────────────

/// One custom (non-standard) field on an entry in the JSON export.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonCustomField {
    key: String,
    value: String,
    protected: bool,
}

/// One entry in the JSON export, including its group path and custom fields.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonEntry {
    group: String,
    title: String,
    username: String,
    password: String,
    url: String,
    notes: String,
    otp: String,
    tags: Vec<String>,
    custom_fields: Vec<JsonCustomField>,
}

/// The top-level JSON export document.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsonExport {
    generator: String,
    database: Option<String>,
    entry_count: usize,
    entries: Vec<JsonEntry>,
}

/// Render the database as a structured JSON document (entries with group path,
/// tags, and custom fields). Recycle-bin entries are excluded, like CSV/XML.
pub fn to_json(db: &Database) -> AppResult<String> {
    let entries: Vec<JsonEntry> = db
        .iter_all_entries()
        .filter(|e| !is_in_recycle_bin(db, e.parent().id()))
        .map(|e| {
            let (_name, path) = group_name_and_path(db, e.parent().id());
            let custom_fields = e
                .fields
                .iter()
                .filter(|(k, _)| !fields::KNOWN_FIELDS.contains(&k.as_str()) && *k != fields::OTP)
                .map(|(k, v)| JsonCustomField {
                    key: k.clone(),
                    value: v.as_str().to_string(),
                    protected: v.is_protected(),
                })
                .collect();
            JsonEntry {
                group: path,
                title: e.get(fields::TITLE).unwrap_or_default().to_string(),
                username: e.get(fields::USERNAME).unwrap_or_default().to_string(),
                password: e.get(fields::PASSWORD).unwrap_or_default().to_string(),
                url: e.get(fields::URL).unwrap_or_default().to_string(),
                notes: e.get(fields::NOTES).unwrap_or_default().to_string(),
                otp: e.get(fields::OTP).unwrap_or_default().to_string(),
                tags: e.tags.clone(),
                custom_fields,
            }
        })
        .collect();

    let doc = JsonExport {
        generator: "VaultPeerDesktop".to_string(),
        database: db.meta.database_name.clone(),
        entry_count: entries.len(),
        entries,
    };
    serde_json::to_string_pretty(&doc)
        .map_err(|e| crate::error::AppError::Other(format!("JSON export failed: {e}")))
}

// ── KDBX export with custom encryption (PLAN Phase 9 / EXP / IMP-02 round-trip) ─

/// Serialize the database to a fresh `.kdbx` using the supplied encryption
/// settings and a (possibly different) master password / key file. Used to
/// export a copy under different encryption — e.g. a stronger KDF, or a separate
/// password for sharing. The live on-disk vault is untouched.
pub fn export_kdbx(
    db: &Database,
    options: &CreateOptions,
    password: Option<&str>,
    key_file: Option<&str>,
) -> AppResult<Vec<u8>> {
    let mut export_db = db.clone();
    crypto::apply_create_options(&mut export_db, options);
    let key: DatabaseKey = crypto::build_key(password, key_file)?;
    crypto::serialize_database(&export_db, key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::create_entry;

    fn db_with_entry() -> Database {
        let mut db = Database::new();
        let gid = db
            .root_mut()
            .add_group()
            .edit(|g| g.name = "Work".into())
            .id();
        let mut input = crate::database::EntryInput::default();
        input.title = "Acme, Inc".into(); // comma forces CSV quoting
        input.username = "alex".into();
        input.password = "p@ss\"word".into(); // embedded quote
        input.url = "https://acme.example".into();
        input.notes = "line1\nline2".into(); // newline forces quoting
        create_entry(&mut db, &gid.uuid().to_string(), &input).unwrap();
        db
    }

    #[test]
    fn csv_quotes_special_characters() {
        let csv = to_csv(&db_with_entry());
        assert!(csv.starts_with("Group,Title,Username,Password,URL,Notes,TOTP\r\n"));
        // Comma-containing title is quoted; embedded quote is doubled.
        assert!(csv.contains("\"Acme, Inc\""));
        assert!(csv.contains("\"p@ss\"\"word\""));
        assert!(csv.contains("\"line1\nline2\""));
    }

    #[test]
    fn xml_escapes_entities() {
        let xml = to_xml(&db_with_entry());
        assert!(xml.contains("<Title>Acme, Inc</Title>"));
        assert!(xml.contains("<Password>p@ss&quot;word</Password>"));
        // Group path ends with the containing group's name.
        assert!(xml.contains("Work</Group>"));
    }

    #[test]
    fn recycle_bin_entries_are_excluded() {
        let mut db = db_with_entry();
        // Soft-delete the only entry into the recycle bin.
        let eid = db.iter_all_entries().next().unwrap().id().uuid().to_string();
        crate::database::delete_entry(&mut db, &eid, false).unwrap();
        let csv = to_csv(&db);
        // Header only — the trashed entry must not appear.
        assert_eq!(csv.lines().count(), 1);
    }

    #[test]
    fn json_export_is_valid_and_complete() {
        let json = to_json(&db_with_entry()).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["entryCount"], 1);
        let entry = &value["entries"][0];
        assert_eq!(entry["title"], "Acme, Inc");
        assert_eq!(entry["password"], "p@ss\"word");
        assert!(entry["group"].as_str().unwrap().ends_with("Work"));
    }

    #[test]
    fn kdbx_export_reopens_with_new_password_and_settings() {
        let db = db_with_entry();
        let opts = CreateOptions {
            kdf: "argon2d".into(),
            cipher: "chacha20".into(),
            kdf_memory_mib: 8,
            kdf_iterations: 1,
            kdf_parallelism: 1,
            aes_rounds: 1000,
            compression: "gzip".into(),
        };
        let bytes = export_kdbx(&db, &opts, Some("export-pw"), None).unwrap();
        // Reopens only with the new password, and carries the entry across.
        let reopened = keepass::Database::open(
            &mut std::io::Cursor::new(&bytes),
            crypto::build_key(Some("export-pw"), None).unwrap(),
        )
        .unwrap();
        assert_eq!(reopened.num_entries(), 1);
        assert!(matches!(
            reopened.config.outer_cipher_config,
            keepass::config::OuterCipherConfig::ChaCha20
        ));
    }
}
