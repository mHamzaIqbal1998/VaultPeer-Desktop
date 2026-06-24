/**
 * @module config
 * @description Environment variable configuration & validation.
 *
 * Reads all required and optional environment variables at startup,
 * validates constraints, and exports a frozen configuration object.
 */

import { randomUUID } from "node:crypto";

/**
 * Read an environment variable with an optional default.
 * @param {string} name  - Variable name.
 * @param {string} [fallback] - Default if the variable is not set.
 * @returns {string}
 */
function env(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    console.error(
      `[config] FATAL: Required environment variable "${name}" is not set.`,
    );
    process.exit(1);
  }
  return value;
}

const LOG_LEVELS = /** @type {const} */ (["debug", "info", "warn", "error"]);

/** @type {typeof LOG_LEVELS[number]} */
const logLevel = /** @type {any} */ (env("LOG_LEVEL", "info"));
if (!LOG_LEVELS.includes(logLevel)) {
  console.error(
    `[config] FATAL: LOG_LEVEL must be one of: ${LOG_LEVELS.join(", ")}`,
  );
  process.exit(1);
}

// Number of previous revisions to retain when a pulled file overwrites an
// existing one. 0 disables backups entirely.
const backupRetention = Number.parseInt(env("BACKUP_RETENTION", "5"), 10);
if (!Number.isInteger(backupRetention) || backupRetention < 0) {
  console.error(
    `[config] FATAL: BACKUP_RETENTION must be a non-negative integer.`,
  );
  process.exit(1);
}

/**
 * @typedef {Object} Config
 * @property {string} signalingUrl  - WebSocket URL of the signaling server.
 * @property {string} vaultId       - Room / Vault identifier for peer grouping.
 * @property {string} storageDir    - Absolute path to the KDBX storage directory.
 * @property {string} kdbxFilename  - Name of the KeePass database file.
 * @property {string} nodeId        - Unique identifier for this node instance.
 * @property {typeof LOG_LEVELS[number]} logLevel
 * @property {string} iceServers    - JSON string of ICE servers.
 * @property {number} backupRetention - Number of previous revisions to keep on overwrite.
 */

/** @type {Readonly<Config>} */
const config = Object.freeze({
  signalingUrl: env("SIGNALING_URL", "wss://phonebook.hamzas.duckdns.org"),
  vaultId: env("VAULT_ID"),
  storageDir: env("STORAGE_DIR", "/data"),
  kdbxFilename: env("KDBX_FILENAME", "vault.kdbx"),
  nodeId: `node_${randomUUID().slice(0, 8)}`,
  logLevel,
  iceServers: env("ICE_SERVERS", ""),
  backupRetention,
});

export default config;
