import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  openDatabaseDialog,
  openKeyFileDialog,
  unlockDatabase,
  biometricAvailable,
  biometricIsEnrolled,
  biometricUnlock,
} from "@/services/tauri";
import { useVaultStore } from "@/stores/vaultStore";
import { useSessionStore } from "@/stores/sessionStore";
import { PasswordField } from "./PasswordField";
import { CreateDatabaseDialog } from "./CreateDatabaseDialog";

/**
 * Phase 2 entry point. Two states share this screen:
 *  - No file selected → landing with Open / Create actions + recent files.
 *  - A file selected  → unlock form (password + optional key file).
 */
export function UnlockScreen() {
  const recentFiles = useVaultStore((s) => s.recentFiles);
  const selectedPath = useVaultStore((s) => s.selectedPath);
  const setSelectedPath = useVaultStore((s) => s.setSelectedPath);
  const addRecentFile = useVaultStore((s) => s.addRecentFile);
  const removeRecentFile = useVaultStore((s) => s.removeRecentFile);
  const clearRecentFiles = useVaultStore((s) => s.clearRecentFiles);

  const setUnlocked = useSessionStore((s) => s.setUnlocked);
  const busy = useSessionStore((s) => s.busy);
  const setBusy = useSessionStore((s) => s.setBusy);

  const [password, setPassword] = useState("");
  const [keyFile, setKeyFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  /** True when the selected DB has a Windows Hello quick-unlock credential. */
  const [helloEnrolled, setHelloEnrolled] = useState(false);

  // When a database is selected, check whether it's enrolled for Windows Hello
  // quick-unlock (and Hello is available) so we can offer the shortcut.
  useEffect(() => {
    let cancelled = false;
    setHelloEnrolled(false);
    if (!selectedPath) return;
    void (async () => {
      try {
        const [available, enrolled] = await Promise.all([
          biometricAvailable(),
          biometricIsEnrolled(selectedPath),
        ]);
        if (!cancelled) setHelloEnrolled(available && enrolled);
      } catch {
        /* biometric unsupported — leave the option hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPath]);

  async function handleBiometricUnlock() {
    if (!selectedPath) return;
    setBusy(true);
    setError(null);
    try {
      const meta = await biometricUnlock(selectedPath);
      addRecentFile(selectedPath);
      setUnlocked(meta);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function resetForm() {
    setPassword("");
    setKeyFile(null);
    setError(null);
  }

  async function handleBrowseOpen() {
    setError(null);
    const path = await openDatabaseDialog();
    if (!path) return;
    resetForm();
    setSelectedPath(path);
  }

  function handlePickRecent(path: string) {
    resetForm();
    setSelectedPath(path);
  }

  function handleBack() {
    resetForm();
    setSelectedPath(null);
  }

  async function handlePickKeyFile() {
    const path = await openKeyFileDialog();
    if (path) setKeyFile(path);
  }

  async function handleUnlock() {
    if (!selectedPath) return;
    if (!password && !keyFile) {
      setError("Enter a master password or select a key file.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const meta = await unlockDatabase(
        selectedPath,
        password || null,
        keyFile,
      );
      addRecentFile(selectedPath);
      setUnlocked(meta);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center overflow-auto p-8">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="w-full max-w-md"
      >
        <Brand />

        {selectedPath ? (
          <UnlockForm
            path={selectedPath}
            password={password}
            onPassword={setPassword}
            keyFile={keyFile}
            onPickKeyFile={handlePickKeyFile}
            onClearKeyFile={() => setKeyFile(null)}
            onUnlock={handleUnlock}
            onBack={handleBack}
            busy={busy}
            error={error}
            helloEnrolled={helloEnrolled}
            onBiometric={handleBiometricUnlock}
          />
        ) : (
          <Landing
            recentFiles={recentFiles}
            onOpen={handleBrowseOpen}
            onCreate={() => setShowCreate(true)}
            onPickRecent={handlePickRecent}
            onRemoveRecent={removeRecentFile}
            onClearRecent={clearRecentFiles}
            busy={busy}
          />
        )}
      </motion.div>

      {showCreate && (
        <CreateDatabaseDialog
          onClose={() => setShowCreate(false)}
          onCreated={(meta) => {
            addRecentFile(meta.path);
            setShowCreate(false);
            setUnlocked(meta);
          }}
        />
      )}
    </div>
  );
}

function Brand() {
  return (
    <div className="mb-7 text-center">
      <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-accent-mint-dim text-accent-mint">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M12 2 4 5v6c0 5 3.4 8.4 8 11 4.6-2.6 8-6 8-11V5l-8-3Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="10.5" r="2" fill="currentColor" />
          <path
            d="M12 12.5v3"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </div>
      <h1 className="text-2xl font-semibold text-text-primary">VaultPeer</h1>
      <p className="mt-1 text-sm text-text-muted">
        KeePass-compatible password manager
      </p>
    </div>
  );
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

interface UnlockFormProps {
  path: string;
  password: string;
  onPassword: (v: string) => void;
  keyFile: string | null;
  onPickKeyFile: () => void;
  onClearKeyFile: () => void;
  onUnlock: () => void;
  onBack: () => void;
  busy: boolean;
  error: string | null;
  helloEnrolled: boolean;
  onBiometric: () => void;
}

function UnlockForm({
  path,
  password,
  onPassword,
  keyFile,
  onPickKeyFile,
  onClearKeyFile,
  onUnlock,
  onBack,
  busy,
  error,
  helloEnrolled,
  onBiometric,
}: UnlockFormProps) {
  return (
    <div className="space-y-4 rounded-xl border border-border-sage bg-surface-card p-5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-text-muted transition-colors hover:bg-accent-mint-dim hover:text-text-primary"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M15 18l-6-6 6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-text-primary" title={path}>
            {basename(path)}
          </div>
          <div className="truncate text-xs text-text-muted" title={path}>
            {path}
          </div>
        </div>
      </div>

      <PasswordField
        value={password}
        onChange={onPassword}
        label="Master password"
        autoFocus
        onEnter={onUnlock}
      />

      <div>
        <span className="mb-1.5 block text-xs font-medium text-text-muted">
          Key file (optional)
        </span>
        {keyFile ? (
          <div className="flex items-center gap-2 rounded-lg border border-border-sage bg-background-primary px-3 py-2">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              className="shrink-0 text-accent-mint"
              aria-hidden
            >
              <circle cx="8" cy="15" r="3" stroke="currentColor" strokeWidth="2" />
              <path
                d="M10 13l9-9M17 4l2 2M15 6l2 2"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="min-w-0 flex-1 truncate text-xs text-text-secondary" title={keyFile}>
              {basename(keyFile)}
            </span>
            <button
              type="button"
              onClick={onClearKeyFile}
              className="text-xs text-text-muted hover:text-status-error"
            >
              Remove
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={onPickKeyFile}
            className="w-full rounded-lg border border-dashed border-border-sage px-3 py-2 text-left text-xs text-text-muted transition-colors hover:border-accent-mint/50 hover:text-text-secondary"
          >
            Select a key file…
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-status-error">
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={onUnlock}
        disabled={busy}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent-mint px-4 py-2.5 text-sm font-semibold text-background-primary transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Unlocking…" : "Unlock"}
      </button>

      {helloEnrolled && (
        <button
          type="button"
          onClick={onBiometric}
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-border-sage bg-surface-elevated px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:border-accent-mint/40 disabled:opacity-50"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M12 11c-1.5 0-2.5 1-2.5 2.5V17M7 9.5a5 5 0 0 1 9-2M5 12a7 7 0 0 1 .5-2.6M12 14v3m4-5.5V17M9 20c-.8-.8-1.5-2-1.5-4"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Unlock with Windows Hello
        </button>
      )}
    </div>
  );
}

interface LandingProps {
  recentFiles: { path: string; name: string; lastOpened: number }[];
  onOpen: () => void;
  onCreate: () => void;
  onPickRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  onClearRecent: () => void;
  busy: boolean;
}

function Landing({
  recentFiles,
  onOpen,
  onCreate,
  onPickRecent,
  onRemoveRecent,
  onClearRecent,
  busy,
}: LandingProps) {
  return (
    <>
      <div className="space-y-3 rounded-xl border border-border-sage bg-surface-card p-5">
        <button
          type="button"
          onClick={onOpen}
          disabled={busy}
          className="w-full rounded-lg bg-accent-mint px-4 py-2.5 text-sm font-semibold text-background-primary transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Open Database…
        </button>
        <button
          type="button"
          onClick={onCreate}
          disabled={busy}
          className="w-full rounded-lg border border-border-sage bg-surface-elevated px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:border-accent-mint/40 disabled:opacity-50"
        >
          Create New Database…
        </button>
      </div>

      {recentFiles.length > 0 && (
        <div className="mt-5 rounded-xl border border-border-sage bg-surface-card p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-primary">Recent Databases</h2>
            <button
              type="button"
              onClick={onClearRecent}
              className="text-xs text-text-muted hover:text-status-error"
            >
              Clear
            </button>
          </div>
          <ul className="space-y-1">
            {recentFiles.map((f) => (
              <li key={f.path} className="group flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onPickRecent(f.path)}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent-mint-dim"
                >
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-background-primary text-accent-mint">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                      <path
                        d="M4 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Z"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-text-primary">{f.name}</span>
                    <span className="block truncate text-xs text-text-muted">{f.path}</span>
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${f.name} from recent`}
                  onClick={() => onRemoveRecent(f.path)}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-text-muted opacity-0 transition-opacity hover:text-status-error group-hover:opacity-100"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path
                      d="M6 6l12 12M18 6 6 18"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
