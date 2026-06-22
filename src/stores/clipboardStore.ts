import { create } from "zustand";

/**
 * Tracks the secret currently sitting on the clipboard so the UI can show a
 * "clears in Ns" countdown and a clear-now affordance (PLAN Phase 6 / CLP-02).
 * The actual write + auto-clear timer lives in `lib/clipboard.ts`; this store is
 * only the observable mirror it drives.
 */
interface ClipboardState {
  /** What was copied, e.g. "Password" or "Username" — null when nothing/cleared. */
  label: string | null;
  /** Epoch ms when the clipboard will be auto-cleared, or null. */
  clearsAt: number | null;
  copied: (label: string, clearsAt: number) => void;
  cleared: () => void;
}

export const useClipboardStore = create<ClipboardState>((set) => ({
  label: null,
  clearsAt: null,
  copied: (label, clearsAt) => set({ label, clearsAt }),
  cleared: () => set({ label: null, clearsAt: null }),
}));
