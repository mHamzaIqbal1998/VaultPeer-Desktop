//! Global search (PLAN Phase 6 / SRC-01..05).
//!
//! Pure, Tauri-free fuzzy search over an in-memory [`Database`]. Matching runs
//! entirely in Rust so secrets never have to be shipped to the frontend just to
//! be searched, and so a 10k-entry vault stays well under the 100ms budget.
//!
//! Searchable fields: title, username, URL, notes, tags, and custom field names
//! plus their *unprotected* values. Passwords and protected custom values are
//! deliberately excluded (KeePass-like behaviour). Entries in the recycle bin
//! are skipped unless explicitly requested.

use keepass::{
    db::{fields, EntryId, GroupId},
    Database,
};
use serde::{Deserialize, Serialize};

use crate::database::{
    self, entry_summary, group_name_and_path, is_in_recycle_bin, EntrySummary,
};

/// Optional filters narrowing a search (SRC-03: group / tag scoping).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchFilters {
    /// Restrict results to this group and its descendants.
    pub group_uuid: Option<String>,
    /// Require this exact tag on the entry.
    pub tag: Option<String>,
    /// Include entries living in the recycle bin (default: excluded).
    pub include_recycle_bin: bool,
}

/// A single ranked search result with enough context to render a rich row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub entry: EntrySummary,
    /// Display name of the entry's group.
    pub group_name: String,
    /// Full root→…→group breadcrumb path.
    pub group_path: String,
    /// Human label of the field that matched (e.g. "Title", "Notes", "Tag").
    pub matched_field: String,
    /// Short context snippet around the match.
    pub snippet: String,
    pub score: i64,
}

/// Field weights so a title hit always outranks a notes hit of equal quality.
const W_TITLE: i64 = 1000;
const W_USERNAME: i64 = 700;
const W_URL: i64 = 600;
const W_TAG: i64 = 550;
const W_FIELD_NAME: i64 = 450;
const W_NOTES: i64 = 400;
const W_FIELD_VALUE: i64 = 350;

/// Run a fuzzy search over the database, returning hits sorted best-first.
pub fn search(db: &Database, query: &str, filters: &SearchFilters) -> Vec<SearchHit> {
    let needle = lc_chars(query.trim());
    if needle.is_empty() {
        return Vec::new();
    }

    // Resolve an optional group-scope filter to a concrete id once.
    let scope = filters
        .group_uuid
        .as_deref()
        .and_then(|s| uuid::Uuid::parse_str(s).ok())
        .map(GroupId::from_uuid);

    let mut hits: Vec<SearchHit> = Vec::new();

    for e in db.iter_all_entries() {
        let gid = e.parent().id();

        if !filters.include_recycle_bin && is_in_recycle_bin(db, gid) {
            continue;
        }
        if let Some(scope) = scope {
            if !database::group_is_under(db, gid, scope) {
                continue;
            }
        }
        if let Some(tag) = &filters.tag {
            if !e.tags.iter().any(|t| t.eq_ignore_ascii_case(tag)) {
                continue;
            }
        }

        if let Some((field, snippet, score)) = best_field_match(&e, &needle) {
            let (group_name, group_path) = group_name_and_path(db, gid);
            hits.push(SearchHit {
                entry: entry_summary(&e, gid),
                group_name,
                group_path,
                matched_field: field,
                snippet,
                score,
            });
        }
    }

    // Best score first; ties broken by title for a stable, readable order.
    hits.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.entry.title.to_lowercase().cmp(&b.entry.title.to_lowercase()))
    });
    hits
}

/// The most-recently-modified entries across the whole vault (excluding the
/// recycle bin), newest first — backs the tray quick-access menu (PLAN Phase 6).
pub fn recent_entries(db: &Database, limit: usize) -> Vec<EntrySummary> {
    let mut all: Vec<EntrySummary> = db
        .iter_all_entries()
        .filter(|e| !is_in_recycle_bin(db, e.parent().id()))
        .map(|e| entry_summary(&e, e.parent().id()))
        .collect();
    // Newest modification first; entries without a timestamp sort last.
    all.sort_by(|a, b| b.modified.unwrap_or(i64::MIN).cmp(&a.modified.unwrap_or(i64::MIN)));
    all.truncate(limit);
    all
}

