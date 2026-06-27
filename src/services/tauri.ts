import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

/**
 * Thin, typed wrappers around the Rust IPC commands. Keeping all `invoke`
 * calls in one place means components never depend on raw command names.
 */

/** Metadata returned by the backend for a file on disk. */
export interface FileMeta {
  path: string;
  size: number;
  /** Unix epoch milliseconds, or null if unavailable. */
  modified: number | null;
}

/** Summary of an open database's configuration, returned after unlock/create. */
export interface DatabaseMetadata {
  path: string;
  name: string | null;
  description: string | null;
  generator: string | null;
  /** Format version, e.g. "KDBX4.1". */
  version: string;
  /** Outer/file cipher, e.g. "AES-256", "ChaCha20", "Twofish". */
  outerCipher: string;
  /** Inner/protected-field cipher, e.g. "ChaCha20", "Salsa20". */
  innerCipher: string;
  /** "GZip" or "None". */
  compression: string;
  /** KDF family, e.g. "Argon2id", "Argon2d", "AES-KDF". */
  kdf: string;
  /** Argon2 iterations or AES-KDF rounds. */
  kdfIterations: number;
  /** Argon2 memory in KiB; null for AES-KDF. */
  kdfMemoryKib: number | null;
  /** Argon2 parallelism; null for AES-KDF. */
  kdfParallelism: number | null;
  entryCount: number;
  groupCount: number;
}

/** Encryption settings for a new database (mirrors Rust `CreateOptions`). */
export interface CreateOptions {
  kdf: "argon2id" | "argon2d" | "aes";
  cipher: "aes256" | "chacha20" | "twofish";
  kdfMemoryMib: number;
  kdfIterations: number;
  kdfParallelism: number;
  aesRounds: number;
  compression: "gzip" | "none";
}

/**
 * Sensible defaults targeting a roughly one-second unlock. Argon2d + AES-256 is
 * the cross-compatible format every VaultPeer node (desktop, mobile, storage
 * node) can read, so it's the default for new databases.
 */
export const DEFAULT_CREATE_OPTIONS: CreateOptions = {
  kdf: "argon2d",
  cipher: "aes256",
  kdfMemoryMib: 64,
  kdfIterations: 10,
  kdfParallelism: 4,
  aesRounds: 100_000,
  compression: "gzip",
};

export async function greet(name: string): Promise<string> {
  return invoke<string>("greet", { name });
}

/**
 * Open a native file-open dialog filtered to KeePass databases.
 * Returns the selected absolute path, or null if cancelled.
 */
export async function openDatabaseDialog(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    title: "Open KeePass Database",
    filters: [
      { name: "KeePass Database", extensions: ["kdbx"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  // `open` returns string | string[] | null depending on options.
  return typeof selected === "string" ? selected : null;
}

/**
 * Open a native save dialog for creating a new KeePass database.
 * Returns the chosen absolute path, or null if cancelled.
 */
export async function saveDatabaseDialog(
  defaultName = "Vault.kdbx",
): Promise<string | null> {
  const path = await save({
    title: "Create KeePass Database",
    defaultPath: defaultName,
    filters: [{ name: "KeePass Database", extensions: ["kdbx"] }],
  });
  return path ?? null;
}

/**
 * Open a native file-open dialog for selecting a key file (any file type).
 * Returns the selected absolute path, or null if cancelled.
 */
export async function openKeyFileDialog(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    title: "Select Key File",
    filters: [{ name: "All Files", extensions: ["*"] }],
  });
  return typeof selected === "string" ? selected : null;
}

/**
 * Open a native file-open dialog for picking a file to attach to an entry.
 * Returns the selected absolute path, or null if cancelled.
 */
export async function openAttachmentDialog(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    title: "Add Attachment",
  });
  return typeof selected === "string" ? selected : null;
}

/**
 * Open a native file-open dialog filtered to image files, used to scan a QR
 * code from a saved screenshot/photo (PLAN Phase 5 / OTP-02 fallback).
 * Returns the selected absolute path, or null if cancelled.
 */
export async function openImageDialog(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    title: "Scan QR Code from Image",
    filters: [
      { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "bmp", "webp"] },
    ],
  });
  return typeof selected === "string" ? selected : null;
}

/**
 * Open a native save dialog for exporting an attachment to disk.
 * Returns the chosen absolute path, or null if cancelled.
 */
