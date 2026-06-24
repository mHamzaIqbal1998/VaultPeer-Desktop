import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { listen } from "@tauri-apps/api/event";
import { TitleBar } from "@/components/TitleBar";
import { UnlockScreen } from "@/components/UnlockScreen";
import { MainLayout } from "@/components/MainLayout";
import { PasswordGenerator } from "@/components/PasswordGenerator";
import { SearchModal } from "@/components/SearchModal";
import { SettingsPanel } from "@/components/SettingsPanel";
import { SyncPanel } from "@/components/SyncPanel";
import { useSessionStore } from "@/stores/sessionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSyncStore } from "@/stores/syncStore";
import { matchesAccelerator } from "@/lib/shortcuts";
import {
  autoTypeToWindow,
  getEntry,
  lockDatabase,
  recentEntries,
  saveDatabase,
  setTrayRecent,
  AUTOTYPE_EVENT,
  type AutoTypeStatus,
} from "@/services/tauri";
import { copyToClipboard } from "@/lib/clipboard";

/** Tauri event emitted by the tray's "Lock Database" item (see tray.rs). */
const LOCK_EVENT = "vault://lock";
/** Tauri event emitted (uuid payload) when a tray recent-entry is clicked. */
const TRAY_ENTRY_EVENT = "vault://tray-entry";

interface AutoTypePick {
  open: boolean;
  windowTitle: string;
  selective: boolean;
}

/**
 * Guess a search query from a window title. Browser/app titles are typically
 * "Page Title — App Name"; the first segment is the most useful match key.
 */
function guessQuery(windowTitle: string): string {
  const first = windowTitle.split(/\s[-—|·]\s/)[0]?.trim() ?? "";
  return first.slice(0, 40);
}

