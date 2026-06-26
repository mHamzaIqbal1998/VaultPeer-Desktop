import TauriWebSocket, { type Message as WsMessage } from "@tauri-apps/plugin-websocket";
import type { IceServerConfig, MergeResult } from "@/services/tauri";

/**
 * WebRTC P2P sync transport (PLAN Phase 8).
 *
 * Speaks the exact VaultPeer signaling + sync protocol used by the mobile app
 * and the storage `Server-node` (see `WEBRTC-SERVERS/`), so the desktop is just
 * another peer in the mesh. Only the RTCPeerConnection runs in the WebView (no
 * `webrtc-rs` dependency); Rust owns the encrypted snapshot and the KeePass
 * merge, injected here via `loadLocal` / `applyRemote`.
 *
 * The signaling WebSocket runs **natively in Rust** via `@tauri-apps/plugin-
 * websocket`, not the WebView's `WebSocket`: WebView2's socket can hang in
 * CONNECTING or be blocked by the app CSP / Windows network stack, whereas the
 * native client uses the same path that connects reliably elsewhere.
 *
 * ## Signaling (WebSocket, JSON)
 *   → {type:"join", roomId}                     join / create the room
 *   → {type:"announce", senderId[, targetId]}   presence; drives offerer choice
 *   ← {type:"joined", peerCount}                join ack
 *   ← {type:"ping"}  → {type:"pong"}            app-level heartbeat (required)
 *   ← {type:"peer_left", clientId}              a peer disconnected
 *   ↔ {type:"offer"|"answer", senderId, targetId, sdp}
 *   ↔ {type:"candidate", senderId, targetId, candidate, mid}
 * Offerer/answerer is decided by string comparison of the two ids (greater id
 * offers), matching the node. All offer/answer/candidate messages are addressed
 * with `targetId` and ignored by peers they're not addressed to.
 *
 * ## Sync (over the "vault-sync" data channel, JSON text)
 * On open both peers exchange metadata, then pull whatever is newer:
 *   metadata_query → metadata_info{filename,lastModified,size} → metadata_complete
 *   pull_request{filename} → pull_response{filename,fileData(base64),lastModified}
 *   push_request{...}      → push_response{status}
 *   sync_complete{...}
 * Large messages (`pull_response`, `push_request`) are chunked as
 * file_chunk_start / file_chunk / file_chunk_end with a SHA-256 over the base64
 * payload, exactly as the node expects.
 */

export type SyncStatus =
  | "idle"
  | "connecting"
  | "waiting" // in the room, waiting for a peer
  | "negotiating" // peer present, establishing the WebRTC connection
  | "syncing" // transferring / merging
  | "done"
  | "error";

export interface SyncProgress {
  sent: number;
  sentTotal: number;
  received: number;
  receivedTotal: number;
}

export interface SyncHandlers {
  onStatus: (status: SyncStatus) => void;
  onPeers: (count: number) => void;
  onProgress: (progress: SyncProgress) => void;
  onLog: (message: string) => void;
  /** Called when a received vault has been merged into the local one. */
  onMerged: (result: MergeResult) => void;
  onError: (message: string) => void;
}

export interface SyncSessionOptions {
  signalingUrl: string;
  /** Room / vault id (`roomId` in the protocol). */
  room: string;
  iceServers: IceServerConfig[];
  /** Filename identifying this vault across devices (basename of the .kdbx). */
  filename: string;
  /** Read the current local vault: encrypted bytes + on-disk mtime (epoch ms). */
  loadLocal: () => Promise<{ bytes: Uint8Array; lastModified: number }>;
  /**
   * Merge received vault bytes into the local vault and persist. `remoteMtime`
   * is the peer's advertised content-version timestamp, adopted locally so an
   * already-in-sync vault isn't re-pulled on every reconnect.
   */
  applyRemote: (
    bytes: Uint8Array,
    remoteMtime: number,
  ) => Promise<{ changed: boolean; lastModified: number; result: MergeResult }>;
}

/**
 * Base64 chars per chunk. Kept well below 16 KiB so the *entire* JSON message
 * (chunk data + `{type,transferId,chunkIndex,...}` wrapper) stays under the
 * 16 KiB max-message-size that some WebRTC stacks (incl. react-native-webrtc on
 * the mobile peer) negotiate — a larger message can be silently dropped or
 * truncated, and since the peer reassembles by index and doesn't re-verify the
 * SHA-256, that corruption would surface only later as a "bad KDF" on open.
 * The receiver reassembles by `chunkIndex`, so the exact size need not match
 * any other peer's.
 */
