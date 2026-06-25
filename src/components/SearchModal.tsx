import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  searchDatabase,
  type EntrySummary,
  type SearchFilters,
  type SearchHit,
} from "@/services/tauri";
import { useDatabaseStore } from "@/stores/databaseStore";
import { VaultIcon } from "@/lib/icons";
import { tagColor } from "@/lib/tags";

interface Props {
  onClose: () => void;
  /** Optional heading shown above the search box (e.g. the auto-type target). */
  heading?: string;
  /** Pre-fill the search box (and run the first search) with this query. */
  initialQuery?: string;
  /**
   * If provided, selecting a result calls this instead of navigating to the
   * entry — used to repurpose the overlay as an entry picker (e.g. auto-type).
   */
  onChoose?: (entry: EntrySummary) => void;
}

/**
 * Global search overlay (PLAN Phase 6 / SRC-01..05). Opens with Ctrl+K, searches
 * as you type (debounced) via the Rust fuzzy matcher, supports tag / current-group
 * filters, and navigates to the chosen entry. Full keyboard control: ↑/↓ to move,
 * Enter to open, Esc to close. With `onChoose` it doubles as an entry picker.
 */
export function SearchModal({ onClose, heading, initialQuery, onChoose }: Props) {
  const tags = useDatabaseStore((s) => s.tags);
  const tree = useDatabaseStore((s) => s.tree);
  const selectedGroupUuid = useDatabaseStore((s) => s.selectedGroupUuid);
  const openEntry = useDatabaseStore((s) => s.openEntry);

  const [query, setQuery] = useState(initialQuery ?? "");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [scoped, setScoped] = useState(false);
  const [results, setResults] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const isRoot = selectedGroupUuid && tree && selectedGroupUuid === tree.root.uuid;

  useEffect(() => {
    // Focus and select any pre-filled query so the user can refine or replace it.
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Search-as-you-type with a short debounce (SRC-01/02).
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setActive(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    const handle = window.setTimeout(async () => {
      const filters: SearchFilters = {
        tag: tagFilter ?? undefined,
        groupUuid: scoped ? selectedGroupUuid ?? undefined : undefined,
      };
      try {
        const hits = await searchDatabase(q, filters);
        setResults(hits);
        setActive(0);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 150);
    return () => window.clearTimeout(handle);
  }, [query, tagFilter, scoped, selectedGroupUuid]);

  // Keep the active row in view as the selection moves.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function choose(hit: SearchHit | undefined) {
    if (!hit) return;
    if (onChoose) {
      onChoose(hit.entry);
    } else {
      void openEntry(hit.entry.groupUuid, hit.entry.uuid);
    }
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(results[active]);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Search entries"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: -12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.15, ease: "easeOut" }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        className="mt-[12vh] flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border-sage bg-surface-card shadow-2xl"
      >
        {heading && (
          <div className="flex items-center gap-2 border-b border-border-sage bg-accent-mint-dim px-4 py-2 text-xs font-medium text-accent-mint">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <rect x="3" y="6" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="1.7" />
              <path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
            <span className="truncate">{heading}</span>
          </div>
        )}

        {/* Search input */}
        <div className="flex items-center gap-2.5 border-b border-border-sage px-4 py-2.5">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden className="shrink-0 text-text-muted">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
            <path d="m20 20-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search titles, usernames, URLs, notes, tags…"
            className="flex-1 bg-transparent text-xs text-text-primary placeholder:text-text-muted/70 focus:outline-none"
            spellCheck={false}
            autoComplete="off"
            role="searchbox"
            aria-label="Search vault entries"
          />
          <kbd className="shrink-0 rounded bg-surface-elevated px-1 py-px text-[9px] leading-tight text-text-muted">Esc</kbd>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border-sage px-4 py-2">
          {!isRoot && selectedGroupUuid && (
            <button
              type="button"
              onClick={() => setScoped((s) => !s)}
              className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
                scoped
                  ? "border-accent-mint bg-accent-mint-dim text-accent-mint"
                  : "border-border-sage text-text-muted hover:text-text-secondary"
              }`}
            >
              In current group
            </button>
          )}
          {tags.slice(0, 12).map((t) => {
            const c = tagColor(t);
            const activeTag = tagFilter === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTagFilter(activeTag ? null : t)}
                className="rounded-full px-2 py-0.5 text-xs font-medium transition-opacity hover:opacity-90"
                style={{
                  backgroundColor: activeTag ? c.fg : c.bg,
                  color: activeTag ? "#0B0F0E" : c.fg,
                  border: `1px solid ${c.border}`,
                }}
              >
                {t}
              </button>
            );
          })}
          {tags.length === 0 && !selectedGroupUuid && (
            <span className="text-xs text-text-muted">No filters available</span>
          )}
        </div>

        {/* Results */}
        <div ref={listRef} className="min-h-0 flex-1 overflow-auto p-2">
          {query.trim() === "" ? (
            <p className="px-3 py-6 text-center text-sm text-text-muted">
              Type to search across the whole vault.
            </p>
          ) : loading && results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-text-muted">Searching…</p>
          ) : results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-text-muted">
              No matches for “{query.trim()}”.
            </p>
          ) : (
            results.map((hit, i) => (
              <ResultRow
                key={hit.entry.uuid}
                hit={hit}
                query={query.trim()}
                active={i === active}
                idx={i}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(hit)}
              />
            ))
          )}
        </div>

        {results.length > 0 && (
          <div className="flex items-center justify-between border-t border-border-sage px-4 py-1.5 text-[10px] text-text-muted">
            <span>{results.length} result{results.length === 1 ? "" : "s"}</span>
            <span className="flex items-center gap-2">
              <kbd className="rounded bg-surface-elevated px-1 py-0.5">↑↓</kbd> navigate
              <kbd className="rounded bg-surface-elevated px-1 py-0.5">↵</kbd> open
            </span>
          </div>
        )}
      </motion.div>
    </div>
  );
}

function ResultRow({
  hit,
  query,
  active,
  idx,
  onMouseEnter,
  onClick,
}: {
  hit: SearchHit;
  query: string;
  active: boolean;
  idx: number;
  onMouseEnter: () => void;
  onClick: () => void;
}) {
  const { entry } = hit;
  return (
    <button
      type="button"
      data-idx={idx}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
        active ? "bg-accent-mint-dim" : "hover:bg-surface-elevated"
      }`}
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-elevated text-accent-mint">
        <VaultIcon icon={entry.icon} size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-text-primary">
            {highlight(entry.title || "(no title)", query)}
          </span>
          <span className="shrink-0 truncate text-[10px] text-text-muted">{hit.groupPath}</span>
        </div>
        <p className="truncate text-xs text-text-muted">
          <span className="text-text-secondary">{hit.matchedField}:</span>{" "}
          {hit.snippet || entry.username || entry.url || "—"}
        </p>
      </div>
      {entry.hasOtp && (
        <span className="shrink-0 rounded bg-surface-elevated px-1.5 py-0.5 text-[10px] text-text-muted">
          OTP
        </span>
      )}
    </button>
  );
}

/** Highlight the first case-insensitive occurrence of `query` within `text`. */
function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded bg-accent-mint/30 text-text-primary">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}
