import { WindowControls } from "./WindowControls";
import { ThemeToggle } from "./ThemeToggle";
import { ClipboardIndicator } from "./ClipboardIndicator";
import { SyncStatus } from "./SyncStatus";
import { useSessionStore } from "@/stores/sessionStore";
import { lockDatabase } from "@/services/tauri";
import appIcon from "@/assets/app-icon.png";

/**
 * Frameless custom title bar. The center region is marked
 * `data-tauri-drag-region` so the user can drag the window by it, while
 * interactive controls opt out of dragging.
 */
interface TitleBarProps {
  /** Open the standalone password generator tool (PLAN Phase 5). */
  onOpenGenerator?: () => void;
  /** Open the global search overlay (PLAN Phase 6); undefined when locked. */
  onOpenSearch?: () => void;
  /** Open the settings panel (PLAN Phase 7). */
  onOpenSettings?: () => void;
  /** Open the P2P sync panel (PLAN Phase 8). */
  onOpenSync?: () => void;
  /** Open the import/export panel (PLAN Phase 9); undefined when locked. */
  onOpenImportExport?: () => void;
}

export function TitleBar({
  onOpenGenerator,
  onOpenSearch,
  onOpenSettings,
  onOpenSync,
  onOpenImportExport,
}: TitleBarProps) {
  const metadata = useSessionStore((s) => s.metadata);
  const setLocked = useSessionStore((s) => s.setLocked);
  const isUnlocked = metadata !== null;

  async function handleLock() {
    try {
      await lockDatabase();
    } finally {
      setLocked();
    }
  }

  return (
    <header
      data-tauri-drag-region
      role="banner"
      aria-label="Application title bar"
      className="flex h-10 select-none items-center justify-between border-b border-border-sage bg-surface-card pl-3"
    >
      {/* Brand */}
      <div data-tauri-drag-region className="flex items-center gap-2">
        <img src={appIcon} alt="" aria-hidden width={22} height={22} className="rounded" draggable={false} />
        <span className="text-[13px] font-semibold tracking-wide text-text-primary">
          VaultPeer
        </span>
      </div>

      {/* Global search (Ctrl+K) — disabled until a database is unlocked. */}
      <div data-tauri-drag-region className="flex flex-1 justify-center px-4">
        <button
          type="button"
          onClick={onOpenSearch}
          disabled={!onOpenSearch}
          className="flex h-7 w-full max-w-md items-center gap-2 rounded-md border border-border-sage bg-background-primary px-2.5 text-text-muted transition-colors hover:border-accent-mint/40 disabled:cursor-default disabled:opacity-50 disabled:hover:border-border-sage"
          title="Search (Ctrl+K)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden className="shrink-0">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
            <path d="m20 20-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span className="text-[11px]">Search…</span>
          <kbd className="ml-auto rounded bg-surface-elevated px-1 py-px text-[9px] leading-tight text-text-muted">
            Ctrl K
          </kbd>
        </button>
      </div>

      {/* Right-side actions + window controls */}
      <div className="flex items-stretch">
        <div className="flex items-center gap-1 px-2">
          <ClipboardIndicator />
          <ActionButton label="Password generator (Ctrl+G)" onClick={onOpenGenerator}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M14 7l3-3 3 3-3 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="7.5" cy="16.5" r="4.5" stroke="currentColor" strokeWidth="2" />
              <path d="M10.7 13.3 17 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </ActionButton>
          <SyncStatus onOpen={onOpenSync} />
          <ActionButton
            label="Import / Export"
            disabled={!onOpenImportExport}
            onClick={onOpenImportExport}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M12 3v10m0 0 3.5-3.5M12 13 8.5 9.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M5 16v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </ActionButton>
          <ActionButton label="Lock database (Ctrl+L)" disabled={!isUnlocked} onClick={handleLock}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <rect x="5" y="10" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="2" />
              <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2" />
            </svg>
          </ActionButton>
          <ActionButton label="Settings (Ctrl+,)" onClick={onOpenSettings}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
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
