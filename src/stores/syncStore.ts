import { create } from "zustand";
import {
  saveDatabase,
  setFileMtime,
  statFile,
  syncExportSnapshot,
  syncGetMtime,
  syncMergeSnapshot,
  syncSetMtime,
  type MergeResult,
} from "@/services/tauri";
import { SyncSession, type SyncProgress, type SyncStatus } from "@/lib/webrtc";
import { generateRoomId } from "@/lib/qr";
import { useSettingsStore } from "./settingsStore";
import { useSessionStore } from "./sessionStore";
import { useDatabaseStore } from "./databaseStore";

/** Sync mode (PRD SYN: Offline = no sync; Network = P2P over WebRTC). */
export type SyncMode = "offline" | "network";

interface SyncState {
  mode: SyncMode;
  status: SyncStatus;
  room: string | null;
  signalingUrl: string;
  isHost: boolean;
  peerCount: number;
  progress: SyncProgress;
  log: string[];
  lastResult: MergeResult | null;
  error: string | null;

  setMode: (mode: SyncMode) => void;
  createRoom: () => void;
  joinRoom: (room: string, signalingUrl?: string) => void;
  leave: () => void;
  /** Push the current (saved) vault to the connected peer, if any. */
  pushNow: () => void;
  /** Tear down the active session (e.g. on lock) without forgetting the room. */
  stop: () => void;
  /**
   * Auto-rejoin the remembered room when a vault is opened (if auto-sync is on).
   * No-op if already connected or nothing is remembered.
   */
  autoStart: () => void;
}

let activeSession: SyncSession | null = null;

const EMPTY_PROGRESS: SyncProgress = { sent: 0, sentTotal: 0, received: 0, receivedTotal: 0 };

/** Basename of a path (the filename peers use to identify a shared vault). */
function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Remember (or forget) the room for auto-reconnect, persisted via settings. */
function rememberRoom(room: string | null, autoSync: boolean) {
  const st = useSettingsStore.getState();
  const sync = st.settings.sync;
  void st.update({ sync: { ...sync, room: room ?? sync.room, autoSync } });
}