export async function saveAttachmentDialog(
  defaultName: string,
): Promise<string | null> {
  const path = await save({ title: "Export Attachment", defaultPath: defaultName });
  return path ?? null;
}

/**
 * Open a native save dialog for an emergency export, filtered to the format.
 * Returns the chosen absolute path, or null if cancelled (PLAN Phase 7).
 */
export async function saveExportDialog(
  format: "csv" | "xml" | "json",
): Promise<string | null> {
  const path = await save({
    title: "Export (unencrypted)",
    defaultPath: `vaultpeer-export.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  });
  return path ?? null;
}

/** Open a native file-open dialog filtered to CSV files (for import). */
export async function openCsvDialog(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    title: "Import from CSV",
    filters: [
      { name: "CSV", extensions: ["csv"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  return typeof selected === "string" ? selected : null;
}

/** Open a native directory-picker (used to write the browser extension bundle). */
export async function openDirectoryDialog(title: string): Promise<string | null> {
  const selected = await open({ multiple: false, directory: true, title });
  return typeof selected === "string" ? selected : null;
}

/** Open a native save dialog for exporting an encrypted `.kdbx` copy. */
export async function saveKdbxDialog(
  defaultName = "vaultpeer-export.kdbx",
): Promise<string | null> {
  const path = await save({
    title: "Export as KeePass Database",
    defaultPath: defaultName,
    filters: [{ name: "KeePass Database", extensions: ["kdbx"] }],
  });
  return path ?? null;
}

// ── Phase 2: database cryptography & unlock ─────────────────────────────────

/** Decrypt an existing database and load it into the vault session. */
export async function unlockDatabase(
  path: string,
  password: string | null,
  keyFile: string | null,
): Promise<DatabaseMetadata> {
  return invoke<DatabaseMetadata>("unlock_database", {
    path,
    password,
    keyFile,
  });
}

/** Create a new database with the given settings and load it into the session. */
export async function createDatabase(
  path: string,
  name: string,
  password: string | null,
  keyFile: string | null,
  options: CreateOptions,
): Promise<DatabaseMetadata> {
  return invoke<DatabaseMetadata>("create_database", {
    path,
    name,
    password,
    keyFile,
    options,
  });
}

/** Persist the open database back to its file (atomic write). */
export async function saveDatabase(): Promise<void> {
  await invoke("save_database");
}

/** Lock the vault, dropping decrypted data from backend memory. */
export async function lockDatabase(): Promise<void> {
  await invoke("lock_database");
}

/** Return the open database's metadata, or null if locked. */
export async function vaultStatus(): Promise<DatabaseMetadata | null> {
  return invoke<DatabaseMetadata | null>("vault_status");
}

// ── Phase 3: entry & group management ───────────────────────────────────────

/** A node in the group hierarchy (mirrors Rust `GroupNode`). */
export interface GroupNode {
  uuid: string;
  name: string;
  /** KeePass built-in icon index, or null. */
  icon: number | null;
  notes: string | null;
  /** Entries directly in this group. */
  entryCount: number;
  /** Entries in this group and all descendants. */
  totalEntryCount: number;
  isRecycleBin: boolean;
  children: GroupNode[];
}

/** The full group tree of the open database. */
export interface DatabaseTree {
  root: GroupNode;
  recycleBinUuid: string | null;
}

/** Compact entry shape for list/card views (mirrors Rust `EntrySummary`). */
export interface EntrySummary {
  uuid: string;
  groupUuid: string;
  title: string;
  username: string;
  url: string;
  icon: number | null;
  hasPassword: boolean;
  hasOtp: boolean;
  /** Number of binary attachments. */
  attachmentCount: number;
  tags: string[];
  /** Epoch milliseconds (UTC), or null. */
  created: number | null;
  modified: number | null;
  expires: boolean;
  expiry: number | null;
}

/** A user-defined custom field (mirrors Rust `CustomField`). */
export interface CustomField {
  key: string;
  value: string;
  /** Whether the value is stored with memory protection (masked by default). */
  protected: boolean;
}

/** Metadata for one binary attachment (mirrors Rust `AttachmentMeta`). */
export interface AttachmentMeta {
  id: number;
  name: string;
  /** Size in bytes. */
  size: number;
}

/** A summary of one historical snapshot of an entry (mirrors Rust `HistoryItem`). */
export interface HistoryItem {
  /** Index into the entry's history list (0 = most recent). */
  index: number;
  title: string;
  username: string;
  url: string;
  /** Epoch milliseconds (UTC), or null. */
  modified: number | null;
}

/** Full entry contents for the detail view / editor (mirrors Rust `EntryDetail`). */
export interface EntryDetail {
  uuid: string;
  groupUuid: string;
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  icon: number | null;
  tags: string[];
  customFields: CustomField[];
  attachments: AttachmentMeta[];
  /** Raw TOTP secret/URI (read-only here; managed in Phase 5). */
  otp: string;
  expires: boolean;
  expiry: number | null;
  /** Number of historical snapshots stored. */
  historyCount: number;
  created: number | null;
  modified: number | null;
}

/** Mutable entry fields sent to the backend on create/update (Rust `EntryInput`). */
export interface EntryInput {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  icon: number | null;
  tags: string[];
  customFields: CustomField[];
  /** Raw TOTP secret/URI (`otpauth://…` or bare base32); empty clears it. */
  otp: string;
  expires: boolean;
  /** Expiry as epoch milliseconds (UTC), or null when not expiring. */
  expiry: number | null;
}

/** An empty entry input, used to seed the editor for a new entry. */
export const EMPTY_ENTRY_INPUT: EntryInput = {
  title: "",
  username: "",
  password: "",
  url: "",
  notes: "",
  icon: null,
  tags: [],
  customFields: [],
  otp: "",
  expires: false,
  expiry: null,
};

/** Build an `EntryInput` (the editable shape) from a full `EntryDetail`. */
export function inputFromDetail(d: EntryDetail): EntryInput {
  return {
    title: d.title,
    username: d.username,
    password: d.password,
    url: d.url,
    notes: d.notes,
    icon: d.icon,
    tags: d.tags,
    customFields: d.customFields,
    otp: d.otp,
    expires: d.expires,
    expiry: d.expiry,
  };
}

/** Fetch the full group hierarchy of the open database. */
export async function getDatabaseTree(): Promise<DatabaseTree> {
  return invoke<DatabaseTree>("get_database_tree");
}

/** List entries directly contained in a group. */
export async function listEntries(groupUuid: string): Promise<EntrySummary[]> {
  return invoke<EntrySummary[]>("list_entries", { groupUuid });
}

/** Read the full contents of a single entry. */
export async function getEntry(entryUuid: string): Promise<EntryDetail> {
  return invoke<EntryDetail>("get_entry", { entryUuid });
}

/** Create a new entry in a group; returns the created entry's detail. */
export async function createEntry(
  groupUuid: string,
  entry: EntryInput,
): Promise<EntryDetail> {
  return invoke<EntryDetail>("create_entry", { groupUuid, entry });
}

/** Overwrite an existing entry's standard fields. */
export async function updateEntry(
  entryUuid: string,
  entry: EntryInput,
): Promise<EntryDetail> {
  return invoke<EntryDetail>("update_entry", { entryUuid, entry });
}

/**
 * Delete an entry. By default this is a soft delete to the recycle bin; pass
 * `permanent` to remove it for good.
 */
export async function deleteEntry(
  entryUuid: string,
  permanent = false,
): Promise<void> {
  await invoke("delete_entry", { entryUuid, permanent });
}

/** Move an entry into a different group. */
export async function moveEntry(
  entryUuid: string,
  targetGroupUuid: string,
): Promise<void> {
  await invoke("move_entry", { entryUuid, targetGroupUuid });
}

/** Create a new subgroup; returns the new group's UUID. */
export async function createGroup(
  parentUuid: string,
  name: string,
): Promise<string> {
  return invoke<string>("create_group", { parentUuid, name });
}

/** Rename a group. */
export async function renameGroup(
  groupUuid: string,
  name: string,
): Promise<void> {
  await invoke("rename_group", { groupUuid, name });
}

/**
 * Delete a group and everything inside it. By default this is a soft delete to
 * the recycle bin; pass `permanent` to remove it for good.
 */
export async function deleteGroup(
  groupUuid: string,
  permanent = false,
): Promise<void> {
  await invoke("delete_group", { groupUuid, permanent });
}

/** Move a group under a new parent (drag-and-drop reordering). */
export async function moveGroup(
  groupUuid: string,
  targetGroupUuid: string,
): Promise<void> {
  await invoke("move_group", { groupUuid, targetGroupUuid });
}

// ── Phase 4: advanced entry features ─────────────────────────────────────────

/** Restore an entry from the recycle bin to its previous location. */
export async function restoreEntry(entryUuid: string): Promise<void> {
  await invoke("restore_entry", { entryUuid });
}

/** Restore a group from the recycle bin to its previous location. */
export async function restoreGroup(groupUuid: string): Promise<void> {
  await invoke("restore_group", { groupUuid });
}

/** Permanently delete everything inside the recycle bin. */
export async function emptyRecycleBin(): Promise<void> {
  await invoke("empty_recycle_bin");
}

/** List an entry's binary attachments. */
export async function listAttachments(
  entryUuid: string,
): Promise<AttachmentMeta[]> {
  return invoke<AttachmentMeta[]>("list_attachments", { entryUuid });
}

/** Read the raw bytes of one of an entry's attachments by filename. */
export async function getAttachment(
  entryUuid: string,
  name: string,
): Promise<Uint8Array> {
  const bytes = await invoke<number[]>("get_attachment", { entryUuid, name });
  return new Uint8Array(bytes);
}

/** Attach a binary to an entry under the given filename; returns the new list. */
export async function addAttachment(
  entryUuid: string,
  name: string,
  data: Uint8Array,
): Promise<AttachmentMeta[]> {
  return invoke<AttachmentMeta[]>("add_attachment", {
    entryUuid,
    name,
    data: Array.from(data),
  });
}

/** Remove one of an entry's attachments by filename; returns the new list. */
export async function removeAttachment(
  entryUuid: string,
  name: string,
): Promise<AttachmentMeta[]> {
  return invoke<AttachmentMeta[]>("remove_attachment", { entryUuid, name });
}

/** List an entry's historical snapshots (newest first). */
export async function getEntryHistory(
  entryUuid: string,
): Promise<HistoryItem[]> {
  return invoke<HistoryItem[]>("get_entry_history", { entryUuid });
}

/** Restore an entry to one of its historical snapshots. */
export async function restoreEntryHistory(
  entryUuid: string,
  index: number,
): Promise<EntryDetail> {
  return invoke<EntryDetail>("restore_entry_history", { entryUuid, index });
}

/** Delete a single historical snapshot from an entry. */
export async function deleteEntryHistory(
  entryUuid: string,
  index: number,
): Promise<void> {
  await invoke("delete_entry_history", { entryUuid, index });
}

/** Every distinct tag used across the database (for autocomplete / filtering). */
export async function allTags(): Promise<string[]> {
  return invoke<string[]>("all_tags");
}

// ── Phase 5: password generator & OTP ────────────────────────────────────────

/** A generated TOTP code plus countdown timing (mirrors Rust `TotpCode`). */
export interface TotpCode {
  code: string;
  period: number;
  digits: number;
  /** Seconds remaining until the code rolls over. */
  remaining: number;
}

/**
 * Generate the current TOTP code for an entry's stored OTP value (an
 * `otpauth://` URI or a bare base32 secret). Rejects if the secret is invalid.
 */
export async function generateTotp(otp: string): Promise<TotpCode> {
  return invoke<TotpCode>("generate_totp", { otp });
}

// ── Phase 6: search, clipboard & auto-type ───────────────────────────────────

/** Optional filters narrowing a search (mirrors Rust `SearchFilters`). */
export interface SearchFilters {
  /** Restrict results to this group and its descendants. */
  groupUuid?: string | null;
  /** Require this exact tag on the entry. */
  tag?: string | null;
  /** Include entries living in the recycle bin (default: excluded). */
  includeRecycleBin?: boolean;
}

/** One ranked search result with group context (mirrors Rust `SearchHit`). */
export interface SearchHit {
  entry: EntrySummary;
  /** Display name of the entry's group. */
  groupName: string;
  /** Full root→…→group breadcrumb path. */
  groupPath: string;
  /** Human label of the field that matched (e.g. "Title", "Notes"). */
  matchedField: string;
  /** Short context snippet around the match. */
  snippet: string;
  score: number;
}

/** A lightweight entry reference for the tray quick-access menu. */
export interface TrayEntry {
  uuid: string;
  title: string;
}

/** Payload of the `vault://autotype` event (mirrors Rust `AutoTypeStatus`). */
export interface AutoTypeStatus {
  /** "typed" (success), "error" (failure/unsupported), or "pick" (no match). */
  kind: "typed" | "error" | "pick";
  message: string;
  /** Title of the window that was focused when the hotkey fired. */
  windowTitle: string;
  /** Whether selective (password-only) auto-type was requested. */
  selective: boolean;
}

/** Tauri event name for auto-type status / picker requests. */
export const AUTOTYPE_EVENT = "vault://autotype";

/**
 * Fuzzy-search the open database across all searchable fields, returning ranked
 * hits with group context and a match snippet (SRC-01/02/03).
 */
export async function searchDatabase(
  query: string,
  filters: SearchFilters = {},
): Promise<SearchHit[]> {
  return invoke<SearchHit[]>("search_database", { query, filters });
}

/** The most-recently-modified entries across the vault (for the tray menu). */
export async function recentEntries(limit: number): Promise<EntrySummary[]> {
  return invoke<EntrySummary[]>("recent_entries", { limit });
}

/** Rebuild the tray's recent-entries quick-access section (empty clears it). */
export async function setTrayRecent(entries: TrayEntry[]): Promise<void> {
  await invoke("set_tray_recent", { entries });
}

/**
 * Copy text to the clipboard with history/cloud exclusion (CLP-03). Windows-
 * only; rejects elsewhere so callers can fall back to the Web Clipboard API.
 */
export async function copyClipboardProtected(text: string): Promise<void> {
  await invoke("copy_clipboard", { text });
}

/**
 * Trigger window-matched auto-type into the currently-focused window (ATY-01).
 * `selective` types only the password. Windows-only; errors elsewhere.
 */
export async function autoType(selective = false): Promise<void> {
  await invoke("auto_type", { selective });
}

/**
 * Auto-type a specific entry: hides the app window so the previously-focused
 * app regains focus, then replays the entry's sequence. Windows-only.
 */
export async function autoTypeEntry(entryUuid: string): Promise<void> {
  await invoke("auto_type_entry", { entryUuid });
}

/**
 * Auto-type a chosen entry into the window captured when the hotkey fired
 * (used by the fallback picker). Re-focuses that window, then types.
 */
export async function autoTypeToWindow(
  entryUuid: string,
  selective: boolean,
): Promise<void> {
  await invoke("auto_type_to_window", { entryUuid, selective });
}

// ── Phase 7: settings & preferences ──────────────────────────────────────────

/** Default password-generator preferences (mirrors Rust `GeneratorDefaults`). */
export interface GeneratorDefaults {
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  digits: boolean;
  symbols: boolean;
  excludeAmbiguous: boolean;
}

/** Customizable in-app keyboard shortcuts (mirrors Rust `ShortcutBindings`). */
export interface ShortcutBindings {
  search: string;
  lock: string;
  save: string;
  newEntry: string;
  generator: string;
  settings: string;
  copyPassword: string;
  copyUsername: string;
}

/** A single ICE (STUN/TURN) server for P2P sync (mirrors Rust `IceServerConfig`). */
export interface IceServerConfig {
  urls: string[];
  username?: string | null;
  credential?: string | null;
}

/** Persisted P2P sync configuration (mirrors Rust `SyncConfig`). */
export interface SyncConfig {
  /** `ws(s)://…` signaling server URL; empty until the user configures one. */
  signalingUrl: string;
  /** ICE servers for NAT traversal (STUN for discovery, TURN as relay). */
  iceServers: IceServerConfig[];
  /** Last room joined/created, remembered for auto-reconnect on vault open. */
  room: string;
  /** When true, opening a vault auto-rejoins `room` and keeps it in sync. */
  autoSync: boolean;
}

/** Persisted vault backup retention settings (mirrors Rust `BackupConfig`). */
export interface BackupConfig {
  /** Whether backups are taken on each newer pull. */
  enabled: boolean;
  /** Number of previous revisions to retain (clamped 1..=50 by the UI). */
  retention: number;
  /** Destination directory for backups (absolute path), or empty if unset. */
  dir: string;
  /** Human-friendly directory name for display, or empty if unset. */
  dirName: string;
}

/** All persisted application settings (mirrors Rust `AppSettings`). */
export interface AppSettings {
  version: number;
  theme: "dark" | "light" | "high-contrast" | "system";
  /** Inactivity seconds before auto-lock; 0 disables. */
  autoLockSeconds: number;
  /** Seconds before a copied secret is cleared; 0 disables. */
  clipboardClearSeconds: number;
  minimizeToTray: boolean;
  startWithWindows: boolean;
  generator: GeneratorDefaults;
  defaultCreateOptions: CreateOptions;
  shortcuts: ShortcutBindings;
  sync: SyncConfig;
  /** Vault backup retention on pull (mirrors mobile/server node). */
  backup: BackupConfig;
}

/** Recycle-bin / history-retention settings of the open DB (Rust `DbMetaSettings`). */
export interface DbMetaSettings {
  recycleBinEnabled: boolean;
  /** Max history snapshots per entry; -1 = unlimited. */
  historyMaxItems: number;
  /** Max total history size per entry in MiB; -1 = unlimited. */
  historyMaxSizeMib: number;
}

/** The open database's encryption + retention settings (Rust `DbSettings`). */
export interface DbSettings {
  encryption: CreateOptions;
  meta: DbMetaSettings;
}

/** Result of a maintenance cleanup pass (mirrors Rust `MaintenanceReport`). */
export interface MaintenanceReport {
  historySnapshotsRemoved: number;
  entriesTrimmed: number;
}

/** Read the persisted application settings. */
export async function getSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_settings");
}

/** Persist application settings (also updates the live in-memory copy). */
export async function saveSettings(settings: AppSettings): Promise<void> {
  await invoke("save_settings", { settings });
}

/** Whether launch-on-login is currently registered. */
export async function getAutostart(): Promise<boolean> {
  return invoke<boolean>("get_autostart");
}

/** Enable/disable launch-on-login (Windows-only; rejects elsewhere). */
export async function setAutostart(enabled: boolean): Promise<void> {
  await invoke("set_autostart", { enabled });
}

/**
 * Calibrate Argon2 iterations to hit a target unlock time (PRD ENC-05). Returns
 * the recommended iteration count for the given memory/parallelism.
 */
export async function kdfBenchmark(
  memoryMib: number,
  parallelism: number,
  targetSecs: number,
  argon2id: boolean,
): Promise<number> {
  return invoke<number>("kdf_benchmark", {
    memoryMib,
    parallelism,
    targetSecs,
    argon2id,
  });
}

/** Read the open database's encryption + recycle-bin/history settings. */
export async function getDbSettings(): Promise<DbSettings> {
  return invoke<DbSettings>("get_db_settings");
}

/** Apply new encryption + recycle-bin/history settings to the open database. */
export async function updateDbSettings(
  encryption: CreateOptions,
  meta: DbMetaSettings,
): Promise<void> {
  await invoke("update_db_settings", { encryption, meta });
}

/** Trim entry histories to the configured retention limits. */
export async function dbMaintenance(): Promise<MaintenanceReport> {
  return invoke<MaintenanceReport>("db_maintenance");
}

/** Produce an unencrypted CSV/XML/JSON export of the open database (PRD UN-06 / EXP-02). */
export async function exportDatabase(format: "csv" | "xml" | "json"): Promise<string> {
  return invoke<string>("export_database", { format });
}

// ── Phase 7: Windows Hello biometric quick-unlock (UN-02/UN-03) ───────────────

/** Whether Windows Hello (or its PIN fallback) is available on this machine. */
export async function biometricAvailable(): Promise<boolean> {
  return invoke<boolean>("biometric_available");
}

/** Whether a database already has a stored biometric quick-unlock credential. */
export async function biometricIsEnrolled(path: string): Promise<boolean> {
  return invoke<boolean>("biometric_is_enrolled", { path });
}

/**
 * Enroll a database for biometric quick-unlock: prompts Windows Hello, then
 * stores the master password DPAPI-protected. Windows-only.
 */
export async function biometricEnroll(
  path: string,
  password: string,
): Promise<void> {
  await invoke("biometric_enroll", { path, password });
}

/**
 * Unlock a database via Windows Hello and load it into the session. Returns the
 * database metadata, like {@link unlockDatabase}.
 */
export async function biometricUnlock(path: string): Promise<DatabaseMetadata> {
  return invoke<DatabaseMetadata>("biometric_unlock", { path });
}

/** Remove a database's stored quick-unlock credential. */
export async function biometricForget(path: string): Promise<void> {
  await invoke("biometric_forget", { path });
}

/** Read raw bytes from a file. */
export async function readFile(path: string): Promise<Uint8Array> {
  const bytes = await invoke<number[]>("read_file", { path });
  return new Uint8Array(bytes);
}

/**
 * Write bytes to a file atomically (temp file + rename) so an interrupted
 * write can never corrupt the target database.
 */
export async function writeFileAtomic(
  path: string,
  contents: Uint8Array,
): Promise<void> {
  await invoke("write_file", { path, contents: Array.from(contents) });
}

/** Fetch metadata (size, modified time) for a file. */
export async function statFile(path: string): Promise<FileMeta> {
  return invoke<FileMeta>("stat_file", { path });
}

/** Set a file's last-modified time (epoch ms) — used by P2P sync. */
export async function setFileMtime(path: string, mtimeMs: number): Promise<void> {
  await invoke("set_file_mtime", { path, mtimeMs });
}

/** One entry returned by `listDir`. */
export interface DirEntry {
  /** Entry name (no path). */
  name: string;
  /** Absolute path to the entry. */
  path: string;
}

/** List the immediate children of a directory (non-recursive). */
export async function listDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("list_dir", { path });
}

