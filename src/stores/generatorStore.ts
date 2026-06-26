import { create } from "zustand";

/**
 * Session-only history of generated passwords/passphrases (PLAN Phase 5). Held
 * in memory and never persisted — it survives reopening the generator tool
 * within a session but is gone on app restart.
 */
interface GeneratorState {
  history: string[];
  /** Record a freshly-generated value (deduped against the most recent one). */
  remember: (value: string) => void;
  clear: () => void;
}

const MAX_HISTORY = 20;

export const useGeneratorStore = create<GeneratorState>((set) => ({
  history: [],
  remember: (value) =>
    set((s) =>
      !value || s.history[0] === value
        ? s
        : { history: [value, ...s.history].slice(0, MAX_HISTORY) },
    ),
  clear: () => set({ history: [] }),
}));
