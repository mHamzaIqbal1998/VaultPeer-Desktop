import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useSyncStore } from "@/stores/syncStore";
import { useSessionStore } from "@/stores/sessionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { buildSyncInvite, parseSyncInvite, qrToSvg } from "@/lib/qr";
import { type SyncStatus } from "@/lib/webrtc";
import { copyToClipboard } from "@/lib/clipboard";
import { QrScanner } from "./QrScanner";

interface Props {
  onClose: () => void;
  /** Jump to the Sync tab of Settings to configure the signaling server. */
  onOpenSettings?: () => void;
}

const STATUS_LABEL: Record<SyncStatus, string> = {
  idle: "Not connected",
  connecting: "Connecting…",
  waiting: "Waiting for peer…",
  negotiating: "Establishing connection…",
  syncing: "Syncing…",
  done: "Sync complete",
  error: "Error",
};

const STATUS_COLOR: Record<SyncStatus, string> = {
  idle: "text-text-muted",
  connecting: "text-status-warning",
  waiting: "text-status-warning",
  negotiating: "text-status-warning",
  syncing: "text-accent-mint",
  done: "text-status-success",
  error: "text-status-error",
};

/**
 * P2P sync overlay (PLAN Phase 8). Lets the user pick Offline/Network mode,
 * create or join a sync room (with a QR code to pass the room to another
 * device), and watch the connection + transfer progress. The encrypted vault
 * travels directly between peers over WebRTC; conflicts are resolved by the
 * KeePass merge in the backend.
 */
