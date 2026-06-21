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

/** Sensible defaults targeting a roughly one-second unlock. */
export const DEFAULT_CREATE_OPTIONS: CreateOptions = {
  kdf: "argon2id",
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
 * Open a native save dialog for exporting an attachment to disk.
 * Returns the chosen absolute path, or null if cancelled.
 */
export async function saveAttachmentDialog(
  defaultName: string,
): Promise<string | null> {
  const path = await save({ title: "Export Attachment", defaultPath: defaultName });
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