/** Delete a file. Missing files are treated as success (idempotent). */
export async function deleteFile(path: string): Promise<void> {
  await invoke("delete_file", { path });
}

/** Read the remembered converged sync version (epoch ms) for a vault filename. */
export async function syncGetMtime(filename: string): Promise<number> {
  return invoke<number>("sync_get_mtime", { filename });
}

/** Persist a converged sync version for a vault filename (monotonic). */
export async function syncSetMtime(filename: string, mtime: number): Promise<void> {
  await invoke("sync_set_mtime", { filename, mtime });
}

// ── Phase 8: P2P synchronization ──────────────────────────────────────────────

/** A lightweight description of a vault's state (mirrors Rust `VaultFingerprint`). */
export interface VaultFingerprint {
  name: string | null;
  entryCount: number;
  groupCount: number;
  /** Most-recent modification time across the vault, epoch millis, or null. */
  latestModified: number | null;
  /** Checksum that differs whenever the vault's contents differ. */
  checksum: string;
}

/** Encrypted vault bytes + their fingerprint, for transfer (Rust `SyncSnapshot`). */
export interface SyncSnapshot {
  /** Encrypted `.kdbx` bytes. */
  bytes: number[];
  fingerprint: VaultFingerprint;
}

/** The result of merging a received snapshot (mirrors Rust `MergeResult`). */
export interface MergeResult {
  created: number;
  updated: number;
  locationUpdated: number;
  deleted: number;
  warnings: string[];
  /** Whether anything changed (so the UI knows to save). */
  changed: boolean;
  /** The vault fingerprint after the merge. */
  fingerprint: VaultFingerprint;
}

