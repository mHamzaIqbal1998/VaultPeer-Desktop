/**
 * @module webrtc
 * @description WebRTC PeerConnection manager using node-datachannel.
 *
 * Manages the full lifecycle of peer connections:
 * 1. Receives `announce` messages from signaling → decides offerer/answerer
 *    using a string-comparison tie-breaker (polite/impolite).
 * 2. Creates / accepts SDP offers & ICE candidates.
 * 3. Opens a "vault-sync" data channel per peer.
 * 4. Delegates data-channel messages to the sync protocol handler.
 *
 * Each remote peer is tracked in a Map keyed by its senderId.
 */

import nodeDataChannel from "node-datachannel";
import { createHash } from "node:crypto";
import config from "./config.js";
import log from "./logger.js";
import * as signaling from "./signaling.js";

const TAG = "webrtc";

/** Default STUN servers for ICE gathering. */
const DEFAULT_ICE_SERVERS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
];

/**
 * Normalises standard WebRTC ICE server configurations to the format expected by node-datachannel.
 *
 * @param {Array<string | Record<string, any>>} servers
 * @returns {Array<string | import('node-datachannel').IceServer>}
 */
function normalizeIceServers(servers) {
  const normalized = [];
  for (const server of servers) {
    if (typeof server === "string") {
      normalized.push(server);
      continue;
    }

    if (server && typeof server === "object") {
      if (
        typeof server.hostname === "string" &&
        typeof server.port === "number"
      ) {
        normalized.push(server);
        continue;
      }

      const urls = Array.isArray(server.urls)
        ? server.urls
        : typeof server.urls === "string"
          ? [server.urls]
          : [];
      for (const url of urls) {
        try {
          const match = url.match(
            /^(stun|stuns|turn|turns):([^:?]+)(?::(\d+))?(?:\?(.+))?$/i,
          );
          if (!match) {
            if (!server.username && !server.credential) {
              normalized.push(url);
            } else {
              log.warn(TAG, `Could not parse ICE server URL: ${url}`);
            }
            continue;
          }

          const [, scheme, host, portStr, query] = match;
          const port = portStr
            ? parseInt(portStr, 10)
            : scheme.startsWith("turns")
              ? 443
              : 3478;

          if (scheme.startsWith("turn")) {
            let relayType = "TurnUdp";
            if (query) {
              const params = new URLSearchParams(query);
              const transport = params.get("transport");
              if (transport === "tcp") {
                relayType = scheme === "turns" ? "TurnTls" : "TurnTcp";
              }
            } else if (scheme === "turns") {
              relayType = "TurnTls";
            }

            normalized.push({
              hostname: host,
              port,
              username: server.username || "",
              password: server.credential || server.password || "",
              relayType,
            });
          } else {
            if (server.username || server.credential) {
              normalized.push({
                hostname: host,
                port,
                username: server.username || "",
                password: server.credential || server.password || "",
              });
            } else {
              normalized.push(url);
            }
          }
        } catch (err) {
          log.warn(TAG, `Failed to normalize ICE server URL: ${url}`, {
            error: err.message,
          });
        }
      }
    }
  }
  // Group and deduplicate by hostname to avoid concurrent allocations to the same host
  const getHost = (item) => {
    if (typeof item === "string") {
      const match = item.match(/^(?:stun|stuns|turn|turns):([^:?]+)/i);
      return match ? match[1].toLowerCase() : item.toLowerCase();
    }
    return (item.hostname || "").toLowerCase();
  };

  const getPriority = (item) => {
    if (typeof item === "string") {
      if (item.startsWith("turns:")) return 0;
      if (item.startsWith("turn:") && item.includes("transport=tcp")) return 1;
      if (item.startsWith("turn:")) return 2;
      return 3;
    }
    if (item.relayType === "TurnTls") return 0;
    if (item.relayType === "TurnTcp") return 1;
    if (item.relayType === "TurnUdp") return 2;
    return 3;
  };

  const groups = new Map();
  for (const item of normalized) {
    const host = getHost(item);
    if (!groups.has(host)) {
      groups.set(host, []);
    }
    groups.get(host).push(item);
  }

  const deduplicated = [];
  groups.forEach((items) => {
    items.sort((a, b) => getPriority(a) - getPriority(b));
    if (items[0]) {
      deduplicated.push(items[0]);
    }
  });

  // Filter out redundant STUNs if TURN is present for the same provider domain
  const hasTurn = deduplicated.some(
    (item) =>
      (typeof item === "string" && item.startsWith("turn")) ||
      (typeof item === "object" && item.relayType),
  );

  if (hasTurn) {
    const turnDomains = deduplicated
      .filter(
        (item) =>
          (typeof item === "string" && item.startsWith("turn")) ||
          (typeof item === "object" && item.relayType),
      )
      .map((item) => {
        const host = getHost(item);
        return host.replace(/^(?:standard|stun|turn|relay)\./, "");
      });

    return deduplicated.filter((item) => {
      const isStunOnly =
        (typeof item === "string" && item.startsWith("stun")) ||
        (typeof item === "object" && !item.relayType);
      if (!isStunOnly) return true;
      const host = getHost(item);
      const stunDomain = host.replace(/^(?:standard|stun|turn|relay)\./, "");
      const isDuplicate = turnDomains.some(
        (td) => stunDomain.includes(td) || td.includes(stunDomain),
      );
      if (isDuplicate) {
        log.info(
          TAG,
          `Filtering out redundant STUN server: ${typeof item === "string" ? item : item.hostname}`,
        );
        return false;
      }
      return true;
    });
  }

  return deduplicated;
}

