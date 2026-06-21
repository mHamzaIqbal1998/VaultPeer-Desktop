import { create } from "zustand";
import { persist } from "zustand/middleware";

/** A recently-opened database, surfaced on the unlock screen later. */
export interface RecentFile {
  path: string;
  name: string;
  lastOpened: number;
}

interface VaultState {
  /** Absolute path of the database the user has selected (not yet unlocked). */
  selectedPath: string | null;
  recentFiles: RecentFile[];
  setSelectedPath: (path: string | null) => void;
  addRecentFile: (path: string) => void;
  removeRecentFile: (path: string) => void;
  clearRecentFiles: () => void;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

const MAX_RECENT = 10;

export const useVaultStore = create<VaultState>()(
  persist(
    (set) => ({
      selectedPath: null,
      recentFiles: [],
      setSelectedPath: (path) => set({ selectedPath: path }),
      addRecentFile: (path) =>
        set((state) => {
          const entry: RecentFile = {
            path,
            name: basename(path),
            lastOpened: Date.now(),
          };
          const deduped = state.recentFiles.filter((f) => f.path !== path);
          return {
            recentFiles: [entry, ...deduped].slice(0, MAX_RECENT),
          };
        }),
      removeRecentFile: (path) =>
        set((state) => ({
          recentFiles: state.recentFiles.filter((f) => f.path !== path),
        })),
      clearRecentFiles: () => set({ recentFiles: [] }),
    }),
    {
      name: "vaultpeer-vault",
      partialize: (state) => ({ recentFiles: state.recentFiles }),
    },
  ),
);