/** Fingerprint of the open vault, for the pre-transfer metadata exchange. */
export async function syncFingerprint(): Promise<VaultFingerprint> {
  return invoke<VaultFingerprint>("sync_fingerprint");
}

/**
 * Serialize the open vault to encrypted KDBX bytes + fingerprint, for chunked
 * transfer over the data channel. Returns the bytes as a `Uint8Array`.
 */
export async function syncExportSnapshot(): Promise<{
  bytes: Uint8Array;
  fingerprint: VaultFingerprint;
}> {
  const snap = await invoke<SyncSnapshot>("sync_export_snapshot");
  return { bytes: new Uint8Array(snap.bytes), fingerprint: snap.fingerprint };
}

/**
 * Merge a received encrypted snapshot into the open vault (newer-wins, history-
 * preserving). Tries the session key first; `password` is a fallback used when
 * the peer's vault has a different master password.
 */
export async function syncMergeSnapshot(
  bytes: Uint8Array,
  password: string | null = null,
): Promise<MergeResult> {
  return invoke<MergeResult>("sync_merge_snapshot", {
    bytes: Array.from(bytes),
    password,
  });
}

// ── Phase 9: import / export & browser integration ────────────────────────────

/** Which CSV column index feeds each entry field (mirrors Rust `ColumnMapping`). */
export interface ColumnMapping {
  title: number | null;
  username: number | null;
  password: number | null;
  url: number | null;
  notes: number | null;
  otp: number | null;
  tags: number | null;
}

