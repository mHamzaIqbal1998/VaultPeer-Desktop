/**
 * @module index
 * @description App entry point — orchestrates WebSocket signaling,
 * WebRTC peer connections, and the KDBX sync protocol.
 *
 * Sync protocol messages flow over WebRTC data channels:
 *   metadata_query  → asks a peer for its file metadata
 *   metadata_info   → responds with local file metadata
 *   pull_request    → asks a peer to send the actual file
 *   pull_response   → contains the base64-encoded KDBX file
 *   push_request    → proactively pushes a new file to a peer
 *   push_response   → acknowledges a push
 */

import config from "./config.js";
import log from "./logger.js";
import * as signaling from "./signaling.js";
import * as storage from "./storage.js";
import * as webrtc from "./webrtc.js";

const TAG = "sync";

/** @type {NodeJS.Timeout | null} */
let peerLogInterval = null;

/* ------------------------------------------------------------------ */
/*  Sync protocol handlers                                            */
/* ------------------------------------------------------------------ */

/**
 * Handle a data-channel message from a connected peer.
 * Routes the message to the appropriate sync handler based on `msg.type`.
 *
 * @param {string} peerId
 * @param {Record<string, unknown>} msg
 */
async function handleDataChannelMessage(peerId, msg) {
  switch (msg.type) {
    case "metadata_query":
      await handleMetadataQuery(peerId, msg);
      break;
    case "metadata_info":
      await handleMetadataInfo(peerId, msg);
      break;
    case "pull_request":
      await handlePullRequest(peerId, msg);
      break;
    case "pull_response":
      await handlePullResponse(peerId, msg);
      break;
    case "push_request":
      await handlePushRequest(peerId, msg);
      break;
    case "push_response":
      handlePushResponse(peerId, msg);
      break;
    case "metadata_complete":
      // Acknowledged — server doesn't need to act on this
      break;
    case "sync_complete":
      log.info(TAG, `sync_complete from ${peerId} for "${msg.filename}"`, {
        lastModified: msg.lastModified,
      });
      break;
    default:
      log.warn(TAG, `Unknown DC message type: ${msg.type}`, { peerId });
  }
}

/**
 * A peer asked us for our file metadata → respond with `metadata_info` for all files.
 * @param {string} peerId
 * @param {Record<string, unknown>} msg
 */
async function handleMetadataQuery(peerId, msg) {
  log.info(TAG, `metadata_query from ${peerId}`);

  const metadataList = await storage.getAllMetadata();
  if (metadataList.length === 0) {
    log.info(TAG, "No local files to advertise in response to metadata_query");
  } else {
    for (const meta of metadataList) {
      webrtc.sendToPeer(peerId, {
        type: "metadata_info",
        filename: meta.filename,
        lastModified: meta.lastModified,
        size: meta.size,
      });
    }
  }

  // Signal that we have finished sending all our file metadata
  webrtc.sendToPeer(peerId, { type: "metadata_complete" });
}

/**
 * We received a peer's file metadata.
 * If their file is newer than ours, or we do not have it, issue a `pull_request`.
 *
 * @param {string} peerId
 * @param {Record<string, unknown>} msg
 */
async function handleMetadataInfo(peerId, msg) {
  const filename = /** @type {string} */ (msg.filename);
  if (!filename) {
    log.warn(TAG, "Received metadata_info without filename from peer", {
      peerId,
    });
    return;
  }

  const remoteMtime = /** @type {number} */ (msg.lastModified);
  const localMtime = storage.getLastKnownMtime(filename);

  log.info(TAG, `metadata_info from ${peerId} for "${filename}"`, {
    remoteMtime,
    localMtime,
    remoteSize: msg.size,
  });

  if (remoteMtime - localMtime > 1000) {
    log.info(
      TAG,
      `Peer ${peerId} has a newer or missing file "${filename}" — pulling`,
      {
        delta: localMtime > 0 ? remoteMtime - localMtime : "new file",
      },
    );
    webrtc.sendToPeer(peerId, {
      type: "pull_request",
      filename,
    });
  } else {
    log.info(
      TAG,
      `Our file "${filename}" is up to date (or newer) — no pull needed`,
    );
  }
}

/**
 * A peer wants a file → read it and send a `pull_response`.
 * @param {string} peerId
 * @param {Record<string, unknown>} msg
 */
