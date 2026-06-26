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
    db::{fields, Entry, EntryId, GroupId, History, Icon, Times, Value},
    Database,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

/// Built-in KeePass icon index used for the recycle bin group (a trash can).
const RECYCLE_BIN_ICON: usize = 43;

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
    /// Number of binary attachments on the entry.
    pub attachment_count: usize,
    pub tags: Vec<String>,
    /// Epoch milliseconds (UTC), or null if unknown.
    pub created: Option<i64>,
    pub modified: Option<i64>,
    pub expires: bool,
    pub expiry: Option<i64>,
}

/// A user-defined custom field (any field beyond the standard KeePass ones).
/// `protected` mirrors the KDBX "memory protection" flag for the value.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomField {
    pub key: String,
    pub value: String,
    #[serde(default)]
    pub protected: bool,
}

/// Metadata for one binary attachment on an entry.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentMeta {
    /// Database-wide attachment id.
    pub id: usize,
    /// The filename under which the attachment is stored on the entry.
    pub name: String,
    /// Size of the binary data in bytes.
    pub size: usize,
}

/// A summary of one historical snapshot of an entry, newest first (index 0).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    /// Index into the entry's history list (0 = most recent snapshot).
    pub index: usize,
    pub title: String,
    pub username: String,
    pub url: String,
    /// Modification time of this snapshot, epoch milliseconds (UTC).
    pub modified: Option<i64>,
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
    pub custom_fields: Vec<CustomField>,
    pub attachments: Vec<AttachmentMeta>,
    /// Raw TOTP secret/URI, surfaced read-only here (editing lands in Phase 5).
    pub otp: String,
    pub expires: bool,
    pub expiry: Option<i64>,
    /// Number of historical snapshots stored for this entry.
    pub history_count: usize,
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
    pub custom_fields: Vec<CustomField>,
    /// Raw TOTP secret/URI (`otpauth://…` or a bare base32 secret). Empty clears
    /// the OTP field. Stored protected like the password (PLAN Phase 5).
    pub otp: String,
    pub expires: bool,
    /// Expiry time as epoch milliseconds (UTC), or null when not expiring.
    pub expiry: Option<i64>,
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

/// Convert epoch milliseconds (UTC) into the crate's naive datetime, or `None`
/// if the timestamp is out of range.
fn naive_from_millis(ms: i64) -> Option<chrono::NaiveDateTime> {
    chrono::DateTime::from_timestamp_millis(ms).map(|d| d.naive_utc())
}

/// True for the reserved KeePass field names that are surfaced as dedicated
/// editor fields (Title, UserName, Password, URL, Notes) plus the OTP field.
/// Everything else is treated as a user-defined custom field.
fn is_standard_field(key: &str) -> bool {
    fields::KNOWN_FIELDS.contains(&key) || key == fields::OTP
}

/// Collect the entry's custom (non-standard) fields, sorted by name.
fn collect_custom_fields(entry: &Entry) -> Vec<CustomField> {
    let mut fields: Vec<CustomField> = entry
        .fields
        .iter()
        .filter(|(k, _)| !is_standard_field(k))
        .map(|(k, v)| CustomField {
            key: k.clone(),
            value: v.as_str().to_string(),
            protected: v.is_protected(),
        })
        .collect();
    fields.sort_by_key(|f| f.key.to_lowercase());
    fields
}