let ICE_SERVERS = DEFAULT_ICE_SERVERS;
if (config.iceServers) {
  try {
    const parsed = JSON.parse(config.iceServers);
    if (Array.isArray(parsed)) {
      const custom = normalizeIceServers(parsed);
      const hasTurn = custom.some((s) => typeof s === "object" && s.relayType);
      ICE_SERVERS = hasTurn ? custom : [DEFAULT_ICE_SERVERS[0], ...custom];
      log.info(
        TAG,
        `Loaded and normalized ${ICE_SERVERS.length} ICE servers from configuration (hasCustomTurn: ${hasTurn})`,
      );
    } else {
      log.warn(
        TAG,
        "ICE_SERVERS configuration is not a JSON array, falling back to default STUN",
      );
    }
  } catch (err) {
    log.warn(
      TAG,
      "Failed to parse ICE_SERVERS configuration, falling back to default STUN",
      { error: err.message },
    );
  }
}

/** Grace period (ms) before cleaning up a peer in 'failed' state.
 *  Must be long enough to allow the offerer's ICE restart offer to arrive. */
const FAILED_GRACE_MS = 15_000;

/**
 * @typedef {Object} PeerState
 * @property {import('node-datachannel').PeerConnection} pc
 * @property {import('node-datachannel').DataChannel | null} dc
 * @property {boolean} isOfferer
 * @property {boolean} remoteDescriptionSet
 * @property {Array<{candidate: string, mid: string}>} candidateQueue
 */

/** @type {Map<string, PeerState>} */
const peers = new Map();

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const failedTimers = new Map();

/**
 * @callback DataChannelMessageHandler
 * @param {string} peerId
 * @param {Record<string, unknown>} message
 * @returns {void}
 */

/**
 * @callback DataChannelOpenHandler
 * @param {string} peerId
 * @returns {void}
 */

/** @type {DataChannelMessageHandler | null} */
let onMessageCallback = null;

/** @type {DataChannelOpenHandler | null} */
let onOpenCallback = null;

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

/**
 * Initialise the WebRTC manager.
 * Sets the node-datachannel log level to match our application config.
 */
export function init() {
  // Map application log level to native node-datachannel log level.
  // Use 'Error' or 'None' for standard runs to avoid harmless libjuice/STUN warnings.
  let ndcLogLevel = "None";
  if (config.logLevel === "debug") {
    ndcLogLevel = "Debug";
  } else if (config.logLevel === "info") {
    ndcLogLevel = "Error";
  }
  nodeDataChannel.initLogger(ndcLogLevel);
  log.info(TAG, "WebRTC manager initialised");
}

/**
 * Register a handler for data channel messages (parsed JSON).
 * @param {DataChannelMessageHandler} handler
 */
export function onDataChannelMessage(handler) {
  onMessageCallback = handler;
}

/**
 * Register a handler invoked when a data channel opens to a peer.
 * @param {DataChannelOpenHandler} handler
 */
export function onDataChannelOpen(handler) {
  onOpenCallback = handler;
}

/**
 * Process an inbound signaling message and route it to the
 * appropriate WebRTC handler.
 *
 * @param {Record<string, unknown>} msg
 */
