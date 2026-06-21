import { useState } from "react";
import { motion } from "framer-motion";
import {
  openDatabaseDialog,
  saveDatabaseDialog,
  readFile,
  writeFileAtomic,
  statFile,
} from "@/services/tauri";
import { useVaultStore } from "@/stores/vaultStore";

/**
 * Phase 1 landing screen. The real unlock/create flow lands in Phase 2;
 * for now this verifies the core infrastructure (file dialogs + atomic
 * read/write IPC) end-to-end and surfaces the recent-files list.
 */
export function WelcomeScreen() {
  const recentFiles = useVaultStore((s) => s.recentFiles);
  const selectedPath = useVaultStore((s) => s.selectedPath);
  const setSelectedPath = useVaultStore((s) => s.setSelectedPath);
  const addRecentFile = useVaultStore((s) => s.addRecentFile);
  const clearRecentFiles = useVaultStore((s) => s.clearRecentFiles);

  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleOpen() {
    setBusy(true);
    setStatus(null);
    try {
      const path = await openDatabaseDialog();
      if (!path) return;
      const meta = await statFile(path);
      setSelectedPath(path);
      addRecentFile(path);
      setStatus(
        `Selected ${meta.path} (${formatBytes(meta.size)}). Unlock arrives in Phase 2.`,
      );
    } catch (e) {
      setStatus(`Error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  // Demonstrates the atomic write + read round-trip wired to the Rust core.
  async function handleSelfTest() {
    setBusy(true);
    setStatus(null);
    try {
      const path = await saveDatabaseDialog("vaultpeer-iotest.bin");
      if (!path) return;
      const payload = new TextEncoder().encode(
        `VaultPeer atomic write @ ${new Date().toISOString()}`,
      );
      await writeFileAtomic(path, payload);
      const readBack = await readFile(path);
      const ok =
        readBack.length === payload.length &&
        readBack.every((b, i) => b === payload[i]);
      setStatus(
        ok
          ? `Atomic write/read round-trip OK (${payload.length} bytes) → ${path}`
          : "Round-trip mismatch — data did not verify!",
      );
    } catch (e) {
      setStatus(`Error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center overflow-auto p-8">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
        className="w-full max-w-xl"
      >
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-accent-mint-dim text-accent-mint">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M12 2 4 5v6c0 5 3.4 8.4 8 11 4.6-2.6 8-6 8-11V5l-8-3Z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
              <circle cx="12" cy="10.5" r="2" fill="currentColor" />
              <path d="M12 12.5v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold text-text-primary">
            Welcome to VaultPeer
          </h1>
          <p className="mt-1 text-sm text-text-muted">
            KeePass-compatible password manager · Phase 1 infrastructure
          </p>
        </div>

        <div className="space-y-3 rounded-xl border border-border-sage bg-surface-card p-5">
          <PrimaryButton onClick={handleOpen} disabled={busy}>
            Open Database…
          </PrimaryButton>
          <SecondaryButton onClick={handleSelfTest} disabled={busy}>
            Run File I/O Self-Test
          </SecondaryButton>

          {status && (
            <div className="rounded-md border border-border-sage bg-background-primary px-3 py-2 font-mono text-xs leading-relaxed text-text-secondary">
              {status}
            </div>
          )}

          {selectedPath && (
            <p className="truncate text-xs text-text-muted" title={selectedPath}>
              Current selection: {selectedPath}
            </p>
          )}
        </div>

        {recentFiles.length > 0 && (
          <div className="mt-5 rounded-xl border border-border-sage bg-surface-card p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text-primary">
                Recent Databases
              </h2>
              <button
                type="button"
                onClick={clearRecentFiles}
                className="text-xs text-text-muted hover:text-status-error"
              >
                Clear
              </button>
            </div>
            <ul className="space-y-1">
              {recentFiles.map((f) => (
                <li key={f.path}>
                  <button
                    type="button"
                    onClick={() => setSelectedPath(f.path)}
                    className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent-mint-dim"
                  >
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-background-primary text-accent-mint">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                        <path d="M4 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                      </svg>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-text-primary">
                        {f.name}
                      </span>
                      <span className="block truncate text-xs text-text-muted">
                        {f.path}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </motion.div>
    </div>
  );
}

function PrimaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className="w-full rounded-lg bg-accent-mint px-4 py-2.5 text-sm font-semibold text-background-primary transition-opacity hover:opacity-90 disabled:opacity-50"
    />
  );
}

function SecondaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className="w-full rounded-lg border border-border-sage bg-surface-elevated px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:border-accent-mint/40 disabled:opacity-50"
    />
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