async function handlePullRequest(peerId, msg) {
  const filename = /** @type {string} */ (msg.filename);
  if (!filename) {
    log.warn(TAG, "Received pull_request without filename from peer", {
      peerId,
    });
    return;
  }

  log.info(TAG, `pull_request from ${peerId} for "${filename}"`);

  const data = await storage.readFile(filename);
  if (!data) {
    log.warn(
      TAG,
      `pull_request received for "${filename}" but file does not exist locally`,
    );
    return;
  }

  const meta = await storage.getMetadata(filename);
  webrtc.sendToPeer(peerId, {
    type: "pull_response",
    filename,
    fileData: data.toString("base64"),
    lastModified: meta?.lastModified ?? 0,
  });

  log.info(TAG, `pull_response sent to ${peerId} for "${filename}"`, {
    size: data.length,
  });
}

/**
 * We received a file from a peer in response to our pull request.
 * Write it atomically to disk with the correct mtime.
 *
 * @param {string} peerId
 * @param {Record<string, unknown>} msg
 */
async function handlePullResponse(peerId, msg) {
  const filename = /** @type {string} */ (msg.filename);
  if (!filename) {
    log.warn(TAG, "Received pull_response without filename from peer", {
      peerId,
    });
    return;
  }

  const remoteMtime = /** @type {number} */ (msg.lastModified);
  const fileData = Buffer.from(/** @type {string} */ (msg.fileData), "base64");
  const localMtime = storage.getLastKnownMtime(filename);

  log.info(TAG, `pull_response from ${peerId} for "${filename}"`, {
    size: fileData.length,
    remoteMtime,
    localMtime,
  });

  // LWW: only apply if the incoming data is still newer.
  if (remoteMtime - localMtime > 1000) {
    await storage.writeFile(filename, fileData, remoteMtime);
    log.info(TAG, `File "${filename}" updated from pull_response`);
    // Send sync_complete so the sender's push task can settle
    webrtc.sendToPeer(peerId, {
      type: "sync_complete",
      filename,
      lastModified: remoteMtime,
      status: "success",
      message: "File accepted and written",
    });
  } else {
    log.info(
      TAG,
      `Ignoring pull_response for "${filename}" — a newer write already occurred`,
    );
  }
}

/**
 * A peer proactively pushed a new file to us.
 * Apply if it's newer than our local copy (LWW).
 *
 * @param {string} peerId
 * @param {Record<string, unknown>} msg
 */
async function handlePushRequest(peerId, msg) {
  const filename = /** @type {string} */ (msg.filename);
  if (!filename) {
    log.warn(TAG, "Received push_request without filename from peer", {
      peerId,
    });
    return;
  }

  const remoteMtime = /** @type {number} */ (msg.lastModified);
  const fileData = Buffer.from(/** @type {string} */ (msg.fileData), "base64");
  const localMtime = storage.getLastKnownMtime(filename);

  log.info(TAG, `push_request from ${peerId} for "${filename}"`, {
    size: fileData.length,
    remoteMtime,
    localMtime,
  });

  if (remoteMtime - localMtime > 1000) {
    await storage.writeFile(filename, fileData, remoteMtime);
    webrtc.sendToPeer(peerId, {
      type: "push_response",
      filename,
      status: "success",
      message: "File accepted and written",
    });
    log.info(TAG, `File "${filename}" updated from push_request`);
  } else {
    webrtc.sendToPeer(peerId, {
      type: "push_response",
      filename,
      status: "ignored",
      message: "Local file is newer or identical",
    });
    log.info(
      TAG,
      `push_request for "${filename}" ignored — local file is newer`,
    );
  }
}

/**
 * Acknowledgement from a peer after we pushed a file.
 * @param {string} peerId
 * @param {Record<string, unknown>} msg
 */
function handlePushResponse(peerId, msg) {
  log.info(TAG, `push_response from ${peerId} for "${msg.filename}"`, {
    status: msg.status,
    message: msg.message,
  });
}

/* ------------------------------------------------------------------ */
/*  Data channel open handler — symmetric sync                        */
/* ------------------------------------------------------------------ */

/**
 * Invoked whenever a new data channel opens to a peer.
 * Initiates the metadata exchange so both sides can decide who needs to pull.
 *
 * @param {string} peerId
 */
