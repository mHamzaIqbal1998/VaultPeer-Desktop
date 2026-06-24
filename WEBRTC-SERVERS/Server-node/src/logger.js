/**
 * @module logger
 * @description Structured logger with configurable verbosity levels.
 *
 * Writes JSON-formatted log lines to stdout/stderr, which makes it
 * compatible with Docker log drivers and log aggregators out of the box.
 */

import config from './config.js';

const LEVEL_RANK = /** @type {const} */ ({ debug: 0, info: 1, warn: 2, error: 3 });
const threshold = LEVEL_RANK[config.logLevel];

/**
 * Emit a structured log line if the level meets the configured threshold.
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} tag   - Component tag (e.g. 'signaling', 'webrtc', 'storage').
 * @param {string} msg   - Human-readable message.
 * @param {Record<string, unknown>} [meta] - Additional structured data.
 */
function log(level, tag, msg, meta) {
  if (LEVEL_RANK[level] < threshold) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    tag,
    nodeId: config.nodeId,
    msg,
    ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
  };

  const out = level === 'error' ? process.stderr : process.stdout;
  out.write(JSON.stringify(entry) + '\n');
}

export default {
  /** @param {string} tag @param {string} msg @param {Record<string,unknown>} [meta] */
  debug: (tag, msg, meta) => log('debug', tag, msg, meta),
  /** @param {string} tag @param {string} msg @param {Record<string,unknown>} [meta] */
  info: (tag, msg, meta) => log('info', tag, msg, meta),
  /** @param {string} tag @param {string} msg @param {Record<string,unknown>} [meta] */
  warn: (tag, msg, meta) => log('warn', tag, msg, meta),
  /** @param {string} tag @param {string} msg @param {Record<string,unknown>} [meta] */
  error: (tag, msg, meta) => log('error', tag, msg, meta),
};
