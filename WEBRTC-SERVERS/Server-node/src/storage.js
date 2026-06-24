/**
 * @module storage
 * @description File reader/writer & directory watcher for the KDBX vault files.
 *
 * Responsibilities:
 * - Read KDBX files and their metadata (mtime) dynamically by filename.
 * - Write incoming vault files atomically (write-to-tmp → rename).
 * - Preserve the remote mtime via fs.utimes to keep LWW consistent.
 * - Watch the entire storage directory for any `.kdbx` file changes.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { watch } from 'chokidar';
import config from './config.js';
import log from './logger.js';

const TAG = 'storage';

/**
 * Suffix appended to retained backup revisions, e.g. `vault.kdbx.1718870400000.bak`.
 * The embedded number is the epoch-ms mtime of the revision being preserved,
 * which keeps revisions sortable by recency and avoids the `.kdbx` glob the
 * watcher listens on (so backups never trigger a sync).
 */
const BACKUP_SUFFIX = '.bak';

/**
 * Last known mtime map (filename -> epoch ms).
 * Used to suppress duplicate change events triggered by our own writes.
 * @type {Map<string, number>}
 */
const lastKnownMtimes = new Map();

/**
 * @callback OnLocalChangeCallback
 * @param {string} filename
 * @param {Buffer} fileData
 * @param {number} mtime - Epoch ms.
 * @returns {void}
 */

/** @type {OnLocalChangeCallback | null} */
let onLocalChangeCallback = null;

/** @type {import('chokidar').FSWatcher | null} */
let watcher = null;

/**
 * Debounce timers per file.
 * @type {Map<string, NodeJS.Timeout>}
 */
const debounceTimers = new Map();

/**
 * Queues per file to serialize write operations.
 * @type {Map<string, Promise<any>>}
 */
const writeQueues = new Map();

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

/**
 * Initialise the storage layer.
 * - Ensures the storage directory exists.
 * - Reads all existing file mtimes.
 * - Starts the file-system watcher.
 *
 * @returns {Promise<void>}
 */
export async function init() {
  await fs.mkdir(config.storageDir, { recursive: true });
  log.info(TAG, 'Storage directory ensured', { dir: config.storageDir });

  // Read existing KDBX files in the directory.
  try {
    const files = await fs.readdir(config.storageDir);
    for (const file of files) {
      if (file.endsWith('.kdbx') && !file.endsWith('.tmp')) {
        const filePath = path.join(config.storageDir, file);
        const stat = await fs.stat(filePath);
        lastKnownMtimes.set(file, stat.mtimeMs);
        log.info(TAG, 'Existing KDBX file found', { file, mtime: stat.mtimeMs });
      }
    }
  } catch (err) {
    log.error(TAG, 'Error scanning storage directory', { error: err.message });
  }

  startWatcher();
}

/**
 * Get the current local file metadata.
 * @param {string} filename
 * @returns {Promise<{ lastModified: number, filename: string, size: number } | null>}
 *   `null` when the file does not exist.
 */
export async function getMetadata(filename) {
  const filePath = path.join(config.storageDir, filename);
  try {
    const stat = await fs.stat(filePath);
    return {
      lastModified: stat.mtimeMs,
      filename,
      size: stat.size,
    };
  } catch {
    return null;
  }
}

/**
 * Get metadata for all `.kdbx` files in the storage directory.
 * @returns {Promise<Array<{ lastModified: number, filename: string, size: number }>>}
 */
export async function getAllMetadata() {
  const metadataList = [];
  try {
    const files = await fs.readdir(config.storageDir);
    for (const file of files) {
      if (file.endsWith('.kdbx') && !file.endsWith('.tmp')) {
        const meta = await getMetadata(file);
        if (meta) metadataList.push(meta);
      }
    }
  } catch (err) {
    log.error(TAG, 'Failed to list all metadata', { error: err.message });
  }
  return metadataList;
}

/**
 * Read a specific file as a raw Buffer.
 * @param {string} filename
 * @returns {Promise<Buffer | null>}
 */
