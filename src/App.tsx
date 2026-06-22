import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { listen } from "@tauri-apps/api/event";
import { TitleBar } from "@/components/TitleBar";
import { UnlockScreen } from "@/components/UnlockScreen";
import { MainLayout } from "@/components/MainLayout";
import { PasswordGenerator } from "@/components/PasswordGenerator";
import { SearchModal } from "@/components/SearchModal";
import { useSessionStore } from "@/stores/sessionStore";
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

  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [autoTypePick, setAutoTypePick] = useState<AutoTypePick>({
    open: false,
    windowTitle: "",
    selective: false,
  });
  const [toast, setToast] = useState<{ kind: AutoTypeStatus["kind"]; message: string } | null>(null);

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

  // Keyboard shortcuts: Ctrl+L lock, Ctrl+S save (PRD §5.3).
  useEffect(() => {
    if (!isUnlocked) return;
    const handler = async (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        await lockDatabase().catch(() => {});
        setLocked();
      } else if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        try {
          await saveDatabase();
          setDirty(false);
        } catch {
          /* surfaced via the Save button in VaultView */
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isUnlocked, setLocked, setDirty]);

  // Ctrl+G: password generator. Ctrl+K: global search (PRD §5.3 / SRC-05).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "g" || e.key === "G") {
        e.preventDefault();
        setGeneratorOpen(true);
      } else if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        if (isUnlocked) setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isUnlocked]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background-primary text-text-primary">
      <TitleBar
        onOpenGenerator={() => setGeneratorOpen(true)}
        onOpenSearch={isUnlocked ? () => setSearchOpen(true) : undefined}
      />
      <main className="flex-1 overflow-hidden">
        {isUnlocked ? <MainLayout /> : <UnlockScreen />}
      </main>
      {generatorOpen && <PasswordGenerator onClose={() => setGeneratorOpen(false)} />}
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
