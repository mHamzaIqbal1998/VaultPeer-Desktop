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
