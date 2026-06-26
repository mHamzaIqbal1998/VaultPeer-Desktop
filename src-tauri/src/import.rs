//! Data import (PLAN Phase 9 / PRD IMP-01, IMP-02).
//!
//! Two import paths:
//!   • **CSV** from other password managers (1Password, LastPass, Bitwarden, or
//!     any generic header row). The file is parsed (RFC 4180), the source format
//!     guessed from its header row, and each column mapped onto a VaultPeer entry
//!     field. The mapping is surfaced to the frontend so the user can correct it
//!     before committing, and a preview flags rows that duplicate an existing
//!     entry (IMP: "Import preview with duplicate detection" / "Field mapping").
//!   • **KDBX** — merged into the open database with the KeePass-compatible
//!     three-way merge (shared with P2P sync), so importing another vault is
//!     non-destructive and history-preserving.
//!
//! Pure and Tauri-free, so the parsing/mapping/duplicate logic is unit-testable.

use std::io::Cursor;

use keepass::{db::fields, Database, DatabaseKey};
use serde::{Deserialize, Serialize};

use crate::crypto;
use crate::database::{self, is_in_recycle_bin, EntryInput};
use crate::error::{AppError, AppResult};
use crate::sync::{self, MergeResult};

// ── CSV parsing (RFC 4180) ────────────────────────────────────────────────────

/// Parse RFC 4180 CSV text into rows of fields. Handles quoted fields containing
/// commas, quotes (doubled), and CR/LF line breaks. The first row is the header.
pub fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();

    while let Some(c) = chars.next() {
        if in_quotes {
            match c {
                '"' => {
                    if chars.peek() == Some(&'"') {
                        field.push('"');
                        chars.next();
                    } else {
                        in_quotes = false;
                    }
                }
                _ => field.push(c),
            }
        } else {
            match c {
                '"' => in_quotes = true,
                ',' => {
                    row.push(std::mem::take(&mut field));
                }
                '\r' => {
                    // Swallow a following \n so CRLF is one break.
                    if chars.peek() == Some(&'\n') {
                        chars.next();
                    }
                    row.push(std::mem::take(&mut field));
                    rows.push(std::mem::take(&mut row));
                }
                '\n' => {
                    row.push(std::mem::take(&mut field));
                    rows.push(std::mem::take(&mut row));
                }
                _ => field.push(c),
            }
        }
    }
    // Flush the trailing field/row if the file doesn't end with a newline.
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    // Drop fully-blank rows (e.g. a trailing empty line).
    rows.retain(|r| !(r.len() == 1 && r[0].trim().is_empty()));
    rows
}

// ── Column mapping ─────────────────────────────────────────────────────────────

/// Which CSV column index feeds each VaultPeer entry field. `None` means the
/// field is left empty. Serialized camelCase as `number | null` for the frontend.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ColumnMapping {
    pub title: Option<usize>,
    pub username: Option<usize>,
    pub password: Option<usize>,
    pub url: Option<usize>,
    pub notes: Option<usize>,
    pub otp: Option<usize>,
    pub tags: Option<usize>,
}

/// Header-name aliases per field, lowercased. The first column whose (trimmed,
/// lowercased) header matches one of these — or contains it as a word — wins.
const TITLE_ALIASES: &[&str] = &["title", "name", "account", "account name", "item"];
const USERNAME_ALIASES: &[&str] =
    &["username", "user name", "login", "login_username", "user", "email", "e-mail", "login name"];
const PASSWORD_ALIASES: &[&str] = &["password", "login_password", "pass", "pwd"];
const URL_ALIASES: &[&str] =
    &["url", "login_uri", "website", "web site", "uri", "login_url", "link", "site"];
