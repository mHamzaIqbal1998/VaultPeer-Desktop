import { useSyncStore } from "@/stores/syncStore";
import type { SyncStatus as Status } from "@/lib/webrtc";

/** Dot color for each sync status, used as a small overlay on the title-bar icon. */
const DOT: Record<Status, string | null> = {
  idle: null,
  connecting: "bg-status-warning",
  waiting: "bg-status-warning",
  negotiating: "bg-status-warning",
  syncing: "bg-accent-mint animate-pulse",
  done: "bg-status-success",
  error: "bg-status-error",
};

/**
 * Title-bar sync indicator (PLAN Phase 8 / SYN-06). Shows the P2P connection
 * state as a colored dot over the sync icon and opens the {@link SyncPanel} on
 * click.
 */
export function SyncStatus({ onOpen }: { onOpen?: () => void }) {
  const status = useSyncStore((s) => s.status);
  const peerCount = useSyncStore((s) => s.peerCount);
  const dot = DOT[status];

  return (
    <button
      type="button"
      aria-label={`Vault sync (${status})`}
      title={`Vault sync — ${status}${peerCount ? ` · ${peerCount} peer` : ""}`}
      onClick={onOpen}
      className="relative grid h-7 w-7 place-items-center rounded-md text-text-muted transition-colors hover:bg-accent-mint-dim hover:text-text-primary"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M4 12a8 8 0 0 1 14-5m2 5a8 8 0 0 1-14 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M18 3v4h-4M6 21v-4h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {dot && (
        <span
          className={`absolute right-1 top-1 h-1.5 w-1.5 rounded-full ring-1 ring-surface-card ${dot}`}
        />
      )}
    </button>
  );
}
