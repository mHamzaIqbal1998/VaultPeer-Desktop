/**
 * @module signaling
 * @description WebSocket signaling client & heartbeat handler.
 *
 * Connects to the VaultPeer Signaling Server, joins a room,
 * announces presence, and routes incoming signaling messages
 * (offer / answer / candidate / announce) to the WebRTC manager.
 *
 * Features:
 * - Automatic reconnect with exponential back-off.
 * - WebSocket ping/pong heartbeat to detect stale connections.
 * - Clean separation: this module only knows about signaling;
 *   all WebRTC logic lives in webrtc.js.
 */

import WebSocket from 'ws';
import config from './config.js';
import log from './logger.js';

const TAG = 'signaling';

/** Back-off parameters (ms). */
const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/** Heartbeat interval & timeout (ms). */
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

/** @type {WebSocket | null} */
let ws = null;

/** @type {NodeJS.Timeout | null} */
let heartbeatInterval = null;

/** @type {NodeJS.Timeout | null} */
let heartbeatTimeout = null;

/** @type {NodeJS.Timeout | null} */
let reconnectTimer = null;

let retryMs = INITIAL_RETRY_MS;
let intentionalClose = false;

/**
 * @callback MessageHandler
 * @param {Record<string, unknown>} msg - Parsed JSON message from signaling.
 * @returns {void}
 */

/** @type {MessageHandler | null} */
let messageHandler = null;

/** @type {(() => void) | null} */
let connectedHandler = null;

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

/**
 * Register a handler for inbound signaling messages.
 * Called with the parsed JSON payload for every message except 'join'.
 * @param {MessageHandler} handler
 */
export function onMessage(handler) {
  messageHandler = handler;
}

/**
 * Register a handler invoked every time the WebSocket (re)connects
 * and the room join is sent.
 * @param {() => void} handler
 */
export function onConnected(handler) {
  connectedHandler = handler;
}

/**
 * Open the WebSocket connection, join the room, and announce.
 * Safe to call multiple times — reconnects are handled internally.
 */
export function connect() {
  intentionalClose = false;
  _connect();
}

/**
 * Send a JSON-serialisable message over the WebSocket.
 * Silently drops the message if the socket is not open.
 *
 * @param {Record<string, unknown>} msg
 */
export function send(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log.warn(TAG, 'Attempted send while disconnected — dropping message', { type: msg.type });
    return;
  }

  ws.send(JSON.stringify(msg));
  log.debug(TAG, 'Sent', { type: msg.type, target: msg.targetId });
}

/**
 * Gracefully close the WebSocket and stop reconnection.
 */
export function disconnect() {
  intentionalClose = true;
  clearTimers();
  if (ws) {
    ws.close();
    ws = null;
  }
  log.info(TAG, 'Disconnected');
}

/* ------------------------------------------------------------------ */
/*  Internals                                                         */
/* ------------------------------------------------------------------ */

function _connect() {
  clearTimers();

  log.info(TAG, `Connecting to ${config.signalingUrl}`);

  ws = new WebSocket(config.signalingUrl);

  ws.on('open', () => {
    log.info(TAG, 'WebSocket connected');
    retryMs = INITIAL_RETRY_MS; // reset back-off

    // Join the vault room.
    send({ type: 'join', roomId: config.vaultId });
    log.info(TAG, 'Joined room', { roomId: config.vaultId });

    // Announce our presence so existing peers can initiate handshakes.
    send({ type: 'announce', senderId: config.nodeId });
    log.info(TAG, 'Announced presence', { nodeId: config.nodeId });

    startHeartbeat();

    if (connectedHandler) connectedHandler();
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      log.warn(TAG, 'Non-JSON message received — ignoring');
      return;
    }

    // Intercept signaling server's JSON heartbeat ping and reply with JSON pong.
    if (msg.type === 'ping') {
      log.debug(TAG, 'Received server JSON ping — responding with JSON pong');
      send({ type: 'pong' });
      resetLivenessTimeout();
      return;
    }

    log.debug(TAG, 'Received', { type: msg.type, sender: msg.senderId });

    if (messageHandler) messageHandler(msg);
  });

  ws.on('close', (code, reason) => {
    log.warn(TAG, 'WebSocket closed', { code, reason: reason?.toString() });
    clearTimers();
    if (!intentionalClose) scheduleReconnect();
  });

  ws.on('error', (err) => {
    log.error(TAG, 'WebSocket error', { error: err.message });
    // The 'close' event will fire next — reconnect is handled there.
  });
}

function startHeartbeat() {
  resetLivenessTimeout();
}

function resetLivenessTimeout() {
  if (heartbeatTimeout) {
    clearTimeout(heartbeatTimeout);
  }
  // Server ping is every 30s. If we don't get any ping/pong activity within 45s, terminate.
  heartbeatTimeout = setTimeout(() => {
    log.warn(TAG, 'Server liveness timeout (no JSON ping received) — closing connection');
    ws?.terminate();
  }, 45_000);
}

function scheduleReconnect() {
  log.info(TAG, `Reconnecting in ${retryMs} ms`);
  reconnectTimer = setTimeout(() => {
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    _connect();
  }, retryMs);
}

function clearTimers() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  if (heartbeatTimeout) { clearTimeout(heartbeatTimeout); heartbeatTimeout = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

