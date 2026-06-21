import { WindowControls } from "./WindowControls";
import { ThemeToggle } from "./ThemeToggle";

/**
 * Frameless custom title bar. The center region is marked
 * `data-tauri-drag-region` so the user can drag the window by it, while
 * interactive controls opt out of dragging.
 */
export function TitleBar() {
  return (
    <header
      data-tauri-drag-region
      className="flex h-10 select-none items-center justify-between border-b border-border-sage bg-surface-card pl-3"
    >
      {/* Brand */}
      <div data-tauri-drag-region className="flex items-center gap-2">
        <div className="grid h-6 w-6 place-items-center rounded-md bg-accent-mint-dim text-accent-mint">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M12 2 4 5v6c0 5 3.4 8.4 8 11 4.6-2.6 8-6 8-11V5l-8-3Z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
            <circle cx="12" cy="10.5" r="2" fill="currentColor" />
            <path d="M12 12.5v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </div>
        <span className="text-[13px] font-semibold tracking-wide text-text-primary">
          VaultPeer
        </span>
      </div>

      {/* Search bar (wired up in Phase 6) */}
      <div data-tauri-drag-region className="flex flex-1 justify-center px-4">
        <button
          type="button"
          className="flex h-7 w-full max-w-md items-center gap-2 rounded-md border border-border-sage bg-background-primary px-3 text-text-muted transition-colors hover:border-accent-mint/40"
          title="Search (Ctrl+K)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
            <path d="m20 20-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span className="text-xs">Search…</span>
          <kbd className="ml-auto rounded bg-surface-elevated px-1.5 py-0.5 text-[10px] text-text-muted">
            Ctrl K
          </kbd>
        </button>
      </div>

      {/* Right-side actions + window controls */}
      <div className="flex items-stretch">
        <div className="flex items-center gap-1 px-2">
          <ActionButton label="Sync status" disabled>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M4 12a8 8 0 0 1 14-5m2 5a8 8 0 0 1-14 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <path d="M18 3v4h-4M6 21v-4h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </ActionButton>
          <ActionButton label="Lock database" disabled>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <rect x="5" y="10" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="2" />
              <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2" />
            </svg>
          </ActionButton>
          <ThemeToggle />
        </div>
        <WindowControls />
      </div>
    </header>
  );
}

function ActionButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-7 w-7 place-items-center rounded-md text-text-muted transition-colors hover:bg-accent-mint-dim hover:text-text-primary disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-muted"
    >
      {children}
    </button>
  );
}
