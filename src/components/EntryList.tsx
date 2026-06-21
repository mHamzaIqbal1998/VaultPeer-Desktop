import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { getEntry, type EntrySummary } from "@/services/tauri";
import {
  groupPath,
  useDatabaseStore,
  type SortKey,
} from "@/stores/databaseStore";
import { VaultIcon } from "@/lib/icons";
import { copyToClipboard } from "@/lib/clipboard";
import { DND_ENTRY } from "./GroupTree";

interface Props {
  /** Open the editor to create a new entry in the current group. */
  onNewEntry: () => void;
}

/**
 * Main content area (PLAN Phase 3): breadcrumb, view toggle (card/list),
 * sorting, and the entry list with quick copy actions. Entries are draggable
 * onto groups in the tree to move them.
 */
export function EntryList({ onNewEntry }: Props) {
  const tree = useDatabaseStore((s) => s.tree);
  const entries = useDatabaseStore((s) => s.entries);
  const selectedGroupUuid = useDatabaseStore((s) => s.selectedGroupUuid);
  const selectedEntryUuid = useDatabaseStore((s) => s.selectedEntryUuid);
  const selectEntry = useDatabaseStore((s) => s.selectEntry);
  const selectGroup = useDatabaseStore((s) => s.selectGroup);
  const view = useDatabaseStore((s) => s.view);
  const setView = useDatabaseStore((s) => s.setView);
  const sortKey = useDatabaseStore((s) => s.sortKey);
  const sortDir = useDatabaseStore((s) => s.sortDir);
  const setSort = useDatabaseStore((s) => s.setSort);
  const loading = useDatabaseStore((s) => s.loadingEntries);

  const crumbs = useMemo(
    () => (selectedGroupUuid ? groupPath(tree?.root ?? null, selectedGroupUuid) : []),
    [tree, selectedGroupUuid],
  );

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    const copy = [...entries];
    copy.sort((a, b) => {
      if (sortKey === "title") {
        return a.title.toLowerCase().localeCompare(b.title.toLowerCase()) * dir;
      }
      const av = (sortKey === "created" ? a.created : a.modified) ?? 0;
      const bv = (sortKey === "created" ? b.created : b.modified) ?? 0;
      return (av - bv) * dir;
    });
    return copy;
  }, [entries, sortKey, sortDir]);

  return (
    <div className="flex h-full flex-col">
      {/* Breadcrumb + actions */}
      <div className="flex items-center justify-between gap-3 border-b border-border-sage px-5 py-3">
        <nav className="flex min-w-0 items-center gap-1 text-sm">
          {crumbs.map((g, i) => (
            <span key={g.uuid} className="flex min-w-0 items-center gap-1">
              {i > 0 && <span className="text-text-muted">/</span>}
              <button
                type="button"
                onClick={() => selectGroup(g.uuid)}
                className={`truncate rounded px-1.5 py-0.5 transition-colors hover:bg-surface-elevated ${
                  i === crumbs.length - 1
                    ? "font-medium text-text-primary"
                    : "text-text-muted"
                }`}
              >
                {i === 0 ? g.name || "Database" : g.name || "Unnamed"}
              </button>
            </span>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <SortMenu sortKey={sortKey} sortDir={sortDir} onSort={setSort} />
          <div className="flex overflow-hidden rounded-lg border border-border-sage">
            <ViewButton active={view === "card"} onClick={() => setView("card")} label="Card view">
              <rect x="4" y="4" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
              <rect x="13" y="4" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
              <rect x="4" y="13" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
              <rect x="13" y="13" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
            </ViewButton>
            <ViewButton active={view === "list"} onClick={() => setView("list")} label="List view">
              <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </ViewButton>
          </div>
          <button
            type="button"
            onClick={onNewEntry}
            className="flex items-center gap-1.5 rounded-lg bg-accent-mint px-3 py-1.5 text-sm font-semibold text-background-primary transition-opacity hover:opacity-90"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
            New Entry
          </button>
        </div>
      </div>

      {/* Entries */}
      <div className="flex-1 overflow-auto p-5">
        {loading ? (
          <p className="text-sm text-text-muted">Loading…</p>
        ) : sorted.length === 0 ? (
          <EmptyState onNewEntry={onNewEntry} />
        ) : view === "card" ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {sorted.map((e) => (
              <EntryCard
                key={e.uuid}
                entry={e}
                selected={e.uuid === selectedEntryUuid}
                onSelect={() => selectEntry(e.uuid)}
              />
            ))}
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border-sage">
            {sorted.map((e, i) => (
              <EntryRow
                key={e.uuid}
                entry={e}
                first={i === 0}
                selected={e.uuid === selectedEntryUuid}
                onSelect={() => selectEntry(e.uuid)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function isExpired(e: EntrySummary): boolean {
  return e.expires && e.expiry != null && e.expiry < Date.now();
}

/** Copy an entry's password, fetching it from the backend on demand. */
async function copyPassword(uuid: string): Promise<boolean> {
  try {
    const detail = await getEntry(uuid);
    return copyToClipboard(detail.password);
  } catch {
    return false;
  }
}

function EntryCard({
  entry,
  selected,
  onSelect,
}: {
  entry: EntrySummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const flash = (what: string) => {
    setCopied(what);
    window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 1200);
  };

  return (
    <motion.div
      layout
      draggable
      onDragStart={(e) => {
        (e as unknown as React.DragEvent).dataTransfer.setData(DND_ENTRY, entry.uuid);
      }}
      onClick={onSelect}
      className={`group cursor-pointer rounded-xl border bg-surface-card p-3.5 transition-colors ${
        selected ? "border-accent-mint" : "border-border-sage hover:border-accent-mint/40"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-accent-mint-dim text-accent-mint">
          <VaultIcon icon={entry.icon} size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-text-primary">
              {entry.title || "(no title)"}
            </h3>
            {isExpired(entry) && (
              <span className="shrink-0 rounded bg-status-error/15 px-1.5 py-0.5 text-[10px] font-medium text-status-error">
                Expired
              </span>
            )}
          </div>
          <p className="truncate text-xs text-text-muted">
            {entry.username || entry.url || "—"}
          </p>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-1.5">
        <CopyButton
          label="Copy username"
          disabled={!entry.username}
          flashed={copied === "user"}
          onCopy={async () => {
            if (await copyToClipboard(entry.username)) flash("user");
          }}
        >
          User
        </CopyButton>
        <CopyButton
          label="Copy password"
          disabled={!entry.hasPassword}
          flashed={copied === "pass"}
          onCopy={async () => {
            if (await copyPassword(entry.uuid)) flash("pass");
          }}
        >
          Pass
        </CopyButton>
        {entry.hasOtp && (
          <span className="ml-auto rounded bg-surface-elevated px-1.5 py-0.5 text-[10px] text-text-muted">
            OTP
          </span>
        )}
      </div>
    </motion.div>
  );
}

function EntryRow({
  entry,
  first,
  selected,
  onSelect,
}: {
  entry: EntrySummary;
  first: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const flash = (what: string) => {
    setCopied(what);
    window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 1200);
  };

  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData(DND_ENTRY, entry.uuid)}
      onClick={onSelect}
      className={`flex cursor-pointer items-center gap-3 px-3.5 py-2.5 transition-colors ${
        first ? "" : "border-t border-border-sage"
      } ${selected ? "bg-accent-mint-dim" : "hover:bg-surface-elevated"}`}
    >
      <span className="text-accent-mint">
        <VaultIcon icon={entry.icon} size={18} />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
        {entry.title || "(no title)"}
        {isExpired(entry) && (
          <span className="ml-2 text-[10px] font-medium text-status-error">Expired</span>
        )}
      </span>
      <span className="hidden min-w-0 flex-1 truncate text-xs text-text-muted sm:block">
        {entry.username}
      </span>
      <div className="flex shrink-0 items-center gap-1.5">
        <CopyButton
          label="Copy username"
          disabled={!entry.username}
          flashed={copied === "user"}
          onCopy={async () => {
            if (await copyToClipboard(entry.username)) flash("user");
          }}
        >
          User
        </CopyButton>
        <CopyButton
          label="Copy password"
          disabled={!entry.hasPassword}
          flashed={copied === "pass"}
          onCopy={async () => {
            if (await copyPassword(entry.uuid)) flash("pass");
          }}
        >
          Pass
        </CopyButton>
      </div>
    </div>
  );
}

function CopyButton({
  label,
  disabled,
  flashed,
  onCopy,
  children,
}: {
  label: string;
  disabled?: boolean;
  flashed: boolean;
  onCopy: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onCopy();
      }}
      className={`rounded-md border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${
        flashed
          ? "border-status-success text-status-success"
          : "border-border-sage text-text-muted hover:border-accent-mint/50 hover:text-text-secondary"
      }`}
    >
      {flashed ? "Copied" : children}
    </button>
  );
}

function ViewButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`grid h-7 w-8 place-items-center transition-colors ${
        active ? "bg-accent-mint-dim text-accent-mint" : "text-text-muted hover:text-text-secondary"
      }`}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
        {children}
      </svg>
    </button>
  );
}

const SORT_LABELS: Record<SortKey, string> = {
  title: "Title",
  created: "Created",
  modified: "Modified",
};

function SortMenu({
  sortKey,
  sortDir,
  onSort,
}: {
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (key: SortKey) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        className="flex items-center gap-1.5 rounded-lg border border-border-sage px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:border-accent-mint/40"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {SORT_LABELS[sortKey]}
        <span className="text-text-muted">{sortDir === "asc" ? "↑" : "↓"}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-40 w-36 rounded-lg border border-border-sage bg-surface-elevated p-1 shadow-2xl">
          {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
            <button
              key={key}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onSort(key);
              }}
              className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent-mint-dim ${
                sortKey === key ? "text-accent-mint" : "text-text-secondary"
              }`}
            >
              {SORT_LABELS[key]}
              {sortKey === key && <span>{sortDir === "asc" ? "↑" : "↓"}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState({ onNewEntry }: { onNewEntry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-surface-card text-text-muted">
        <VaultIcon icon={0} size={26} />
      </div>
      <p className="text-sm text-text-secondary">No entries in this group yet.</p>
      <button
        type="button"
        onClick={onNewEntry}
        className="mt-3 rounded-lg border border-border-sage px-3.5 py-2 text-sm font-medium text-text-primary transition-colors hover:border-accent-mint/40"
      >
        Create your first entry
      </button>
    </div>
  );
}
