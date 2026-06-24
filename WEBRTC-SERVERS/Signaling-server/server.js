const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_PAYLOAD_SIZE = 50 * 1024; // 50KB

// ─── Utilities ────────────────────────────────────────────────────────────────
const ts = () => new Date().toISOString();

// ─── Room State ───────────────────────────────────────────────────────────────
// Map<roomId, Set<WebSocket>>
const rooms = new Map();

// ─── Server Setup ─────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ host: '0.0.0.0', port: PORT });

console.log(`[${ts()}] ═══════════════════════════════════════════════════════════════`);
console.log(`[${ts()}]   🚀  VaultPeer Signaling Server listening on ws://0.0.0.0:${PORT}`);
console.log(`[${ts()}] ═══════════════════════════════════════════════════════════════`);

// ─── Heartbeat ────────────────────────────────────────────────────────────────
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log(`[${ts()}]   ⚠  [TIMEOUT] Client ${ws._clientId} dead, terminating.`);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.send(JSON.stringify({ type: 'ping' }));
  });
}, 30000);

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
const shutdown = () => {
  console.log(`\n[${ts()}] 🛑  [SHUTDOWN] Terminating server gracefully...`);
  clearInterval(interval);
  wss.clients.forEach((ws) => {
    ws.send(JSON.stringify({ type: 'server_shutdown' }));
    ws.close();
  });
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ─── Connection Handler ───────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  const clientId = generateId();
  ws._clientId = clientId;
  ws._roomId = null; // track which room this client is in
  ws.isAlive = true;

  console.log(`\n[${ts()}] ┌─ [CONNECT] Client ${clientId} connected`);
  console.log(`[${ts()}] │  Total active connections: ${wss.clients.size}`);
  console.log(`[${ts()}] │  Active rooms: ${rooms.size}`);
  console.log(`[${ts()}] └──────────────────────────────────────────────────`);

  // ── Message Handler ───────────────────────────────────────────────────────
  ws.on('message', (raw) => {
    if (raw.length > MAX_PAYLOAD_SIZE) {
      console.log(`[${ts()}]   ⚠  [PAYLOAD ERROR] Client ${clientId} exceeded 50KB limit`);
      ws.send(JSON.stringify({ type: 'error', message: 'Payload size exceeds 50KB limit' }));
      return;
    }

    let msg;

    try {
      msg = JSON.parse(raw);
    } catch {
      console.log(`[${ts()}]   ⚠  [PARSE ERROR] Client ${clientId} sent invalid JSON`);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    const { type, roomId, data } = msg;

    switch (type) {
      case 'pong':
        console.log(`[${ts()}]   ✔  [PONG] Client ${clientId} sent pong`);
        ws.isAlive = true;
        return;

      // ── JOIN ─────────────────────────────────────────────────────────────
      case 'join': {
        if (!roomId) {
          console.log(`[${ts()}]   ⚠  [JOIN ERROR] Client ${clientId} sent join without roomId`);
          ws.send(JSON.stringify({ type: 'error', message: 'Missing roomId' }));
          return;
        }

        // Remove from previous room if any
        if (ws._roomId) {
          removeClientFromRoom(ws);
        }

        // Create room if it doesn't exist
        if (!rooms.has(roomId)) {
          rooms.set(roomId, new Set());
          console.log(`[${ts()}]   🏠  [ROOM CREATED] Room "${roomId}" created`);
        }

        const room = rooms.get(roomId);
        room.add(ws);
        ws._roomId = roomId;

        console.log(`\n[${ts()}] ┌─ [JOIN] Client ${clientId} joined room "${roomId}"`);
        console.log(`[${ts()}] │  Clients in room "${roomId}": ${room.size}`);
        console.log(`[${ts()}] │  Total active rooms: ${rooms.size}`);
        console.log(`[${ts()}] └──────────────────────────────────────────────────`);

        // Acknowledge the join
        ws.send(JSON.stringify({
          type: 'joined',
          roomId,
          clientId,
          peerCount: room.size - 1, // how many OTHER peers are in the room
        }));

        break;
      }
      // ── LEAVE ────────────────────────────────────────────────────────────
      case 'leave': {
        const currentRoomId = ws._roomId;
        if (!currentRoomId) {
          console.log(`[${ts()}]   ⚠  [LEAVE ERROR] Client ${clientId} sent leave before joining a room`);
          ws.send(JSON.stringify({ type: 'error', message: 'You must join a room first' }));
          return;
        }

        console.log(`\n[${ts()}] ┌─ [LEAVE] Client ${clientId} leaving room "${currentRoomId}"`);

        removeClientFromRoom(ws);

        // Acknowledge the leave
        ws.send(JSON.stringify({
          type: 'left',
          roomId: currentRoomId,
          clientId,
        }));

        break;
      }
      // ── ALL OTHER MESSAGES (FORWARD) ────────────────────────────────────
      default: {
        const currentRoomId = ws._roomId;

        if (!currentRoomId) {
          console.log(`[${ts()}]   ⚠  [FORWARD ERROR] Client ${clientId} sent "${type}" before joining a room`);
          ws.send(JSON.stringify({ type: 'error', message: 'You must join a room first' }));
          return;
        }

        const room = rooms.get(currentRoomId);
        if (!room) return;

        let forwarded = 0;

        room.forEach((peer) => {
          if (peer !== ws && peer.readyState === peer.OPEN) {
            peer.send(JSON.stringify(msg));
            forwarded++;
          }
        });

        console.log(`\n[${ts()}] ┌─ [FORWARD] Client ${clientId} → room "${currentRoomId}" (type: ${type || 'unknown'})`);
        console.log(`[${ts()}] │  Forwarded to ${forwarded} peer(s)`);
        console.log(`[${ts()}] │  Room size: ${room.size}`);
        console.log(`[${ts()}] └──────────────────────────────────────────────────`);
      }
    }
  });

  // ── Disconnect Handler ──────────────────────────────────────────────────
  ws.on('close', () => {
    console.log(`\n[${ts()}] ┌─ [DISCONNECT] Client ${clientId} disconnected`);

    if (ws._roomId) {
      removeClientFromRoom(ws);
    }

    console.log(`[${ts()}] │  Total active connections: ${wss.clients.size}`);
    console.log(`[${ts()}] │  Active rooms: ${rooms.size}`);
    console.log(`[${ts()}] └──────────────────────────────────────────────────`);
  });

  // ── Error Handler ───────────────────────────────────────────────────────
  ws.on('error', (err) => {
    console.error(`[${ts()}]   ❌  [ERROR] Client ${clientId}:`, err.message);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Remove a WebSocket client from its current room.
 * Cleans up the room from the Map if empty.
 */
function removeClientFromRoom(ws) {
  const roomId = ws._roomId;
  const room = rooms.get(roomId);

  if (!room) return;

  const clientId = ws._clientId;
  let notified = 0;

  // Notify other peers in the room before we remove this client
  room.forEach((peer) => {
    if (peer !== ws && peer.readyState === peer.OPEN) {
      peer.send(JSON.stringify({
        type: 'peer_left',
        roomId,
        clientId,
      }));
      notified++;
    }
  });

  room.delete(ws);
  console.log(`[${ts()}] │  Removed from room "${roomId}" (${room.size} remaining)`);
  if (notified > 0) {
    console.log(`[${ts()}] │  Notified ${notified} peer(s) about client leaving`);
  }

  if (room.size === 0) {
    rooms.delete(roomId);
    console.log(`[${ts()}] │  🗑  Room "${roomId}" is empty — deleted`);
  }

  ws._roomId = null;
}

/**
 * Generate a short random client ID for logging.
 */
function generateId() {
  return Math.random().toString(36).substring(2, 8);
}