/// Collect the entry's attachments (name + size), sorted by name.
fn collect_attachments(e: &keepass::db::EntryRef<'_>) -> Vec<AttachmentMeta> {
    let mut atts: Vec<AttachmentMeta> = e
        .attachments_named()
        .map(|(name, att)| AttachmentMeta {
            id: att.id().id(),
            name: name.to_string(),
            size: att.data.len(),
        })
        .collect();
    atts.sort_by_key(|a| a.name.to_lowercase());
    atts
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

pub(crate) fn entry_summary(e: &keepass::db::EntryRef<'_>, group_id: GroupId) -> EntrySummary {
    EntrySummary {
        uuid: e.id().uuid().to_string(),
        group_uuid: group_id.uuid().to_string(),
        title: e.get(fields::TITLE).unwrap_or_default().to_string(),
        username: e.get(fields::USERNAME).unwrap_or_default().to_string(),
        url: e.get(fields::URL).unwrap_or_default().to_string(),
        icon: builtin_icon(e.icon()),
        has_password: e.get(fields::PASSWORD).is_some_and(|p| !p.is_empty()),
        has_otp: e.get(fields::OTP).is_some_and(|o| !o.is_empty()),
        attachment_count: e.attachments().count(),
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
        custom_fields: collect_custom_fields(&e),
        attachments: collect_attachments(&e),
        otp: e.get(fields::OTP).unwrap_or_default().to_string(),
        expires: e.times.expires.unwrap_or(false),
        expiry: millis(&e.times.expiry),
        history_count: e.history.as_ref().map_or(0, |h| h.get_entries().len()),
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

    // OTP secret/URI: stored protected, or cleared when blank (PLAN Phase 5).
    if input.otp.trim().is_empty() {
        e.fields.remove(fields::OTP);
    } else {
        e.set_protected(fields::OTP, input.otp.as_str());
    }

    // Replace the custom fields wholesale: drop the existing non-standard fields
    // (preserving Title/UserName/.../OTP) and write the supplied ones back.
    let stale: Vec<String> = e
        .fields
        .keys()
        .filter(|k| !is_standard_field(k))
        .cloned()
        .collect();
    for key in stale {
        e.fields.remove(&key);
    }
    for cf in &input.custom_fields {
        if cf.key.trim().is_empty() || is_standard_field(&cf.key) {
            continue;
        }
        if cf.protected {
            e.set_protected(cf.key.clone(), cf.value.clone());
        } else {
            e.set_unprotected(cf.key.clone(), cf.value.clone());
        }
    }

    e.times.expires = Some(input.expires);
    e.times.expiry = input.expiry.and_then(naive_from_millis);

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

/// Overwrite an existing entry's fields, snapshotting the prior state into the
/// entry's history first (KeePass DX: every save is recoverable).
pub fn update_entry(
    db: &mut Database,
    entry_uuid: &str,
    input: &EntryInput,
) -> AppResult<EntryDetail> {
    let eid = parse_entry_id(entry_uuid)?;
    require_entry(db, eid)?;

    db.entry_mut(eid)
        .expect("entry existence checked")
        .edit_tracking(|t| apply_input(&mut t.as_mut(), input));

    get_entry(db, entry_uuid)
}

// ── Recycle bin ──────────────────────────────────────────────────────────────

/// The recycle bin group's id, if one exists in this database.
pub(crate) fn recycle_bin_id(db: &Database) -> Option<GroupId> {
    db.recycle_bin().map(|g| g.id())
}

/// True if `group_id` is the recycle bin or lives anywhere inside it. Used by
/// search to skip trashed entries (PLAN Phase 6).
pub(crate) fn is_in_recycle_bin(db: &Database, group_id: GroupId) -> bool {
    match recycle_bin_id(db) {
        Some(rb) => group_is_under(db, group_id, rb),
        None => false,
    }
}

/// Build a group's display name and its full root→…→group breadcrumb path
/// (segments joined by " / "), used to give search hits context.
pub(crate) fn group_name_and_path(db: &Database, group_id: GroupId) -> (String, String) {
    let mut names: Vec<String> = Vec::new();
    let mut cur = Some(group_id);
    while let Some(id) = cur {
        match db.group(id) {
            Some(g) => {
                names.push(g.name.clone());
                cur = g.parent().map(|p| p.id());
            }
            None => break,
        }
    }
    names.reverse();
    let name = names.last().cloned().unwrap_or_default();
    (name, names.join(" / "))
}

/// Whether the recycle bin is enabled for this database (default: enabled,
/// matching KeePass — only an explicit `false` disables it).
fn recycle_enabled(db: &Database) -> bool {
    db.meta.recyclebin_enabled != Some(false)
}

/// True if `group_id` is `ancestor` or lives anywhere beneath it.
pub(crate) fn group_is_under(db: &Database, group_id: GroupId, ancestor: GroupId) -> bool {
    let mut cur = Some(group_id);
    while let Some(id) = cur {
        if id == ancestor {
            return true;
        }
        cur = db.group(id).and_then(|g| g.parent().map(|p| p.id()));
    }
    false
}

/// Whether an entry currently lives inside the recycle bin subtree.
fn entry_in_recycle_bin(db: &Database, eid: EntryId) -> bool {
    match (db.entry(eid), recycle_bin_id(db)) {
        (Some(e), Some(rb)) => group_is_under(db, e.parent().id(), rb),
        _ => false,
    }
}

/// Return the recycle bin group's id, creating the group (and registering it in
/// the database metadata) if it does not yet exist.
fn ensure_recycle_bin(db: &mut Database) -> GroupId {
    if let Some(id) = recycle_bin_id(db) {
        return id;
    }
    let root_id = db.root().id();
    let id = {
        let mut root = db.group_mut(root_id).expect("root always exists");
        root.add_group()
            .edit(|g| {
                g.name = "Recycle Bin".to_string();
                g.set_icon_builtin(RECYCLE_BIN_ICON);
            })
            .id()
    };
    db.meta.recyclebin_uuid = Some(id.uuid());
    db.meta.recyclebin_enabled = Some(true);
    db.meta.recyclebin_changed = Some(Times::now());
    id
}

/// Delete an entry. By default this is a soft delete that moves the entry to the
/// recycle bin; when `permanent` is set (or the entry is already in the recycle
/// bin, or the recycle bin is disabled) it is removed for good.
pub fn delete_entry(db: &mut Database, entry_uuid: &str, permanent: bool) -> AppResult<()> {
    let eid = parse_entry_id(entry_uuid)?;
    require_entry(db, eid)?;

    if permanent || !recycle_enabled(db) || entry_in_recycle_bin(db, eid) {
        db.entry_mut(eid).expect("entry existence checked").remove();
        return Ok(());
    }

    let rb = ensure_recycle_bin(db);
    db.entry_mut(eid)
        .expect("entry existence checked")
        .move_to(rb)
        .map_err(|e| AppError::InvalidOperation(e.to_string()))
}

/// Restore an entry out of the recycle bin, back to its previous parent group
/// (or the root group if that parent is gone or itself in the recycle bin).
pub fn restore_entry(db: &mut Database, entry_uuid: &str) -> AppResult<()> {
    let eid = parse_entry_id(entry_uuid)?;
    require_entry(db, eid)?;

    let previous = db
        .entry(eid)
        .and_then(|e| e.previous_parent().map(|p| p.id()));
    let root = db.root().id();
    let rb = recycle_bin_id(db);

    let dest = match previous {
        Some(t)
            if db.group(t).is_some() && rb.map_or(true, |r| !group_is_under(db, t, r)) =>
        {
            t
        }
        _ => root,
    };

    db.entry_mut(eid)
        .expect("entry existence checked")
        .move_to(dest)
        .map_err(|e| AppError::InvalidOperation(e.to_string()))
}

/// Restore a group out of the recycle bin, back to its previous parent group
/// (or the root group if that parent is gone or itself in the recycle bin).
pub fn restore_group(db: &mut Database, group_uuid: &str) -> AppResult<()> {
    let gid = parse_group_id(group_uuid)?;
    require_group(db, gid)?;

    let previous = db.group(gid).and_then(|g| g.previous_parent().map(|p| p.id()));
    let root = db.root().id();
    let rb = recycle_bin_id(db);

    let dest = match previous {
        Some(t)
            if t != gid
                && db.group(t).is_some()
                && rb.map_or(true, |r| !group_is_under(db, t, r)) =>
        {
            t
        }
        _ => root,
    };

    db.group_mut(gid)
        .expect("group existence checked")
        .move_to(dest)
        .map_err(|e| AppError::InvalidOperation(e.to_string()))
}

/// Permanently delete everything inside the recycle bin (the bin group itself
/// is kept). A no-op when there is no recycle bin.
pub fn empty_recycle_bin(db: &mut Database) -> AppResult<()> {
    let Some(rb) = recycle_bin_id(db) else {
        return Ok(());
    };

    let entry_ids: Vec<EntryId> = db
        .group(rb)
        .map(|g| g.entry_ids().collect())
        .unwrap_or_default();
    for eid in entry_ids {
        db.entry_mut(eid).expect("entry existence checked").remove();
    }

    let group_ids: Vec<GroupId> = db
        .group(rb)
        .map(|g| g.group_ids().collect())
        .unwrap_or_default();
    for gid in group_ids {
        db.group_mut(gid).expect("group existence checked").remove();
    }
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

/// Delete a group and everything inside it. By default this is a soft delete
/// that moves the group to the recycle bin; when `permanent` is set (or the
/// group is the recycle bin, is already inside it, or the recycle bin is
/// disabled) it is removed for good.
pub fn delete_group(db: &mut Database, group_uuid: &str, permanent: bool) -> AppResult<()> {
    let gid = parse_group_id(group_uuid)?;
    require_group(db, gid)?;

    if gid == db.root().id() {
        return Err(AppError::InvalidOperation(
            "the root group cannot be deleted".into(),
        ));
    }

    let rb = recycle_bin_id(db);
    let is_bin_or_inside = rb.is_some_and(|r| group_is_under(db, gid, r));

    if permanent || !recycle_enabled(db) || is_bin_or_inside {
        db.group_mut(gid).expect("group existence checked").remove();
        return Ok(());
    }

    let bin = ensure_recycle_bin(db);
    db.group_mut(gid)
        .expect("group existence checked")
        .move_to(bin)
        .map_err(|e| AppError::InvalidOperation(e.to_string()))
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

// ── Attachments ───────────────────────────────────────────────────────────────

/// List an entry's binary attachments.
pub fn list_attachments(db: &Database, entry_uuid: &str) -> AppResult<Vec<AttachmentMeta>> {
    let eid = parse_entry_id(entry_uuid)?;
    let e = db
        .entry(eid)
        .ok_or_else(|| AppError::NotFound(format!("entry {eid} not found")))?;
    Ok(collect_attachments(&e))
}

/// Read the raw bytes of one of an entry's attachments by filename.
pub fn get_attachment(db: &Database, entry_uuid: &str, name: &str) -> AppResult<Vec<u8>> {
    let eid = parse_entry_id(entry_uuid)?;
    let e = db
        .entry(eid)
        .ok_or_else(|| AppError::NotFound(format!("entry {eid} not found")))?;
    let att = e
        .attachment_by_name(name)
        .ok_or_else(|| AppError::NotFound(format!("attachment {name} not found")))?;
    Ok(att.data.get().clone())
}

/// Attach a binary to an entry under the given filename. An existing attachment
/// with the same name is replaced.
pub fn add_attachment(
    db: &mut Database,
    entry_uuid: &str,
    name: &str,
    data: Vec<u8>,
) -> AppResult<Vec<AttachmentMeta>> {
    let eid = parse_entry_id(entry_uuid)?;
    require_entry(db, eid)?;
    if name.trim().is_empty() {
        return Err(AppError::InvalidOperation(
            "attachment name cannot be empty".into(),
        ));
    }

    db.entry_mut(eid)
        .expect("entry existence checked")
        .add_attachment(name.to_string(), Value::unprotected(data));

    list_attachments(db, entry_uuid)
}

/// Remove one of an entry's attachments by filename.
pub fn remove_attachment(
    db: &mut Database,
    entry_uuid: &str,
    name: &str,
) -> AppResult<Vec<AttachmentMeta>> {
    let eid = parse_entry_id(entry_uuid)?;
    require_entry(db, eid)?;

    db.entry_mut(eid)
        .expect("entry existence checked")
        .remove_attachment_by_name(name);

    list_attachments(db, entry_uuid)
}

// ── History ───────────────────────────────────────────────────────────────────

/// List an entry's historical snapshots, newest first (index 0).
pub fn get_entry_history(db: &Database, entry_uuid: &str) -> AppResult<Vec<HistoryItem>> {
    let eid = parse_entry_id(entry_uuid)?;
    let e = db
        .entry(eid)
        .ok_or_else(|| AppError::NotFound(format!("entry {eid} not found")))?;

    let items = e
        .history
        .as_ref()
        .map(|h| {
            h.get_entries()
                .iter()
                .enumerate()
                .map(|(index, snap)| HistoryItem {
                    index,
                    title: snap.get(fields::TITLE).unwrap_or_default().to_string(),
                    username: snap.get(fields::USERNAME).unwrap_or_default().to_string(),
                    url: snap.get(fields::URL).unwrap_or_default().to_string(),
                    modified: millis(&snap.times.last_modification),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(items)
}

/// Restore an entry to one of its historical snapshots. The current state is
/// itself snapshotted into history first, so the restore is reversible.
pub fn restore_entry_history(
    db: &mut Database,
    entry_uuid: &str,
    index: usize,
) -> AppResult<EntryDetail> {
    let eid = parse_entry_id(entry_uuid)?;

    // Clone the snapshot out first to avoid overlapping borrows.
    let snapshot: Entry = {
        let e = db
            .entry(eid)
            .ok_or_else(|| AppError::NotFound(format!("entry {eid} not found")))?;
        e.history
            .as_ref()
            .and_then(|h| h.get_entries().get(index).cloned())
            .ok_or_else(|| AppError::NotFound(format!("history snapshot {index} not found")))?
    };

    db.entry_mut(eid)
        .expect("entry existence checked")
        .edit_tracking(|t| {
            let mut e = t.as_mut();
            // Replace all fields with the snapshot's.
            let keys: Vec<String> = e.fields.keys().cloned().collect();
            for k in keys {
                e.fields.remove(&k);
            }
            for (k, v) in &snapshot.fields {
                e.set(k.clone(), v.clone());
            }
            e.tags = snapshot.tags.clone();
            e.times.expires = snapshot.times.expires;
            e.times.expiry = snapshot.times.expiry;
            match snapshot.icon() {
                Some(Icon::BuiltIn(id)) => e.set_icon_builtin(*id),
                _ => e.set_icon_none(),
            }
            e.times.last_modification = Some(Times::now());
        });

    get_entry(db, entry_uuid)
}

/// Delete a single historical snapshot from an entry by index.
pub fn delete_entry_history(db: &mut Database, entry_uuid: &str, index: usize) -> AppResult<()> {
    let eid = parse_entry_id(entry_uuid)?;
    let mut e = db
        .entry_mut(eid)
        .ok_or_else(|| AppError::NotFound(format!("entry {eid} not found")))?;

    let Some(history) = e.history.as_ref() else {
        return Err(AppError::NotFound("entry has no history".into()));
    };
    let entries = history.get_entries();
    if index >= entries.len() {
        return Err(AppError::NotFound(format!(
            "history snapshot {index} not found"
        )));
    }

    // History exposes no index-removal, so rebuild it without the dropped item.
    // get_entries() is newest-first and add_entry() pushes to the front, so we
    // re-add the kept snapshots oldest-first to preserve ordering.
    let kept: Vec<Entry> = entries
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != index)
        .map(|(_, snap)| snap.clone())
        .collect();
    let mut rebuilt = History::default();
    for snap in kept.into_iter().rev() {
        rebuilt.add_entry(snap);
    }
    e.history = Some(rebuilt);
    Ok(())
}

// ── Database-level settings & maintenance (PLAN Phase 7) ──────────────────────

/// Database-level (KDBX meta) settings the user can tune: recycle-bin behaviour
/// and history retention limits. Mirrors the relevant `keepass::db::Meta` fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DbMetaSettings {
    /// Whether deletions go to the recycle bin (true) or are permanent (false).
    pub recycle_bin_enabled: bool,
    /// Max history snapshots kept per entry; `-1` means unlimited (KeePass).
    pub history_max_items: i64,
    /// Max total history size per entry in MiB; `-1` means unlimited.
    pub history_max_size_mib: i64,
}

impl Default for DbMetaSettings {
    fn default() -> Self {
        // KeePass defaults: recycle bin on, 10 history items, ~6 MiB history.
        Self {
            recycle_bin_enabled: true,
            history_max_items: 10,
            history_max_size_mib: 6,
        }
    }
}

const MIB: i64 = 1024 * 1024;

/// Read the database's current recycle-bin / history settings.
pub fn read_db_meta_settings(db: &Database) -> DbMetaSettings {
    let recycle_bin_enabled = db.meta.recyclebin_enabled != Some(false);
    let history_max_items = db.meta.history_max_items.map(|v| v as i64).unwrap_or(-1);
    let history_max_size_mib = match db.meta.history_max_size {
        Some(bytes) if bytes >= 0 => (bytes as i64) / MIB,
        Some(_) => -1,
        None => -1,
    };
    DbMetaSettings {
        recycle_bin_enabled,
        history_max_items,
        history_max_size_mib,
    }
}

/// Apply recycle-bin / history settings onto the database metadata, stamping the
/// settings-changed timestamp. Persisted on the next save.
pub fn apply_db_meta_settings(db: &mut Database, s: &DbMetaSettings) -> AppResult<()> {
    db.meta.recyclebin_enabled = Some(s.recycle_bin_enabled);
    db.meta.history_max_items = Some(s.history_max_items as isize);
    db.meta.history_max_size = Some(if s.history_max_size_mib < 0 {
        -1
    } else {
        (s.history_max_size_mib * MIB) as isize
    });
    db.meta.settings_changed = Some(Times::now());
    Ok(())
}

/// Summary of what a maintenance pass removed (for user feedback).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceReport {
    /// Number of history snapshots pruned across all entries.
    pub history_snapshots_removed: usize,
    /// Number of entries whose history was trimmed.
    pub entries_trimmed: usize,
}

/// Approximate byte size of one history snapshot (sum of field value lengths).
fn snapshot_size(e: &Entry) -> usize {
    e.fields.values().map(|v| v.as_str().len()).sum()
}

/// Trim every entry's history to the database's configured retention limits
/// (max item count and/or max total size), keeping the newest snapshots. This
/// is the "Database maintenance (cleanup)" action (PLAN Phase 7).
pub fn maintenance_cleanup(db: &mut Database) -> AppResult<MaintenanceReport> {
    let settings = read_db_meta_settings(db);
    let max_items = settings.history_max_items;
    let max_bytes: i64 = if settings.history_max_size_mib < 0 {
        -1
    } else {
        settings.history_max_size_mib * MIB
    };

    let mut report = MaintenanceReport::default();

    let entry_ids: Vec<EntryId> = db.iter_all_entries().map(|e| e.id()).collect();
    for eid in entry_ids {
        // Snapshot the (newest-first) history out, decide what to keep.
        let snapshots: Vec<Entry> = match db.entry(eid).and_then(|e| e.history.clone()) {
            Some(h) => h.get_entries().to_vec(),
            None => continue,
        };
        if snapshots.is_empty() {
            continue;
        }

        let mut kept: Vec<Entry> = Vec::with_capacity(snapshots.len());
        let mut running: i64 = 0;
        for snap in snapshots.iter() {
            // Enforce the item-count cap (newest kept first).
            if max_items >= 0 && kept.len() as i64 >= max_items {
                break;
            }
            // Enforce the total-size cap.
            if max_bytes >= 0 {
                let size = snapshot_size(snap) as i64;
                if !kept.is_empty() && running + size > max_bytes {
                    break;
                }
                running += size;
            }
            kept.push(snap.clone());
        }

        if kept.len() == snapshots.len() {
            continue; // nothing to trim for this entry
        }

        report.history_snapshots_removed += snapshots.len() - kept.len();
        report.entries_trimmed += 1;

        // Rebuild oldest-first (add_entry pushes to the front).
        let mut rebuilt = History::default();
        for snap in kept.into_iter().rev() {
            rebuilt.add_entry(snap);
        }
        if let Some(mut e) = db.entry_mut(eid) {
            e.history = Some(rebuilt);
        }
    }

    Ok(report)
}

/// Collect every distinct tag used across all entries in the database, sorted
/// case-insensitively. Powers tag autocomplete and the tag filter.
pub fn all_tags(db: &Database) -> Vec<String> {
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for e in db.iter_all_entries() {
        for t in &e.tags {
            if !t.trim().is_empty() {
                seen.insert(t.clone());
            }
        }
    }
    let mut tags: Vec<String> = seen.into_iter().collect();
    tags.sort_by_key(|t| t.to_lowercase());
    tags
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
            custom_fields: vec![],
            otp: String::new(),
            expires: false,
            expiry: None,
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

        // Permanent delete removes it.
        delete_entry(&mut db, &created.uuid, true).unwrap();
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

        delete_group(&mut db, &sub, true).unwrap();
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
            delete_group(&mut db, &root, true),
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
            delete_entry(&mut db, &absent, true),
            Err(AppError::NotFound(_))
        ));
        assert!(matches!(
            list_entries(&db, &absent),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn custom_fields_round_trip() {
        let (mut db, gid) = seeded();
        let mut inp = input("Server", "pw");
        inp.custom_fields = vec![
            CustomField {
                key: "API Token".into(),
                value: "abc123".into(),
                protected: true,
            },
            CustomField {
                key: "Account ID".into(),
                value: "42".into(),
                protected: false,
            },
        ];
        let e = create_entry(&mut db, &gid, &inp).unwrap();
        assert_eq!(e.custom_fields.len(), 2);
        // Sorted case-insensitively by key.
        assert_eq!(e.custom_fields[0].key, "Account ID");
        assert_eq!(e.custom_fields[1].key, "API Token");
        assert!(e.custom_fields[1].protected);

        // Updating with one fewer custom field drops the removed one but keeps
        // the standard fields intact.
        let mut upd = input("Server", "pw");
        upd.custom_fields = vec![CustomField {
            key: "Account ID".into(),
            value: "99".into(),
            protected: false,
        }];
        let e = update_entry(&mut db, &e.uuid, &upd).unwrap();
        assert_eq!(e.custom_fields.len(), 1);
        assert_eq!(e.custom_fields[0].value, "99");
        assert_eq!(e.password, "pw");
    }

    #[test]
    fn otp_round_trips_and_clears() {
        let (mut db, gid) = seeded();
        let mut inp = input("2FA", "p");
        inp.otp = "otpauth://totp/x?secret=MZXW6YTBOI".into();
        let e = create_entry(&mut db, &gid, &inp).unwrap();
        assert_eq!(e.otp, "otpauth://totp/x?secret=MZXW6YTBOI");
        // Surfaced as a flag on the list summary, and not leaked as a custom field.
        assert!(list_entries(&db, &gid).unwrap()[0].has_otp);
        assert!(e.custom_fields.is_empty());

        // Clearing the OTP removes the field entirely.
        let mut upd = input("2FA", "p");
        upd.otp = String::new();
        let e = update_entry(&mut db, &e.uuid, &upd).unwrap();
        assert_eq!(e.otp, "");
        assert!(!list_entries(&db, &gid).unwrap()[0].has_otp);
    }

    #[test]
    fn expiration_round_trip() {
        let (mut db, gid) = seeded();
        let mut inp = input("X", "p");
        inp.expires = true;
        inp.expiry = Some(1_700_000_000_000);
        let e = create_entry(&mut db, &gid, &inp).unwrap();
        assert!(e.expires);
        assert_eq!(e.expiry, Some(1_700_000_000_000));
        // Also reflected in the summary.
        let list = list_entries(&db, &gid).unwrap();
        assert!(list[0].expires);
        assert_eq!(list[0].expiry, Some(1_700_000_000_000));
    }

    #[test]
    fn attachments_add_get_remove() {
        let (mut db, gid) = seeded();
        let e = create_entry(&mut db, &gid, &input("Doc", "p")).unwrap();

        let metas = add_attachment(&mut db, &e.uuid, "notes.txt", b"hello".to_vec()).unwrap();
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].name, "notes.txt");
        assert_eq!(metas[0].size, 5);

        let data = get_attachment(&db, &e.uuid, "notes.txt").unwrap();
        assert_eq!(data, b"hello");

        // Reflected on the entry detail and summary.
        assert_eq!(get_entry(&db, &e.uuid).unwrap().attachments.len(), 1);
        assert_eq!(list_entries(&db, &gid).unwrap()[0].attachment_count, 1);

        let metas = remove_attachment(&mut db, &e.uuid, "notes.txt").unwrap();
        assert_eq!(metas.len(), 0);
        assert_eq!(db.num_attachments(), 0);
    }

    #[test]
    fn history_snapshot_restore_delete() {
        let (mut db, gid) = seeded();
        let e = create_entry(&mut db, &gid, &input("v1", "p1")).unwrap();
        assert_eq!(get_entry_history(&db, &e.uuid).unwrap().len(), 0);

        // Each update snapshots the prior state.
        let mut upd = input("v2", "p2");
        update_entry(&mut db, &e.uuid, &upd).unwrap();
        upd.title = "v3".into();
        upd.password = "p3".into();
        update_entry(&mut db, &e.uuid, &upd).unwrap();

        let hist = get_entry_history(&db, &e.uuid).unwrap();
        assert_eq!(hist.len(), 2);
        // Newest snapshot first: that's the "v2" state saved before the v3 edit.
        assert_eq!(hist[0].title, "v2");
        assert_eq!(hist[1].title, "v1");

        // Restoring the oldest (v1) brings its password back and snapshots v3.
        let restored = restore_entry_history(&mut db, &e.uuid, 1).unwrap();
        assert_eq!(restored.title, "v1");
        assert_eq!(restored.password, "p1");
        assert_eq!(get_entry_history(&db, &e.uuid).unwrap().len(), 3);

        // Deleting a history item removes exactly one.
        delete_entry_history(&mut db, &e.uuid, 0).unwrap();
        assert_eq!(get_entry_history(&db, &e.uuid).unwrap().len(), 2);
    }

    #[test]
    fn soft_delete_moves_to_recycle_bin_then_restores() {
        let (mut db, gid) = seeded();
        let e = create_entry(&mut db, &gid, &input("Trash me", "p")).unwrap();

        // Soft delete creates the recycle bin and moves the entry there.
        delete_entry(&mut db, &e.uuid, false).unwrap();
        assert_eq!(db.num_entries(), 1, "entry still exists, just relocated");
        let tree = database_tree(&db);
        assert!(tree.recycle_bin_uuid.is_some());
        assert_eq!(list_entries(&db, &gid).unwrap().len(), 0);

        // Restore returns it to its original group.
        restore_entry(&mut db, &e.uuid).unwrap();
        assert_eq!(list_entries(&db, &gid).unwrap().len(), 1);

        // Soft delete again, then a permanent delete from the bin removes it.
        delete_entry(&mut db, &e.uuid, false).unwrap();
        delete_entry(&mut db, &e.uuid, false).unwrap(); // already in bin → permanent
        assert_eq!(db.num_entries(), 0);
    }

    #[test]
    fn empty_recycle_bin_clears_contents() {
        let (mut db, gid) = seeded();
        let a = create_entry(&mut db, &gid, &input("a", "p")).unwrap();
        let b = create_entry(&mut db, &gid, &input("b", "p")).unwrap();
        delete_entry(&mut db, &a.uuid, false).unwrap();
        delete_entry(&mut db, &b.uuid, false).unwrap();

        let rb = database_tree(&db).recycle_bin_uuid.unwrap();
        assert_eq!(list_entries(&db, &rb).unwrap().len(), 2);

        empty_recycle_bin(&mut db).unwrap();
        assert_eq!(list_entries(&db, &rb).unwrap().len(), 0);
        assert_eq!(db.num_entries(), 0);
    }

    #[test]
    fn all_tags_are_deduped_and_sorted() {
        let (mut db, gid) = seeded();
        let mut a = input("a", "p");
        a.tags = vec!["Work".into(), "email".into()];
        create_entry(&mut db, &gid, &a).unwrap();
        let mut b = input("b", "p");
        b.tags = vec!["email".into(), "Archive".into()];
        create_entry(&mut db, &gid, &b).unwrap();

        assert_eq!(all_tags(&db), vec!["Archive", "email", "Work"]);
    }
}