const NOTES_ALIASES: &[&str] = &["notes", "note", "comments", "comment", "extra", "additional"];
const OTP_ALIASES: &[&str] = &[
    "otp",
    "otpauth",
    "totp",
    "login_totp",
    "one-time password",
    "onetimepassword",
    "two-factor",
    "2fa",
];
const TAGS_ALIASES: &[&str] = &["tags", "tag", "grouping", "folder", "category", "group", "type"];

/// A recognized source-format label, for display only — the actual mapping is
/// always header-driven so even an unrecognized export still imports.
fn detect_format(headers: &[String]) -> String {
    let lc: Vec<String> = headers.iter().map(|h| h.trim().to_lowercase()).collect();
    let has = |name: &str| lc.iter().any(|h| h == name);

    if has("login_uri") || has("login_password") || has("login_username") {
        "Bitwarden".to_string()
    } else if has("grouping") && has("extra") && has("name") {
        "LastPass".to_string()
    } else if has("otpauth") || (has("title") && has("url") && has("password")) {
        "1Password".to_string()
    } else {
        "Generic".to_string()
    }
}

/// Find the best column index for a field given its header aliases. Prefers an
/// exact header match, then a header that contains an alias as a substring.
fn match_column(headers_lc: &[String], aliases: &[&str], used: &[Option<usize>]) -> Option<usize> {
    let is_free = |i: usize| !used.contains(&Some(i));

    // Exact match first.
    for alias in aliases {
        if let Some(i) = headers_lc.iter().position(|h| h == alias) {
            if is_free(i) {
                return Some(i);
            }
        }
    }
    // Then substring (e.g. "Login URL" contains "url").
    for alias in aliases {
        if let Some(i) = headers_lc.iter().position(|h| h.contains(alias)) {
            if is_free(i) {
                return Some(i);
            }
        }
    }
    None
}

/// Derive a sensible default column mapping from a header row. Each column is
/// assigned to at most one field, in priority order.
pub fn default_mapping(headers: &[String]) -> ColumnMapping {
    let lc: Vec<String> = headers.iter().map(|h| h.trim().to_lowercase()).collect();
    let mut m = ColumnMapping::default();
    // Order matters: claim the most specific fields first so e.g. a "login_uri"
    // column isn't grabbed by "username" via a loose substring. Each step passes
    // the already-claimed columns so they aren't reused.
    m.password = match_column(&lc, PASSWORD_ALIASES, &[m.title, m.username, m.url, m.notes, m.otp, m.tags]);
    m.url = match_column(&lc, URL_ALIASES, &[m.title, m.username, m.password, m.notes, m.otp, m.tags]);
    m.otp = match_column(&lc, OTP_ALIASES, &[m.title, m.username, m.password, m.url, m.notes, m.tags]);
    m.username = match_column(&lc, USERNAME_ALIASES, &[m.title, m.password, m.url, m.notes, m.otp, m.tags]);
    m.title = match_column(&lc, TITLE_ALIASES, &[m.username, m.password, m.url, m.notes, m.otp, m.tags]);
    m.notes = match_column(&lc, NOTES_ALIASES, &[m.title, m.username, m.password, m.url, m.otp, m.tags]);
    m.tags = match_column(&lc, TAGS_ALIASES, &[m.title, m.username, m.password, m.url, m.notes, m.otp]);
    m
}

// ── Preview & candidates ────────────────────────────────────────────────────────

/// One importable entry resolved from a CSV row via the active mapping, with a
/// flag indicating it duplicates an entry already in the database.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCandidate {
    pub title: String,
    pub username: String,
    pub password: String,
    pub url: String,
    pub notes: String,
    pub otp: String,
    pub tags: Vec<String>,
    /// True if an existing entry has the same title + username + URL.
    pub duplicate: bool,
}

/// The result of analysing a CSV file: the detected format, headers, the
/// suggested mapping, and the candidate rows it produces under that mapping.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvPreview {
    pub format: String,
    pub headers: Vec<String>,
    pub mapping: ColumnMapping,
    pub candidates: Vec<ImportCandidate>,
    pub total: usize,
    pub duplicate_count: usize,
}

