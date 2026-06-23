//! Emergency database export (PLAN Phase 7 / PRD UN-06).
//!
//! Produces an **unencrypted** dump of every entry — the caller must warn the
//! user before writing it to disk. Two formats are offered: CSV (spreadsheet-
//! friendly, the lingua franca of password-manager migration) and a simple XML
//! document. Entries living in the recycle bin are skipped so trashed
//! credentials aren't resurrected into a plaintext file.

use keepass::{db::fields, Database};

use crate::database::{group_name_and_path, is_in_recycle_bin};

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
}
