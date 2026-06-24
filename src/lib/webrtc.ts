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
  /** Merge received vault bytes into the local vault and persist. */
  applyRemote: (
    bytes: Uint8Array,
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

export class SyncSession {
  private ws: TauriWebSocket | null = null;
  private wsUnlisten: (() => void) | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private closed = false;
  private currentStatus: SyncStatus = "idle";

  /** Our stable id for this session (used in the offerer tie-breaker). */
  private readonly myId: string;
  /** The remote peer's id, learned from its announce/offer. */
  private peerId: string | null = null;

  /** Cached local vault, loaded lazily at sync time. */
  private local: { bytes: Uint8Array; lastModified: number } | null = null;

  // Sync-protocol bookkeeping.
  private peerMetaComplete = false;
  private pullInFlight = false;
  private didApply = false;
  private incoming: IncomingTransfer | null = null;

  private progress: SyncProgress = { sent: 0, sentTotal: 0, received: 0, receivedTotal: 0 };

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
      if (this.currentStatus !== "done" && this.dc?.readyState !== "open") {
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
    try {
      this.dc?.close();
    } catch {
      /* ignore */
    }
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    void this.ws?.disconnect().catch(() => {});
    this.wsUnlisten = null;
    this.dc = null;
    this.pc = null;
    this.ws = null;
  }

  private setStatus(status: SyncStatus): void {
    this.currentStatus = status;
    this.handlers.onStatus(status);
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
        if (typeof msg.peerCount === "number") {
          this.handlers.onPeers(msg.peerCount);
          if (msg.peerCount > 0) this.setStatus("negotiating");
        }
        return;
      case "announce":
        await this.onAnnounce(msg);
        return;
      case "offer":
        await this.onOffer(msg);
        return;
      case "answer":
        if (msg.targetId && msg.targetId !== this.myId) return;
        await this.pc?.setRemoteDescription({ type: "answer", sdp: getSdp(msg) });
        return;
      case "candidate":
        await this.onCandidate(msg);
        return;
      case "peer_left":
      case "peer-left":
        this.handlers.onPeers(0);
        if (!this.closed && this.currentStatus !== "done") {
          this.handlers.onLog("Peer left the room.");
        }
        // Tear down the stale peer connection and reset per-peer state so the
        // next peer (e.g. the mobile auto-reconnecting) gets a fresh handshake
        // instead of being silently ignored (the cause of the stuck
        // "establishing connection" loop).
        this.resetForNewPeer();
        if (!this.closed && this.currentStatus !== "done") this.setStatus("waiting");
        return;
      case "server_shutdown":
        if (this.currentStatus !== "done") this.fail("Signaling server shut down.");
        return;
      default:
        return;
    }
  }

  /** Mirror the node's announce logic: greater id offers, lesser id answers. */
  private async onAnnounce(msg: Record<string, any>): Promise<void> {
    const remoteId = String(msg.senderId ?? "");
    if (!remoteId || remoteId === this.myId) return;
    this.peerId = remoteId;
    this.handlers.onPeers(1);
    this.setStatus("negotiating");

    const weAreOfferer = this.myId > remoteId;
    if (weAreOfferer) {
      // Offer once; ignore duplicate announces while a connection exists.
      if (!this.pc) {
        this.ensurePeerConnection(true);
        await this.makeOffer();
      }
    } else {
      // Announce back so the offerer definitely knows about us, then wait.
      this.send({ type: "announce", senderId: this.myId, targetId: remoteId });
      if (!this.pc) this.ensurePeerConnection(false);
    }
  }

  private async onOffer(msg: Record<string, any>): Promise<void> {
    if (msg.targetId && msg.targetId !== this.myId) return;
    if (msg.senderId) this.peerId = String(msg.senderId);
    this.handlers.onPeers(1);
    this.setStatus("negotiating");
    // Re-create a clean peer connection for this offer.
    this.resetPeerConnection();
    this.ensurePeerConnection(false);
    await this.pc!.setRemoteDescription({ type: "offer", sdp: getSdp(msg) });
    await this.makeAnswer();
  }

  private async onCandidate(msg: Record<string, any>): Promise<void> {
    if (msg.targetId && msg.targetId !== this.myId) return;
    const init = candidateInit(msg);
    if (!init) return;
    try {
      await this.pc?.addIceCandidate(init);
    } catch {
      /* may arrive before the remote description; browsers queue most */
    }
  }

  // ── WebRTC ──────────────────────────────────────────────────────────────────

  private resetPeerConnection(): void {
    if (this.pc) {
      try {
        this.dc?.close();
        this.pc.close();
      } catch {
        /* ignore */
      }
      this.pc = null;
      this.dc = null;
    }
  }

  /** Drop the peer connection and all per-peer sync state for a fresh round. */
  private resetForNewPeer(): void {
    this.resetPeerConnection();
    this.peerId = null;
    this.peerMetaComplete = false;
    this.pullInFlight = false;
    this.didApply = false;
    this.incoming = null;
    this.progress = { sent: 0, sentTotal: 0, received: 0, receivedTotal: 0 };
    this.emitProgress();
  }

  private ensurePeerConnection(isOfferer: boolean): void {
    if (this.pc) return;
    this.pc = new RTCPeerConnection({
      iceServers: this.opts.iceServers.map((s) => ({
        urls: s.urls,
        username: s.username ?? undefined,
        credential: s.credential ?? undefined,
      })),
    });

    this.pc.onicecandidate = (ev) => {
      if (ev.candidate && this.peerId) {
        this.send({
          type: "candidate",
          senderId: this.myId,
          targetId: this.peerId,
          candidate: ev.candidate.candidate,
          mid: ev.candidate.sdpMid ?? "",
        });
      }
    };
    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState;
      if (state === "connected") {
        this.handlers.onLog("Peer connection established.");
      } else if (state === "disconnected") {
        this.handlers.onLog("Peer connection interrupted, attempting to recover…");
      } else if (state === "failed") {
        if (!this.closed && this.currentStatus !== "done") {
          this.fail(
            "Peer connection failed — no direct path between the devices. " +
              "Add a TURN server in Settings → Sync if they're on different networks.",
          );
        }
      }
    };

    if (isOfferer) {
      this.setupDataChannel(this.pc.createDataChannel(DC_LABEL, { ordered: true }));
    } else {
      this.pc.ondatachannel = (ev) => this.setupDataChannel(ev.channel);
    }
  }

  private async makeOffer(): Promise<void> {
    const offer = await this.pc!.createOffer();
    await this.pc!.setLocalDescription(offer);
    this.send({
      type: "offer",
      senderId: this.myId,
      targetId: this.peerId,
      sdp: offer.sdp,
    });
  }

  private async makeAnswer(): Promise<void> {
    const answer = await this.pc!.createAnswer();
    await this.pc!.setLocalDescription(answer);
    this.send({
      type: "answer",
      senderId: this.myId,
      targetId: this.peerId,
      sdp: answer.sdp,
    });
  }

  // ── Data channel ──────────────────────────────────────────────────────────────

  private setupDataChannel(dc: RTCDataChannel): void {
    this.dc = dc;
    dc.onopen = () => {
      this.setStatus("syncing");
      this.handlers.onLog("Peer link open. Exchanging vault metadata…");
      void this.beginSync();
    };
    dc.onmessage = (ev) => void this.onDataMessage(ev.data);
    dc.onerror = () => {
      if (!this.closed && this.currentStatus !== "done") this.handlers.onLog("Data channel error.");
    };
  }

  private dcSend(msg: Record<string, unknown>): void {
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(msg));
  }

  /** Kick off the symmetric metadata exchange once the channel is open. */
  private async beginSync(): Promise<void> {
    try {
      this.local = await this.opts.loadLocal();
    } catch (e) {
      this.fail(`Could not read the local vault: ${String(e)}`);
      return;
    }
    this.dcSend({ type: "metadata_query" });
    this.advertiseMetadata();
    this.dcSend({ type: "metadata_complete" });
  }

  private advertiseMetadata(): void {
    if (!this.local) return;
    this.dcSend({
      type: "metadata_info",
      filename: this.opts.filename,
      lastModified: this.local.lastModified,
      size: this.local.bytes.length,
    });
  }

  private async onDataMessage(data: unknown): Promise<void> {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer));
    } catch {
      return;
    }

    switch (msg.type) {
      case "file_chunk_start":
        this.incoming = {
          msgType: msg.msgType,
          filename: msg.filename,
          lastModified: msg.lastModified ?? 0,
          totalChunks: msg.totalChunks ?? 0,
          chunks: new Array(msg.totalChunks ?? 0),
          received: 0,
        };
        this.progress.received = 0;
        this.progress.receivedTotal = msg.totalChunks ?? 0;
        this.emitProgress();
        this.handlers.onLog(`Receiving ${msg.msgType} (${msg.totalChunks} chunks)…`);
        return;
      case "file_chunk": {
        const t = this.incoming;
        if (!t) return;
        if (t.chunks[msg.chunkIndex] === undefined) t.received++;
        t.chunks[msg.chunkIndex] = msg.chunkData;
        this.progress.receivedTotal = t.totalChunks;
        this.progress.received = t.received;
        this.emitProgress();
        return;
      }
      case "file_chunk_end": {
        const t = this.incoming;
        this.incoming = null;
        if (!t) return;
        const fileData = t.chunks.join("");
        await this.handleAppMessage({
          type: t.msgType,
          filename: t.filename,
          fileData,
          lastModified: t.lastModified,
        });
        return;
      }
      case "dc_ping":
        this.dcSend({ type: "dc_pong" });
        return;
      case "dc_pong":
        return;
      default:
        await this.handleAppMessage(msg);
    }
  }

  // ── Sync protocol ──────────────────────────────────────────────────────────────

  private async handleAppMessage(msg: Record<string, any>): Promise<void> {
    switch (msg.type) {
      case "metadata_query":
        if (!this.local) this.local = await this.opts.loadLocal().catch(() => null as any);
        this.advertiseMetadata();
        this.dcSend({ type: "metadata_complete" });
        return;
      case "metadata_info":
        this.onMetadataInfo(msg);
        return;
      case "metadata_complete":
        this.peerMetaComplete = true;
        this.maybeDone();
        return;
      case "pull_request":
        await this.onPullRequest(msg);
        return;
      case "pull_response":
        await this.onPullResponse(msg);
        return;
      case "push_request":
        await this.onPushRequest(msg);
        return;
      case "push_response":
        this.handlers.onLog(`Peer ${msg.status === "success" ? "accepted" : "skipped"} our vault.`);
        this.maybeDone();
        return;
      case "sync_complete":
        this.maybeDone();
        return;
      default:
        return;
    }
  }

  private onMetadataInfo(msg: Record<string, any>): void {
    // Only consider the file that matches our vault; ignore unrelated files so
    // we never merge a stranger's database into ours.
    if (msg.filename !== this.opts.filename) {
      this.handlers.onLog(
        `Peer advertises "${msg.filename}", which doesn't match this vault ("${this.opts.filename}"). Ignoring.`,
      );
      return;
    }
    const remote = Number(msg.lastModified ?? 0);
    const localMtime = this.local?.lastModified ?? 0;
    if (remote - localMtime > MTIME_EPSILON) {
      this.handlers.onLog("Peer has a newer vault — pulling.");
      this.pullInFlight = true;
      this.dcSend({ type: "pull_request", filename: this.opts.filename });
    } else {
      this.handlers.onLog("Local vault is up to date or newer.");
      this.maybeDone();
    }
  }

  private async onPullRequest(msg: Record<string, any>): Promise<void> {
    if (msg.filename !== this.opts.filename) return;
    if (!this.local) this.local = await this.opts.loadLocal();
    await this.sendChunked("pull_response", {
      filename: this.opts.filename,
      fileData: bytesToBase64(this.local.bytes),
      lastModified: this.local.lastModified,
    });
    this.handlers.onLog("Sent our vault to the peer.");
  }

  private async onPullResponse(msg: Record<string, any>): Promise<void> {
    this.pullInFlight = false;
    await this.applyReceived(msg.fileData);
    this.dcSend({
      type: "sync_complete",
      filename: this.opts.filename,
      lastModified: this.local?.lastModified ?? Date.now(),
      status: "success",
      message: "File accepted and merged",
    });
    this.maybeDone();
  }

  private async onPushRequest(msg: Record<string, any>): Promise<void> {
    if (msg.filename !== this.opts.filename) {
      this.dcSend({ type: "push_response", filename: msg.filename, status: "ignored", message: "Unknown vault" });
      return;
    }
    const changed = await this.applyReceived(msg.fileData);
    this.dcSend({
      type: "push_response",
      filename: this.opts.filename,
      status: changed ? "success" : "ignored",
      message: changed ? "File accepted and merged" : "Local file is newer or identical",
    });
    this.maybeDone();
  }

  /** Decode + merge a received base64 vault, refresh local metadata. */
  private async applyReceived(fileDataB64: string): Promise<boolean> {
    try {
      const bytes = base64ToBytes(fileDataB64);
      this.handlers.onLog("Merging received vault…");
      const { changed, lastModified, result } = await this.opts.applyRemote(bytes);
      this.didApply = true;
      this.handlers.onMerged(result);
      // Refresh our cached local snapshot so a subsequent advertise/pull is current.
      this.local = { bytes: await this.exportLocalBytes(), lastModified };
      this.handlers.onLog(
        changed
          ? `Merged: +${result.created} new, ${result.updated} updated.`
          : "Merged: no changes.",
      );
      return changed;
    } catch (e) {
      this.fail(`Merge failed: ${String(e)}`);
      return false;
    }
  }

  /** Re-read the local bytes after a merge (the on-disk vault changed). */
  private async exportLocalBytes(): Promise<Uint8Array> {
    const next = await this.opts.loadLocal();
    return next.bytes;
  }

  /** Chunked send matching the node's file_chunk_* framing + SHA-256. */
  private async sendChunked(
    msgType: string,
    payload: { filename: string; fileData: string; lastModified: number },
  ): Promise<void> {
    const { fileData } = payload;
    const totalChunks = Math.max(1, Math.ceil(fileData.length / CHUNK_CHARS));
    const transferId = `${msgType}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const sha256 = await sha256Hex(fileData);

    this.dcSend({
      type: "file_chunk_start",
      transferId,
      filename: payload.filename,
      totalChunks,
      lastModified: payload.lastModified,
      msgType,
      sha256,
    });

    this.progress.sent = 0;
    this.progress.sentTotal = totalChunks;
    this.emitProgress();

    for (let i = 0; i < totalChunks; i++) {
      if (this.closed || !this.dc) return;
      await this.waitForDrain();
      this.dcSend({
        type: "file_chunk",
        transferId,
        chunkIndex: i,
        chunkData: fileData.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS),
      });
      this.progress.sent = i + 1;
      this.emitProgress();
      if (i > 0 && i % 20 === 0) await new Promise((r) => setTimeout(r, 1));
    }
    this.dcSend({ type: "file_chunk_end", transferId });
  }

  private async waitForDrain(): Promise<void> {
    const dc = this.dc;
    if (!dc) return;
    while (dc.bufferedAmount > MAX_BUFFERED) {
      if (this.closed || dc.readyState !== "open") return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Mark the sync done once the peer finished advertising and no pull is open. */
  private maybeDone(): void {
    if (this.closed || this.currentStatus === "done") return;
    if (this.peerMetaComplete && !this.pullInFlight) {
      this.setStatus("done");
      this.handlers.onLog(this.didApply ? "Sync complete." : "Sync complete — already in sync.");
    }
  }

  private emitProgress(): void {
    this.handlers.onProgress({ ...this.progress });
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