/// Outcome of committing an import.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: usize,
    pub skipped: usize,
}

fn cell(row: &[String], idx: Option<usize>) -> String {
    idx.and_then(|i| row.get(i)).map(|s| s.trim().to_string()).unwrap_or_default()
}

/// Split a tags cell into individual tags (comma or semicolon separated). A
/// folder path like "Work/Email" is kept as a single tag.
fn split_tags(cell: &str) -> Vec<String> {
    cell.split([',', ';'])
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect()
}

/// A normalized key for duplicate detection: title + username + URL, lowercased.
fn dup_key(title: &str, username: &str, url: &str) -> String {
    format!(
        "{}\u{0}{}\u{0}{}",
        title.trim().to_lowercase(),
        username.trim().to_lowercase(),
        url.trim().to_lowercase()
    )
}

/// Collect duplicate keys for every existing entry outside the recycle bin.
fn existing_keys(db: &Database) -> std::collections::HashSet<String> {
    db.iter_all_entries()
        .filter(|e| !is_in_recycle_bin(db, e.parent().id()))
        .map(|e| {
            dup_key(
                e.get(fields::TITLE).unwrap_or_default(),
                e.get(fields::USERNAME).unwrap_or_default(),
                e.get(fields::URL).unwrap_or_default(),
            )
        })
        .collect()
}

/// Build candidates from parsed CSV rows under a mapping, flagging duplicates
/// against the existing database. The first row is treated as the header.
fn candidates_from(
    db: &Database,
    rows: &[Vec<String>],
    mapping: &ColumnMapping,
) -> Vec<ImportCandidate> {
    let existing = existing_keys(db);
    rows.iter()
        .skip(1) // header
        .map(|row| {
            let title = cell(row, mapping.title);
            let username = cell(row, mapping.username);
            let url = cell(row, mapping.url);
            let duplicate = existing.contains(&dup_key(&title, &username, &url));
            ImportCandidate {
                title,
                username,
                password: cell(row, mapping.password),
                url,
                notes: cell(row, mapping.notes),
                otp: cell(row, mapping.otp),
                tags: split_tags(&cell(row, mapping.tags)),
                duplicate,
            }
        })
        // Skip rows that are entirely empty across mapped fields.
        .filter(|c| {
            !(c.title.is_empty()
                && c.username.is_empty()
                && c.password.is_empty()
                && c.url.is_empty()
                && c.notes.is_empty()
                && c.otp.is_empty())
        })
        .collect()
}

/// Analyse CSV text against the open database. When `mapping` is `None` a default
/// mapping is derived from the header row; otherwise the supplied one is used so
/// the preview reflects the user's adjustments.
pub fn preview_csv(db: &Database, text: &str, mapping: Option<ColumnMapping>) -> AppResult<CsvPreview> {
    let rows = parse_csv(text);
    let headers = rows
        .first()
        .cloned()
        .ok_or_else(|| AppError::InvalidOperation("the CSV file is empty".into()))?;
    let format = detect_format(&headers);
    let mapping = mapping.unwrap_or_else(|| default_mapping(&headers));
    let candidates = candidates_from(db, &rows, &mapping);
    let duplicate_count = candidates.iter().filter(|c| c.duplicate).count();
    let total = candidates.len();
    Ok(CsvPreview {
        format,
        headers,
        mapping,
        candidates,
        total,
        duplicate_count,
    })
}

