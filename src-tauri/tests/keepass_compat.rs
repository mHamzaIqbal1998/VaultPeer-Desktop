//! KeePass compatibility tests (Phase 10).
//!
//! Verify that databases created by VaultPeerDesktop can be opened by the
//! keepass crate with different KDF/cipher combinations, and that metadata
//! round-trips correctly.

use keepass::{Database, DatabaseKey};
use std::io::Cursor;

/// A minimal helper to create a keepass `DatabaseKey` from a password.
fn key(pw: &str) -> DatabaseKey {
    DatabaseKey::new().with_password(pw)
}

/// Verify AES-256 + Argon2d databases round-trip.
#[test]
fn aes256_argon2d_roundtrip() {
    let mut db = Database::new(Default::default());
    db.meta.database_name = Some("TestAES256".into());
    db.config.outer_cipher_config =
        keepass::config::OuterCipherConfig::AES256;
    db.config.kdf_config = keepass::config::KdfConfig::Argon2 {
        iterations: 1,
        memory: 1024 * 1024,
        parallelism: 1,
        version: argon2::Version::Version13,
    };
    let mut buf = Vec::new();
    db.save(&mut buf, key("test123")).expect("save");
    let opened = Database::open(&mut Cursor::new(buf), key("test123"));
    assert!(opened.is_ok());
    assert_eq!(
        opened.unwrap().meta.database_name.as_deref(),
        Some("TestAES256")
    );
}

/// Verify ChaCha20 + Argon2id databases round-trip.
#[test]
fn chacha20_argon2id_roundtrip() {
    let mut db = Database::new(Default::default());
    db.meta.database_name = Some("TestChaCha".into());
    db.config.outer_cipher_config =
        keepass::config::OuterCipherConfig::ChaCha20;
    db.config.kdf_config = keepass::config::KdfConfig::Argon2Id {
        iterations: 1,
        memory: 1024 * 1024,
        parallelism: 1,
        version: argon2::Version::Version13,
    };
    let mut buf = Vec::new();
    db.save(&mut buf, key("test123")).expect("save");
    let opened = Database::open(&mut Cursor::new(buf), key("test123"));
    assert!(opened.is_ok());
    assert_eq!(
        opened.unwrap().meta.database_name.as_deref(),
        Some("TestChaCha")
    );
}

/// Wrong password must fail to open.
#[test]
fn wrong_password_fails() {
    let mut db = Database::new(Default::default());
    db.meta.database_name = Some("WrongPW".into());
    let mut buf = Vec::new();
    db.save(&mut buf, key("correct")).expect("save");
    let result = Database::open(&mut Cursor::new(buf), key("wrong"));
    assert!(result.is_err());
}

/// Entry data persists across save/open cycle.
#[test]
fn entry_data_persists() {
    let mut db = Database::new(Default::default());
    {
        let root = &mut db.root;
        let mut entry = keepass::db::Entry::new();
        entry
            .fields
            .insert("Title".into(), keepass::db::Value::Unprotected("MyLogin".into()));
        entry
            .fields
            .insert("UserName".into(), keepass::db::Value::Unprotected("user@example.com".into()));
        entry
            .fields
            .insert("Password".into(), keepass::db::Value::Protected("s3cret".as_bytes().into()));
        root.add_child(keepass::db::NodeRef::Entry(entry));
    }

    let mut buf = Vec::new();
    db.save(&mut buf, key("pw")).expect("save");
    let opened = Database::open(&mut Cursor::new(buf), key("pw")).expect("open");
    let entries: Vec<_> = opened.root.children.iter().filter_map(|n| match n {
        keepass::db::Node::Entry(e) => Some(e),
        _ => None,
    }).collect();
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].get_title().unwrap_or_default(),
        "MyLogin"
    );
    assert_eq!(
        entries[0].get("UserName").map(|v| v.to_string()),
        Some("user@example.com".into())
    );
}

/// Groups round-trip with their names.
#[test]
fn group_hierarchy_roundtrip() {
    let mut db = Database::new(Default::default());
    {
        let mut child = keepass::db::Group::new("WorkGroup");
        let mut subchild = keepass::db::Group::new("SubGroup");
        subchild.name = "SubGroup".into();
        child.add_child(keepass::db::NodeRef::Group(subchild));
        db.root.add_child(keepass::db::NodeRef::Group(child));
    }

    let mut buf = Vec::new();
    db.save(&mut buf, key("pw")).expect("save");
    let opened = Database::open(&mut Cursor::new(buf), key("pw")).expect("open");

    fn find_group<'a>(node: &'a keepass::db::Group, name: &str) -> Option<&'a keepass::db::Group> {
        for child in &node.children {
            if let keepass::db::Node::Group(g) = child {
                if g.name == name {
                    return Some(g);
                }
                if let Some(found) = find_group(g, name) {
                    return Some(found);
                }
            }
        }
        None
    }

    assert!(find_group(&opened.root, "WorkGroup").is_some());
    assert!(find_group(&opened.root, "SubGroup").is_some());
}