export default function App() {
  const metadata = useSessionStore((s) => s.metadata);
  const setLocked = useSessionStore((s) => s.setLocked);
  const setDirty = useSessionStore((s) => s.setDirty);
  const dirty = useSessionStore((s) => s.dirty);
  const isUnlocked = metadata !== null;

  const loadSettings = useSettingsStore((s) => s.load);
  const settingsLoading = useSettingsStore((s) => s.loading);
  const shortcuts = useSettingsStore((s) => s.settings.shortcuts);
  const autoLockSeconds = useSettingsStore((s) => s.settings.autoLockSeconds);
  const syncAutoStart = useSyncStore((s) => s.autoStart);
  const syncStop = useSyncStore((s) => s.stop);
  const pushNow = useSyncStore((s) => s.pushNow);

  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [autoTypePick, setAutoTypePick] = useState<AutoTypePick>({
    open: false,
    windowTitle: "",
    selective: false,
  });
  const [toast, setToast] = useState<{ kind: AutoTypeStatus["kind"]; message: string } | null>(null);

  // Load persisted settings once at startup (PLAN Phase 7).
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // Lock from the system tray: drop backend state, then clear the UI session.
  useEffect(() => {
    const unlisten = listen(LOCK_EVENT, async () => {
      try {
        await lockDatabase();
      } finally {
        setLocked();
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [setLocked]);

  // Tray recent-entry click: copy that entry's password to the clipboard.
  useEffect(() => {
    const unlisten = listen<string>(TRAY_ENTRY_EVENT, async (event) => {
      try {
        const detail = await getEntry(event.payload);
        await copyToClipboard(detail.password, { label: "Password" });
      } catch {
        /* entry may have been deleted; ignore */
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Auto-type feedback: show a toast on success/error, or open the entry picker
  // when no entry matched the focused window (PLAN Phase 6 / ATY).
  useEffect(() => {
    const unlisten = listen<AutoTypeStatus>(AUTOTYPE_EVENT, (event) => {
      const s = event.payload;
      if (s.kind === "pick") {
        setAutoTypePick({ open: true, windowTitle: s.windowTitle, selective: s.selective });
      } else {
        setToast({ kind: s.kind, message: s.message });
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Auto-dismiss the auto-type toast.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(id);
  }, [toast]);

  // Keep the tray's recent-entries quick-access section in sync: populate on
  // unlock and after each save, clear on lock (PLAN Phase 6).
  useEffect(() => {
    let cancelled = false;
    if (isUnlocked) {
      recentEntries(8)
        .then((entries) => {
          if (cancelled) return;
          void setTrayRecent(
            entries.map((e) => ({ uuid: e.uuid, title: e.title || "(no title)" })),
          );
        })
        .catch(() => {});
    } else {
      void setTrayRecent([]).catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [isUnlocked, dirty]);

  // Auto-sync (PLAN Phase 8): once settings are loaded, opening a vault
  // auto-rejoins the remembered room and keeps it in sync; locking tears the
  // session down (without forgetting the room).
  useEffect(() => {
    if (settingsLoading) return;
    if (isUnlocked) {
      syncAutoStart();
    } else {
      syncStop();
    }
  }, [isUnlocked, settingsLoading, syncAutoStart, syncStop]);

  // Keyboard shortcuts (PRD §5.3), using the user's customizable bindings
  // (PLAN Phase 7 / SET-11): lock, save, generator, search, settings.
  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      if (matchesAccelerator(e, shortcuts.settings)) {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (matchesAccelerator(e, shortcuts.generator)) {
        e.preventDefault();
        setGeneratorOpen(true);
      } else if (isUnlocked && matchesAccelerator(e, shortcuts.search)) {
        e.preventDefault();
        setSearchOpen(true);
      } else if (isUnlocked && matchesAccelerator(e, shortcuts.lock)) {
        e.preventDefault();
        await lockDatabase().catch(() => {});
        setLocked();
      } else if (isUnlocked && matchesAccelerator(e, shortcuts.save)) {
        e.preventDefault();
        try {
          await saveDatabase();
          setDirty(false);
          // Push the saved changes to any connected peer (PLAN Phase 8).
          pushNow();
        } catch {
          /* surfaced via the Save button in VaultView */
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isUnlocked, setLocked, setDirty, shortcuts, pushNow]);

  // Auto-lock after inactivity (PLAN Phase 7 / UN-04). Any user input resets a
  // timer; when it elapses we lock the vault and clear the UI session. Disabled
  // when locked or when the timeout is set to "Never" (0).
  useEffect(() => {
    if (!isUnlocked || autoLockSeconds <= 0) return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        await lockDatabase().catch(() => {});
        setLocked();
      }, autoLockSeconds * 1000);
    };
    const events = ["mousemove", "mousedown", "keydown", "wheel", "touchstart"];
    events.forEach((evt) => window.addEventListener(evt, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach((evt) => window.removeEventListener(evt, reset));
    };
  }, [isUnlocked, autoLockSeconds, setLocked]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background-primary text-text-primary">
      <TitleBar
        onOpenGenerator={() => setGeneratorOpen(true)}
        onOpenSearch={isUnlocked ? () => setSearchOpen(true) : undefined}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenSync={() => setSyncOpen(true)}
      />
      <main className="flex-1 overflow-hidden">
        {isUnlocked ? <MainLayout /> : <UnlockScreen />}
      </main>
      {generatorOpen && <PasswordGenerator onClose={() => setGeneratorOpen(false)} />}
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      {syncOpen && (
        <SyncPanel
          onClose={() => setSyncOpen(false)}
          onOpenSettings={() => {
            setSyncOpen(false);
            setSettingsOpen(true);
          }}
        />
      )}
      {searchOpen && isUnlocked && (
        <SearchModal onClose={() => setSearchOpen(false)} />
      )}
      {autoTypePick.open && isUnlocked && (
        <SearchModal
          heading={
            autoTypePick.windowTitle
              ? `Auto-type into “${autoTypePick.windowTitle}” — pick an entry`
              : "Pick an entry to auto-type"
          }
          initialQuery={guessQuery(autoTypePick.windowTitle)}
          onChoose={(entry) => {
            void autoTypeToWindow(entry.uuid, autoTypePick.selective);
          }}
          onClose={() =>
            setAutoTypePick({ open: false, windowTitle: "", selective: false })
          }
        />
      )}

      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ duration: 0.18 }}
            className={`fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-xl border px-4 py-2.5 text-sm shadow-2xl ${
              toast.kind === "typed"
                ? "border-accent-mint/40 bg-surface-elevated text-text-primary"
                : "border-status-error/40 bg-status-error/10 text-status-error"
            }`}
          >
            {toast.kind === "typed" ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
                <path d="M12 8v5M12 16h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            )}
            <span>{toast.message}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