/// Import CSV rows into `group_uuid` under `mapping`. When `skip_duplicates` is
/// set, rows that match an existing entry (title+username+URL) are not created.
pub fn import_csv(
    db: &mut Database,
    text: &str,
    mapping: &ColumnMapping,
    group_uuid: &str,
    skip_duplicates: bool,
) -> AppResult<ImportReport> {
    let rows = parse_csv(text);
    let candidates = candidates_from(db, &rows, mapping);

    let mut report = ImportReport::default();
    for c in candidates {
        if skip_duplicates && c.duplicate {
            report.skipped += 1;
            continue;
        }
        let input = EntryInput {
            title: c.title,
            username: c.username,
            password: c.password,
            url: c.url,
            notes: c.notes,
            otp: c.otp,
            tags: c.tags,
            ..Default::default()
        };
        database::create_entry(db, group_uuid, &input)?;
        report.imported += 1;
    }
    Ok(report)
}

// ── KDBX import (merge) ──────────────────────────────────────────────────────

/// Open a KDBX file from bytes with the given password/key-file, mapping a
/// wrong-credentials failure to [`AppError::InvalidCredentials`].
fn open_kdbx(bytes: &[u8], password: Option<&str>, key_file: Option<&str>) -> AppResult<Database> {
    let key: DatabaseKey = crypto::build_key(password, key_file)?;
    Database::open(&mut Cursor::new(bytes), key).map_err(|_| AppError::InvalidCredentials)
}

/// Preview a KDBX import by running the merge against a *clone* of the open
/// database, so the counts (created/updated/…) are reported without mutating the
/// live vault.
pub fn preview_kdbx(
    local: &Database,
    bytes: &[u8],
    password: Option<&str>,
    key_file: Option<&str>,
) -> AppResult<MergeResult> {
    let remote = open_kdbx(bytes, password, key_file)?;
    let mut clone = local.clone();
    sync::merge_database(&mut clone, remote)
}

