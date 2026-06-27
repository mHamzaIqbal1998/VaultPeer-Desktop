import { create } from "zustand";
import {
  getSettings,
  saveSettings,
  type AppSettings,
  DEFAULT_CREATE_OPTIONS,
} from "@/services/tauri";

/**
 * Application settings (PLAN Phase 7). The canonical copy lives in the Rust
 * backend (a JSON file in AppData); this store mirrors it for the UI and writes
 * changes straight back through `save_settings`. We keep a sensible default so
 * the app renders before the async load resolves.
 */

const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  theme: "system",
  autoLockSeconds: 600,
  clipboardClearSeconds: 30,
  minimizeToTray: true,
  startWithWindows: false,
  generator: {
    length: 20,
    uppercase: true,
    lowercase: true,
    digits: true,
    symbols: true,
    excludeAmbiguous: false,
  },
  defaultCreateOptions: DEFAULT_CREATE_OPTIONS,
  shortcuts: {
    search: "Ctrl+K",
    lock: "Ctrl+L",
    save: "Ctrl+S",
    newEntry: "Ctrl+N",
    generator: "Ctrl+G",
    settings: "Ctrl+,",
    copyPassword: "Ctrl+C",
    copyUsername: "Ctrl+B",
  },
  sync: {
    signalingUrl: "",
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
    room: "",
    autoSync: false,
  },
  backup: {
    enabled: false,
    retention: 3,
    dir: "",
    dirName: "",
  },
};

interface SettingsState {
  settings: AppSettings;
  /** True until the first load from the backend completes. */
  loading: boolean;
  /** Load settings from the backend (call once at startup). */
  load: () => Promise<void>;
  /**
   * Merge a partial update into the settings and persist the whole object.
   * Returns once the write resolves so callers can surface errors.
   */
  update: (patch: Partial<AppSettings>) => Promise<void>;
  /** Replace the in-memory settings without persisting (e.g. after a backend echo). */
  setLocal: (settings: AppSettings) => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loading: true,
  load: async () => {
    try {
      const settings = await getSettings();
      set({ settings, loading: false });
    } catch {
      // Backend unavailable (shouldn't happen) — keep defaults.
      set({ loading: false });
    }
  },
  update: async (patch) => {
    const next = { ...get().settings, ...patch };
    set({ settings: next });
    await saveSettings(next);
  },
  setLocal: (settings) => set({ settings }),
}));