export const useSyncStore = create<SyncState>((set, get) => {
  const pushLog = (message: string) => set((s) => ({ log: [...s.log, message].slice(-60) }));

  const startSession = (room: string, isHost: boolean, overrideUrl?: string) => {
    const metadata = useSessionStore.getState().metadata;
    if (!metadata) {
      set({ status: "error", error: "Unlock a vault before syncing." });
      return;
    }

    const cfg = useSettingsStore.getState().settings.sync;
    const signalingUrl = (overrideUrl || cfg.signalingUrl).trim();
    const filename = basename(metadata.path);

    activeSession?.close();
    activeSession = null;

    set({
      room,
      isHost,
      signalingUrl,
      status: "connecting",
      peerCount: 0,
      progress: { ...EMPTY_PROGRESS },
      log: [],
      lastResult: null,
      error: null,
    });

    // Probe the persisted version store once. If the command is missing, the
    // running Rust backend is stale (e.g. launched via `npm run dev`, which only
    // builds the frontend) — surface it, since without it the vault re-pulls
    // every reconnect.
    void syncGetMtime(filename).catch(() =>
      pushLog(
        "⚠ Sync version store unavailable — the Rust backend is out of date. " +
          "Rebuild & run with `npm run tauri dev` (not `npm run dev`).",
      ),
    );

    // The advertised version is a persisted *logical* clock (Rust-backed, like
    // the mobile app's), NOT the raw filesystem mtime — that's the key to
    // convergence. We advertise exactly the version we last converged to, so a
    // peer that holds the same version sees us as equal and neither side pulls.
    const loadLocal = async () => {
      const wasDirty = useSessionStore.getState().dirty;
      if (wasDirty) {
        await saveDatabase();
        useSessionStore.getState().setDirty(false);
      }
      const { bytes } = await syncExportSnapshot();
      const stat = await statFile(metadata.path).catch(() => null);
      const fileMtime = stat?.modified ?? Date.now();
      const known = await syncGetMtime(filename).catch(() => 0);

      let lastModified: number;
      if (wasDirty) {
        // A local edit just landed → it's a new version (now).
        lastModified = fileMtime;
      } else if (known > 0 && fileMtime <= known + 1500) {
        // Use our converged logical version (don't let a raw fs mtime inflate it).
        lastModified = known;
      } else {
        // First time, or the file changed outside the app (mtime jumped past our
        // recorded version) → adopt the filesystem mtime as the new version.
        lastModified = fileMtime;
      }
      await syncSetMtime(filename, lastModified).catch(() => {});
      return { bytes, lastModified };
    };

    // Merge received bytes into the open vault, persist, and refresh the UI.
    // `remoteMtime` is the peer's content-version timestamp; we adopt it locally
    // so an already-in-sync vault isn't re-pulled on every reconnect (the node
    // tracks a logical content mtime, not our filesystem mtime).
    const applyRemote = async (bytes: Uint8Array, remoteMtime: number) => {
      const result = await syncMergeSnapshot(bytes);
      let lastModified: number;
      if (result.changed) {
        // The merge produced a genuinely new version both sides converge to.
        await saveDatabase();
        useSessionStore.getState().setDirty(false);
        const db = useDatabaseStore.getState();
        await Promise.all([db.refreshTree(), db.refreshEntries(), db.refreshTags()]);
        const stat = await statFile(metadata.path).catch(() => null);
        const fileMtime = stat?.modified ?? Date.now();
        // Make it strictly the newest so peers pull this merged result.
        lastModified = Math.max(fileMtime, remoteMtime + 1000);
      } else {
        // No content change — converge to the peer's version *exactly* (like the
        // mobile's recordRemoteApply). Using max() here would inflate our
        // version above the peer's and make it pull back from us forever.
        lastModified = remoteMtime;
      }
      // Persist the converged version (authoritative) and align the file mtime.
      await syncSetMtime(filename, lastModified).catch(() => {});
      await setFileMtime(metadata.path, lastModified).catch(() => {});
      return { changed: result.changed, lastModified, result };
    };

    const session = new SyncSession(
      { signalingUrl, room, iceServers: cfg.iceServers, filename, loadLocal, applyRemote },
      {
        onStatus: (status) => set({ status }),
        onPeers: (peerCount) => set({ peerCount }),
        onProgress: (progress) => set({ progress }),
        onLog: pushLog,
        onError: (message) => set({ error: message }),
        onMerged: (result) => set({ lastResult: result }),
      },
    );
    activeSession = session;
    session.start();
    // Remember this room so the vault auto-reconnects on next open.
    rememberRoom(room, true);
  };

  return {
    mode: "offline",
    status: "idle",
    room: null,
    signalingUrl: "",
    isHost: false,
    peerCount: 0,
    progress: { ...EMPTY_PROGRESS },
    log: [],
    lastResult: null,
    error: null,

    setMode: (mode) => {
      if (mode === "offline") get().leave();
      set({ mode });
    },
    createRoom: () => {
      set({ mode: "network" });
      startSession(generateRoomId(), true);
    },
    joinRoom: (room, signalingUrl) => {
      set({ mode: "network" });
      startSession(room.trim(), false, signalingUrl);
    },
    leave: () => {
      activeSession?.close();
      activeSession = null;
      // Stop auto-reconnecting; keep the room value so the user can rejoin it.
      rememberRoom(null, false);
      set({
        status: "idle",
        room: null,
        isHost: false,
        peerCount: 0,
        progress: { ...EMPTY_PROGRESS },
        lastResult: null,
        error: null,
      });
    },
    pushNow: () => {
      void activeSession?.pushUpdate();
    },
    stop: () => {
      activeSession?.close();
      activeSession = null;
      set({
        status: "idle",
        room: null,
        isHost: false,
        peerCount: 0,
        progress: { ...EMPTY_PROGRESS },
        lastResult: null,
        error: null,
      });
    },
    autoStart: () => {
      // Only when nothing is running and a vault is open.
      if (get().status !== "idle" || activeSession) return;
      if (!useSessionStore.getState().metadata) return;
      const sync = useSettingsStore.getState().settings.sync;
      if (sync.autoSync && sync.room && sync.signalingUrl) {
        set({ mode: "network" });
        startSession(sync.room, false);
      }
    },
  };
});
