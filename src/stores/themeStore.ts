import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemePreference = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

interface ThemeState {
  /** The user's chosen preference. */
  preference: ThemePreference;
  /** The theme actually applied to the DOM (system resolves to dark/light). */
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  /** Re-evaluate the resolved theme (e.g. when the OS scheme changes). */
  applyResolved: () => void;
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolve(pref: ThemePreference): ResolvedTheme {
  if (pref === "system") return systemPrefersDark() ? "dark" : "light";
  return pref;
}

/** Push the resolved theme onto the <html data-theme> attribute. */
function commitToDom(resolved: ResolvedTheme) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", resolved);
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      preference: "system",
      resolved: resolve("system"),
      setPreference: (preference) => {
        const resolved = resolve(preference);
        commitToDom(resolved);
        set({ preference, resolved });
      },
      applyResolved: () => {
        const resolved = resolve(get().preference);
        commitToDom(resolved);
        set({ resolved });
      },
    }),
    {
      name: "vaultpeer-theme",
      partialize: (state) => ({ preference: state.preference }),
      onRehydrateStorage: () => (state) => {
        // After preference is restored from storage, apply it to the DOM.
        state?.applyResolved();
      },
    },
  ),
);

/**
 * Wire up the OS color-scheme listener so "system" preference reacts live.
 * Call once at app startup. Returns an unsubscribe function.
 */
export function initThemeSystemListener(): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    if (useThemeStore.getState().preference === "system") {
      useThemeStore.getState().applyResolved();
    }
  };
  mq.addEventListener("change", handler);
  // Ensure DOM reflects current state immediately.
  useThemeStore.getState().applyResolved();
  return () => mq.removeEventListener("change", handler);
}
