/**
 * backup — retain previous vault revisions when a newer file is pulled.
 *
 * Mirrors the mobile `backupService` and the server-node `storage.backupExisting`
 * / `pruneBackups`: before a pulled (or remote-applied) file overwrites the
 * local vault, the current on-disk revision is copied into a user-chosen
 * directory as
 *
 *     <filename>.<mtime>.bak     e.g.  Passwords.kdbx.1718870400000.bak
 *
 * where `<mtime>` is the epoch-ms logical clock of the revision being
 * preserved. The embedded timestamp keeps revisions sortable by recency. The
 * latest file always keeps the original vault filename — only retained backups
 * are renamed.
 *
 * Backups are best-effort: a failure here must never block a pull from
 * completing (matching the server node).
 */

import {
  deleteFile,
  listDir,
  writeFileAtomic,
} from "@/services/tauri";
import { useSettingsStore } from "@/stores/settingsStore";

const TAG = "[backup]";

/** Suffix appended to retained backup revisions (matches server node + mobile). */
const BACKUP_SUFFIX = ".bak";

/** Bounds for the retention count exposed in settings. */
export const MIN_BACKUP_RETENTION = 1;
export const MAX_BACKUP_RETENTION = 50;
export const DEFAULT_BACKUP_RETENTION = 3;

/** Clamp the retention count to the supported range. */
export function clampRetention(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_BACKUP_RETENTION;
  return Math.min(
    MAX_BACKUP_RETENTION,
    Math.max(MIN_BACKUP_RETENTION, Math.round(n)),
  );
}

/**
 * Join `dir` and `name` with the separator the chosen directory already uses,
 * falling back to the platform convention. The desktop lets users pick any
 * folder (Windows or POSIX), so we can't assume a single separator.
 */
function joinPath(dir: string, name: string): string {
  const trimmed = dir.replace(/[\\/]+$/, "");
  const sep = trimmed.includes("\\") && !trimmed.includes("/") ? "\\" : "/";
  return `${trimmed}${sep}${name}`;
}

/**
 * Back up the current local revision before it is overwritten by a newer pull.
 *
 * No-ops when backups are disabled, no directory is configured, retention is
 * non-positive, or there is no prior content to preserve.
 *
 * @param filename      Basename of the vault file, e.g. "Passwords.kdbx".
 * @param oldContent    Bytes of the revision currently on disk (about to be
 *                      overwritten). Empty/undefined skips the backup.
 * @param oldMtime      Epoch-ms logical clock of the revision being preserved.
 */
export async function backupPulledRevision(
  filename: string,
  oldContent: Uint8Array | null | undefined,
  oldMtime: number,
): Promise<void> {
  const { backup } = useSettingsStore.getState().settings;
  const { enabled, dir, retention } = backup;

  if (!enabled || !dir || retention <= 0) return;
  if (!oldContent || oldContent.length === 0) return;

  const ts = Math.round(oldMtime);
  if (!Number.isFinite(ts) || ts <= 0) {
    console.warn(TAG, "Skipping backup — invalid mtime", { filename, oldMtime });
    return;
  }

  const backupName = `${filename}.${ts}${BACKUP_SUFFIX}`;
  const backupPath = joinPath(dir, backupName);

  try {
    await writeFileAtomic(backupPath, oldContent);
    console.log(TAG, "Backup created", { filename, backup: backupName });
  } catch (e) {
    // A backup failure must not block the pull from completing.
    console.warn(TAG, "Failed to create backup", { filename, error: e });
    return;
  }

  await pruneBackups(filename, dir, retention);
}

/**
 * Delete the oldest backups for a file so at most `retention` remain. Newest
 * revisions (highest embedded timestamp) are kept.
 */
async function pruneBackups(
  filename: string,
  dir: string,
  retention: number,
): Promise<void> {
  const prefix = `${filename}.`;
  try {
    const entries = await listDir(dir);
    const backups = entries
      .filter((e) => e.name.startsWith(prefix) && e.name.endsWith(BACKUP_SUFFIX))
      .map((e) => ({
        path: e.path,
        ts: Number(e.name.slice(prefix.length, -BACKUP_SUFFIX.length)),
      }))
      .filter((b) => Number.isFinite(b.ts))
      .sort((a, b) => b.ts - a.ts); // newest first

    for (const stale of backups.slice(retention)) {
      try {
        await deleteFile(stale.path);
        console.log(TAG, "Pruned old backup", { filename, path: stale.path });
      } catch (e) {
        console.warn(TAG, "Failed to prune backup", {
          path: stale.path,
          error: e,
        });
      }
    }
  } catch (e) {
    console.warn(TAG, "Failed to enumerate backups for pruning", {
      filename,
      error: e,
    });
  }
}
