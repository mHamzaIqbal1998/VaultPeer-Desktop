import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  addAttachment,
  getAttachment,
  getEntry,
  openAttachmentDialog,
  readFile,
  removeAttachment,
  saveAttachmentDialog,
  writeFileAtomic,
  type AttachmentMeta,
  type EntryDetail as EntryDetailData,
} from "@/services/tauri";
import { isInRecycleBin, useDatabaseStore } from "@/stores/databaseStore";
import { useSessionStore } from "@/stores/sessionStore";
import { VaultIcon } from "@/lib/icons";
import { copyToClipboard } from "@/lib/clipboard";
import { tagColor } from "@/lib/tags";
import { ConfirmDialog } from "./ConfirmDialog";
import { HistoryPanel } from "./HistoryPanel";

interface Props {
  /** Open the editor for this entry. */
  onEdit: (entry: EntryDetailData) => void;
}

/** Strip the directory part from a file path (handles both \ and /). */
function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Right-hand entry detail pane (PLAN Phase 3 + Phase 4). Shows the standard
 * fields plus custom fields, expiration status, tags, attachments, and history,
 * and offers recycle-bin-aware delete / restore actions.
 */
export function EntryDetail({ onEdit }: Props) {
  const selectedEntryUuid = useDatabaseStore((s) => s.selectedEntryUuid);
  const selectEntry = useDatabaseStore((s) => s.selectEntry);
  const deleteEntry = useDatabaseStore((s) => s.deleteEntry);
  const restoreEntry = useDatabaseStore((s) => s.restoreEntry);
  const refreshEntries = useDatabaseStore((s) => s.refreshEntries);
  const tree = useDatabaseStore((s) => s.tree);
  // Track the selected entry's modification time so an in-place edit (same uuid)
  // triggers a reload of the detail pane.
  const selectedModified = useDatabaseStore(
    (s) => s.entries.find((e) => e.uuid === s.selectedEntryUuid)?.modified ?? null,
  );
  const setDirty = useSessionStore((s) => s.setDirty);

  const [detail, setDetail] = useState<EntryDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [revealedFields, setRevealedFields] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"recycle" | "permanent" | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [attachBusy, setAttachBusy] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);

  async function reload() {
    if (!selectedEntryUuid) return;
    try {
      setDetail(await getEntry(selectedEntryUuid));
    } catch {
      setDetail(null);
    }
  }

  useEffect(() => {
    setReveal(false);
    setRevealedFields(new Set());
    setCopied(null);
    setAttachError(null);
    if (!selectedEntryUuid) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getEntry(selectedEntryUuid)
      .then((d) => !cancelled && setDetail(d))
      .catch(() => !cancelled && setDetail(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selectedEntryUuid, selectedModified]);

  if (!selectedEntryUuid) return null;

  const inRecycleBin = detail ? isInRecycleBin(tree, detail.groupUuid) : false;

  const flash = (what: string) => {
    setCopied(what);
    window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 1200);
  };
  const copy = async (what: string, value: string) => {
    if (value && (await copyToClipboard(value))) flash(what);
  };

  async function handleAddAttachment() {
    if (!detail) return;
    setAttachError(null);
    try {
      const path = await openAttachmentDialog();
      if (!path) return;
      setAttachBusy(true);
      const bytes = await readFile(path);
      await addAttachment(detail.uuid, basename(path), bytes);
      setDirty(true);
      await Promise.all([reload(), refreshEntries()]);
    } catch (e) {
      setAttachError(String(e));
    } finally {
      setAttachBusy(false);
    }
  }

  async function handleExportAttachment(att: AttachmentMeta) {
    if (!detail) return;
    setAttachError(null);
    try {
      const path = await saveAttachmentDialog(att.name);
      if (!path) return;
      const bytes = await getAttachment(detail.uuid, att.name);
      await writeFileAtomic(path, bytes);
    } catch (e) {
      setAttachError(String(e));
    }
  }

  async function handleRemoveAttachment(att: AttachmentMeta) {
    if (!detail) return;
    setAttachError(null);
    try {
      setAttachBusy(true);
      await removeAttachment(detail.uuid, att.name);
      setDirty(true);
      await Promise.all([reload(), refreshEntries()]);
    } catch (e) {
      setAttachError(String(e));
    } finally {
      setAttachBusy(false);
    }
  }

  function toggleField(key: string) {
    setRevealedFields((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  const expiryState = detail?.expires && detail.expiry != null
    ? detail.expiry < Date.now()
      ? "expired"
      : detail.expiry < Date.now() + 7 * 24 * 60 * 60 * 1000
        ? "soon"
        : "ok"
    : null;

  return (
    <motion.aside
      initial={{ x: 24, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="flex h-full w-80 shrink-0 flex-col border-l border-border-sage bg-surface-card"
    >
      <div className="flex items-center justify-between border-b border-border-sage px-4 py-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">
          {inRecycleBin ? "Details · In Recycle Bin" : "Details"}
        </span>
        <button
          type="button"
          onClick={() => selectEntry(null)}
          aria-label="Close details"
          className="grid h-6 w-6 place-items-center rounded-md text-text-muted transition-colors hover:bg-accent-mint-dim hover:text-text-primary"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {loading || !detail ? (
        <p className="p-4 text-sm text-text-muted">{loading ? "Loading…" : "Not found."}</p>
      ) : (
        <div className="flex-1 overflow-auto p-4">
          <div className="mb-4 flex items-center gap-3">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-accent-mint-dim text-accent-mint">
              <VaultIcon icon={detail.icon} size={24} />
            </div>
            <h2 className="min-w-0 flex-1 break-words text-base font-semibold text-text-primary">
              {detail.title || "(no title)"}
            </h2>
          </div>

          {expiryState && (
            <div
              className={`mb-3 rounded-lg border px-3 py-2 text-xs font-medium ${
                expiryState === "expired"
                  ? "border-status-error/40 bg-status-error/10 text-status-error"
                  : expiryState === "soon"
                    ? "border-status-warning/40 bg-status-warning/10 text-status-warning"
                    : "border-border-sage text-text-muted"
              }`}
            >
              {expiryState === "expired" ? "Expired " : "Expires "}
              {detail.expiry != null ? formatDate(detail.expiry) : ""}
            </div>
          )}

          <DetailRow
            label="Username"
            value={detail.username}
            flashed={copied === "user"}
            onCopy={() => copy("user", detail.username)}
          />

          <div className="mb-3">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-text-muted">Password</span>
              <div className="flex items-center gap-1">
                <IconAction label={reveal ? "Hide" : "Reveal"} onClick={() => setReveal((r) => !r)}>
                  {reveal ? (
                    <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A9.6 9.6 0 0 1 12 5c5 0 9 4.5 9 7a12 12 0 0 1-2.2 3M6.1 6.1A12.6 12.6 0 0 0 3 12c0 2.5 4 7 9 7 1.3 0 2.5-.3 3.6-.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  ) : (
                    <>
                      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
                    </>
                  )}
                </IconAction>
                <IconAction
                  label="Copy password"
                  flashed={copied === "pass"}
                  onClick={() => copy("pass", detail.password)}
                >
                  <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M5 15V5a2 2 0 0 1 2-2h8" stroke="currentColor" strokeWidth="1.8" />
                </IconAction>
              </div>
            </div>
            <div className="rounded-lg border border-border-sage bg-background-primary px-3 py-2 font-mono text-sm text-text-primary">
              {detail.password ? (reveal ? detail.password : "•".repeat(Math.min(detail.password.length, 24))) : <span className="text-text-muted">—</span>}
            </div>
          </div>

          <DetailRow
            label="URL"
            value={detail.url}
            isLink
            flashed={copied === "url"}
            onCopy={() => copy("url", detail.url)}
          />

          {detail.notes && (
            <div className="mb-3">
              <span className="mb-1 block text-xs font-medium text-text-muted">Notes</span>
              <p className="whitespace-pre-wrap break-words rounded-lg border border-border-sage bg-background-primary px-3 py-2 text-sm text-text-secondary">
                {detail.notes}
              </p>
            </div>
          )}

          {/* Custom fields */}
          {detail.customFields.length > 0 && (
            <div className="mb-3 space-y-3 border-t border-border-sage pt-3">
              {detail.customFields.map((cf) => {
                const shown = !cf.protected || revealedFields.has(cf.key);
                return (
                  <div key={cf.key}>
                    <div className="mb-1 flex items-center justify-between">
                      <span className="truncate text-xs font-medium text-text-muted">{cf.key}</span>
                      <div className="flex items-center gap-1">
                        {cf.protected && (
                          <IconAction
                            label={shown ? "Hide" : "Reveal"}
                            onClick={() => toggleField(cf.key)}
                          >
                            {shown ? (
                              <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A9.6 9.6 0 0 1 12 5c5 0 9 4.5 9 7a12 12 0 0 1-2.2 3M6.1 6.1A12.6 12.6 0 0 0 3 12c0 2.5 4 7 9 7 1.3 0 2.5-.3 3.6-.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                            ) : (
                              <>
                                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                                <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
                              </>
                            )}
                          </IconAction>
                        )}
                        <IconAction
                          label={`Copy ${cf.key}`}
                          flashed={copied === `cf:${cf.key}`}
                          onClick={() => copy(`cf:${cf.key}`, cf.value)}
                        >
                          <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
                          <path d="M5 15V5a2 2 0 0 1 2-2h8" stroke="currentColor" strokeWidth="1.8" />
                        </IconAction>
                      </div>
                    </div>
                    <div
                      className={`break-all rounded-lg border border-border-sage bg-background-primary px-3 py-2 text-sm text-text-primary ${
                        cf.protected ? "font-mono" : ""
                      }`}
                    >
                      {cf.value ? (
                        shown ? cf.value : "•".repeat(Math.min(cf.value.length, 24))
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Attachments */}
          <div className="mb-3 border-t border-border-sage pt-3">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-medium text-text-muted">
                Attachments {detail.attachments.length > 0 && `(${detail.attachments.length})`}
              </span>
              <button
                type="button"
                onClick={handleAddAttachment}
                disabled={attachBusy}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-accent-mint transition-colors hover:bg-accent-mint-dim disabled:opacity-50"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
                Add
              </button>
            </div>
            {attachError && (
              <div className="mb-2 rounded-md border border-status-error/40 bg-status-error/10 px-2.5 py-1.5 text-xs text-status-error">
                {attachError}
              </div>
            )}
            {detail.attachments.length === 0 ? (
              <p className="text-xs text-text-muted">No attachments.</p>
            ) : (
              <div className="space-y-1.5">
                {detail.attachments.map((att) => (
                  <div
                    key={att.id}
                    className="flex items-center gap-2 rounded-lg border border-border-sage bg-background-primary px-2.5 py-1.5"
                  >
                    <span className="text-text-muted">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
                        <path d="M14 3v5h5M14 3l5 5v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h8Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                      </svg>
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-text-primary">{att.name}</p>
                      <p className="text-[10px] text-text-muted">{formatBytes(att.size)}</p>
                    </div>
                    <IconAction label="Export attachment" onClick={() => handleExportAttachment(att)}>
                      <path d="M12 3v12M7 10l5 5 5-5M5 21h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </IconAction>
                    <IconAction label="Delete attachment" onClick={() => handleRemoveAttachment(att)}>
                      <path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </IconAction>
                  </div>
                ))}
              </div>
            )}
          </div>

          {detail.tags.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1.5 border-t border-border-sage pt-3">
              {detail.tags.map((t) => {
                const c = tagColor(t);
                return (
                  <span
                    key={t}
                    className="rounded-full px-2 py-0.5 text-xs font-medium"
                    style={{ backgroundColor: c.bg, color: c.fg, border: `1px solid ${c.border}` }}
                  >
                    {t}
                  </span>
                );
              })}
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowHistory(true)}
            className="mt-1 flex w-full items-center justify-between rounded-lg border border-border-sage px-3 py-2 text-xs text-text-secondary transition-colors hover:border-accent-mint/40"
          >
            <span>History</span>
            <span className="text-text-muted">{detail.historyCount} snapshot{detail.historyCount === 1 ? "" : "s"} ›</span>
          </button>

          <div className="mt-4 space-y-1 border-t border-border-sage pt-3 text-xs text-text-muted">
            {detail.created != null && <div>Created {formatDate(detail.created)}</div>}
            {detail.modified != null && <div>Modified {formatDate(detail.modified)}</div>}
          </div>
        </div>
      )}

      {detail && (
        <div className="flex gap-2 border-t border-border-sage px-4 py-3">
          {inRecycleBin ? (
            <>
              <button
                type="button"
                onClick={async () => {
                  await restoreEntry(detail.uuid);
                }}
                className="flex-1 rounded-lg bg-accent-mint px-3 py-2 text-sm font-semibold text-background-primary transition-opacity hover:opacity-90"
              >
                Restore
              </button>
              <button
                type="button"
                onClick={() => setConfirm("permanent")}
                className="rounded-lg border border-border-sage px-3 py-2 text-sm font-medium text-text-muted transition-colors hover:border-status-error/50 hover:text-status-error"
              >
                Delete
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => onEdit(detail)}
                className="flex-1 rounded-lg bg-accent-mint px-3 py-2 text-sm font-semibold text-background-primary transition-opacity hover:opacity-90"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => setConfirm("recycle")}
                className="rounded-lg border border-border-sage px-3 py-2 text-sm font-medium text-text-muted transition-colors hover:border-status-error/50 hover:text-status-error"
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}

      {confirm && detail && (
        <ConfirmDialog
          title={confirm === "permanent" ? "Delete Permanently" : "Delete Entry"}
          message={
            confirm === "permanent"
              ? `Permanently delete "${detail.title || "this entry"}"? This cannot be undone.`
              : `Move "${detail.title || "this entry"}" to the recycle bin?`
          }
          confirmLabel={confirm === "permanent" ? "Delete Forever" : "Move to Recycle Bin"}
          destructive
          onConfirm={async () => {
            await deleteEntry(detail.uuid, confirm === "permanent");
            setConfirm(null);
          }}
          onCancel={() => setConfirm(null)}
        />
      )}

      {showHistory && detail && (
        <HistoryPanel
          entryUuid={detail.uuid}
          onRestored={reload}
          onClose={() => setShowHistory(false)}
        />
      )}
    </motion.aside>
  );
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function DetailRow({
  label,
  value,
  isLink,
  flashed,
  onCopy,
}: {
  label: string;
  value: string;
  isLink?: boolean;
  flashed: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-text-muted">{label}</span>
        <IconAction label={`Copy ${label.toLowerCase()}`} flashed={flashed} onClick={onCopy}>
          <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
          <path d="M5 15V5a2 2 0 0 1 2-2h8" stroke="currentColor" strokeWidth="1.8" />
        </IconAction>
      </div>
      <div className="rounded-lg border border-border-sage bg-background-primary px-3 py-2 text-sm">
        {value ? (
          isLink ? (
            <a
              href={value}
              target="_blank"
              rel="noreferrer"
              className="break-all text-accent-mint hover:underline"
            >
              {value}
            </a>
          ) : (
            <span className="break-all text-text-primary">{value}</span>
          )
        ) : (
          <span className="text-text-muted">—</span>
        )}
      </div>
    </div>
  );
}

function IconAction({
  label,
  flashed,
  onClick,
  children,
}: {
  label: string;
  flashed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`grid h-6 w-6 place-items-center rounded-md transition-colors ${
        flashed
          ? "text-status-success"
          : "text-text-muted hover:bg-accent-mint-dim hover:text-text-primary"
      }`}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
        {children}
      </svg>
    </button>
  );
}
