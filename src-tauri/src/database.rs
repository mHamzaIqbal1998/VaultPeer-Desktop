//! Entry & group management (PLAN Phase 3).
//!
//! Pure, Tauri-free operations over an in-memory [`Database`]: read the group
//! tree, list/read entries, and create/update/delete/move entries and groups.
//! Commands in [`crate::commands`] are thin wrappers that hold the session lock
//! and delegate here, so all of this is unit-testable without a running app.
//!
//! The frontend identifies entries and groups by their KeePass UUID rendered as
//! a string; helpers here parse those back into the crate's typed identifiers and
//! map "not found" / "malformed" into a single non-revealing [`AppError::NotFound`].

use keepass::{
    db::{fields, EntryId, GroupId, Icon, Times},
    Database,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

// ── Frontend-facing shapes ──────────────────────────────────────────────────

/// A node in the group hierarchy, including its direct/total entry counts and
/// nested children. Serialized camelCase for natural TypeScript consumption.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupNode {
    pub uuid: String,
    pub name: String,
    /// KeePass built-in icon index, if one is set (custom icons are ignored here).
    pub icon: Option<usize>,
    pub notes: Option<String>,
    /// Entries directly in this group.
    pub entry_count: usize,
    /// Entries in this group and all descendants.
    pub total_entry_count: usize,
    /// True if this is the database's recycle bin group.
    pub is_recycle_bin: bool,
    pub children: Vec<GroupNode>,
}

/// The full group tree, rooted at the database's root group.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseTree {
    pub root: GroupNode,
    pub recycle_bin_uuid: Option<String>,
}

/// Compact entry representation for list/card views.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntrySummary {
    pub uuid: String,
    pub group_uuid: String,
    pub title: String,
    pub username: String,
    pub url: String,
    pub icon: Option<usize>,
    pub has_password: bool,
    pub has_otp: bool,
    pub tags: Vec<String>,
    /// Epoch milliseconds (UTC), or null if unknown.
    pub created: Option<i64>,
    pub modified: Option<i64>,
    pub expires: bool,
    pub expiry: Option<i64>,
}

/// Full entry contents for the detail view and editor.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryDetail {
    pub uuid: String,
    pub group_uuid: String,
    pub title: String,
    pub username: String,
    pub password: String,
    pub url: String,
    pub notes: String,
    pub icon: Option<usize>,
    pub tags: Vec<String>,
    pub created: Option<i64>,
    pub modified: Option<i64>,
}

/// Mutable entry fields supplied by the frontend on create/update. All string
/// fields default to empty so the editor can omit ones the user left blank.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EntryInput {
    pub title: String,
    pub username: String,
    pub password: String,
    pub url: String,
    pub notes: String,
    /// KeePass built-in icon index, or null to clear.
    pub icon: Option<usize>,
    pub tags: Vec<String>,
}

// ── Identifier parsing ──────────────────────────────────────────────────────

fn parse_uuid(kind: &str, s: &str) -> AppResult<Uuid> {
    Uuid::parse_str(s).map_err(|_| AppError::NotFound(format!("invalid {kind} id: {s}")))
}

fn parse_group_id(s: &str) -> AppResult<GroupId> {
    parse_uuid("group", s).map(GroupId::from_uuid)
}

fn parse_entry_id(s: &str) -> AppResult<EntryId> {
    parse_uuid("entry", s).map(EntryId::from_uuid)
}

fn require_group(db: &Database, id: GroupId) -> AppResult<()> {
    db.group(id)
        .map(|_| ())
        .ok_or_else(|| AppError::NotFound(format!("group {id} not found")))
}

fn require_entry(db: &Database, id: EntryId) -> AppResult<()> {
    db.entry(id)
        .map(|_| ())
        .ok_or_else(|| AppError::NotFound(format!("entry {id} not found")))
}

fn millis(dt: &Option<chrono::NaiveDateTime>) -> Option<i64> {
    dt.map(|d| d.and_utc().timestamp_millis())
}

fn builtin_icon(icon: Option<&Icon>) -> Option<usize> {
    match icon {
        Some(Icon::BuiltIn(id)) => Some(*id),
        _ => None,
    }
}

// ── Reads ───────────────────────────────────────────────────────────────────