async function onDataChannelOpen(peerId) {
  log.info(
    TAG,
    `Channel opened — sending metadata query & advertising local files to ${peerId}`,
  );

  // 1. Query peer for their files.
  webrtc.sendToPeer(peerId, { type: "metadata_query" });

  // 2. Advertise our files.
  const metadataList = await storage.getAllMetadata();
  for (const meta of metadataList) {
    webrtc.sendToPeer(peerId, {
      type: "metadata_info",
      filename: meta.filename,
      lastModified: meta.lastModified,
      size: meta.size,
    });
  }

  // 3. Signal end of our metadata batch so the peer can flush its deferred
  //    advertisement and proceed with pulling/pushing as needed.
  webrtc.sendToPeer(peerId, { type: "metadata_complete" });
}

/* ------------------------------------------------------------------ */
/*  File watcher handler — push on local edit                         */
/* ------------------------------------------------------------------ */

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const pendingPushTimers = new Map();

const PUSH_DEBOUNCE_MS = 500;

/**
 * Invoked by the storage watcher when any local KDBX file is modified.
 * Broadcasts a `push_request` to all connected peers with debouncing
 * to prevent redundant pushes during rapid successive saves.
 *
 * @param {string} filename
 * @param {Buffer} fileData
 * @param {number} mtime
 */
function onLocalFileChange(filename, fileData, mtime) {
  // Clear any pending push for this file
  const existingTimer = pendingPushTimers.get(filename);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Debounce: wait for rapid successive changes to settle
  const timer = setTimeout(() => {
    pendingPushTimers.delete(filename);

    const peerCount = webrtc.getConnectedPeers().length;
    if (peerCount === 0) {
      log.info(
        TAG,
        `Local file "${filename}" changed but no peers connected — skipping push`,
      );
      return;
    }

    log.info(
      TAG,
      `Local file "${filename}" changed — broadcasting push_request to ${peerCount} peer(s)`,
      {
        mtime,
        size: fileData.length,
      },
    );

    webrtc.broadcast({
      type: "push_request",
      filename,
      fileData: fileData.toString("base64"),
      lastModified: mtime,
    });
  }, PUSH_DEBOUNCE_MS);

  pendingPushTimers.set(filename, timer);
}

/* ------------------------------------------------------------------ */
/*  Bootstrap                                                         */
/* ------------------------------------------------------------------ */

async function main() {
  log.info(TAG, "═══════════════════════════════════════════");
  log.info(TAG, "  VaultPeer Server Node starting");
  log.info(TAG, "═══════════════════════════════════════════");
  log.info(TAG, "Configuration", {
    nodeId: config.nodeId,
    vaultId: config.vaultId,
    signalingUrl: config.signalingUrl,
    storageDir: config.storageDir,
    logLevel: config.logLevel,
  });

  // Phase 1: Storage
  await storage.init();
  storage.onLocalChange(onLocalFileChange);

  // Phase 2: WebRTC
  webrtc.init();
  webrtc.onDataChannelMessage(handleDataChannelMessage);
  webrtc.onDataChannelOpen(onDataChannelOpen);

  // Phase 2: Signaling
  signaling.onMessage((msg) => webrtc.handleSignalingMessage(msg));
  signaling.onConnected(() => {
    log.info(TAG, "Signaling connected — ready for peer handshakes");
  });
  signaling.connect();

  log.info(TAG, "Node is running — waiting for peers");

  // Log the number of connected peers every 15 seconds
  peerLogInterval = setInterval(() => {
    const peerCount = webrtc.getConnectedPeers().length;
    log.info(TAG, `Connected peers: ${peerCount}`);
  }, 15000);
}

/* ------------------------------------------------------------------ */
/*  Graceful shutdown                                                 */
/* ------------------------------------------------------------------ */

async function shutdown(signal) {
  log.info(TAG, `Received ${signal} — shutting down gracefully`);

  if (peerLogInterval) {
    clearInterval(peerLogInterval);
    peerLogInterval = null;
  }

  // Clear any pending push debounce timers
  for (const [filename, timer] of pendingPushTimers) {
    clearTimeout(timer);
    log.debug(TAG, `Cleared pending push timer for ${filename}`);
  }
  pendingPushTimers.clear();

  signaling.disconnect();
  webrtc.destroy();
  await storage.destroy();

  log.info(TAG, "Shutdown complete");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (err) => {
  log.error(TAG, "Uncaught exception", {
    error: err.message,
    stack: err.stack,
  });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log.error(TAG, "Unhandled rejection", { reason: String(reason) });
  process.exit(1);
});

main().catch((err) => {
  log.error(TAG, "Fatal startup error", {
    error: err.message,
    stack: err.stack,
  });
  process.exit(1);
});
