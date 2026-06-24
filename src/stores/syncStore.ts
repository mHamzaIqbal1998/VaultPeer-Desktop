import { create } from "zustand";
import {
  saveDatabase,
  statFile,
  syncExportSnapshot,
  syncMergeSnapshot,
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
}

let activeSession: SyncSession | null = null;

const EMPTY_PROGRESS: SyncProgress = { sent: 0, sentTotal: 0, received: 0, receivedTotal: 0 };

/** Basename of a path (the filename peers use to identify a shared vault). */
function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
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

    // Read the current vault as encrypted bytes + on-disk mtime. Save first if
    // there are unsaved edits so the advertised mtime matches what we send.
    const loadLocal = async () => {
      if (useSessionStore.getState().dirty) {
        await saveDatabase();
        useSessionStore.getState().setDirty(false);
      }
      const { bytes } = await syncExportSnapshot();
      const stat = await statFile(metadata.path).catch(() => null);
      return { bytes, lastModified: stat?.modified ?? Date.now() };
    };

    // Merge received bytes into the open vault, persist, and refresh the UI.
    const applyRemote = async (bytes: Uint8Array) => {
      const result = await syncMergeSnapshot(bytes);
      if (result.changed) {
        await saveDatabase();
        useSessionStore.getState().setDirty(false);
        const db = useDatabaseStore.getState();
        await Promise.all([db.refreshTree(), db.refreshEntries(), db.refreshTags()]);
      }
      const stat = await statFile(metadata.path).catch(() => null);
      return { changed: result.changed, lastModified: stat?.modified ?? Date.now(), result };
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
    createRoom: () => startSession(generateRoomId(), true),
    joinRoom: (room, signalingUrl) => startSession(room.trim(), false, signalingUrl),
    leave: () => {
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
  };
});