/// Build the full group tree from the database's root group.
pub fn database_tree(db: &Database) -> DatabaseTree {
    let recycle_bin_uuid = db.recycle_bin().map(|g| g.id().uuid().to_string());
    let recycle_id = db.recycle_bin().map(|g| g.id());
    let root = build_group_node(db, db.root().id(), recycle_id);
    DatabaseTree {
        root,
        recycle_bin_uuid,
    }
}

fn build_group_node(db: &Database, id: GroupId, recycle_id: Option<GroupId>) -> GroupNode {
    let group = db
        .group(id)
        .expect("build_group_node called with a valid group id");

    let entry_count = group.entry_ids().count();

    // Children sorted by name (case-insensitive) for a stable, readable tree.
    let mut child_ids: Vec<GroupId> = group.group_ids().collect();
    child_ids.sort_by_key(|cid| {
        db.group(*cid)
            .map(|g| g.name.to_lowercase())
            .unwrap_or_default()
    });

    let children: Vec<GroupNode> = child_ids
        .into_iter()
        .map(|cid| build_group_node(db, cid, recycle_id))
        .collect();

    let total_entry_count = entry_count + children.iter().map(|c| c.total_entry_count).sum::<usize>();

    GroupNode {
        uuid: id.uuid().to_string(),
        name: group.name.clone(),
        icon: builtin_icon(group.icon()),
        notes: group.notes.clone(),
        entry_count,
        total_entry_count,
        is_recycle_bin: recycle_id == Some(id),
        children,
    }
}

/// List the entries directly contained in a group, sorted by title.
pub fn list_entries(db: &Database, group_uuid: &str) -> AppResult<Vec<EntrySummary>> {
    let gid = parse_group_id(group_uuid)?;
    let group = db
        .group(gid)
        .ok_or_else(|| AppError::NotFound(format!("group {gid} not found")))?;

    let mut entries: Vec<EntrySummary> = group
        .entry_ids()
        .filter_map(|eid| db.entry(eid).map(|e| entry_summary(&e, gid)))
        .collect();

    entries.sort_by_key(|e| e.title.to_lowercase());
    Ok(entries)
}

fn entry_summary(e: &keepass::db::EntryRef<'_>, group_id: GroupId) -> EntrySummary {
    EntrySummary {
        uuid: e.id().uuid().to_string(),
        group_uuid: group_id.uuid().to_string(),
        title: e.get(fields::TITLE).unwrap_or_default().to_string(),
        username: e.get(fields::USERNAME).unwrap_or_default().to_string(),
        url: e.get(fields::URL).unwrap_or_default().to_string(),
        icon: builtin_icon(e.icon()),
        has_password: e.get(fields::PASSWORD).is_some_and(|p| !p.is_empty()),
        has_otp: e.get(fields::OTP).is_some_and(|o| !o.is_empty()),
        tags: e.tags.clone(),
        created: millis(&e.times.creation),
        modified: millis(&e.times.last_modification),
        expires: e.times.expires.unwrap_or(false),
        expiry: millis(&e.times.expiry),
    }
}

/// Read the full contents of a single entry.
pub fn get_entry(db: &Database, entry_uuid: &str) -> AppResult<EntryDetail> {
    let eid = parse_entry_id(entry_uuid)?;
    let e = db
        .entry(eid)
        .ok_or_else(|| AppError::NotFound(format!("entry {eid} not found")))?;

    Ok(EntryDetail {
        uuid: eid.uuid().to_string(),
        group_uuid: e.parent().id().uuid().to_string(),
        title: e.get(fields::TITLE).unwrap_or_default().to_string(),
        username: e.get(fields::USERNAME).unwrap_or_default().to_string(),
        password: e.get(fields::PASSWORD).unwrap_or_default().to_string(),
        url: e.get(fields::URL).unwrap_or_default().to_string(),
        notes: e.get(fields::NOTES).unwrap_or_default().to_string(),
        icon: builtin_icon(e.icon()),
        tags: e.tags.clone(),
        created: millis(&e.times.creation),
        modified: millis(&e.times.last_modification),
    })
}

// ── Mutations ────────────────────────────────────────────────────────────────