/** One importable entry resolved from a CSV row (mirrors Rust `ImportCandidate`). */
export interface ImportCandidate {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  otp: string;
  tags: string[];
  /** True if an existing entry has the same title + username + URL. */
  duplicate: boolean;
}

/** Analysis of a CSV file against the open database (mirrors Rust `CsvPreview`). */
export interface CsvPreview {
  format: string;
  headers: string[];
  mapping: ColumnMapping;
  candidates: ImportCandidate[];
  total: number;
  duplicateCount: number;
}

/** Outcome of committing an import (mirrors Rust `ImportReport`). */
export interface ImportReport {
  imported: number;
  skipped: number;
}

/** The editable entry-field keys, used to render the mapping UI. */
export const MAPPING_FIELDS: { key: keyof ColumnMapping; label: string }[] = [
  { key: "title", label: "Title" },
  { key: "username", label: "Username" },
  { key: "password", label: "Password" },
  { key: "url", label: "URL" },
  { key: "notes", label: "Notes" },
  { key: "otp", label: "OTP / TOTP" },
  { key: "tags", label: "Tags" },
];

/**
 * Analyse CSV text against the open database: detect format, suggest a column
 * mapping, and flag duplicate rows. Pass `mapping` to reflect user adjustments.
 */
export async function importCsvPreview(
  text: string,
  mapping: ColumnMapping | null = null,
): Promise<CsvPreview> {
  return invoke<CsvPreview>("import_csv_preview", { text, mapping });
}

