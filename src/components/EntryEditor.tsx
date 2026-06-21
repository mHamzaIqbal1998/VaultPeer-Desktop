import { useState } from "react";
import { motion } from "framer-motion";
import {
  addAttachment,
  EMPTY_ENTRY_INPUT,
  inputFromDetail,
  openAttachmentDialog,
  readFile,
  removeAttachment,
  type AttachmentMeta,
  type CustomField,
  type EntryDetail,
  type EntryInput,
} from "@/services/tauri";
import { useDatabaseStore } from "@/stores/databaseStore";
import { useSessionStore } from "@/stores/sessionStore";
import { ENTRY_TEMPLATES, type EntryTemplate } from "@/lib/templates";
import { PasswordField } from "./PasswordField";
import { StrengthMeter } from "./StrengthMeter";
import { IconPicker } from "./IconPicker";
import { PasswordGeneratorPopover } from "./PasswordGeneratorPopover";
import { OtpEditor } from "./OtpEditor";
import { TagInput } from "./TagInput";

/** Strip the directory part from a file path (handles both \ and /). */
function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

interface Props {
  /** The entry being edited, or null to create a new one. */
  entry: EntryDetail | null;
  /** Group the new entry is created in (ignored when editing). */
  groupUuid: string;
  onClose: () => void;
}

