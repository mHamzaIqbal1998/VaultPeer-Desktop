import { useSyncStore } from "@/stores/syncStore";
import type { SyncStatus as Status } from "@/lib/webrtc";

/** Dot color for each sync status, used as a small overlay on the title-bar icon. */
const DOT: Record<Status, string | null> = {
  idle: null,
  connecting: "bg-status-warning",
  waiting: "bg-status-warning",
  negotiating: "bg-status-warning",
  syncing: "bg-accent-mint",
  done: "bg-status-success",
  error: "bg-status-error",
};

/** Short label shown next to the icon for non-transfer states. */
const LABEL: Partial<Record<Status, string>> = {
  connecting: "Connecting…",
  waiting: "Waiting…",
  negotiating: "Linking…",
  done: "Synced",
  error: "Sync error",
};

/**
 * Title-bar sync indicator (PLAN Phase 8 / SYN-06). Shows the live P2P state —
 * a colored status dot, a spinning icon while active, and the transfer
 * percentage during a sync — so progress is visible without opening the panel.
 * Clicking opens the {@link SyncPanel}.
 */
export function SyncStatus({ onOpen }: { onOpen?: () => void }) {
  const status = useSyncStore((s) => s.status);
  const peerCount = useSyncStore((s) => s.peerCount);
  const progress = useSyncStore((s) => s.progress);
  const dot = DOT[status];

  const active = status === "connecting" || status === "negotiating" || status === "syncing";

  // Percentage of the in-flight transfer (whichever direction is active).
  const sentPct = progress.sentTotal ? progress.sent / progress.sentTotal : 0;
  const recvPct = progress.receivedTotal ? progress.received / progress.receivedTotal : 0;
  const transferring =
    status === "syncing" && (progress.sentTotal > 0 || progress.receivedTotal > 0);
  const pct = Math.round(Math.max(sentPct, recvPct) * 100);

  const label = transferring ? `${pct}%` : LABEL[status];
  const showLabel = status !== "idle" && !!label;

  return (
    <button
      type="button"
      aria-label={`Vault sync (${status})`}
      title={`Vault sync — ${status}${peerCount ? ` · ${peerCount} peer` : ""}`}
      onClick={onOpen}
      className="relative flex h-7 items-center gap-1.5 rounded-md px-1.5 text-text-muted transition-colors hover:bg-accent-mint-dim hover:text-text-primary"
    >
      <span className="relative grid h-5 w-5 place-items-center">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden
          className={active ? "animate-spin [animation-duration:1.6s]" : undefined}
        >
          <path d="M4 12a8 8 0 0 1 14-5m2 5a8 8 0 0 1-14 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M18 3v4h-4M6 21v-4h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {dot && !active && (
          <span
            className={`absolute right-0 top-0 h-1.5 w-1.5 rounded-full ring-1 ring-surface-card ${dot}`}
          />
        )}
      </span>
      {showLabel && (
        <span
          className={`text-[11px] font-medium tabular-nums ${
            status === "error"
              ? "text-status-error"
              : status === "done"
                ? "text-status-success"
                : "text-text-secondary"
          }`}
        >
          {label}
        </span>
      )}
    </button>
  );
}