/** Import CSV rows into a group under the given mapping (optionally skipping dups). */
export async function importCsvApply(
  text: string,
  mapping: ColumnMapping,
  groupUuid: string,
  skipDuplicates: boolean,
): Promise<ImportReport> {
  return invoke<ImportReport>("import_csv_apply", {
    text,
    mapping,
    groupUuid,
    skipDuplicates,
  });
}

/** Preview a KDBX import (merge) without mutating the open vault. */
export async function importKdbxPreview(
  bytes: Uint8Array,
  password: string | null,
  keyFile: string | null,
): Promise<MergeResult> {
  return invoke<MergeResult>("import_kdbx_preview", {
    bytes: Array.from(bytes),
    password,
    keyFile,
  });
}

/** Import a KDBX file by merging it into the open vault. */
export async function importKdbxApply(
  bytes: Uint8Array,
  password: string | null,
  keyFile: string | null,
): Promise<MergeResult> {
  return invoke<MergeResult>("import_kdbx_apply", {
    bytes: Array.from(bytes),
    password,
    keyFile,
  });
}

/** Export the open vault to a fresh `.kdbx` with the chosen settings/password. */
export async function exportKdbx(
  path: string,
  options: CreateOptions,
  password: string | null,
  keyFile: string | null,
): Promise<void> {
  await invoke("export_kdbx", { path, options, password, keyFile });
}