/// Apply the standard fields from an [`EntryInput`] onto a mutable entry,
/// protecting the password and stamping the modification time.
fn apply_input(e: &mut keepass::db::EntryMut<'_>, input: &EntryInput) {
    e.set_unprotected(fields::TITLE, input.title.as_str());
    e.set_unprotected(fields::USERNAME, input.username.as_str());
    e.set_protected(fields::PASSWORD, input.password.as_str());
    e.set_unprotected(fields::URL, input.url.as_str());
    e.set_unprotected(fields::NOTES, input.notes.as_str());
    e.tags = input.tags.clone();
    match input.icon {
        Some(id) => e.set_icon_builtin(id),
        None => e.set_icon_none(),
    }
    e.times.last_modification = Some(Times::now());
}

/// Create a new entry in the given group and return its full detail.
pub fn create_entry(
    db: &mut Database,
    group_uuid: &str,
    input: &EntryInput,
) -> AppResult<EntryDetail> {
    let gid = parse_group_id(group_uuid)?;
    require_group(db, gid)?;

    let id = {
        let mut group = db.group_mut(gid).expect("group existence checked");
        group.add_entry().edit(|e| apply_input(e, input)).id()
    };

    get_entry(db, &id.uuid().to_string())
}

/// Overwrite an existing entry's standard fields.
pub fn update_entry(
    db: &mut Database,
    entry_uuid: &str,
    input: &EntryInput,
) -> AppResult<EntryDetail> {
    let eid = parse_entry_id(entry_uuid)?;
    require_entry(db, eid)?;

    db.entry_mut(eid)
        .expect("entry existence checked")
        .edit(|e| apply_input(e, input));

    get_entry(db, entry_uuid)
}

/// Permanently delete an entry (recycle bin handling arrives in Phase 4).
pub fn delete_entry(db: &mut Database, entry_uuid: &str) -> AppResult<()> {
    let eid = parse_entry_id(entry_uuid)?;
    require_entry(db, eid)?;
    db.entry_mut(eid).expect("entry existence checked").remove();
    Ok(())
}

/// Move an entry into a different group.
pub fn move_entry(db: &mut Database, entry_uuid: &str, target_group_uuid: &str) -> AppResult<()> {
    let eid = parse_entry_id(entry_uuid)?;
    let target = parse_group_id(target_group_uuid)?;
    require_entry(db, eid)?;
    require_group(db, target)?;

    db.entry_mut(eid)
        .expect("entry existence checked")
        .move_to(target)
        .map_err(|e| AppError::InvalidOperation(e.to_string()))
}

/// Create a new subgroup and return its UUID.
pub fn create_group(db: &mut Database, parent_uuid: &str, name: &str) -> AppResult<String> {
    let pid = parse_group_id(parent_uuid)?;
    require_group(db, pid)?;

    let id = {
        let mut parent = db.group_mut(pid).expect("group existence checked");
        parent
            .add_group()
            .edit(|g| g.name = name.to_string())
            .id()
    };
    Ok(id.uuid().to_string())
}

/// Rename a group (the root group cannot be renamed via this path).
pub fn rename_group(db: &mut Database, group_uuid: &str, name: &str) -> AppResult<()> {
    let gid = parse_group_id(group_uuid)?;
    require_group(db, gid)?;

    if gid == db.root().id() {
        return Err(AppError::InvalidOperation(
            "the root group cannot be renamed".into(),
        ));
    }

    db.group_mut(gid)
        .expect("group existence checked")
        .edit(|g| {
            g.name = name.to_string();
            g.times.last_modification = Some(Times::now());
        });
    Ok(())
}

/// Permanently delete a group and everything inside it (recycle bin in Phase 4).
pub fn delete_group(db: &mut Database, group_uuid: &str) -> AppResult<()> {
    let gid = parse_group_id(group_uuid)?;
    require_group(db, gid)?;

    if gid == db.root().id() {
        return Err(AppError::InvalidOperation(
            "the root group cannot be deleted".into(),
        ));
    }

    db.group_mut(gid).expect("group existence checked").remove();
    Ok(())
}