const CHUNK_CHARS = 12 * 1024;
/** Pause sending when the channel's send buffer exceeds this (matches node). */
const MAX_BUFFERED = 128 * 1024;
/** The data-channel label the node creates / expects. */
const DC_LABEL = "vault-sync";
/** LWW comparison threshold (ms), matching the node. */
const MTIME_EPSILON = 1000;

interface IncomingTransfer {
  msgType: string;
  filename: string;
  lastModified: number;
  totalChunks: number;
  chunks: string[];
  received: number;
}

/** One remote peer in the mesh, with its own connection + per-peer sync state. */
interface Peer {
  id: string;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  /** Peer finished advertising its metadata. */
  metaComplete: boolean;
  /** A pull we requested from this peer is in flight. */
  pullInFlight: boolean;
  /** We are currently sending a file (pull_response / push) to this peer. */
  sending: boolean;
  /** We applied (merged) something from this peer this session. */
  didApply: boolean;
  incoming: IncomingTransfer | null;
  progress: SyncProgress;
}

export class SyncSession {
  private ws: TauriWebSocket | null = null;
  private wsUnlisten: (() => void) | null = null;
  private closed = false;
  private currentStatus: SyncStatus = "idle";

  /** Our stable id for this session (used in the offerer tie-breaker). */
  private readonly myId: string;

  /** All connected/connecting peers, keyed by their app id (announce senderId). */
  private readonly peers = new Map<string, Peer>();

  /** Cached local vault, loaded lazily at sync time (shared across peers). */
  private local: { bytes: Uint8Array; lastModified: number } | null = null;
  /** De-dupes the async `loadLocal()` so a peer's metadata never races it. */
  private localPromise: Promise<{ bytes: Uint8Array; lastModified: number }> | null = null;