/** Rank vault entries whose URL matches a page URL (BRW-03; no secrets returned). */
export async function matchUrl(url: string, limit = 10): Promise<EntrySummary[]> {
  return invoke<EntrySummary[]>("match_url", { url, limit });
}

/** Status of the localhost browser-integration HTTP server (mirrors `ServerStatus`). */
export interface BrowserServerStatus {
  running: boolean;
  port: number;
  token: string;
}

/** Read the browser-integration server status. */
export async function browserServerStatus(): Promise<BrowserServerStatus> {
  return invoke<BrowserServerStatus>("browser_server_status");
}

/** Start the localhost browser-integration server (token auto-generated if omitted). */
export async function browserServerStart(
  port: number | null = null,
  token: string | null = null,
): Promise<BrowserServerStatus> {
  return invoke<BrowserServerStatus>("browser_server_start", { port, token });
}

/** Stop the browser-integration server. */
export async function browserServerStop(): Promise<void> {
  await invoke("browser_server_stop");
}

/** Write a ready-to-load browser extension + native-host manifest into `dir`. */
export async function exportBrowserExtension(dir: string): Promise<void> {
  await invoke("export_browser_extension", { dir });
}

/** Register the native-messaging host manifest (Windows-only; errors elsewhere). */
export async function registerNativeHost(manifestPath: string): Promise<void> {
  await invoke("register_native_host", { manifestPath });
}
