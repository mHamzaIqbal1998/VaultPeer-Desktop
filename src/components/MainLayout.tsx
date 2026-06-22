import { useEffect, useState } from "react";
import { getEntry, saveDatabase, type EntryDetail as EntryDetailData } from "@/services/tauri";
import { useSessionStore } from "@/stores/sessionStore";
import { useDatabaseStore } from "@/stores/databaseStore";
import { copyToClipboard } from "@/lib/clipboard";
import { GroupTree } from "./GroupTree";
import { EntryList } from "./EntryList";
import { EntryDetail } from "./EntryDetail";
import { EntryEditor } from "./EntryEditor";

/** True when focus is in a text field, so global copy hotkeys defer to it. */
function isEditingText(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    (el as HTMLElement).isContentEditable
  );
}

type EditorState =
  | { open: true; entry: EntryDetailData | null }
  | { open: false };

/**
 * The unlocked database workspace (PLAN Phase 3): a three-pane layout of the
 * group tree, the entry list, and the entry detail pane, plus the entry editor
 * modal. Loads the tree on mount and clears it on unmount/lock.
 */
export function MainLayout() {
  const metadata = useSessionStore((s) => s.metadata);
  const dirty = useSessionStore((s) => s.dirty);
  const setDirty = useSessionStore((s) => s.setDirty);

  const init = useDatabaseStore((s) => s.init);
  const reset = useDatabaseStore((s) => s.reset);
  const selectedGroupUuid = useDatabaseStore((s) => s.selectedGroupUuid);
  const selectedEntryUuid = useDatabaseStore((s) => s.selectedEntryUuid);
  const error = useDatabaseStore((s) => s.error);

  const [editor, setEditor] = useState<EditorState>({ open: false });
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  // Load the tree when the workspace mounts; tear it down when it unmounts.
  useEffect(() => {
    void init();
    return () => reset();
  }, [init, reset]);

  // Ctrl+N: create a new entry in the current group (PRD §5.3).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        if (selectedGroupUuid) setEditor({ open: true, entry: null });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedGroupUuid]);

  // Ctrl+C / Ctrl+B: copy the selected entry's password / username (PRD §5.3 /
  // CLP-01). Skipped while editing text or when the user has a selection, so
  // normal copy still works.
  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key !== "c" && key !== "b") return;
      if (!selectedEntryUuid || isEditingText()) return;
      if (window.getSelection()?.toString()) return; // honour a real text selection
      e.preventDefault();
      try {
        const detail = await getEntry(selectedEntryUuid);
        if (key === "c") {
          await copyToClipboard(detail.password, { label: "Password" });
        } else {
          await copyToClipboard(detail.username, { label: "Username" });
        }
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedEntryUuid]);

  async function handleSave() {
    setSaving(true);
    try {
      await saveDatabase();
      setDirty(false);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
    } catch {
      /* surfaced below via the error banner if needed */
    } finally {
      setSaving(false);
    }
  }

  if (!metadata) return null;

  return (
    <div className="flex h-full flex-col">
      {/* Database header strip */}
      <div className="flex items-center justify-between gap-3 border-b border-border-sage bg-surface-card px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold text-text-primary" title={metadata.path}>
            {metadata.name || "Untitled Database"}
          </span>
          {dirty && (
            <span className="shrink-0 text-xs font-medium text-status-warning">● unsaved</span>
          )}
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || (!dirty && !savedFlash)}
          className="shrink-0 rounded-lg border border-border-sage bg-surface-elevated px-3 py-1.5 text-sm font-medium text-text-primary transition-colors hover:border-accent-mint/40 disabled:opacity-50"
        >
          {saving ? "Saving…" : savedFlash ? "Saved" : "Save"}
        </button>
      </div>

      {error && (
        <div className="border-b border-status-error/30 bg-status-error/10 px-4 py-2 text-xs text-status-error">
          {error}
        </div>
      )}

      {/* Three-pane workspace */}
      <div className="flex min-h-0 flex-1">
        <aside className="w-64 shrink-0 border-r border-border-sage bg-surface-card/40">
          <GroupTree />
        </aside>

        <main className="min-w-0 flex-1">
          <EntryList
            onNewEntry={() =>
              selectedGroupUuid && setEditor({ open: true, entry: null })
            }
          />
        </main>

        {selectedEntryUuid && (
          <EntryDetail
            onEdit={(entry) => setEditor({ open: true, entry })}
          />
        )}
      </div>

      {editor.open && selectedGroupUuid && (
        <EntryEditor
          entry={editor.entry}
          groupUuid={editor.entry?.groupUuid ?? selectedGroupUuid}
          onClose={() => setEditor({ open: false })}
        />
      )}
    </div>
  );
}