export function handleSignalingMessage(msg) {
  const { type } = msg;

  switch (type) {
    case "announce":
      handleAnnounce(msg);
      break;
    case "offer":
      handleOffer(msg);
      break;
    case "answer":
      handleAnswer(msg);
      break;
    case "candidate":
      handleCandidate(msg);
      break;
    default:
      // Ignore message types we don't care about (e.g. join confirmations).
      log.debug(TAG, `Ignoring signaling message type: ${type}`);
  }
}

/** @type {Map<string, { filename: string, totalChunks: number, lastModified: number, msgType: string, sha256: string, chunks: string[], receivedCount: number, lastActivity: number }>} */
const activeTransfers = new Map();

/** Stale transfer cleanup interval (ms). */
const STALE_TRANSFER_TIMEOUT_MS = 30_000;

/** Per-peer transfer generation counter to prevent interleaved chunks. */
const transferGenerations = new Map();

// Periodically clean up stale transfers to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [transferId, transfer] of activeTransfers) {
    if (now - transfer.lastActivity > STALE_TRANSFER_TIMEOUT_MS) {
      log.warn(
        TAG,
        `Cleaning up stale transfer ${transferId} for "${transfer.filename}" (${transfer.receivedCount}/${transfer.totalChunks} chunks, inactive ${Math.round((now - transfer.lastActivity) / 1000)}s)`,
      );
      activeTransfers.delete(transferId);
    }
  }
}, STALE_TRANSFER_TIMEOUT_MS / 2);

/**
 * Safely send a raw message over a node-datachannel DataChannel.
 * @param {import('node-datachannel').DataChannel} dc
 * @param {Record<string, unknown>} msg
 * @param {string} peerId
 * @returns {boolean}
 */
function sendRaw(dc, msg, peerId) {
  try {
    dc.sendMessage(JSON.stringify(msg));
    return true;
  } catch (err) {
    log.error(TAG, "Failed to send raw data channel message", {
      peerId,
      error: err.message,
    });
    return false;
  }
}

/**
 * Poll until the data channel's send buffer drains below the threshold (or timeout).
 * @param {import('node-datachannel').DataChannel} dc
 * @param {number} maxBufferedAmount
 * @returns {Promise<boolean>}
 */