export function SyncPanel({ onClose, onOpenSettings }: Props) {
  const isUnlocked = useSessionStore((s) => s.metadata !== null);
  const signalingUrl = useSettingsStore((s) => s.settings.sync.signalingUrl);

  const {
    mode,
    status,
    room,
    isHost,
    peerCount,
    progress,
    log,
    lastResult,
    error,
    setMode,
    createRoom,
    joinRoom,
    leave,
  } = useSyncStore();

  const [joinValue, setJoinValue] = useState("");
  const [scanning, setScanning] = useState(false);
  const [qrSvg, setQrSvg] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Render a QR invite whenever we are hosting a room.
  useEffect(() => {
    let cancelled = false;
    if (room && isHost) {
      void qrToSvg(buildSyncInvite(room, signalingUrl)).then((svg) => {
        if (!cancelled) setQrSvg(svg);
      });
    } else {
      setQrSvg(null);
    }
    return () => {
      cancelled = true;
    };
  }, [room, isHost, signalingUrl]);

  const active = status !== "idle";

  function handleJoin(value: string) {
    const invite = parseSyncInvite(value);
    if (!invite) return;
    joinRoom(invite.room, invite.signalingUrl ?? undefined);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border-sage bg-surface-card shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-sage px-5 py-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-text-primary">Vault Sync</span>
            {active && (
              <span className={`text-xs font-medium ${STATUS_COLOR[status]}`}>
                ● {STATUS_LABEL[status]}
              </span>
            )}
          </div>
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

        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-5 py-4">
          {!isUnlocked ? (
            <p className="rounded-lg border border-status-warning/30 bg-status-warning/10 px-3 py-2 text-xs text-status-warning">
              Unlock a vault to synchronize it with another device.
            </p>
          ) : (
            <>
              {/* Mode toggle */}
              <div className="flex gap-1 rounded-lg border border-border-sage p-1">
                {(["offline", "network"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                      mode === m
                        ? "bg-accent-mint-dim text-text-primary"
                        : "text-text-muted hover:text-text-secondary"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>

              {mode === "offline" && (
                <p className="text-xs text-text-muted">
                  Offline mode keeps this vault local. Switch to Network mode to
                  sync it peer-to-peer with another device.
                </p>
              )}

              {mode === "network" && (
                <>
                  {!signalingUrl && (
                    <div className="rounded-lg border border-status-warning/30 bg-status-warning/10 px-3 py-2 text-xs text-status-warning">
                      No signaling server configured.{" "}
                      <button
                        type="button"
                        onClick={onOpenSettings}
                        className="font-semibold underline"
                      >
                        Configure it in Settings → Sync
                      </button>
                      .
                    </div>
                  )}

                  {!active ? (
                    <div className="space-y-4">
                      {/* Create */}
                      <div className="rounded-xl border border-border-sage bg-background-primary/40 p-4">
                        <h3 className="text-sm font-semibold text-text-primary">
                          Create a room
                        </h3>
                        <p className="mt-1 text-xs text-text-muted">
                          Start a session and share the code (or QR) with your
                          other device.
                        </p>
                        <button
                          type="button"
                          onClick={createRoom}
                          disabled={!signalingUrl}
                          className="mt-3 w-full rounded-lg bg-accent-mint px-3 py-2 text-sm font-semibold text-background-primary transition-opacity hover:opacity-90 disabled:opacity-40"
                        >
                          Create room
                        </button>
                      </div>

                      {/* Join */}
                      <div className="rounded-xl border border-border-sage bg-background-primary/40 p-4">
                        <h3 className="text-sm font-semibold text-text-primary">
                          Join a room
                        </h3>
                        <div className="mt-3 flex gap-2">
                          <input
                            type="text"
                            value={joinValue}
                            placeholder="Room code or invite link"
                            spellCheck={false}
                            onChange={(e) => setJoinValue(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && handleJoin(joinValue)}
                            className="w-full rounded-lg border border-border-sage bg-background-primary px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent-mint/50"
                          />
                          <button
                            type="button"
                            onClick={() => setScanning(true)}
                            aria-label="Scan QR code"
                            title="Scan QR code"
                            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border-sage text-text-muted transition-colors hover:border-accent-mint/40 hover:text-text-primary"
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                              <path d="M4 7V4h3M20 7V4h-3M4 17v3h3M20 17v3h-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                              <rect x="9" y="9" width="6" height="6" stroke="currentColor" strokeWidth="2" />
                            </svg>
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleJoin(joinValue)}
                          disabled={!joinValue.trim()}
                          className="mt-3 w-full rounded-lg border border-border-sage bg-surface-elevated px-3 py-2 text-sm font-semibold text-text-primary transition-colors hover:border-accent-mint/40 disabled:opacity-40"
                        >
                          Join room
                        </button>
                      </div>
                    </div>
                  ) : (
                    <ActiveSession
                      room={room!}
                      isHost={isHost}
                      status={status}
                      peerCount={peerCount}
                      qrSvg={qrSvg}
                      progress={progress}
                      log={log}
                      lastResult={lastResult}
                      error={error}
                      onLeave={leave}
                    />
                  )}
                </>
              )}
            </>
          )}
        </div>
      </motion.div>

      {scanning && (
        <QrScanner
          onScan={(value) => {
            setScanning(false);
            handleJoin(value);
          }}
          onClose={() => setScanning(false)}
        />
      )}
    </div>
  );
}

// ── Active session view ───────────────────────────────────────────────────────

function ActiveSession({
  room,
  isHost,
  status,
  peerCount,
  qrSvg,
  progress,
  log,
  lastResult,
  error,
  onLeave,
}: {
  room: string;
  isHost: boolean;
  status: SyncStatus;
  peerCount: number;
  qrSvg: string | null;
  progress: ReturnType<typeof useSyncStore.getState>["progress"];
  log: string[];
  lastResult: ReturnType<typeof useSyncStore.getState>["lastResult"];
  error: string | null;
  onLeave: () => void;
}) {
  const sentPct = progress.sentTotal ? (progress.sent / progress.sentTotal) * 100 : 0;
  const recvPct = progress.receivedTotal
    ? (progress.received / progress.receivedTotal) * 100
    : 0;

  return (
    <div className="space-y-4">
      {/* Room + QR */}
      <div className="flex items-center gap-4 rounded-xl border border-border-sage bg-background-primary/40 p-4">
        {isHost && qrSvg && (
          <div
            className="h-28 w-28 shrink-0 overflow-hidden rounded-lg bg-white p-1.5 [&>svg]:h-full [&>svg]:w-full"
            dangerouslySetInnerHTML={{ __html: qrSvg }}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-xs uppercase tracking-wide text-text-muted">Room code</div>
          <div className="flex items-center gap-2">
            <code className="truncate font-mono text-lg font-semibold text-accent-mint">
              {room}
            </code>
            <button
              type="button"
              onClick={() => void copyToClipboard(room, { label: "Room code" })}
              aria-label="Copy room code"
              title="Copy room code"
              className="grid h-6 w-6 shrink-0 place-items-center rounded text-text-muted transition-colors hover:bg-accent-mint-dim hover:text-text-primary"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
                <path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" strokeWidth="2" />
              </svg>
            </button>
          </div>
          <div className="mt-1 text-xs text-text-muted">
            {peerCount > 0
              ? `${peerCount} peer${peerCount === 1 ? "" : "s"} connected`
              : "Waiting for a peer to join…"}
          </div>
        </div>
      </div>

      {/* Transfer progress */}
      {(progress.sentTotal > 0 || progress.receivedTotal > 0) && (
        <div className="space-y-2">
          {progress.sentTotal > 0 && (
            <ProgressBar
              label={`Sending vault… ${progress.sent}/${progress.sentTotal} chunks`}
              pct={sentPct}
            />
          )}
          {progress.receivedTotal > 0 && (
            <ProgressBar
              label={`Receiving vault… ${progress.received}/${progress.receivedTotal} chunks`}
              pct={recvPct}
            />
          )}
        </div>
      )}

      {/* Merge result */}
      {lastResult && (
        <div className="rounded-lg border border-accent-mint/30 bg-accent-mint-dim/40 px-3 py-2 text-xs text-text-secondary">
          {lastResult.changed ? (
            <span>
              Merged <strong className="text-text-primary">{lastResult.created}</strong> new,{" "}
              <strong className="text-text-primary">{lastResult.updated}</strong> updated
              {lastResult.deleted > 0 && <>, {lastResult.deleted} removed</>}. Review and
              save to persist the changes.
            </span>
          ) : (
            <span>Vaults already match — no changes.</span>
          )}
          {lastResult.warnings.length > 0 && (
            <ul className="mt-1 list-inside list-disc text-status-warning">
              {lastResult.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <p className="rounded-lg border border-status-error/30 bg-status-error/10 px-3 py-2 text-xs text-status-error">
          {error}
        </p>
      )}

      {/* Activity log */}
      {log.length > 0 && (
        <div className="max-h-32 overflow-auto rounded-lg border border-border-sage bg-background-primary/60 p-2 font-mono text-[11px] leading-relaxed text-text-muted">
          {log.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={onLeave}
        className="w-full rounded-lg border border-border-sage px-3 py-2 text-sm font-medium text-text-muted transition-colors hover:border-status-error/40 hover:text-status-error"
      >
        {status === "done" ? "Close session" : "Leave room"}
      </button>
    </div>
  );
}

function ProgressBar({ label, pct }: { label: string; pct: number }) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-[11px] text-text-muted">
        <span>{label}</span>
        <span>{Math.round(pct)}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-border-sage">
        <div
          className="h-full rounded-full bg-accent-mint transition-[width] duration-150"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