/// Pick the entry whose title or URL host best matches a foreground window
/// title, used by auto-type window matching (PLAN Phase 6 / ATY-03). The
/// longest substring match wins.
pub fn match_entry_for_window(db: &Database, window_title: &str) -> Option<EntryId> {
    let wt = window_title.to_lowercase();
    if wt.trim().is_empty() {
        return None;
    }

    let mut best: Option<(usize, EntryId)> = None;
    for e in db.iter_all_entries() {
        if is_in_recycle_bin(db, e.parent().id()) {
            continue;
        }
        let title = e.get(fields::TITLE).unwrap_or_default();
        let url = e.get(fields::URL).unwrap_or_default();

        let mut best_len = 0usize;
        if title.chars().count() >= 2 && wt.contains(&title.to_lowercase()) {
            best_len = best_len.max(title.len());
        }
        if let Some(host) = url_host(url) {
            if host.len() >= 3 && wt.contains(&host.to_lowercase()) {
                best_len = best_len.max(host.len());
            }
        }
        if best_len > 0 && best.map_or(true, |(l, _)| best_len > l) {
            best = Some((best_len, e.id()));
        }
    }
    best.map(|(_, id)| id)
}

/// Evaluate every searchable field of an entry and return the best match as
/// `(field_label, snippet, score)`, or `None` if nothing matched.
fn best_field_match(e: &keepass::db::EntryRef<'_>, needle: &[char]) -> Option<(String, String, i64)> {
    let mut best: Option<(String, String, i64)> = None;
    let consider = |label: &str, text: &str, weight: i64, best: &mut Option<(String, String, i64)>| {
        if text.is_empty() {
            return;
        }
        let orig: Vec<char> = text.chars().collect();
        let hay = lc_chars(text);
        if let Some((m, start, mlen)) = fuzzy(&hay, needle) {
            let score = weight + m;
            if best.as_ref().map_or(true, |(_, _, s)| score > *s) {
                *best = Some((label.to_string(), snippet(&orig, start, mlen), score));
            }
        }
    };

    consider("Title", e.get(fields::TITLE).unwrap_or_default(), W_TITLE, &mut best);
    consider("Username", e.get(fields::USERNAME).unwrap_or_default(), W_USERNAME, &mut best);
    consider("URL", e.get(fields::URL).unwrap_or_default(), W_URL, &mut best);
    consider("Notes", e.get(fields::NOTES).unwrap_or_default(), W_NOTES, &mut best);

    for tag in &e.tags {
        consider("Tag", tag, W_TAG, &mut best);
    }

    for (key, value) in e.fields.iter() {
        if fields::KNOWN_FIELDS.contains(&key.as_str()) || key == fields::OTP {
            continue;
        }
        consider(key, key, W_FIELD_NAME, &mut best);
        if !value.is_protected() {
            consider(key, value.as_str(), W_FIELD_VALUE, &mut best);
        }
    }

    best
}

// ── Fuzzy matching primitives ────────────────────────────────────────────────

/// Lowercase a string char-by-char while preserving the 1:1 char mapping with
/// the original, so a match offset on the lowercased form indexes the original.
fn lc_chars(s: &str) -> Vec<char> {
    s.chars()
        .map(|c| c.to_lowercase().next().unwrap_or(c))
        .collect()
}

/// Match `needle` against `hay` (both lowercased). Returns
/// `(quality_score, match_start, match_len)`, preferring contiguous substring
/// matches (with start/word-boundary bonuses) over scattered subsequences.
fn fuzzy(hay: &[char], needle: &[char]) -> Option<(i64, usize, usize)> {
    if needle.is_empty() {
        return None;
    }

    // Exact contiguous substring — the strongest signal.
    if let Some(pos) = find_sub(hay, needle) {
        let mut score = 1000 - pos.min(400) as i64;
        if pos == 0 {
            score += 300;
        } else if !hay[pos - 1].is_alphanumeric() {
            score += 150; // matched at a word boundary
        }
        return Some((score, pos, needle.len()));
    }

    // Fall back to an in-order subsequence (typo / abbreviation tolerance).
    let mut idx = 0usize;
    let mut first: Option<usize> = None;
    let mut last: Option<usize> = None;
    let mut gaps: i64 = 0;
    for &nc in needle {
        let mut found = false;
        while idx < hay.len() {
            let c = hay[idx];
            idx += 1;
            if c == nc {
                if first.is_none() {
                    first = Some(idx - 1);
                }
                if let Some(l) = last {
                    if idx - 1 > l + 1 {
                        gaps += (idx - 1 - l - 1) as i64;
                    }
                }
                last = Some(idx - 1);
                found = true;
                break;
            }
        }
        if !found {
            return None;
        }
    }
    let start = first.unwrap_or(0);
    let len = last.map_or(0, |l| l + 1 - start);
    Some((400 - gaps.min(380) - start.min(20) as i64, start, len))
}

