import { create } from "zustand";
import type { DatabaseMetadata } from "@/services/tauri";

/**
 * The unlocked-vault session. Deliberately *not* persisted — decrypted state
 * lives only in the Rust backend for the lifetime of the unlock, and this store
 * only mirrors the metadata needed to render the UI. Locking clears it.
 */
interface SessionState {
  /** Metadata of the open database, or null when locked. */
  metadata: DatabaseMetadata | null;
  /** True while an open/create/save command is in flight. */
  busy: boolean;
  /** True if there are unsaved in-memory changes (set by edit ops in Phase 3+). */
  dirty: boolean;
  setUnlocked: (metadata: DatabaseMetadata) => void;
  setLocked: () => void;
  setBusy: (busy: boolean) => void;
  setDirty: (dirty: boolean) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  metadata: null,
  busy: false,
  dirty: false,
  setUnlocked: (metadata) => set({ metadata, dirty: false }),
  setLocked: () => set({ metadata: null, dirty: false }),
  setBusy: (busy) => set({ busy }),
  setDirty: (dirty) => set({ dirty }),
}));
