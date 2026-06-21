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