/** Convert epoch millis to the value a <input type="datetime-local"> expects. */
function toLocalInput(ms: number | null): string {
  if (ms == null) return "";
  const d = new Date(ms);
  // Shift by the timezone offset so the displayed local time round-trips.
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

/** Convert a <input type="datetime-local"> value back to epoch millis. */
function fromLocalInput(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Entry creation/editing form (PLAN Phase 3 + Phase 4). Covers the standard
 * KeePass fields plus custom fields, tags, expiration, and (on creation)
 * templates that pre-populate common record types.
 */
export function EntryEditor({ entry, groupUuid, onClose }: Props) {
  const createEntry = useDatabaseStore((s) => s.createEntry);
  const updateEntry = useDatabaseStore((s) => s.updateEntry);
  const refreshEntries = useDatabaseStore((s) => s.refreshEntries);
  const knownTags = useDatabaseStore((s) => s.tags);
  const setDirty = useSessionStore((s) => s.setDirty);

  const isEdit = entry !== null;
  const [form, setForm] = useState<EntryInput>(
    entry ? inputFromDetail(entry) : { ...EMPTY_ENTRY_INPUT },
  );
  const [templateId, setTemplateId] = useState<string | null>(null);
  // Edit mode operates on the server-side attachment list directly; create mode
  // stages files in memory and commits them once the entry exists.
  const [attachments, setAttachments] = useState<AttachmentMeta[]>(
    entry?.attachments ?? [],
  );
  const [pending, setPending] = useState<{ name: string; data: Uint8Array }[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [attachBusy, setAttachBusy] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function patch(p: Partial<EntryInput>) {
    setForm((f) => ({ ...f, ...p }));
  }

  function applyTemplate(t: EntryTemplate) {
    setForm((f) => {
      // Swap out the previously-selected template's fields (keeping any the user
      // added by hand) and apply the new template's fields + icon.
      const prev = ENTRY_TEMPLATES.find((x) => x.id === templateId);
      const prevKeys = new Set((prev?.fields ?? []).map((pf) => pf.key.toLowerCase()));
      const kept = f.customFields.filter((c) => !prevKeys.has(c.key.toLowerCase()));
      const keptKeys = new Set(kept.map((c) => c.key.toLowerCase()));
      const merged = [
        ...kept,
        ...t.fields.filter((tf) => !keptKeys.has(tf.key.toLowerCase())),
      ];
      return { ...f, icon: t.icon, customFields: merged };
    });
    setTemplateId(t.id);
  }

  async function handleAddAttachment() {
    setAttachError(null);
    try {
      const path = await openAttachmentDialog();
      if (!path) return;
      setAttachBusy(true);
      const bytes = await readFile(path);
      const name = basename(path);
      if (isEdit && entry) {
        setAttachments(await addAttachment(entry.uuid, name, bytes));
        setDirty(true);
        await refreshEntries();
      } else {
        // Replace any staged file with the same name.
        setPending((p) => [...p.filter((x) => x.name !== name), { name, data: bytes }]);
      }
    } catch (e) {
      setAttachError(String(e));
    } finally {
      setAttachBusy(false);
    }
  }

  async function handleRemoveAttachment(name: string) {
    setAttachError(null);
    try {
      if (isEdit && entry) {
        setAttachBusy(true);
        setAttachments(await removeAttachment(entry.uuid, name));
        setDirty(true);
        await refreshEntries();
      } else {
        setPending((p) => p.filter((x) => x.name !== name));
      }
    } catch (e) {
      setAttachError(String(e));
    } finally {
      setAttachBusy(false);
    }
  }

  function setCustomField(index: number, patch: Partial<CustomField>) {
    setForm((f) => ({
      ...f,
      customFields: f.customFields.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    }));
  }

  function addCustomField() {
    setForm((f) => ({
      ...f,
      customFields: [...f.customFields, { key: "", value: "", protected: false }],
    }));
  }

  function removeCustomField(index: number) {
    setForm((f) => ({
      ...f,
      customFields: f.customFields.filter((_, i) => i !== index),
    }));
  }

  async function handleSave() {
    if (!form.title.trim() && !form.username.trim() && !form.url.trim()) {
      setError("Give the entry a title, username, or URL.");
      return;
    }
    // Drop empty custom-field rows before saving.
    const cleaned: EntryInput = {
      ...form,
      customFields: form.customFields.filter((c) => c.key.trim()),
    };
    setBusy(true);
    setError(null);
    try {
      if (isEdit && entry) {
        await updateEntry(entry.uuid, cleaned);
      } else {
        const uuid = await createEntry(groupUuid, cleaned);
        // Commit any files staged before the entry existed.
        for (const p of pending) {
          await addAttachment(uuid, p.name, p.data);
        }
        if (pending.length) await refreshEntries();
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
          {!isEdit && (
            <div>
              <span className="mb-1.5 block text-xs font-medium text-text-muted">
                Start from a template
              </span>
              <div className="flex flex-wrap gap-1.5">
                {ENTRY_TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => applyTemplate(t)}
                    className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                      templateId === t.id
                        ? "border-accent-mint bg-accent-mint-dim text-accent-mint"
                        : "border-border-sage text-text-secondary hover:border-accent-mint/50 hover:text-text-primary"
                    }`}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
          )}

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
              rows={3}
              placeholder="Additional notes…"
              className={`${inputCls} resize-y`}
            />
          </Field>

          <Field label="One-Time Password (2FA)">
            <OtpEditor value={form.otp} onChange={(otp) => patch({ otp })} />
          </Field>

          <Field label="Tags">
            <TagInput
              value={form.tags}
              onChange={(tags) => patch({ tags })}
              suggestions={knownTags}
            />
          </Field>

          {/* Expiration */}
          <div>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={form.expires}
                onChange={(e) =>
                  patch({
                    expires: e.target.checked,
                    expiry:
                      e.target.checked && form.expiry == null
                        ? Date.now() + 30 * 24 * 60 * 60 * 1000
                        : form.expiry,
                  })
                }
                className="h-4 w-4 accent-accent-mint"
              />
              <span className="text-xs font-medium text-text-muted">Expires</span>
            </label>
            {form.expires && (
              <input
                type="datetime-local"
                value={toLocalInput(form.expiry)}
                onChange={(e) => patch({ expiry: fromLocalInput(e.target.value) })}
                className={`${inputCls} mt-2`}
              />
            )}
          </div>

          {/* Custom fields */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-medium text-text-muted">Custom fields</span>
              <button
                type="button"
                onClick={addCustomField}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-accent-mint transition-colors hover:bg-accent-mint-dim"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
                Add field
              </button>
            </div>
            {form.customFields.length === 0 ? (
              <p className="text-xs text-text-muted">No custom fields.</p>
            ) : (
              <div className="space-y-2">
                {form.customFields.map((cf, i) => (
                  <div key={i} className="flex items-start gap-1.5">
                    <input
                      value={cf.key}
                      onChange={(e) => setCustomField(i, { key: e.target.value })}
                      placeholder="Name"
                      className={`${inputCls} w-1/3 py-2`}
                    />
                    <div className="flex-1">
                      {cf.protected ? (
                        <PasswordField
                          value={cf.value}
                          onChange={(value) => setCustomField(i, { value })}
                          placeholder="Value"
                        />
                      ) : (
                        <input
                          value={cf.value}
                          onChange={(e) => setCustomField(i, { value: e.target.value })}
                          placeholder="Value"
                          className={`${inputCls} py-2`}
                        />
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setCustomField(i, { protected: !cf.protected })}
                      aria-label={cf.protected ? "Unprotect field" : "Protect field"}
                      title={cf.protected ? "Protected (masked)" : "Plain text"}
                      className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg border transition-colors ${
                        cf.protected
                          ? "border-accent-mint/50 text-accent-mint"
                          : "border-border-sage text-text-muted hover:text-text-secondary"
                      }`}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
                        <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="1.8" />
                        <path
                          d="M8 11V8a4 4 0 0 1 8 0v3"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                        />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => removeCustomField(i)}
                      aria-label="Remove field"
                      className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border-sage text-text-muted transition-colors hover:border-status-error/50 hover:text-status-error"
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
                        <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Attachments */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-medium text-text-muted">Attachments</span>
              <button
                type="button"
                onClick={handleAddAttachment}
                disabled={attachBusy}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-accent-mint transition-colors hover:bg-accent-mint-dim disabled:opacity-50"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
                Add file
              </button>
            </div>
            {attachError && (
              <div className="mb-2 rounded-md border border-status-error/40 bg-status-error/10 px-2.5 py-1.5 text-xs text-status-error">
                {attachError}
              </div>
            )}
            {attachments.length === 0 && pending.length === 0 ? (
              <p className="text-xs text-text-muted">No attachments.</p>
            ) : (
              <div className="space-y-1.5">
                {attachments.map((att) => (
                  <AttachmentRow
                    key={`a-${att.id}`}
                    name={att.name}
                    size={att.size}
                    disabled={attachBusy}
                    onRemove={() => handleRemoveAttachment(att.name)}
                  />
                ))}
                {pending.map((p) => (
                  <AttachmentRow
                    key={`p-${p.name}`}
                    name={p.name}
                    size={p.data.length}
                    badge="pending"
                    disabled={attachBusy}
                    onRemove={() => handleRemoveAttachment(p.name)}
                  />
                ))}
              </div>
            )}
          </div>

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

function AttachmentRow({
  name,
  size,
  badge,
  disabled,
  onRemove,
}: {
  name: string;
  size: number;
  badge?: string;
  disabled?: boolean;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border-sage bg-background-primary px-2.5 py-1.5">
      <span className="text-text-muted">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M14 3v5h5M14 3l5 5v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h8Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        </svg>
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-text-primary">{name}</p>
        <p className="text-[10px] text-text-muted">{formatBytes(size)}</p>
      </div>
      {badge && (
        <span className="rounded bg-surface-elevated px-1.5 py-0.5 text-[10px] text-text-muted">
          {badge}
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label="Remove attachment"
        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-text-muted transition-colors hover:text-status-error disabled:opacity-50"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}