  /** Fires after a lull to settle the status if a transfer/response stalled. */
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly opts: SyncSessionOptions,
    private readonly handlers: SyncHandlers,
  ) {
    this.myId = `desktop_${randomHex(8)}`;
  }

  start(): void {
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (!this.opts.signalingUrl) {
      this.fail("No signaling server configured. Set one in Settings → Sync.");
      return;
    }
    this.setStatus("connecting");
    this.handlers.onLog(`Connecting to ${this.opts.signalingUrl}…`);

    // The native WebSocket plugin resolves `connect` on a successful open and
    // rejects on failure, so there's no CONNECTING-hang to guard against; a
    // timeout still backs it up in case the underlying connect stalls.
    let conn: TauriWebSocket;
    try {
      conn = await withTimeout(
        TauriWebSocket.connect(this.opts.signalingUrl),
        15_000,
        "connection timed out",
      );
    } catch (e) {
      this.fail(
        `Could not reach the signaling server (${this.opts.signalingUrl}): ${String(e)}. ` +
          "Check the URL and scheme (ws:// vs wss://), that the server is running, and " +
          "that it's reachable from this device.",
      );
      return;
    }
    if (this.closed) {
      void conn.disconnect();
      return;
    }

    this.ws = conn;
    this.wsUnlisten = conn.addListener((m) => void this.onWsMessage(m));

    // Join the room, then announce our presence so the existing peer can start
    // the handshake (or so we learn we should offer).
    this.send({ type: "join", roomId: this.opts.room });
    this.send({ type: "announce", senderId: this.myId });
    this.setStatus("waiting");
    this.handlers.onLog(`Connected. Joined room ${this.opts.room} as ${this.myId}.`);
  }

  /** Dispatch a native-plugin WebSocket message. */
  private async onWsMessage(m: WsMessage): Promise<void> {
    if (m.type === "Text") {
      await this.onSignal(m.data);
    } else if (m.type === "Close") {
      if (this.closed) return;
      if (this.currentStatus !== "done" && !this.hasOpenPeer()) {
        const code = m.data?.code;
        this.handlers.onLog(`Signaling connection closed${code ? ` (code ${code})` : ""}.`);
      }
    }
    // Ping/Pong/Binary frames are not used by this protocol (the app-level
    // ping/pong are Text JSON messages, handled in onSignal).
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearSettleTimer();
    try {
      this.send({ type: "leave", roomId: this.opts.room });
    } catch {
      /* socket may already be gone */
    }
    try {
      this.wsUnlisten?.();
    } catch {
      /* ignore */
    }
    for (const peer of this.peers.values()) {
      try {
        peer.dc?.close();
        peer.pc.close();
      } catch {
        /* ignore */
      }
    }
    this.peers.clear();
    void this.ws?.disconnect().catch(() => {});
    this.wsUnlisten = null;
    this.ws = null;
  }

  /** Whether any peer's data channel is currently open. */
  private hasOpenPeer(): boolean {
    for (const p of this.peers.values()) if (p.dc?.readyState === "open") return true;
    return false;
  }

  private setStatus(status: SyncStatus): void {
    this.currentStatus = status;
    if (status === "syncing") this.bumpSettleWatchdog();
    else this.clearSettleTimer();
    this.handlers.onStatus(status);
  }

  /**
   * Arm/refresh a watchdog while syncing. Transfer progress refreshes it, so it
   * only fires after a genuine lull — at which point any peer still flagged
   * mid-transfer (a dropped chunk stream or an unanswered pull/response) is
   * treated as settled, so the status can't get pinned on "Syncing…".
   */
  private bumpSettleWatchdog(): void {
    if (this.closed) return;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.forceSettle(), 12_000);
  }

  private clearSettleTimer(): void {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
  }

  private forceSettle(): void {
    if (this.closed) return;
    let stalled = false;
    for (const p of this.peers.values()) {
      if (p.incoming || p.pullInFlight || p.sending) {
        p.incoming = null;
        p.pullInFlight = false;
        p.sending = false;
        stalled = true;
      }
    }
    if (stalled) this.handlers.onLog("Sync idle — settling.");
    this.recomputeStatus();
  }

  // ── Signaling ───────────────────────────────────────────────────────────────

  private send(msg: Record<string, unknown>): void {
    // Fire-and-forget; the native plugin's send is async.
    void this.ws?.send(JSON.stringify(msg)).catch(() => {});
  }

  private async onSignal(raw: string): Promise<void> {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case "ping":
        // App-level heartbeat — the server terminates us if we don't reply.
        this.send({ type: "pong" });
        return;
      case "joined":
        // Informational; peer presence is driven by announce/offer below.
        return;
      case "announce":
        await this.onAnnounce(msg);
        return;
      case "offer":
        await this.onOffer(msg);
        return;
      case "answer": {
        if (msg.targetId && msg.targetId !== this.myId) return;
        const peer = msg.senderId ? this.peers.get(String(msg.senderId)) : undefined;
        await peer?.pc.setRemoteDescription({ type: "answer", sdp: getSdp(msg) });
        return;
      }
      case "candidate":
        await this.onCandidate(msg);
        return;
      case "peer_left":
      case "peer-left":
        // The server's `clientId` here is its own short id, not the app id we
        // key peers by, so we can't map it to a specific peer. Departures are
        // detected per-connection via `connectionstatechange` instead (matching
        // the node). Nothing to do — other peers stay connected.
        return;
      case "server_shutdown":
        if (!this.hasOpenPeer()) this.fail("Signaling server shut down.");
        return;
      default:
        return;
    }
  }

  /** Mirror the node's announce logic: greater id offers, lesser id answers. */
  private async onAnnounce(msg: Record<string, any>): Promise<void> {
    const remoteId = String(msg.senderId ?? "");
    if (!remoteId || remoteId === this.myId) return;

    // Already have a connection to this peer — ignore the duplicate announce.
    if (this.peers.has(remoteId)) return;

    const weAreOfferer = this.myId > remoteId;
    if (weAreOfferer) {
      const peer = this.createPeer(remoteId, true);
      await this.makeOffer(peer);
    } else {
      // Announce back so the offerer definitely knows about us, then wait.
      this.send({ type: "announce", senderId: this.myId, targetId: remoteId });
      this.createPeer(remoteId, false);
    }
    this.recomputeStatus();
  }

  private async onOffer(msg: Record<string, any>): Promise<void> {
    if (msg.targetId && msg.targetId !== this.myId) return;
    const remoteId = String(msg.senderId ?? "");
    if (!remoteId) return;

    // A fresh offer (re)starts this peer's connection.
    this.removePeer(remoteId);
    const peer = this.createPeer(remoteId, false);
    await peer.pc.setRemoteDescription({ type: "offer", sdp: getSdp(msg) });
    await this.makeAnswer(peer);
    this.recomputeStatus();
  }

  private async onCandidate(msg: Record<string, any>): Promise<void> {
    if (msg.targetId && msg.targetId !== this.myId) return;
    const peer = msg.senderId ? this.peers.get(String(msg.senderId)) : undefined;
    const init = candidateInit(msg);
    if (!peer || !init) return;
    try {
      await peer.pc.addIceCandidate(init);
    } catch {
      /* may arrive before the remote description; browsers queue most */
    }
  }

  // ── WebRTC (per peer) ─────────────────────────────────────────────────────────

  private createPeer(id: string, isOfferer: boolean): Peer {
    const pc = new RTCPeerConnection({
      iceServers: this.opts.iceServers.map((s) => ({
        urls: s.urls,
        username: s.username ?? undefined,
        credential: s.credential ?? undefined,
      })),
    });
    const peer: Peer = {
      id,
      pc,
      dc: null,
      metaComplete: false,
      pullInFlight: false,
      sending: false,
      didApply: false,
      incoming: null,
      progress: { sent: 0, sentTotal: 0, received: 0, receivedTotal: 0 },
    };
    this.peers.set(id, peer);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.send({
          type: "candidate",
          senderId: this.myId,
          targetId: id,
          candidate: ev.candidate.candidate,
          mid: ev.candidate.sdpMid ?? "",
        });
      }
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === "connected") {
        this.handlers.onLog(`Peer ${id} connected.`);
      } else if (state === "disconnected") {
        this.handlers.onLog(`Peer ${id} interrupted, attempting to recover…`);
      } else if (state === "failed" || state === "closed") {
        // Only this peer is affected — drop it and let the others continue. A
        // failed peer can re-announce and we'll recreate it.
        if (this.peers.get(id)?.pc === pc) this.removePeer(id, state);
      }
      this.recomputeStatus();
    };

    if (isOfferer) {
      this.setupDataChannel(peer, pc.createDataChannel(DC_LABEL, { ordered: true }));
    } else {
      pc.ondatachannel = (ev) => this.setupDataChannel(peer, ev.channel);
    }
    return peer;
  }

  /** Tear down and forget a single peer. */
  private removePeer(id: string, reason?: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    try {
      peer.dc?.close();
      peer.pc.close();
    } catch {
      /* ignore */
    }
    if (reason && !this.closed) this.handlers.onLog(`Peer ${id} ${reason}.`);
  }

  private async makeOffer(peer: Peer): Promise<void> {
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    this.send({ type: "offer", senderId: this.myId, targetId: peer.id, sdp: offer.sdp });
  }

  private async makeAnswer(peer: Peer): Promise<void> {
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    this.send({ type: "answer", senderId: this.myId, targetId: peer.id, sdp: answer.sdp });
  }

  // ── Data channel (per peer) ────────────────────────────────────────────────────

  private setupDataChannel(peer: Peer, dc: RTCDataChannel): void {
    peer.dc = dc;
    dc.onopen = () => {
      this.handlers.onLog(`Peer ${peer.id} link open. Exchanging vault metadata…`);
      this.recomputeStatus();
      void this.beginSync(peer);
    };
    dc.onmessage = (ev) => void this.onDataMessage(peer, ev.data);
    dc.onerror = () => {
      if (!this.closed) this.handlers.onLog(`Data channel error with ${peer.id}.`);
    };
    dc.onclose = () => this.recomputeStatus();
  }

  private dcSend(peer: Peer, msg: Record<string, unknown>): void {
    if (peer.dc?.readyState === "open") peer.dc.send(JSON.stringify(msg));
  }

  /** True once at least one peer data channel is open (ready for live pushes). */
  isLive(): boolean {
    return !this.closed && this.hasOpenPeer();
  }

  /**
   * Push the current local vault to every connected peer (called after a save).
   * No-op if no peer link is open. Mirrors the node's push-on-local-change.
   */
  async pushUpdate(): Promise<void> {
    if (!this.isLive()) return;
    let local: { bytes: Uint8Array; lastModified: number };
    try {
      local = await this.opts.loadLocal();
      this.local = local;
    } catch (e) {
      this.handlers.onLog(`Push failed: ${String(e)}`);
      return;
    }
    const fileData = bytesToBase64(local.bytes);
    const open = [...this.peers.values()].filter((p) => p.dc?.readyState === "open");
    this.handlers.onLog(`Pushing local changes to ${open.length} peer(s)…`);
    await Promise.all(
      open.map((peer) =>
        this.sendChunked(peer, "push_request", {
          filename: this.opts.filename,
          fileData,
          lastModified: local.lastModified,
        }).catch((e) => this.handlers.onLog(`Push to ${peer.id} failed: ${String(e)}`)),
      ),
    );
    this.handlers.onLog("Local changes pushed.");
    this.recomputeStatus();
  }

  /**
   * Load the local vault once, shared across peers. Awaited everywhere the
   * local version is needed so an incoming `metadata_info` can never be compared
   * before our own version is known (which previously read 0 → spurious pull).
   */
  private async ensureLocal(): Promise<{ bytes: Uint8Array; lastModified: number }> {
    if (this.local) return this.local;
    if (!this.localPromise) {
      this.localPromise = this.opts.loadLocal().catch((e) => {
        this.localPromise = null;
        throw e;
      });
    }
    this.local = await this.localPromise;
    return this.local;
  }

  /** Kick off the symmetric metadata exchange once a peer's channel is open. */
  private async beginSync(peer: Peer): Promise<void> {
    try {
      await this.ensureLocal();
    } catch (e) {
      this.handlers.onLog(`Could not read the local vault: ${String(e)}`);
      return;
    }
    this.dcSend(peer, { type: "metadata_query" });
    this.advertiseMetadata(peer);
    this.dcSend(peer, { type: "metadata_complete" });
  }

  private advertiseMetadata(peer: Peer): void {
    if (!this.local) return;
    this.dcSend(peer, {
      type: "metadata_info",
      filename: this.opts.filename,
      lastModified: this.local.lastModified,
      size: this.local.bytes.length,
    });
  }

  private async onDataMessage(peer: Peer, data: unknown): Promise<void> {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer));
    } catch {
      return;
    }

    switch (msg.type) {
      case "file_chunk_start":
        peer.incoming = {
          msgType: msg.msgType,
          filename: msg.filename,
          lastModified: msg.lastModified ?? 0,
          totalChunks: msg.totalChunks ?? 0,
          chunks: new Array(msg.totalChunks ?? 0),
          received: 0,
        };
        peer.progress = { sent: 0, sentTotal: 0, received: 0, receivedTotal: msg.totalChunks ?? 0 };
        this.emitProgress(peer);
        this.recomputeStatus(); // reflect the incoming transfer in the status bar
        this.handlers.onLog(`Receiving ${msg.msgType} from ${peer.id} (${msg.totalChunks} chunks)…`);
        return;
      case "file_chunk": {
        const t = peer.incoming;
        if (!t) return;
        if (t.chunks[msg.chunkIndex] === undefined) t.received++;
        t.chunks[msg.chunkIndex] = msg.chunkData;
        peer.progress.receivedTotal = t.totalChunks;
        peer.progress.received = t.received;
        this.emitProgress(peer);
        return;
      }
      case "file_chunk_end": {
        const t = peer.incoming;
        peer.incoming = null;
        if (!t) return;
        const fileData = t.chunks.join("");
        await this.handleAppMessage(peer, {
          type: t.msgType,
          filename: t.filename,
          fileData,
          lastModified: t.lastModified,
        });
        return;
      }
      case "dc_ping":
        this.dcSend(peer, { type: "dc_pong" });
        return;
      case "dc_pong":
        return;
      default:
        await this.handleAppMessage(peer, msg);
    }
  }

  // ── Sync protocol (per peer) ────────────────────────────────────────────────────

  private async handleAppMessage(peer: Peer, msg: Record<string, any>): Promise<void> {
    switch (msg.type) {
      case "metadata_query":
        await this.ensureLocal().catch(() => {});
        this.advertiseMetadata(peer);
        this.dcSend(peer, { type: "metadata_complete" });
        return;
      case "metadata_info":
        await this.onMetadataInfo(peer, msg);
        return;
      case "metadata_complete":
        peer.metaComplete = true;
        this.maybeDone(peer);
        return;
      case "pull_request":
        await this.onPullRequest(peer, msg);
        return;
      case "pull_response":
        await this.onPullResponse(peer, msg);
        return;
      case "push_request":
        await this.onPushRequest(peer, msg);
        return;
      case "push_response":
        this.handlers.onLog(`Peer ${peer.id} ${msg.status === "success" ? "accepted" : "skipped"} our vault.`);
        this.maybeDone(peer);
        return;
      case "sync_complete":
        this.maybeDone(peer);
        return;
      default:
        return;
    }
  }

  private async onMetadataInfo(peer: Peer, msg: Record<string, any>): Promise<void> {
    // Only consider the file that matches our vault; never merge a stranger's DB.
    if (msg.filename !== this.opts.filename) {
      this.handlers.onLog(
        `Peer ${peer.id} advertises "${msg.filename}", which doesn't match this vault ("${this.opts.filename}"). Ignoring.`,
      );
      return;
    }
    // Ensure our own version is loaded before comparing — otherwise a fast
    // metadata_info races loadLocal() and compares against 0 → spurious pull.
    await this.ensureLocal().catch(() => {});
    const remote = Number(msg.lastModified ?? 0);
    const localMtime = this.local?.lastModified ?? 0;
    if (remote - localMtime > MTIME_EPSILON) {
      this.handlers.onLog(`Peer ${peer.id} has a newer vault — pulling.`);
      peer.pullInFlight = true;
      this.dcSend(peer, { type: "pull_request", filename: this.opts.filename });
      this.recomputeStatus();
    } else {
      this.maybeDone(peer);
    }
  }

  private async onPullRequest(peer: Peer, msg: Record<string, any>): Promise<void> {
    if (msg.filename !== this.opts.filename) return;
    const local = await this.ensureLocal();
    await this.sendChunked(peer, "pull_response", {
      filename: this.opts.filename,
      fileData: bytesToBase64(local.bytes),
      lastModified: local.lastModified,
    });
    this.handlers.onLog(`Sent our vault to ${peer.id}.`);
  }

  private async onPullResponse(peer: Peer, msg: Record<string, any>): Promise<void> {
    peer.pullInFlight = false;
    await this.applyReceived(peer, msg.fileData, Number(msg.lastModified ?? 0));
    this.dcSend(peer, {
      type: "sync_complete",
      filename: this.opts.filename,
      lastModified: this.local?.lastModified ?? Date.now(),
      status: "success",
      message: "File accepted and merged",
    });
    this.maybeDone(peer);
  }

  private async onPushRequest(peer: Peer, msg: Record<string, any>): Promise<void> {
    if (msg.filename !== this.opts.filename) {
      this.dcSend(peer, { type: "push_response", filename: msg.filename, status: "ignored", message: "Unknown vault" });
      return;
    }
    const changed = await this.applyReceived(peer, msg.fileData, Number(msg.lastModified ?? 0));
    this.dcSend(peer, {
      type: "push_response",
      filename: this.opts.filename,
      status: changed ? "success" : "ignored",
      message: changed ? "File accepted and merged" : "Local file is newer or identical",
    });
    this.maybeDone(peer);
  }

  /** Decode + merge a received base64 vault into the shared local vault. */
  private async applyReceived(
    peer: Peer,
    fileDataB64: string,
    remoteMtime: number,
  ): Promise<boolean> {
    try {
      const bytes = base64ToBytes(fileDataB64);
      this.handlers.onLog(`Merging vault received from ${peer.id}…`);
      const { changed, lastModified, result } = await this.opts.applyRemote(bytes, remoteMtime);
      peer.didApply = true;
      this.handlers.onMerged(result);
      // Refresh the shared local snapshot so later advertises/pulls are current.
      this.local = { bytes: (await this.opts.loadLocal()).bytes, lastModified };
      this.handlers.onLog(
        changed ? `Merged: +${result.created} new, ${result.updated} updated.` : "Merged: no changes.",
      );
      return changed;
    } catch (e) {
      // A merge failure for one peer must not tear down the whole mesh.
      this.handlers.onError(`Merge failed: ${String(e)}`);
      this.handlers.onLog(`Merge from ${peer.id} failed: ${String(e)}`);
      return false;
    }
  }

  /** Chunked send to one peer, matching the node's file_chunk_* framing. */
  private async sendChunked(
    peer: Peer,
    msgType: string,
    payload: { filename: string; fileData: string; lastModified: number },
  ): Promise<void> {
    const { fileData } = payload;
    const totalChunks = Math.max(1, Math.ceil(fileData.length / CHUNK_CHARS));
    const transferId = `${msgType}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const sha256 = await sha256Hex(fileData);

    this.dcSend(peer, {
      type: "file_chunk_start",
      transferId,
      filename: payload.filename,
      totalChunks,
      lastModified: payload.lastModified,
      msgType,
      sha256,
    });

    peer.sending = true;
    peer.progress = { sent: 0, sentTotal: totalChunks, received: 0, receivedTotal: 0 };
    this.emitProgress(peer);
    this.recomputeStatus(); // reflect the outgoing transfer in the status bar

    try {
      for (let i = 0; i < totalChunks; i++) {
        if (this.closed || peer.dc?.readyState !== "open") return;
        await this.waitForDrain(peer);
        this.dcSend(peer, {
          type: "file_chunk",
          transferId,
          chunkIndex: i,
          chunkData: fileData.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS),
        });
        peer.progress.sent = i + 1;
        this.emitProgress(peer);
        if (i > 0 && i % 20 === 0) await new Promise((r) => setTimeout(r, 1));
      }
      this.dcSend(peer, { type: "file_chunk_end", transferId });
    } finally {
      peer.sending = false;
      this.recomputeStatus();
    }
  }

  private async waitForDrain(peer: Peer): Promise<void> {
    const dc = peer.dc;
    if (!dc) return;
    while (dc.bufferedAmount > MAX_BUFFERED) {
      if (this.closed || dc.readyState !== "open") return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Log per-peer completion and recompute the aggregate session status. */
  private maybeDone(peer: Peer): void {
    if (this.closed) return;
    if (peer.metaComplete && !peer.pullInFlight && peer.didApply) {
      this.handlers.onLog(`Sync with ${peer.id} complete.`);
    }
    this.recomputeStatus();
  }

  /**
   * Aggregate the mesh into one session status + peer count for the UI:
   * `syncing` while any open peer is still exchanging, `done` once all open
   * peers are settled, `negotiating`/`waiting` when none are connected yet.
   */
  private recomputeStatus(): void {
    if (this.closed || this.currentStatus === "error") return;
    const peers = [...this.peers.values()];
    const open = peers.filter((p) => p.dc?.readyState === "open");
    this.handlers.onPeers(open.length);

    if (open.length === 0) {
      this.setStatus(peers.length > 0 ? "negotiating" : "waiting");
      return;
    }
    // A peer is "busy" only while actively transferring — sending a file,
    // receiving one (`incoming`), or awaiting a pull we requested. We
    // deliberately don't gate on `metaComplete`: a connected, idle peer is
    // considered in-sync ("done"), so a missed `metadata_complete` can't pin the
    // status on "Syncing…".
    const busy = open.some((p) => p.pullInFlight || p.incoming || p.sending);
    this.setStatus(busy ? "syncing" : "done");
  }

  private emitProgress(peer: Peer): void {
    // Transfer activity refreshes the settle watchdog so it only fires on a lull.
    if (this.currentStatus === "syncing") this.bumpSettleWatchdog();
    this.handlers.onProgress({ ...peer.progress });
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.handlers.onError(message);
    this.setStatus("error");
    this.close();
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Extract an SDP string from a signaling message (string or nested object). */
function getSdp(msg: Record<string, any>): string {
  if (typeof msg.sdp === "string") return msg.sdp;
  if (msg.sdp && typeof msg.sdp.sdp === "string") return msg.sdp.sdp;
  if (msg.offer && typeof msg.offer.sdp === "string") return msg.offer.sdp;
  if (msg.answer && typeof msg.answer.sdp === "string") return msg.answer.sdp;
  return "";
}

/** Build an RTCIceCandidateInit from the node's `{candidate, mid}` shape. */
function candidateInit(msg: Record<string, any>): RTCIceCandidateInit | null {
  if (typeof msg.candidate === "string") {
    return { candidate: msg.candidate, sdpMid: typeof msg.mid === "string" ? msg.mid : undefined };
  }
  if (msg.candidate && typeof msg.candidate === "object") {
    return msg.candidate as RTCIceCandidateInit;
  }
  return null;
}

/** Reject a promise if it doesn't settle within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Encode bytes to base64 (chunked to avoid call-stack limits on large vaults). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Decode base64 back to bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** SHA-256 of a string, hex-encoded (matches the node's integrity check). */
async function sha256Hex(str: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Human-readable byte size. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