/// Move a group under a new parent (used by drag-and-drop reordering).
pub fn move_group(db: &mut Database, group_uuid: &str, target_group_uuid: &str) -> AppResult<()> {
    let gid = parse_group_id(group_uuid)?;
    let target = parse_group_id(target_group_uuid)?;
    require_group(db, gid)?;
    require_group(db, target)?;

    db.group_mut(gid)
        .expect("group existence checked")
        .move_to(target)
        .map_err(|e| AppError::InvalidOperation(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use keepass::Database;

    /// A database with a root and one child group "General"; returns (db, general_uuid).
    fn seeded() -> (Database, String) {
        let mut db = Database::new();
        let gid = db
            .root_mut()
            .add_group()
            .edit(|g| g.name = "General".into())
            .id();
        (db, gid.uuid().to_string())
    }

    fn input(title: &str, pw: &str) -> EntryInput {
        EntryInput {
            title: title.to_string(),
            username: "user".into(),
            password: pw.to_string(),
            url: "https://example.com".into(),
            notes: "note".into(),
            icon: Some(19),
            tags: vec!["work".into()],
        }
    }

    #[test]
    fn create_read_update_delete_entry() {
        let (mut db, gid) = seeded();

        let created = create_entry(&mut db, &gid, &input("Gmail", "secret")).unwrap();
        assert_eq!(created.title, "Gmail");
        assert_eq!(created.password, "secret");
        assert_eq!(created.group_uuid, gid);
        assert_eq!(created.icon, Some(19));

        // Listed in its group, sorted, with password/otp flags.
        let list = list_entries(&db, &gid).unwrap();
        assert_eq!(list.len(), 1);
        assert!(list[0].has_password);
        assert!(!list[0].has_otp);
        assert_eq!(list[0].tags, vec!["work".to_string()]);

        // Update overwrites fields.
        let mut upd = input("Gmail 2", "newpass");
        upd.icon = None;
        let updated = update_entry(&mut db, &created.uuid, &upd).unwrap();
        assert_eq!(updated.title, "Gmail 2");
        assert_eq!(updated.password, "newpass");
        assert_eq!(updated.icon, None);

        // Delete removes it.
        delete_entry(&mut db, &created.uuid).unwrap();
        assert_eq!(list_entries(&db, &gid).unwrap().len(), 0);
        assert_eq!(db.num_entries(), 0);
    }

    #[test]
    fn move_entry_between_groups() {
        let (mut db, gid) = seeded();
        let root = db.root().id().uuid().to_string();
        let other = create_group(&mut db, &root, "Other").unwrap();

        let e = create_entry(&mut db, &gid, &input("X", "p")).unwrap();
        move_entry(&mut db, &e.uuid, &other).unwrap();

        assert_eq!(list_entries(&db, &gid).unwrap().len(), 0);
        assert_eq!(list_entries(&db, &other).unwrap().len(), 1);
        assert_eq!(get_entry(&db, &e.uuid).unwrap().group_uuid, other);
    }

    #[test]
    fn group_create_rename_delete() {
        let (mut db, _gid) = seeded();
        let root = db.root().id().uuid().to_string();

        let sub = create_group(&mut db, &root, "Projects").unwrap();
        rename_group(&mut db, &sub, "Renamed").unwrap();

        let tree = database_tree(&db);
        let names: Vec<&str> = tree.root.children.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"Renamed"));

        // Nested entry counts roll up.
        create_entry(&mut db, &sub, &input("a", "p")).unwrap();
        let tree = database_tree(&db);
        assert_eq!(tree.root.total_entry_count, 1);

        delete_group(&mut db, &sub).unwrap();
        let tree = database_tree(&db);
        let names: Vec<&str> = tree.root.children.iter().map(|c| c.name.as_str()).collect();
        assert!(!names.contains(&"Renamed"));
    }

    #[test]
    fn root_cannot_be_renamed_or_deleted() {
        let (mut db, _gid) = seeded();
        let root = db.root().id().uuid().to_string();
        assert!(matches!(
            rename_group(&mut db, &root, "x"),
            Err(AppError::InvalidOperation(_))
        ));
        assert!(matches!(
            delete_group(&mut db, &root),
            Err(AppError::InvalidOperation(_))
        ));
    }

    #[test]
    fn unknown_ids_report_not_found() {
        let (mut db, _gid) = seeded();
        assert!(matches!(
            get_entry(&db, "not-a-uuid"),
            Err(AppError::NotFound(_))
        ));
        let absent = Uuid::new_v4().to_string();
        assert!(matches!(
            delete_entry(&mut db, &absent),
            Err(AppError::NotFound(_))
        ));
        assert!(matches!(
            list_entries(&db, &absent),
            Err(AppError::NotFound(_))
        ));
    }
}