/// Index of the first contiguous occurrence of `needle` within `hay`.
fn find_sub(hay: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| hay[i..i + needle.len()] == needle[..])
}

/// Build a short context snippet around a match, eliding distant context.
fn snippet(orig: &[char], start: usize, match_len: usize) -> String {
    const PAD: usize = 24;
    let from = start.saturating_sub(PAD);
    let to = (start + match_len + PAD).min(orig.len());
    let mut s = String::new();
    if from > 0 {
        s.push('…');
    }
    s.extend(orig[from..to].iter());
    if to < orig.len() {
        s.push('…');
    }
    s
}

/// Extract the host portion of a URL (scheme/userinfo/port stripped).
fn url_host(url: &str) -> Option<String> {
    let rest = url.trim().split("://").nth(1).unwrap_or(url.trim());
    let host = rest.split('/').next().unwrap_or(rest);
    let host = host.rsplit('@').next().unwrap_or(host);
    let host = host.split(':').next().unwrap_or(host);
    (!host.is_empty()).then(|| host.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::{create_entry, EntryInput};
    use keepass::Database;

    fn seeded() -> (Database, String) {
        let mut db = Database::new();
        let gid = db
            .root_mut()
            .add_group()
            .edit(|g| g.name = "Work".into())
            .id();
        (db, gid.uuid().to_string())
    }

    fn input(title: &str, username: &str, url: &str, notes: &str) -> EntryInput {
        EntryInput {
            title: title.into(),
            username: username.into(),
            url: url.into(),
            notes: notes.into(),
            ..Default::default()
        }
    }

    #[test]
    fn finds_by_title_username_and_url() {
        let (mut db, gid) = seeded();
        create_entry(&mut db, &gid, &input("Gmail", "alex@gmail.com", "https://mail.google.com", "")).unwrap();
        create_entry(&mut db, &gid, &input("GitHub", "octocat", "https://github.com", "personal token")).unwrap();

        let hits = search(&db, "gmail", &SearchFilters::default());
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].entry.title, "Gmail");
        assert_eq!(hits[0].matched_field, "Title");

        // Username match.
        let hits = search(&db, "octocat", &SearchFilters::default());
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].matched_field, "Username");

        // Notes match.
        let hits = search(&db, "token", &SearchFilters::default());
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].matched_field, "Notes");
    }

    #[test]
    fn fuzzy_subsequence_matches() {
        let (mut db, gid) = seeded();
        create_entry(&mut db, &gid, &input("GitHub", "x", "", "")).unwrap();
        // "gthb" is a subsequence of "github".
        let hits = search(&db, "gthb", &SearchFilters::default());
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].entry.title, "GitHub");
    }

    #[test]
    fn ranks_title_above_notes() {
        let (mut db, gid) = seeded();
        create_entry(&mut db, &gid, &input("Bank", "x", "", "")).unwrap();
        create_entry(&mut db, &gid, &input("Other", "x", "", "my bank notes")).unwrap();
        let hits = search(&db, "bank", &SearchFilters::default());
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].entry.title, "Bank", "title hit ranks first");
    }

    #[test]
    fn empty_query_returns_nothing() {
        let (mut db, gid) = seeded();
        create_entry(&mut db, &gid, &input("X", "y", "", "")).unwrap();
        assert!(search(&db, "   ", &SearchFilters::default()).is_empty());
    }

    #[test]
    fn tag_filter_restricts_results() {
        let (mut db, gid) = seeded();
        let mut a = input("Alpha", "u", "", "");
        a.tags = vec!["work".into()];
        create_entry(&mut db, &gid, &a).unwrap();
        let mut b = input("Alphabet", "u", "", "");
        b.tags = vec!["home".into()];
        create_entry(&mut db, &gid, &b).unwrap();

        let filters = SearchFilters {
            tag: Some("work".into()),
            ..Default::default()
        };
        let hits = search(&db, "alpha", &filters);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].entry.title, "Alpha");
    }

    #[test]
    fn window_matching_picks_longest() {
        let (mut db, gid) = seeded();
        create_entry(&mut db, &gid, &input("Git", "u", "", "")).unwrap();
        create_entry(&mut db, &gid, &input("GitHub", "u", "https://github.com", "")).unwrap();
        let id = match_entry_for_window(&db, "octocat/repo · GitHub — Mozilla Firefox");
        assert!(id.is_some());
        // "GitHub" (len 6) beats "Git" (len 3).
        let detail = crate::database::get_entry(&db, &id.unwrap().uuid().to_string()).unwrap();
        assert_eq!(detail.title, "GitHub");
    }
}
