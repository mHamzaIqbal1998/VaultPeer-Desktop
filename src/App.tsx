import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { TitleBar } from "@/components/TitleBar";
import { UnlockScreen } from "@/components/UnlockScreen";
import { MainLayout } from "@/components/MainLayout";
import { PasswordGenerator } from "@/components/PasswordGenerator";
import { useSessionStore } from "@/stores/sessionStore";
import { lockDatabase, saveDatabase } from "@/services/tauri";

/** Tauri event emitted by the tray's "Lock Database" item (see tray.rs). */
const LOCK_EVENT = "vault://lock";

export default function App() {
  const metadata = useSessionStore((s) => s.metadata);
  const setLocked = useSessionStore((s) => s.setLocked);
  const setDirty = useSessionStore((s) => s.setDirty);
  const isUnlocked = metadata !== null;

  const [generatorOpen, setGeneratorOpen] = useState(false);

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

  // Ctrl+G: open the standalone password generator tool (PLAN Phase 5).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "g" || e.key === "G")) {
        e.preventDefault();
        setGeneratorOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background-primary text-text-primary">
      <TitleBar onOpenGenerator={() => setGeneratorOpen(true)} />
      <main className="flex-1 overflow-hidden">
        {isUnlocked ? <MainLayout /> : <UnlockScreen />}
      </main>
      {generatorOpen && <PasswordGenerator onClose={() => setGeneratorOpen(false)} />}
    </div>
  );
}