/// Import a KDBX file by merging it into the open database (newer-wins,
/// history-preserving). The caller persists the result via a normal save.
pub fn import_kdbx(
    local: &mut Database,
    bytes: &[u8],
    password: Option<&str>,
    key_file: Option<&str>,
) -> AppResult<MergeResult> {
    let remote = open_kdbx(bytes, password, key_file)?;
    sync::merge_database(local, remote)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db_with(title: &str, username: &str, url: &str) -> (Database, String) {
        let mut db = Database::new();
        let gid = db
            .root_mut()
            .add_group()
            .edit(|g| g.name = "Imported".into())
            .id();
        let gid = gid.uuid().to_string();
        let input = EntryInput {
            title: title.into(),
            username: username.into(),
            url: url.into(),
            ..Default::default()
        };
        database::create_entry(&mut db, &gid, &input).unwrap();
        (db, gid)
    }

    #[test]
    fn csv_parser_handles_quotes_and_newlines() {
        let text = "Title,Notes\r\n\"Acme, Inc\",\"line1\nline2\"\r\n\"She said \"\"hi\"\"\",x\n";
        let rows = parse_csv(text);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0], vec!["Title", "Notes"]);
        assert_eq!(rows[1], vec!["Acme, Inc", "line1\nline2"]);
        assert_eq!(rows[2], vec!["She said \"hi\"", "x"]);
    }

    #[test]
    fn detects_known_formats() {
        assert_eq!(
            detect_format(&svec(&["folder", "name", "login_uri", "login_username", "login_password"])),
            "Bitwarden"
        );
        assert_eq!(
            detect_format(&svec(&["url", "username", "password", "extra", "name", "grouping"])),
            "LastPass"
        );
        assert_eq!(
            detect_format(&svec(&["Title", "Url", "Username", "Password", "OTPAuth"])),
            "1Password"
        );
        assert_eq!(detect_format(&svec(&["foo", "bar"])), "Generic");
    }

    #[test]
    fn default_mapping_maps_common_headers() {
        let m = default_mapping(&svec(&["name", "login_uri", "login_username", "login_password", "notes"]));
        assert_eq!(m.title, Some(0));
        assert_eq!(m.url, Some(1));
        assert_eq!(m.username, Some(2));
        assert_eq!(m.password, Some(3));
        assert_eq!(m.notes, Some(4));
    }

    #[test]
    fn preview_flags_duplicates() {
        let (db, _gid) = db_with("Gmail", "alex@gmail.com", "https://mail.google.com");
        let csv = "title,username,password,url\n\
                   Gmail,alex@gmail.com,secret,https://mail.google.com\n\
                   GitHub,octocat,hunter2,https://github.com\n";
        let preview = preview_csv(&db, csv, None).unwrap();
        assert_eq!(preview.total, 2);
        assert_eq!(preview.duplicate_count, 1);
        assert!(preview.candidates[0].duplicate, "Gmail row duplicates existing");
        assert!(!preview.candidates[1].duplicate);
    }

    #[test]
    fn import_csv_skips_duplicates_when_requested() {
        let (mut db, gid) = db_with("Gmail", "alex@gmail.com", "https://mail.google.com");
        let csv = "title,username,password,url\n\
                   Gmail,alex@gmail.com,secret,https://mail.google.com\n\
                   GitHub,octocat,hunter2,https://github.com\n";
        let mapping = default_mapping(&parse_csv(csv)[0]);

        let report = import_csv(&mut db, csv, &mapping, &gid, true).unwrap();
        assert_eq!(report.imported, 1, "only the non-duplicate is imported");
        assert_eq!(report.skipped, 1);

        // The imported GitHub entry now exists with its password.
        let entries = database::list_entries(&db, &gid).unwrap();
        assert!(entries.iter().any(|e| e.title == "GitHub"));
    }

    #[test]
    fn import_csv_imports_all_when_not_skipping() {
        let (mut db, gid) = db_with("Gmail", "alex@gmail.com", "https://mail.google.com");
        let csv = "title,username,password,url\n\
                   Gmail,alex@gmail.com,secret,https://mail.google.com\n";
        let mapping = default_mapping(&parse_csv(csv)[0]);
        let report = import_csv(&mut db, csv, &mapping, &gid, false).unwrap();
        assert_eq!(report.imported, 1);
        assert_eq!(report.skipped, 0);
    }

    #[test]
    fn kdbx_import_merges_remote_only_entry() {
        // Build a remote vault with one extra entry, serialize, import.
        let opts = crypto::CreateOptions {
            kdf: "argon2id".into(),
            cipher: "aes256".into(),
            kdf_memory_mib: 8,
            kdf_iterations: 1,
            kdf_parallelism: 1,
            aes_rounds: 1000,
            compression: "gzip".into(),
        };
        let mut local = crypto::create_database("Vault", &opts);
        let mut remote = local.clone();
        let gid = remote.root().id();
        remote
            .group_mut(gid)
            .unwrap()
            .add_entry()
            .edit(|e| e.set_unprotected(fields::TITLE, "Remote Only"));

        let key = crypto::build_key(Some("pw"), None).unwrap();
        let bytes = crypto::serialize_database(&remote, key).unwrap();

        let before = local.num_entries();
        let result = import_kdbx(&mut local, &bytes, Some("pw"), None).unwrap();
        assert!(result.changed);
        assert_eq!(result.created, 1);
        assert_eq!(local.num_entries(), before + 1);
    }

    #[test]
    fn kdbx_import_wrong_password_is_invalid_credentials() {
        let opts = crypto::CreateOptions {
            kdf: "argon2id".into(),
            cipher: "aes256".into(),
            kdf_memory_mib: 8,
            kdf_iterations: 1,
            kdf_parallelism: 1,
            aes_rounds: 1000,
            compression: "gzip".into(),
        };
        let mut local = crypto::create_database("Vault", &opts);
        let remote = crypto::create_database("Other", &opts);
        let bytes = crypto::serialize_database(&remote, crypto::build_key(Some("right"), None).unwrap()).unwrap();
        let err = import_kdbx(&mut local, &bytes, Some("wrong"), None).unwrap_err();
        assert!(matches!(err, AppError::InvalidCredentials));
    }

    fn svec(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }
}