export async function readFile(filename) {
  const filePath = path.join(config.storageDir, filename);
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

/**
 * Atomically write incoming vault data.
 *
 * 1. Backs up the existing revision (if any) before overwriting.
 * 2. Writes to a `.tmp` sibling file.
 * 3. Renames the tmp file over the real file (atomic on POSIX).
 * 4. Sets the file mtime to the provided remote timestamp.
 *
 * @param {string} filename
 * @param {Buffer} data          - Raw file content.
 * @param {number} remoteMtime   - Epoch ms timestamp from the remote peer.
 * @returns {Promise<void>}
 */
export function writeFile(filename, data, remoteMtime) {
  const current = writeQueues.get(filename) || Promise.resolve();

  const next = current.then(async () => {
    const filePath = path.join(config.storageDir, filename);
    const tmpPath = `${filePath}.tmp`;

    log.info(TAG, 'Atomic write start', { filename, size: data.length, remoteMtime });

    // Preserve the revision currently on disk before it is overwritten.
    // First pull of a new file has nothing to back up — handled inside.
    await backupExisting(filename, filePath);

    await fs.writeFile(tmpPath, data);
    await fs.rename(tmpPath, filePath);

    // Preserve the remote mtime so LWW comparisons stay consistent.
    const secs = remoteMtime / 1000;
    await fs.utimes(filePath, secs, secs);

    // Update the local sentinel so the watcher ignores this rename event.
    lastKnownMtimes.set(filename, remoteMtime);

    log.info(TAG, 'Atomic write complete', { filename, mtime: remoteMtime });
  });

  const cleanChain = next.catch(() => {}).then(() => {
    if (writeQueues.get(filename) === cleanChain) {
      writeQueues.delete(filename);
    }
  });

  writeQueues.set(filename, cleanChain);

  return next;
}

/**
 * Register a callback that fires when any KDBX file is modified locally.
 *
 * @param {OnLocalChangeCallback} cb
 */
export function onLocalChange(cb) {
  onLocalChangeCallback = cb;
}

/**
 * Return the last known local mtime (epoch ms) for a specific file.
 * @param {string} filename
 * @returns {number}
 */
export function getLastKnownMtime(filename) {
  return lastKnownMtimes.get(filename) ?? 0;
}

/**
 * Tear down the watcher (used for graceful shutdown).
 * @returns {Promise<void>}
 */
export async function destroy() {
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();

  if (watcher) {
    await watcher.close();
    watcher = null;
    log.info(TAG, 'File watcher closed');
  }
}

/* ------------------------------------------------------------------ */
/*  Internals                                                         */
/* ------------------------------------------------------------------ */

/**
 * Copy the revision currently on disk to a timestamped backup, then prune
 * old backups down to `config.backupRetention`.
 *
 * No-ops when retention is disabled (0) or when the file does not yet exist
 * (a first-time pull has no prior revision to preserve).
 *
 * @param {string} filename
 * @param {string} filePath - Absolute path of the live file about to be overwritten.
 * @returns {Promise<void>}
 */
async function backupExisting(filename, filePath) {
  if (config.backupRetention <= 0) return;

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    // File does not exist yet — nothing to back up.
    return;
  }

  const ts = Math.round(stat.mtimeMs);
  const backupName = `${filename}.${ts}${BACKUP_SUFFIX}`;
  const backupPath = path.join(config.storageDir, backupName);

  try {
    await fs.copyFile(filePath, backupPath);
    // Keep the backup's mtime aligned with the revision it represents.
    const secs = stat.mtimeMs / 1000;
    await fs.utimes(backupPath, secs, secs);
    log.info(TAG, 'Backup created', { filename, backup: backupName, size: stat.size });
  } catch (err) {
    // A backup failure must not block the pull from completing.
    log.error(TAG, 'Failed to create backup', { filename, error: err.message });
    return;
  }

  await pruneBackups(filename);
}

/**
 * Delete the oldest backups for a file so that at most `config.backupRetention`
 * remain. Newest revisions (highest embedded timestamp) are kept.
 *
 * @param {string} filename
 * @returns {Promise<void>}
 */
async function pruneBackups(filename) {
  const prefix = `${filename}.`;
  try {
    const files = await fs.readdir(config.storageDir);
    const backups = files
      .filter((f) => f.startsWith(prefix) && f.endsWith(BACKUP_SUFFIX))
      .map((f) => ({
        name: f,
        ts: Number(f.slice(prefix.length, -BACKUP_SUFFIX.length)),
      }))
      .filter((b) => Number.isFinite(b.ts))
      .sort((a, b) => b.ts - a.ts); // newest first

    for (const stale of backups.slice(config.backupRetention)) {
      try {
        await fs.unlink(path.join(config.storageDir, stale.name));
        log.info(TAG, 'Pruned old backup', { filename, backup: stale.name });
      } catch (err) {
        log.error(TAG, 'Failed to prune backup', { backup: stale.name, error: err.message });
      }
    }
  } catch (err) {
    log.error(TAG, 'Failed to enumerate backups for pruning', { filename, error: err.message });
  }
}

/**
 * Start watching the storage directory for any .kdbx file changes.
 * Uses chokidar for cross-platform reliability.
 */
function startWatcher() {
  // Watch all .kdbx files inside storageDir
  const watchPattern = path.join(config.storageDir, '*.kdbx').replace(/\\/g, '/');

  watcher = watch(watchPattern, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  watcher.on('change', handleChange);
  watcher.on('add', handleChange);
  watcher.on('error', (err) => log.error(TAG, 'Watcher error', { error: err.message }));

  log.info(TAG, 'File watcher started', { watching: watchPattern });
}

/**
 * Handle a filesystem change event.
 * Debounces per file and checks mtime to skip self-triggered writes.
 *
 * @param {string} filePath
 */
async function handleChange(filePath) {
  const filename = path.basename(filePath);
  if (filename.endsWith('.tmp')) return;

  const existingTimer = debounceTimers.get(filename);
  if (existingTimer) clearTimeout(existingTimer);

  debounceTimers.set(
    filename,
    setTimeout(async () => {
      debounceTimers.delete(filename);
      try {
        const stat = await fs.stat(filePath);
        const newMtime = stat.mtimeMs;
        const lastMtime = lastKnownMtimes.get(filename) ?? 0;

        // Skip if mtime is unchanged (our own atomic write).
        if (newMtime === lastMtime) {
          log.debug(TAG, 'Ignored self-triggered change event', { filename, mtime: newMtime });
          return;
        }

        lastKnownMtimes.set(filename, newMtime);
        log.info(TAG, 'Local KDBX modification detected', { filename, mtime: newMtime, size: stat.size });

        if (onLocalChangeCallback) {
          const data = await fs.readFile(filePath);
          onLocalChangeCallback(filename, data, newMtime);
        }
      } catch (err) {
        log.error(TAG, 'Error processing change event', { filename, error: err.message });
      }
    }, 500)
  );
}
