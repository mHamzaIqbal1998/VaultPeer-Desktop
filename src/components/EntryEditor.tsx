import { useState } from "react";
import { motion } from "framer-motion";
import {
  EMPTY_ENTRY_INPUT,
  type EntryDetail,
  type EntryInput,
} from "@/services/tauri";
import { useDatabaseStore } from "@/stores/databaseStore";
import { PasswordField } from "./PasswordField";
import { StrengthMeter } from "./StrengthMeter";
import { IconPicker } from "./IconPicker";
import { PasswordGeneratorPopover } from "./PasswordGeneratorPopover";

interface Props {
  /** The entry being edited, or null to create a new one. */
  entry: EntryDetail | null;
  /** Group the new entry is created in (ignored when editing). */
  groupUuid: string;
  onClose: () => void;
}

/**
 * Entry creation/editing form (PLAN Phase 3). Covers the standard KeePass
 * fields (Title, Username, Password, URL, Notes) plus the icon picker and an
 * integrated password generator. Existing tags are preserved untouched
 * (tag editing lands in Phase 4).
 */
export function EntryEditor({ entry, groupUuid, onClose }: Props) {
  const createEntry = useDatabaseStore((s) => s.createEntry);
  const updateEntry = useDatabaseStore((s) => s.updateEntry);

  const isEdit = entry !== null;
  const [form, setForm] = useState<EntryInput>(
    entry
      ? {
          title: entry.title,
          username: entry.username,
          password: entry.password,
          url: entry.url,
          notes: entry.notes,
          icon: entry.icon,
          tags: entry.tags,
        }
      : { ...EMPTY_ENTRY_INPUT },
  );
  const [showGenerator, setShowGenerator] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function patch(p: Partial<EntryInput>) {
    setForm((f) => ({ ...f, ...p }));
  }

  async function handleSave() {
    if (!form.title.trim() && !form.username.trim() && !form.url.trim()) {
      setError("Give the entry a title, username, or URL.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (isEdit && entry) {
        await updateEntry(entry.uuid, form);
      } else {
        await createEntry(groupUuid, form);
      }
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border-sage bg-surface-card shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-border-sage px-5 py-4">
          <h2 className="text-base font-semibold text-text-primary">
            {isEdit ? "Edit Entry" : "New Entry"}
          </h2>
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

        <div className="space-y-4 overflow-auto px-5 py-4">
          <div className="flex items-end gap-3">
            <div>
              <span className="mb-1.5 block text-xs font-medium text-text-muted">Icon</span>
              <IconPicker value={form.icon} onChange={(icon) => patch({ icon })} />
            </div>
            <div className="flex-1">
              <Field label="Title">
                <input
                  value={form.title}
                  autoFocus
                  onChange={(e) => patch({ title: e.target.value })}
                  placeholder="e.g. Gmail"
                  className={inputCls}
                />
              </Field>
            </div>
          </div>

          <Field label="Username">
            <input
              value={form.username}
              onChange={(e) => patch({ username: e.target.value })}
              placeholder="user@example.com"
              className={inputCls}
            />
          </Field>

          <div className="relative">
            <span className="mb-1.5 flex items-center justify-between text-xs font-medium text-text-muted">
              <span>Password</span>
              <button
                type="button"
                onClick={() => setShowGenerator((s) => !s)}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-accent-mint transition-colors hover:bg-accent-mint-dim"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M4 12a8 8 0 0 1 14-5m2-2v4h-4M20 12a8 8 0 0 1-14 5m-2 2v-4h4"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                Generate
              </button>
            </span>
            <PasswordField
              value={form.password}
              onChange={(password) => patch({ password })}
              placeholder="Password"
            />
            <div className="mt-2">
              <StrengthMeter password={form.password} />
            </div>
            {showGenerator && (
              <PasswordGeneratorPopover
                onApply={(password) => patch({ password })}
                onClose={() => setShowGenerator(false)}
              />
            )}
          </div>

          <Field label="URL">
            <input
              value={form.url}
              onChange={(e) => patch({ url: e.target.value })}
              placeholder="https://example.com"
              className={inputCls}
            />
          </Field>

          <Field label="Notes">
            <textarea
              value={form.notes}
              onChange={(e) => patch({ notes: e.target.value })}
              rows={4}
              placeholder="Additional notes…"
              className={`${inputCls} resize-y`}
            />
          </Field>

          {error && (
            <div className="rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-status-error">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border-sage px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-border-sage px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:border-accent-mint/40 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={busy}
            className="rounded-lg bg-accent-mint px-4 py-2 text-sm font-semibold text-background-primary transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Saving…" : isEdit ? "Save Changes" : "Create Entry"}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-border-sage bg-background-primary px-3 py-2.5 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-mint";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="mb-1.5 block text-xs font-medium text-text-muted">{label}</span>
      {children}
    </div>
  );
}
