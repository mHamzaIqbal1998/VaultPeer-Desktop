import { useState } from "react";
import { motion } from "framer-motion";
import {
  saveDatabaseDialog,
  openKeyFileDialog,
  createDatabase,
  DEFAULT_CREATE_OPTIONS,
  type CreateOptions,
  type DatabaseMetadata,
} from "@/services/tauri";
import { PasswordField } from "./PasswordField";
import { StrengthMeter } from "./StrengthMeter";

interface Props {
  onClose: () => void;
  onCreated: (meta: DatabaseMetadata) => void;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Modal flow for creating a new `.kdbx` database (PRD FM-02, ENC-01..04). */
export function CreateDatabaseDialog({ onClose, onCreated }: Props) {
  const [name, setName] = useState("My Vault");
  const [path, setPath] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [keyFile, setKeyFile] = useState<string | null>(null);
  const [options, setOptions] = useState<CreateOptions>(DEFAULT_CREATE_OPTIONS);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isArgon2 = options.kdf !== "aes";

  async function handlePickPath() {
    const safeName = name.trim() || "Vault";
    const chosen = await saveDatabaseDialog(`${safeName}.kdbx`);
    if (chosen) setPath(chosen);
  }

  async function handlePickKeyFile() {
    const chosen = await openKeyFileDialog();
    if (chosen) setKeyFile(chosen);
  }

  function validate(): string | null {
    if (!name.trim()) return "Enter a database name.";
    if (!path) return "Choose where to save the database.";
    if (!password && !keyFile)
      return "Set a master password or a key file (or both).";
    if (password && password !== confirm) return "Passwords do not match.";
    return null;
  }

  async function handleCreate() {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const meta = await createDatabase(
        path!,
        name.trim(),
        password || null,
        keyFile,
        options,
      );
      onCreated(meta);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border-sage bg-surface-card shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-border-sage px-5 py-4">
          <h2 className="text-base font-semibold text-text-primary">
            Create New Database
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-7 w-7 place-items-center rounded-md text-text-muted transition-colors hover:bg-accent-mint-dim hover:text-text-primary"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M6 6l12 12M18 6 6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className="space-y-4 overflow-auto px-5 py-4">
          <Field label="Database name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-border-sage bg-background-primary px-3 py-2.5 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-mint"
              placeholder="My Vault"
            />
          </Field>

          <Field label="Save location">
            <button
              type="button"
              onClick={handlePickPath}
              className="w-full truncate rounded-lg border border-dashed border-border-sage px-3 py-2.5 text-left text-xs transition-colors hover:border-accent-mint/50"
              title={path ?? undefined}
            >
              {path ? (
                <span className="text-text-secondary">{path}</span>
              ) : (
                <span className="text-text-muted">Choose a file location…</span>
              )}
            </button>
          </Field>

          <Field label="Master password">
            <PasswordField
              value={password}
              onChange={setPassword}
              placeholder="Master password"
            />
            <div className="mt-2">
              <StrengthMeter password={password} />
            </div>
          </Field>

          <Field label="Confirm password">
            <PasswordField
              value={confirm}
              onChange={setConfirm}
              placeholder="Re-enter password"
            />
          </Field>

          <Field label="Key file (optional)">
            {keyFile ? (
              <div className="flex items-center gap-2 rounded-lg border border-border-sage bg-background-primary px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-xs text-text-secondary" title={keyFile}>
                  {basename(keyFile)}
                </span>
                <button
                  type="button"
                  onClick={() => setKeyFile(null)}
                  className="text-xs text-text-muted hover:text-status-error"
                >
                  Remove
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handlePickKeyFile}
                className="w-full rounded-lg border border-dashed border-border-sage px-3 py-2 text-left text-xs text-text-muted transition-colors hover:border-accent-mint/50 hover:text-text-secondary"
              >
                Select a key file…
              </button>
            )}
          </Field>

          <div className="rounded-lg border border-border-sage">
            <button
              type="button"
              onClick={() => setShowAdvanced((s) => !s)}
              className="flex w-full items-center justify-between px-3 py-2.5 text-xs font-medium text-text-secondary"
            >
              <span>Encryption settings</span>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden
                className={`transition-transform ${showAdvanced ? "rotate-180" : ""}`}
              >
                <path
                  d="M6 9l6 6 6-6"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>

            {showAdvanced && (
              <div className="space-y-3 border-t border-border-sage px-3 py-3">
                <div className="grid grid-cols-2 gap-3">
                  <Select
                    label="Key derivation"
                    value={options.kdf}
                    onChange={(v) =>
                      setOptions((o) => ({ ...o, kdf: v as CreateOptions["kdf"] }))
                    }
                    options={[
                      ["argon2id", "Argon2id"],
                      ["argon2d", "Argon2d"],
                      ["aes", "AES-KDF"],
                    ]}
                  />
                  <Select
                    label="Cipher"
                    value={options.cipher}
                    onChange={(v) =>
                      setOptions((o) => ({
                        ...o,
                        cipher: v as CreateOptions["cipher"],
                      }))
                    }
                    options={[
                      ["aes256", "AES-256"],
                      ["chacha20", "ChaCha20"],
                      ["twofish", "Twofish"],
                    ]}
                  />
                </div>

                {isArgon2 ? (
                  <div className="grid grid-cols-3 gap-3">
                    <NumberField
                      label="Memory (MiB)"
                      value={options.kdfMemoryMib}
                      min={1}
                      onChange={(v) => setOptions((o) => ({ ...o, kdfMemoryMib: v }))}
                    />
                    <NumberField
                      label="Iterations"
                      value={options.kdfIterations}
                      min={1}
                      onChange={(v) =>
                        setOptions((o) => ({ ...o, kdfIterations: v }))
                      }
                    />
                    <NumberField
                      label="Parallelism"
                      value={options.kdfParallelism}
                      min={1}
                      onChange={(v) =>
                        setOptions((o) => ({ ...o, kdfParallelism: v }))
                      }
                    />
                  </div>
                ) : (
                  <NumberField
                    label="AES-KDF rounds"
                    value={options.aesRounds}
                    min={1}
                    onChange={(v) => setOptions((o) => ({ ...o, aesRounds: v }))}
                  />
                )}

                <Select
                  label="Compression"
                  value={options.compression}
                  onChange={(v) =>
                    setOptions((o) => ({
                      ...o,
                      compression: v as CreateOptions["compression"],
                    }))
                  }
                  options={[
                    ["gzip", "GZip"],
                    ["none", "None"],
                  ]}
                />
              </div>
            )}
          </div>

          {error && (
            <div className="rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-status-error">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border-sage px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-border-sage px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:border-accent-mint/40 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={busy}
            className="rounded-lg bg-accent-mint px-4 py-2 text-sm font-semibold text-background-primary transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create Database"}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <span className="mb-1.5 block text-xs font-medium text-text-muted">
        {label}
      </span>
      {children}
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: [string, string][];
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-text-muted">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-border-sage bg-background-primary px-2.5 py-2 text-sm text-text-primary outline-none transition-colors focus:border-accent-mint"
      >
        {options.map(([val, text]) => (
          <option key={val} value={val}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

function NumberField({
  label,
  value,
  min,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-text-muted">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) onChange(Math.max(min ?? 0, Math.floor(n)));
        }}
        className="w-full rounded-lg border border-border-sage bg-background-primary px-2.5 py-2 text-sm text-text-primary outline-none transition-colors focus:border-accent-mint"
      />
    </label>
  );
}