async function waitForBufferDrain(dc, maxBufferedAmount) {
  const start = Date.now();
  const timeoutMs = 60000; // 60s timeout
  while (Date.now() - start < timeoutMs) {
    let buffered = 0;
    try {
      if (typeof dc.isOpen === "function" && !dc.isOpen()) {
        return false;
      }
      buffered = dc.bufferedAmount();
    } catch {
      return false; // Channel closed or error
    }
    if (buffered <= maxBufferedAmount) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/**
 * Split a large payload into chunk messages and send them sequentially with backpressure.
 * Includes SHA-256 hash for integrity verification and a generation counter to cancel
 * superseded transfers.
 * @param {import('node-datachannel').DataChannel} dc
 * @param {Record<string, unknown>} msg
 * @param {string} peerId
 * @returns {Promise<boolean>}
 */
async function sendChunkedAsync(dc, msg, peerId) {
  const fileData = /** @type {string} */ (msg.fileData || "");
  const chunkSize = 16384; // 16 KB chunk size
  const totalChunks = Math.ceil(fileData.length / chunkSize);
  const transferId = `${msg.type}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  // Increment generation counter — any previous in-flight transfer for this peer
  // will detect the mismatch and abort.
  const prevGen = transferGenerations.get(peerId) ?? 0;
  const myGen = prevGen + 1;
  transferGenerations.set(peerId, myGen);

  // Compute SHA-256 hash for integrity verification
  let sha256 = "";
  try {
    sha256 = createHash("sha256").update(fileData).digest("hex");
  } catch (err) {
    log.warn(
      TAG,
      `SHA-256 computation failed, sending without hash: ${err.message}`,
    );
  }

  log.info(
    TAG,
    `Starting chunked transfer ${transferId} of type ${msg.type} to ${peerId}. Length: ${fileData.length}, chunks: ${totalChunks}, hash: ${sha256 ? sha256.substring(0, 8) + "…" : "none"}`,
  );

  const startMsg = {
    type: "file_chunk_start",
    transferId,
    filename: msg.filename,
    totalChunks,
    lastModified: msg.lastModified,
    msgType: msg.type,
    sha256,
  };
  if (!sendRaw(dc, startMsg, peerId)) return false;

  // We enforce a 128KB buffer limit to prevent flooding the mobile native bridge
  const MAX_BUFFERED_AMOUNT = 128 * 1024;

  for (let i = 0; i < totalChunks; i++) {
    // Check if a newer transfer has superseded this one
    if (transferGenerations.get(peerId) !== myGen) {
      log.info(
        TAG,
        `Chunked send to ${peerId} superseded by newer transfer (gen ${myGen}). Aborting.`,
      );
      return false;
    }

    let buffered = 0;
    try {
      if (typeof dc.isOpen === "function" && !dc.isOpen()) {
        log.error(
          TAG,
          `Data channel closed during chunked transfer to ${peerId}`,
        );
        return false;
      }
      buffered = dc.bufferedAmount();
    } catch {
      log.error(
        TAG,
        `Data channel closed during chunked transfer to ${peerId}`,
      );
      return false;
    }

    if (buffered > MAX_BUFFERED_AMOUNT) {
      const drained = await waitForBufferDrain(dc, MAX_BUFFERED_AMOUNT);
      if (!drained) {
        log.error(
          TAG,
          `Aborting chunked transfer to ${peerId}: buffer stuck / timed out`,
        );
        return false;
      }
      // Re-check generation after drain
      if (transferGenerations.get(peerId) !== myGen) {
        log.info(
          TAG,
          `Chunked send to ${peerId} superseded after buffer drain (gen ${myGen}). Aborting.`,
        );
        return false;
      }
    }

    const chunkData = fileData.substring(i * chunkSize, (i + 1) * chunkSize);
    const chunkMsg = {
      type: "file_chunk",
      transferId,
      chunkIndex: i,
      chunkData,
    };
    if (!sendRaw(dc, chunkMsg, peerId)) return false;

    // Adaptive pacing: yield every 20 chunks to allow event loop to breathe,
    // but NO fixed delay per chunk. Backpressure handles slow networks.
    if (i > 0 && i % 20 === 0) {
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  const endMsg = {
    type: "file_chunk_end",
    transferId,
  };
  if (!sendRaw(dc, endMsg, peerId)) return false;

  log.info(TAG, `Finished chunked transfer ${transferId} to ${peerId}`);
  return true;
}

/**
 * Send a JSON message over the data channel to a specific peer.
 * @param {string} peerId
 * @param {Record<string, unknown>} msg
 * @returns {boolean} `true` if the message was dispatched/sent.
 */
export function sendToPeer(peerId, msg) {
  const state = peers.get(peerId);
  if (!state?.dc) {
    log.warn(TAG, `No data channel to peer ${peerId} — message dropped`, {
      type: msg.type,
    });
    return false;
  }

  if (msg.type === "pull_response" || msg.type === "push_request") {
    // Fire-and-forget the async chunk transfer so we don't block the caller
    void sendChunkedAsync(state.dc, msg, peerId);
    return true;
  }

  try {
    state.dc.sendMessage(JSON.stringify(msg));
    log.debug(TAG, "Sent data channel message", { peerId, type: msg.type });
    return true;
  } catch (err) {
    log.error(TAG, "Failed to send data channel message", {
      peerId,
      error: err.message,
    });
    return false;
  }
}

/**
 * Broadcast a JSON message to all connected peers with open data channels.
 * @param {Record<string, unknown>} msg
 */
export function broadcast(msg) {
  for (const [peerId, state] of peers) {
    if (state.dc) {
      sendToPeer(peerId, msg);
    }
  }
}

/**
 * Close all peer connections (graceful shutdown).
 */
export function destroy() {
  // Clear all pending failed grace timers
  for (const timer of failedTimers.values()) {
    clearTimeout(timer);
  }
  failedTimers.clear();

  for (const [peerId, state] of peers) {
    try {
      state.dc?.close();
      state.pc.close();
    } catch {
      /* best-effort */
    }
    log.info(TAG, `Peer connection closed: ${peerId}`);
  }
  peers.clear();
  log.info(TAG, "All peer connections destroyed");
}

/**
 * Get the list of currently connected peer IDs.
 * @returns {string[]}
 */
export function getConnectedPeers() {
  const result = [];
  for (const [peerId, state] of peers) {
    if (state.dc) result.push(peerId);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/*  Signaling message handlers                                        */
/* ------------------------------------------------------------------ */

/**
 * Handle an `announce` from a remote peer.
 * Uses a string comparison tie-breaker to decide who creates the offer:
 *   - The peer with the "greater" ID is the **offerer** (impolite).
 *   - The peer with the "lesser"  ID is the **answerer** (polite).
 *
 * @param {Record<string, unknown>} msg
 */
function handleAnnounce(msg) {
  const remotePeerId = /** @type {string} */ (msg.senderId);
  if (remotePeerId === config.nodeId) return; // ignore self

  if (peers.has(remotePeerId)) {
    log.info(
      TAG,
      `Peer announced again: ${remotePeerId} — cleaning up previous connection`,
    );
    cleanupPeer(remotePeerId);
  }

  const weAreOfferer = config.nodeId > remotePeerId;
  log.info(TAG, `Peer announced: ${remotePeerId}`, {
    role: weAreOfferer ? "offerer (impolite)" : "answerer (polite)",
  });

  if (weAreOfferer) {
    createPeerConnection(remotePeerId, true);
  } else {
    log.info(TAG, `Sending targeted announce back to offerer ${remotePeerId}`);
    signaling.send({
      type: "announce",
      senderId: config.nodeId,
      targetId: remotePeerId,
    });
    createPeerConnection(remotePeerId, false);
  }
}

/**
 * Helper to safely extract SDP string from incoming message.
 * Supports:
 * - msg.sdp: "v=0..."
 * - msg.sdp: { sdp: "v=0...", type: "offer" }
 * - msg.offer: { sdp: "v=0...", type: "offer" }
 * - msg.answer: { sdp: "v=0...", type: "answer" }
 *
 * @param {Record<string, unknown>} msg
 * @returns {string}
 */
function getSdpString(msg) {
  // Check msg.sdp first
  if (typeof msg.sdp === "string") return msg.sdp;
  if (msg.sdp && typeof msg.sdp === "object") {
    const obj = /** @type {Record<string, unknown>} */ (msg.sdp);
    if (typeof obj.sdp === "string") return obj.sdp;
  }

  // Check msg.offer
  if (typeof msg.offer === "string") return msg.offer;
  if (msg.offer && typeof msg.offer === "object") {
    const obj = /** @type {Record<string, unknown>} */ (msg.offer);
    if (typeof obj.sdp === "string") return obj.sdp;
  }

  // Check msg.answer
  if (typeof msg.answer === "string") return msg.answer;
  if (msg.answer && typeof msg.answer === "object") {
    const obj = /** @type {Record<string, unknown>} */ (msg.answer);
    if (typeof obj.sdp === "string") return obj.sdp;
  }

  return "";
}

/**
 * Handle an incoming SDP offer.
 * @param {Record<string, unknown>} msg
 */
function handleOffer(msg) {
  const remotePeerId = /** @type {string} */ (msg.senderId);
  const targetId = /** @type {string} */ (msg.targetId);

  // Only process offers addressed to us.
  if (targetId !== config.nodeId) return;

  log.info(TAG, `Received offer from ${remotePeerId}`);

  if (peers.has(remotePeerId)) {
    log.info(
      TAG,
      `Received new offer for existing peer ${remotePeerId} — cleaning up previous connection first`,
    );
    cleanupPeer(remotePeerId);
  }
  createPeerConnection(remotePeerId, false);

  const state = peers.get(remotePeerId);
  if (!state) return;

  const sdpStr = getSdpString(msg);
  if (!sdpStr) {
    log.error(TAG, "Invalid SDP in offer message from peer", {
      remotePeerId,
      msg,
    });
    return;
  }

  try {
    state.pc.setRemoteDescription(sdpStr, "offer");
    state.remoteDescriptionSet = true;
    processQueuedCandidates(remotePeerId, state);
  } catch (err) {
    log.error(TAG, "Failed to set remote description for offer", {
      remotePeerId,
      error: err.message,
    });
  }
}

/**
 * Handle an incoming SDP SDP answer.
 * @param {Record<string, unknown>} msg
 */
function handleAnswer(msg) {
  const remotePeerId = /** @type {string} */ (msg.senderId);
  const targetId = /** @type {string} */ (msg.targetId);

  if (targetId !== config.nodeId) return;

  const state = peers.get(remotePeerId);
  if (!state) {
    log.warn(TAG, `Answer from unknown peer ${remotePeerId}`);
    return;
  }

  log.info(TAG, `Received answer from ${remotePeerId}`);
  const sdpStr = getSdpString(msg);
  if (!sdpStr) {
    log.error(TAG, "Invalid SDP in answer message from peer", {
      remotePeerId,
      msg,
    });
    return;
  }

  try {
    state.pc.setRemoteDescription(sdpStr, "answer");
    state.remoteDescriptionSet = true;
    processQueuedCandidates(remotePeerId, state);
  } catch (err) {
    log.error(TAG, "Failed to set remote description for answer", {
      remotePeerId,
      error: err.message,
    });
  }
}

/**
 * Handle an incoming ICE candidate.
 * @param {Record<string, unknown>} msg
 */
function handleCandidate(msg) {
  const remotePeerId = /** @type {string} */ (msg.senderId);
  const targetId = /** @type {string} */ (msg.targetId);

  if (targetId !== config.nodeId) return;

  const state = peers.get(remotePeerId);
  if (!state) {
    log.warn(TAG, `ICE candidate from unknown peer ${remotePeerId}`);
    return;
  }

  let candidateStr = "";
  let midStr = "";

  if (typeof msg.candidate === "string") {
    candidateStr = msg.candidate;
    midStr = typeof msg.mid === "string" ? msg.mid : "";
  } else if (msg.candidate && typeof msg.candidate === "object") {
    // Handle standard RTCIceCandidate dictionary format
    const candObj = /** @type {Record<string, unknown>} */ (msg.candidate);
    if (typeof candObj.candidate === "string") {
      candidateStr = candObj.candidate;
    }
    if (typeof candObj.sdpMid === "string") {
      midStr = candObj.sdpMid;
    }
  }

  if (!candidateStr) {
    log.warn(TAG, "Empty or invalid ICE candidate format from peer", {
      remotePeerId,
      msg,
    });
    return;
  }

  // If remote description is not set yet, queue the candidate
  if (!state.remoteDescriptionSet) {
    log.debug(
      TAG,
      `Remote description not set yet for ${remotePeerId}. Queueing ICE candidate.`,
    );
    if (!state.candidateQueue) {
      state.candidateQueue = [];
    }
    state.candidateQueue.push({ candidate: candidateStr, mid: midStr });
    return;
  }

  try {
    state.pc.addRemoteCandidate(candidateStr, midStr);
  } catch (err) {
    log.warn(TAG, "Failed to add remote candidate", {
      remotePeerId,
      error: err.message,
    });
  }
}

/**
 * Process any queued remote ICE candidates once remote description has been set.
 * @param {string} remotePeerId
 * @param {PeerState} state
 */
function processQueuedCandidates(remotePeerId, state) {
  if (!state.candidateQueue || state.candidateQueue.length === 0) return;
  log.debug(
    TAG,
    `Processing ${state.candidateQueue.length} queued remote ICE candidates for ${remotePeerId}`,
  );
  const queue = [...state.candidateQueue];
  state.candidateQueue = [];
  for (const item of queue) {
    try {
      state.pc.addRemoteCandidate(item.candidate, item.mid);
    } catch (err) {
      log.warn(TAG, "Failed to add queued remote candidate", {
        remotePeerId,
        error: err.message,
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/*  PeerConnection creation                                           */
/* ------------------------------------------------------------------ */

/**
 * Create and configure a new RTCPeerConnection for a remote peer.
 *
 * @param {string} remotePeerId
 * @param {boolean} isOfferer - Whether this node initiates the offer.
 */
function createPeerConnection(remotePeerId, isOfferer) {
  log.info(TAG, `Creating PeerConnection for ${remotePeerId}`, { isOfferer });

  const pc = new nodeDataChannel.PeerConnection(`pc-${remotePeerId}`, {
    iceServers: ICE_SERVERS,
  });

  /** @type {PeerState} */
  const state = {
    pc,
    dc: null,
    isOfferer,
    remoteDescriptionSet: false,
    candidateQueue: [],
  };
  peers.set(remotePeerId, state);

  // ── Signaling callbacks ──────────────────────────────────────────

  pc.onLocalDescription((sdp, type) => {
    log.debug(TAG, `Local description generated (${type})`, { remotePeerId });
    signaling.send({
      type,
      senderId: config.nodeId,
      targetId: remotePeerId,
      sdp,
    });
  });

  pc.onLocalCandidate((candidate, mid) => {
    signaling.send({
      type: "candidate",
      senderId: config.nodeId,
      targetId: remotePeerId,
      candidate,
      mid,
    });
  });

  pc.onStateChange((newState) => {
    log.info(TAG, `Connection state → ${newState}`, { remotePeerId });

    if (peers.get(remotePeerId)?.pc !== pc) {
      log.info(
        TAG,
        `Ignoring state change for stale peer connection ${remotePeerId}`,
      );
      return;
    }

    if (newState === "connected") {
      // Connection established or recovered — cancel any pending failed timer
      const timer = failedTimers.get(remotePeerId);
      if (timer) {
        clearTimeout(timer);
        failedTimers.delete(remotePeerId);
        log.info(TAG, `Peer ${remotePeerId} recovered from failed state`);
      }
    } else if (newState === "failed") {
      // Don't immediately clean up — the mobile peer may attempt ICE restart,
      // or we can attempt reconnection ourselves.
      if (!failedTimers.has(remotePeerId)) {
        log.info(
          TAG,
          `Peer ${remotePeerId} failed — waiting ${FAILED_GRACE_MS}ms then attempting reconnection`,
        );
        const timer = setTimeout(() => {
          failedTimers.delete(remotePeerId);
          // Clean up the old connection and attempt a fresh one
          cleanupPeer(remotePeerId);
          log.info(TAG, `Attempting reconnection to ${remotePeerId}`);
          createPeerConnection(remotePeerId, isOfferer);
        }, FAILED_GRACE_MS);
        failedTimers.set(remotePeerId, timer);
      }
    } else if (newState === "closed") {
      // In node-datachannel, 'closed' fires immediately after 'failed'
      // at the same millisecond. If we have a pending grace timer, do NOT
      // clean up — let the timer handle reconnection.
      if (failedTimers.has(remotePeerId)) {
        log.info(
          TAG,
          `Peer ${remotePeerId} closed during grace period — deferring to reconnection timer`,
        );
      } else {
        cleanupPeer(remotePeerId);
      }
    }
  });

  pc.onGatheringStateChange((gatheringState) => {
    log.debug(TAG, `ICE gathering → ${gatheringState}`, { remotePeerId });
  });

  // ── Data channel setup ───────────────────────────────────────────

  if (isOfferer) {
    // We create the data channel when we are the offerer.
    const dc = pc.createDataChannel("vault-sync");
    bindDataChannel(remotePeerId, state, dc);
  } else {
    // As the answerer, we wait for the remote peer to open a channel.
    pc.onDataChannel((dc) => {
      log.info(
        TAG,
        `Incoming data channel from ${remotePeerId}: ${dc.getLabel()}`,
      );
      bindDataChannel(remotePeerId, state, dc);
    });
  }
}

/**
 * Bind event handlers to a data channel and attach it to the peer state.
 *
 * @param {string} remotePeerId
 * @param {PeerState} state
 * @param {import('node-datachannel').DataChannel} dc
 */
function bindDataChannel(remotePeerId, state, dc) {
  state.dc = dc;

  dc.onOpen(() => {
    log.info(TAG, `Data channel OPEN with ${remotePeerId}`);
    if (onOpenCallback) onOpenCallback(remotePeerId);
  });

  dc.onMessage((raw) => {
    try {
      const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());

      if (msg.type === "file_chunk_start") {
        log.info(
          TAG,
          `Received file_chunk_start for transfer ${msg.transferId} from ${remotePeerId}, total chunks: ${msg.totalChunks}, hash: ${msg.sha256 ? msg.sha256.substring(0, 8) + "…" : "none"}`,
        );
        activeTransfers.set(msg.transferId, {
          filename: msg.filename,
          totalChunks: msg.totalChunks,
          lastModified: msg.lastModified,
          msgType: msg.msgType,
          sha256: msg.sha256 || "",
          chunks: new Array(msg.totalChunks),
          receivedCount: 0,
          lastActivity: Date.now(),
        });
        return;
      }

      if (msg.type === "file_chunk") {
        const transfer = activeTransfers.get(msg.transferId);
        if (transfer) {
          if (transfer.chunks[msg.chunkIndex] === undefined) {
            transfer.receivedCount++;
          }
          transfer.chunks[msg.chunkIndex] = msg.chunkData;
          transfer.lastActivity = Date.now();
        } else {
          log.warn(
            TAG,
            `Received chunk for unknown transfer ${msg.transferId} from ${remotePeerId}`,
          );
        }
        return;
      }

      if (msg.type === "file_chunk_end") {
        log.info(
          TAG,
          `Received file_chunk_end for transfer ${msg.transferId} from ${remotePeerId}`,
        );
        const transfer = activeTransfers.get(msg.transferId);
        if (transfer) {
          activeTransfers.delete(msg.transferId);
          if (transfer.receivedCount !== transfer.totalChunks) {
            const missing = transfer.totalChunks - transfer.receivedCount;
            log.error(
              TAG,
              `Transfer ${msg.transferId} from ${remotePeerId} incomplete. ${missing}/${transfer.totalChunks} chunks missing.`,
            );
            // Send NACK so the sender knows to retry
            sendRaw(
              dc,
              {
                type: "transfer_nack",
                transferId: msg.transferId,
                filename: transfer.filename,
                reason: `Incomplete: ${missing}/${transfer.totalChunks} chunks missing`,
              },
              remotePeerId,
            );
            return;
          }
          const fullData = transfer.chunks.join("");

          // Verify SHA-256 integrity if hash was provided
          if (transfer.sha256) {
            try {
              const actualHash = createHash("sha256")
                .update(fullData)
                .digest("hex");
              if (actualHash !== transfer.sha256) {
                log.error(
                  TAG,
                  `Transfer ${msg.transferId} from ${remotePeerId} FAILED integrity check. Expected: ${transfer.sha256.substring(0, 8)}…, Got: ${actualHash.substring(0, 8)}…`,
                );
                sendRaw(
                  dc,
                  {
                    type: "transfer_nack",
                    transferId: msg.transferId,
                    filename: transfer.filename,
                    reason: "SHA-256 integrity check failed",
                  },
                  remotePeerId,
                );
                return;
              }
              log.info(
                TAG,
                `Transfer ${msg.transferId} integrity verified (SHA-256: ${transfer.sha256.substring(0, 8)}…)`,
              );
            } catch (err) {
              log.warn(
                TAG,
                `SHA-256 verification failed, accepting anyway: ${err.message}`,
              );
            }
          }

          const assembledMessage = {
            type: transfer.msgType,
            filename: transfer.filename,
            fileData: fullData,
            lastModified: transfer.lastModified,
          };
          log.info(
            TAG,
            `Reassembled message type ${transfer.msgType} successfully from ${remotePeerId}. Size: ${fullData.length}`,
          );
          if (onMessageCallback)
            onMessageCallback(remotePeerId, assembledMessage);
        } else {
          log.warn(
            TAG,
            `Received chunk_end for unknown transfer ${msg.transferId} from ${remotePeerId}`,
          );
        }
        return;
      }

      // Handle data channel heartbeat
      if (msg.type === "dc_ping") {
        try {
          dc.sendMessage(JSON.stringify({ type: "dc_pong" }));
        } catch {}
        return;
      }
      if (msg.type === "dc_pong") {
        // Heartbeat received — connection is alive
        return;
      }

      // Handle transfer NACK from receiver
      if (msg.type === "transfer_nack") {
        log.warn(
          TAG,
          `Transfer NACK from ${remotePeerId} for "${msg.filename}": ${msg.reason}`,
        );
        // The transfer failed on the receiver side — could trigger retry logic here
        return;
      }

      log.debug(TAG, "DC message received", {
        peerId: remotePeerId,
        type: msg.type,
      });
      if (onMessageCallback) onMessageCallback(remotePeerId, msg);
    } catch (err) {
      log.warn(TAG, "Non-JSON DC message — ignoring", {
        peerId: remotePeerId,
        error: err.message,
      });
    }
  });

  dc.onClosed(() => {
    log.info(TAG, `Data channel CLOSED with ${remotePeerId}`);
    state.dc = null;
  });

  dc.onError((errMsg) => {
    log.error(TAG, "Data channel error", {
      peerId: remotePeerId,
      error: errMsg,
    });
  });
}

/**
 * Clean up a peer connection that has disconnected.
 * @param {string} peerId
 */
function cleanupPeer(peerId) {
  // Cancel any pending failed grace timer
  const timer = failedTimers.get(peerId);
  if (timer) {
    clearTimeout(timer);
    failedTimers.delete(peerId);
  }

  const state = peers.get(peerId);
  if (!state) return;

  try {
    state.dc?.close();
    state.pc.close();
  } catch {
    /* best-effort */
  }

  peers.delete(peerId);
  log.info(TAG, `Peer cleaned up: ${peerId}`);
}
