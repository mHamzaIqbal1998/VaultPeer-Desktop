import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { getEntry, type EntryDetail as EntryDetailData } from "@/services/tauri";
import { useDatabaseStore } from "@/stores/databaseStore";
import { VaultIcon } from "@/lib/icons";
import { copyToClipboard } from "@/lib/clipboard";
import { ConfirmDialog } from "./ConfirmDialog";

interface Props {
  /** Open the editor for this entry. */
  onEdit: (entry: EntryDetailData) => void;
}

/**
 * Right-hand entry detail pane (PLAN Phase 3: entry view with actions). Loads
 * the full entry — including the protected password — for the currently
 * selected entry and offers copy / reveal / edit / delete.
 */
export function EntryDetail({ onEdit }: Props) {
  const selectedEntryUuid = useDatabaseStore((s) => s.selectedEntryUuid);
  const selectEntry = useDatabaseStore((s) => s.selectEntry);
  const deleteEntry = useDatabaseStore((s) => s.deleteEntry);

  const [detail, setDetail] = useState<EntryDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setReveal(false);
    setCopied(null);
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
  }, [selectedEntryUuid]);

  if (!selectedEntryUuid) return null;

  const flash = (what: string) => {
    setCopied(what);
    window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 1200);
  };
  const copy = async (what: string, value: string) => {
    if (value && (await copyToClipboard(value))) flash(what);
  };

  return (
    <motion.aside
      initial={{ x: 24, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="flex h-full w-80 shrink-0 flex-col border-l border-border-sage bg-surface-card"
    >
      <div className="flex items-center justify-between border-b border-border-sage px-4 py-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">
          Details
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
                <IconAction
                  label={reveal ? "Hide" : "Reveal"}
                  onClick={() => setReveal((r) => !r)}
                >
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

          {detail.tags.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {detail.tags.map((t) => (
                <span key={t} className="rounded-full bg-surface-elevated px-2 py-0.5 text-xs text-text-secondary">
                  {t}
                </span>
              ))}
            </div>
          )}

          <div className="mt-4 space-y-1 border-t border-border-sage pt-3 text-xs text-text-muted">
            {detail.created != null && <div>Created {formatDate(detail.created)}</div>}
            {detail.modified != null && <div>Modified {formatDate(detail.modified)}</div>}
          </div>
        </div>
      )}

      {detail && (
        <div className="flex gap-2 border-t border-border-sage px-4 py-3">
          <button
            type="button"
            onClick={() => onEdit(detail)}
            className="flex-1 rounded-lg bg-accent-mint px-3 py-2 text-sm font-semibold text-background-primary transition-opacity hover:opacity-90"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="rounded-lg border border-border-sage px-3 py-2 text-sm font-medium text-text-muted transition-colors hover:border-status-error/50 hover:text-status-error"
          >
            Delete
          </button>
        </div>
      )}

      {confirmDelete && detail && (
        <ConfirmDialog
          title="Delete Entry"
          message={`Permanently delete "${detail.title || "this entry"}"? This cannot be undone.`}
          confirmLabel="Delete"
          destructive
          onConfirm={async () => {
            await deleteEntry(detail.uuid);
            setConfirmDelete(false);
          }}
          onCancel={() => setConfirmDelete(false)}
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
