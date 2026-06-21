import { useState } from "react";
import { motion } from "framer-motion";
import { useSessionStore } from "@/stores/sessionStore";
import { saveDatabase, lockDatabase } from "@/services/tauri";

/**
 * The unlocked database view. Phase 2 shows the database's metadata and the
 * core session actions (Save / Lock); the group tree + entry list arrive in
 * Phase 3. Kept intentionally simple so it reads as a verified "you're in".
 */
export function VaultView() {
  const metadata = useSessionStore((s) => s.metadata);
  const setLocked = useSessionStore((s) => s.setLocked);
  const dirty = useSessionStore((s) => s.dirty);
  const setDirty = useSessionStore((s) => s.setDirty);

  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  if (!metadata) return null;

  async function handleSave() {
    setSaving(true);
    setStatus(null);
    try {
      await saveDatabase();
      setDirty(false);
      setStatus("Saved.");
    } catch (e) {
      setStatus(`Error: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleLock() {
    try {
      await lockDatabase();
    } finally {
      setLocked();
    }
  }

  const kdfDetail =
    metadata.kdfMemoryKib != null
      ? `${metadata.kdf} · ${metadata.kdfIterations} iters · ${Math.round(
          metadata.kdfMemoryKib / 1024,
        )} MiB · p${metadata.kdfParallelism}`
      : `${metadata.kdf} · ${metadata.kdfIterations} rounds`;

  return (
    <div className="flex h-full flex-col overflow-auto p-8">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="mx-auto w-full max-w-3xl"
      >
        <div className="mb-6 flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-accent-mint-dim text-accent-mint">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
                <rect x="5" y="10" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="2" />
                <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2" />
                <circle cx="12" cy="15" r="1.4" fill="currentColor" />
              </svg>
            </div>
            <div>
              <h1 className="text-xl font-semibold text-text-primary">
                {metadata.name || "Untitled Database"}
                {dirty && (
                  <span className="ml-2 align-middle text-xs font-normal text-status-warning">
                    ● unsaved
                  </span>
                )}
              </h1>
              <p className="truncate text-xs text-text-muted" title={metadata.path}>
                {metadata.path}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="rounded-lg border border-border-sage bg-surface-elevated px-3.5 py-2 text-sm font-medium text-text-primary transition-colors hover:border-accent-mint/40 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={handleLock}
              className="rounded-lg bg-accent-mint px-3.5 py-2 text-sm font-semibold text-background-primary transition-opacity hover:opacity-90"
            >
              Lock
            </button>
          </div>
        </div>

        {status && (
          <div className="mb-5 rounded-md border border-border-sage bg-surface-card px-3 py-2 text-xs text-text-secondary">
            {status}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Entries" value={String(metadata.entryCount)} />
          <Stat label="Groups" value={String(metadata.groupCount)} />
          <Stat label="Format" value={metadata.version} />
          <Stat label="Cipher" value={metadata.outerCipher} />
          <Stat label="Compression" value={metadata.compression} />
          <Stat label="Protected fields" value={metadata.innerCipher} />
        </div>

        <div className="mt-3 rounded-xl border border-border-sage bg-surface-card p-4">
          <div className="text-xs font-medium text-text-muted">Key derivation</div>
          <div className="mt-1 font-mono text-sm text-text-primary">{kdfDetail}</div>
          {metadata.generator && (
            <div className="mt-3 text-xs text-text-muted">
              Generator: <span className="text-text-secondary">{metadata.generator}</span>
            </div>
          )}
        </div>

        <div className="mt-6 rounded-xl border border-dashed border-border-sage bg-surface-card/50 p-6 text-center">
          <p className="text-sm text-text-secondary">Database unlocked successfully.</p>
          <p className="mt-1 text-xs text-text-muted">
            Group tree and entry management arrive in Phase 3.
          </p>
        </div>
      </motion.div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border-sage bg-surface-card p-4">
      <div className="text-xs text-text-muted">{label}</div>
      <div className="mt-1 truncate text-base font-semibold text-text-primary" title={value}>
        {value}
      </div>
    </div>
  );
}
