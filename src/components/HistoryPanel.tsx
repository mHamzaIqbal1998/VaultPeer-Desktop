import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  deleteEntryHistory,
  getEntryHistory,
  restoreEntryHistory,
  type HistoryItem,
} from "@/services/tauri";
import { useSessionStore } from "@/stores/sessionStore";
import { useDatabaseStore } from "@/stores/databaseStore";

interface Props {
  entryUuid: string;
  /** Called after a restore so the detail view can reload the entry. */
  onRestored: () => void;
  onClose: () => void;
}

/**
 * Entry history browser (PLAN Phase 4: view history, restore, delete snapshots).
 * Lists snapshots newest-first; each can be restored (the current state is
 * snapshotted first, so it is reversible) or removed individually.
 */
export function HistoryPanel({ entryUuid, onRestored, onClose }: Props) {
  const setDirty = useSessionStore((s) => s.setDirty);
  const refreshEntries = useDatabaseStore((s) => s.refreshEntries);

  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setItems(await getEntryHistory(entryUuid));
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryUuid]);

  async function restore(index: number) {
    setBusy(true);
    setError(null);
    try {
      await restoreEntryHistory(entryUuid, index);
      setDirty(true);
      await Promise.all([load(), refreshEntries()]);
      onRestored();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(index: number) {
    setBusy(true);
    setError(null);
    try {
      await deleteEntryHistory(entryUuid, index);
      setDirty(true);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/50 p-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border-sage bg-surface-card shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-border-sage px-5 py-4">
          <h2 className="text-base font-semibold text-text-primary">Entry History</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-7 w-7 place-items-center rounded-md text-text-muted transition-colors hover:bg-accent-mint-dim hover:text-text-primary"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {error && (
            <div className="mb-3 rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-status-error">
              {error}
            </div>
          )}
          {items == null ? (
            <p className="text-sm text-text-muted">Loading…</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-text-muted">
              No history yet — snapshots are saved each time you edit this entry.
            </p>
          ) : (
            <div className="space-y-2">
              {items.map((h) => (
                <div
                  key={h.index}
                  className="flex items-center gap-3 rounded-lg border border-border-sage bg-background-primary px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-text-primary">
                      {h.title || "(no title)"}
                    </p>
                    <p className="truncate text-xs text-text-muted">
                      {h.modified != null ? formatDate(h.modified) : "Unknown date"}
                      {h.username ? ` · ${h.username}` : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => restore(h.index)}
                    className="rounded-md border border-border-sage px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:border-accent-mint/50 hover:text-accent-mint disabled:opacity-50"
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => remove(h.index)}
                    aria-label="Delete snapshot"
                    title="Delete snapshot"
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-text-muted transition-colors hover:text-status-error disabled:opacity-50"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                      <path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
