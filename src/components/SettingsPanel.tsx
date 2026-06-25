import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useSettingsStore } from "@/stores/settingsStore";
import { useThemeStore, type ThemePreference } from "@/stores/themeStore";
import { useSessionStore } from "@/stores/sessionStore";
import { useVaultStore } from "@/stores/vaultStore";
import {
  setAutostart,
  getDbSettings,
  updateDbSettings,
  dbMaintenance,
  kdfBenchmark,
  exportDatabase,
  saveExportDialog,
  writeFileAtomic,
  saveDatabase,
  biometricAvailable,
  biometricIsEnrolled,
  biometricEnroll,
  biometricForget,
  browserServerStatus,
  browserServerStart,
  browserServerStop,
  exportBrowserExtension,
  registerNativeHost,
  openDirectoryDialog,
  type BrowserServerStatus,
  type CreateOptions,
  type DbSettings,
  type ShortcutBindings,
} from "@/services/tauri";
import { captureAccelerator } from "@/lib/shortcuts";
import { PasswordField } from "./PasswordField";

type Tab = "app" | "database" | "security" | "sync" | "browser";

interface Props {
  onClose: () => void;
}

/**
 * Tabbed settings interface (PLAN Phase 7 / PRD §3.9). App preferences persist
 * via the Rust-backed settings store; Database settings mutate the open vault
 * (and require a save to take effect); Security covers Windows Hello quick-
 * unlock, emergency export, and clearing recent-files history.
 */
export function SettingsPanel({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>("app");
  const metadata = useSessionStore((s) => s.metadata);
  const isUnlocked = metadata !== null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tabs: { id: Tab; label: string }[] = [
    { id: "app", label: "Application" },
    { id: "database", label: "Database" },
    { id: "security", label: "Security" },
    { id: "sync", label: "Sync" },
    { id: "browser", label: "Browser" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="flex h-[640px] max-h-full w-full max-w-2xl overflow-hidden rounded-2xl border border-border-sage bg-surface-card shadow-2xl"
      >
        {/* Tab rail */}
        <nav className="flex w-44 shrink-0 flex-col gap-1 border-r border-border-sage bg-background-primary/40 p-3">
          <h2 className="px-2 pb-2 pt-1 text-sm font-semibold text-text-primary">
            Settings
          </h2>
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${
                tab === t.id
                  ? "bg-accent-mint-dim text-text-primary"
                  : "text-text-muted hover:bg-accent-mint-dim/50 hover:text-text-secondary"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-border-sage px-5 py-3">
            <span className="text-sm font-semibold text-text-primary">
              {tabs.find((t) => t.id === tab)?.label}
            </span>
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

          <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
            {tab === "app" && <AppTab />}
            {tab === "database" && <DatabaseTab isUnlocked={isUnlocked} />}
            {tab === "security" && (
              <SecurityTab isUnlocked={isUnlocked} dbPath={metadata?.path ?? null} />
            )}
            {tab === "sync" && <SyncTab />}
            {tab === "browser" && <BrowserTab />}
          </div>
        </div>
      </motion.div>
    </div>
  );
}

// ── Application tab ───────────────────────────────────────────────────────────

const AUTO_LOCK_OPTIONS: [number, string][] = [
  [0, "Never"],
  [60, "1 minute"],
  [300, "5 minutes"],
  [600, "10 minutes"],
  [1800, "30 minutes"],
  [3600, "1 hour"],
];

const CLIPBOARD_OPTIONS: [number, string][] = [
  [0, "Never"],
  [10, "10 seconds"],
  [30, "30 seconds"],
  [60, "1 minute"],
  [300, "5 minutes"],
];

function AppTab() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const setPreference = useThemeStore((s) => s.setPreference);
  const [autostartError, setAutostartError] = useState<string | null>(null);

  function setTheme(theme: ThemePreference) {
    setPreference(theme);
    void update({ theme });
  }

  async function toggleStartWithWindows(enabled: boolean) {
    setAutostartError(null);
    try {
      await setAutostart(enabled);
      await update({ startWithWindows: enabled });
    } catch (e) {
      setAutostartError(String(e));
    }
  }

  const gen = settings.generator;

  return (
    <div className="space-y-6">
      <Section title="Appearance">
        <Row label="Theme" hint="Match the system, or force light/dark/high contrast.">
          <Segmented
            value={settings.theme}
            options={[
              ["system", "System"],
              ["light", "Light"],
              ["dark", "Dark"],
              ["high-contrast", "High Contrast"],
            ]}
            onChange={(v) => setTheme(v as ThemePreference)}
          />
        </Row>
      </Section>

      <Section title="Security & privacy">
        <Row label="Auto-lock" hint="Lock the vault after inactivity.">
          <SelectBox
            value={settings.autoLockSeconds}
            options={AUTO_LOCK_OPTIONS}
            onChange={(v) => update({ autoLockSeconds: v })}
          />
        </Row>
        <Row label="Clear clipboard" hint="Wipe copied secrets after a delay.">
          <SelectBox
            value={settings.clipboardClearSeconds}
            options={CLIPBOARD_OPTIONS}
            onChange={(v) => update({ clipboardClearSeconds: v })}
          />
        </Row>
      </Section>

      <Section title="Window & startup">
        <ToggleRow
          label="Minimize to tray on close"
          hint="Keep running in the tray instead of quitting."
          checked={settings.minimizeToTray}
          onChange={(v) => update({ minimizeToTray: v })}
        />
        <ToggleRow
          label="Start with Windows"
          hint="Launch VaultPeer when you sign in."
          checked={settings.startWithWindows}
          onChange={toggleStartWithWindows}
        />
        {autostartError && (
          <p className="text-xs text-status-error">{autostartError}</p>
        )}
      </Section>

      <Section title="Default password generator">
        <Row label="Length">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={8}
              max={128}
              value={gen.length}
              onChange={(e) =>
                update({ generator: { ...gen, length: Number(e.target.value) } })
              }
              className="w-40 accent-[var(--color-accent-mint)]"
            />
            <span className="w-8 text-right font-mono text-sm text-text-primary">
              {gen.length}
            </span>
          </div>
        </Row>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ["uppercase", "Uppercase (A–Z)"],
              ["lowercase", "Lowercase (a–z)"],
              ["digits", "Digits (0–9)"],
              ["symbols", "Symbols (!@#)"],
              ["excludeAmbiguous", "Exclude ambiguous"],
            ] as [keyof typeof gen, string][]
          ).map(([key, label]) => (
            <label
              key={key}
              className="flex cursor-pointer items-center gap-2 text-xs text-text-secondary"
            >
              <input
                type="checkbox"
                checked={gen[key] as boolean}
                onChange={(e) =>
                  update({ generator: { ...gen, [key]: e.target.checked } })
                }
                className="accent-[var(--color-accent-mint)]"
              />
              {label}
            </label>
          ))}
        </div>
      </Section>

      <Section title="Keyboard shortcuts">
        <ShortcutEditor
          bindings={settings.shortcuts}
          onChange={(shortcuts) => update({ shortcuts })}
        />
      </Section>
    </div>
  );
}

const SHORTCUT_LABELS: [keyof ShortcutBindings, string][] = [
  ["search", "Search"],
  ["lock", "Lock database"],
  ["save", "Save database"],
  ["newEntry", "New entry"],
  ["generator", "Password generator"],
  ["settings", "Open settings"],
  ["copyPassword", "Copy password"],
  ["copyUsername", "Copy username"],
];

/**
 * Global OS-level hotkeys registered natively at startup (see `lib.rs`). They
 * fire even when the app is unfocused, so they're fixed rather than editable —
 * shown here read-only so the functionality is discoverable.
 */
const GLOBAL_HOTKEYS: [string, string][] = [
  ["Auto-type matched entry", "Ctrl+Alt+A"],
  ["Auto-type password only", "Ctrl+Alt+P"],
];

function ShortcutEditor({
  bindings,
  onChange,
}: {
  bindings: ShortcutBindings;
  onChange: (b: ShortcutBindings) => void;
}) {
  const [capturing, setCapturing] = useState<keyof ShortcutBindings | null>(null);

  useEffect(() => {
    if (!capturing) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const accel = captureAccelerator(e);
      if (accel) {
        onChange({ ...bindings, [capturing]: accel });
        setCapturing(null);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [capturing, bindings, onChange]);

  return (
    <div className="space-y-1.5">
      {SHORTCUT_LABELS.map(([key, label]) => (
        <div key={key} className="flex items-center justify-between gap-3">
          <span className="text-sm text-text-secondary">{label}</span>
          <button
            type="button"
            onClick={() => setCapturing(capturing === key ? null : key)}
            className={`min-w-28 rounded-md border px-3 py-1 text-center font-mono text-xs transition-colors ${
              capturing === key
                ? "border-accent-mint bg-accent-mint-dim text-text-primary"
                : "border-border-sage text-text-primary hover:border-accent-mint/40"
            }`}
          >
            {capturing === key ? "Press keys…" : bindings[key]}
          </button>
        </div>
      ))}
      <p className="pt-1 text-xs text-text-muted">
        Click a shortcut, then press the new key combination.
      </p>

      <div className="mt-3 border-t border-border-sage pt-3">
        <div className="mb-1.5 text-xs font-medium text-text-muted">
          Global hotkeys (system-wide, fixed)
        </div>
        {GLOBAL_HOTKEYS.map(([label, accel]) => (
          <div key={accel} className="flex items-center justify-between gap-3 py-0.5">
            <span className="text-sm text-text-secondary">{label}</span>
            <span
              title="Registered system-wide — works even when VaultPeer isn't focused"
              className="min-w-28 cursor-default rounded-md border border-dashed border-border-sage px-3 py-1 text-center font-mono text-xs text-text-muted"
            >
              {accel}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Database tab ──────────────────────────────────────────────────────────────

function DatabaseTab({ isUnlocked }: { isUnlocked: boolean }) {
  const setDirty = useSessionStore((s) => s.setDirty);
  const [dbSettings, setDbSettings] = useState<DbSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [benchmarking, setBenchmarking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isUnlocked) return;
    void getDbSettings()
      .then(setDbSettings)
      .catch((e) => setError(String(e)));
  }, [isUnlocked]);

  if (!isUnlocked) {
    return (
      <div className="space-y-6">
        <NewDatabaseDefaults />
        <Section title="Current database">
          <p className="text-sm text-text-muted">
            Unlock a database to change its encryption, recycle-bin, and history
            settings.
          </p>
        </Section>
      </div>
    );
  }
  if (error) {
    return <p className="text-sm text-status-error">{error}</p>;
  }
  if (!dbSettings) {
    return <p className="text-sm text-text-muted">Loading…</p>;
  }

  const enc = dbSettings.encryption;
  const meta = dbSettings.meta;
  const isArgon2 = enc.kdf !== "aes";

  function patchEnc(patch: Partial<CreateOptions>) {
    setDbSettings((s) => (s ? { ...s, encryption: { ...s.encryption, ...patch } } : s));
  }
  function patchMeta(patch: Partial<DbSettings["meta"]>) {
    setDbSettings((s) => (s ? { ...s, meta: { ...s.meta, ...patch } } : s));
  }

  async function handleBenchmark() {
    setBenchmarking(true);
    setStatus(null);
    try {
      const iterations = await kdfBenchmark(
        enc.kdfMemoryMib,
        enc.kdfParallelism,
        1.0,
        enc.kdf === "argon2id",
      );
      patchEnc({ kdfIterations: iterations });
      setStatus(`Calibrated to ${iterations} iterations for ~1.0s.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBenchmarking(false);
    }
  }

  async function handleApply() {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      await updateDbSettings(enc, meta);
      await saveDatabase();
      setDirty(false);
      setStatus("Database settings saved and re-encrypted.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleMaintenance() {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const report = await dbMaintenance();
      await saveDatabase();
      setDirty(false);
      setStatus(
        report.historySnapshotsRemoved === 0
          ? "Nothing to clean up — histories are within limits."
          : `Pruned ${report.historySnapshotsRemoved} snapshot(s) across ${report.entriesTrimmed} entr${report.entriesTrimmed === 1 ? "y" : "ies"}.`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <NewDatabaseDefaults />

      <div className="-mx-5 border-t border-border-sage" />
      <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
        Current database
      </h3>

      <Section title="Encryption">
        <div className="grid grid-cols-2 gap-3">
          <LabeledSelect
            label="Key derivation"
            value={enc.kdf}
            onChange={(v) => patchEnc({ kdf: v as CreateOptions["kdf"] })}
            options={[
              ["argon2id", "Argon2id"],
              ["argon2d", "Argon2d"],
              ["aes", "AES-KDF"],
            ]}
          />
          <LabeledSelect
            label="Cipher"
            value={enc.cipher}
            onChange={(v) => patchEnc({ cipher: v as CreateOptions["cipher"] })}
            options={[
              ["aes256", "AES-256"],
              ["chacha20", "ChaCha20"],
              ["twofish", "Twofish"],
            ]}
          />
        </div>

        {isArgon2 ? (
          <>
            <div className="grid grid-cols-3 gap-3">
              <LabeledNumber
                label="Memory (MiB)"
                value={enc.kdfMemoryMib}
                min={1}
                onChange={(v) => patchEnc({ kdfMemoryMib: v })}
              />
              <LabeledNumber
                label="Iterations"
                value={enc.kdfIterations}
                min={1}
                onChange={(v) => patchEnc({ kdfIterations: v })}
              />
              <LabeledNumber
                label="Parallelism"
                value={enc.kdfParallelism}
                min={1}
                onChange={(v) => patchEnc({ kdfParallelism: v })}
              />
            </div>
            <button
              type="button"
              onClick={handleBenchmark}
              disabled={benchmarking}
              className="rounded-lg border border-border-sage bg-surface-elevated px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:border-accent-mint/40 disabled:opacity-50"
            >
              {benchmarking ? "Calculating…" : "Calculate for 1.0s"}
            </button>
          </>
        ) : (
          <LabeledNumber
            label="AES-KDF rounds"
            value={enc.aesRounds}
            min={1}
            onChange={(v) => patchEnc({ aesRounds: v })}
          />
        )}

        <LabeledSelect
          label="Compression"
          value={enc.compression}
          onChange={(v) => patchEnc({ compression: v as CreateOptions["compression"] })}
          options={[
            ["gzip", "GZip"],
            ["none", "None"],
          ]}
        />
        {(enc.kdf === "aes" || enc.cipher === "twofish") && (
          <p className="text-[11px] text-status-warning">
            ⚠ AES-KDF and Twofish can't be opened by VaultPeer mobile or other
            KeePass apps. For cross-device sync, choose Argon2d (or Argon2id) with
            AES-256 or ChaCha20, then Save &amp; re-encrypt.
          </p>
        )}
      </Section>

      <Section title="Recycle bin & history">
        <ToggleRow
          label="Enable recycle bin"
          hint="Send deletions to the bin instead of removing them immediately."
          checked={meta.recycleBinEnabled}
          onChange={(v) => patchMeta({ recycleBinEnabled: v })}
        />
        <div className="grid grid-cols-2 gap-3">
          <LabeledNumber
            label="Max history items"
            value={meta.historyMaxItems}
            min={-1}
            hint="-1 = unlimited"
            onChange={(v) => patchMeta({ historyMaxItems: v })}
          />
          <LabeledNumber
            label="Max history size (MiB)"
            value={meta.historyMaxSizeMib}
            min={-1}
            hint="-1 = unlimited"
            onChange={(v) => patchMeta({ historyMaxSizeMib: v })}
          />
        </div>
      </Section>

      <Section title="Maintenance">
        <p className="text-xs text-text-muted">
          Trim each entry's history down to the limits above.
        </p>
        <button
          type="button"
          onClick={handleMaintenance}
          disabled={busy}
          className="rounded-lg border border-border-sage bg-surface-elevated px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:border-accent-mint/40 disabled:opacity-50"
        >
          Clean up history
        </button>
      </Section>

      {status && <p className="text-xs text-status-success">{status}</p>}
      {error && <p className="text-xs text-status-error">{error}</p>}

      <div className="sticky bottom-[-16px] -mx-5 mt-4 flex justify-end gap-2 border-t border-border-sage bg-surface-card px-5 py-3">
        <button
          type="button"
          onClick={handleApply}
          disabled={busy}
          className="rounded-lg bg-accent-mint px-4 py-2 text-sm font-semibold text-background-primary transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save & re-encrypt"}
        </button>
      </div>
    </div>
  );
}

/** Editor for the encryption settings pre-filled when creating a new DB (SET-06). */
function NewDatabaseDefaults() {
  const options = useSettingsStore((s) => s.settings.defaultCreateOptions);
  const update = useSettingsStore((s) => s.update);
  const isArgon2 = options.kdf !== "aes";

  function patch(p: Partial<CreateOptions>) {
    void update({ defaultCreateOptions: { ...options, ...p } });
  }

  return (
    <Section title="Defaults for new databases">
      <div className="grid grid-cols-2 gap-3">
        <LabeledSelect
          label="Key derivation"
          value={options.kdf}
          onChange={(v) => patch({ kdf: v as CreateOptions["kdf"] })}
          options={[
            ["argon2id", "Argon2id"],
            ["argon2d", "Argon2d"],
            ["aes", "AES-KDF"],
          ]}
        />
        <LabeledSelect
          label="Cipher"
          value={options.cipher}
          onChange={(v) => patch({ cipher: v as CreateOptions["cipher"] })}
          options={[
            ["aes256", "AES-256"],
            ["chacha20", "ChaCha20"],
            ["twofish", "Twofish"],
          ]}
        />
      </div>
      {isArgon2 ? (
        <div className="grid grid-cols-3 gap-3">
          <LabeledNumber
            label="Memory (MiB)"
            value={options.kdfMemoryMib}
            min={1}
            onChange={(v) => patch({ kdfMemoryMib: v })}
          />
          <LabeledNumber
            label="Iterations"
            value={options.kdfIterations}
            min={1}
            onChange={(v) => patch({ kdfIterations: v })}
          />
          <LabeledNumber
            label="Parallelism"
            value={options.kdfParallelism}
            min={1}
            onChange={(v) => patch({ kdfParallelism: v })}
          />
        </div>
      ) : (
        <LabeledNumber
          label="AES-KDF rounds"
          value={options.aesRounds}
          min={1}
          onChange={(v) => patch({ aesRounds: v })}
        />
      )}
      <LabeledSelect
        label="Compression"
        value={options.compression}
        onChange={(v) => patch({ compression: v as CreateOptions["compression"] })}
        options={[
          ["gzip", "GZip"],
          ["none", "None"],
        ]}
      />
      {(options.kdf === "aes" || options.cipher === "twofish") && (
        <p className="text-[11px] text-status-warning">
          ⚠ AES-KDF and Twofish can't be opened by VaultPeer mobile or other
          KeePass apps. For cross-device sync, use Argon2d (or Argon2id) with
          AES-256 or ChaCha20.
        </p>
      )}
    </Section>
  );
}

// ── Security tab ──────────────────────────────────────────────────────────────

function SecurityTab({
  isUnlocked,
  dbPath,
}: {
  isUnlocked: boolean;
  dbPath: string | null;
}) {
  const clearRecentFiles = useVaultStore((s) => s.clearRecentFiles);
  const [helloAvailable, setHelloAvailable] = useState(false);
  const [enrolled, setEnrolled] = useState(false);
  const [enrollPassword, setEnrollPassword] = useState("");
  const [showEnroll, setShowEnroll] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recentCleared, setRecentCleared] = useState(false);

  useEffect(() => {
    void biometricAvailable()
      .then(setHelloAvailable)
      .catch(() => setHelloAvailable(false));
  }, []);

  useEffect(() => {
    if (!dbPath) return;
    void biometricIsEnrolled(dbPath)
      .then(setEnrolled)
      .catch(() => setEnrolled(false));
  }, [dbPath]);

  async function handleEnroll() {
    if (!dbPath || !enrollPassword) return;
    setError(null);
    setStatus(null);
    try {
      await biometricEnroll(dbPath, enrollPassword);
      setEnrolled(true);
      setShowEnroll(false);
      setEnrollPassword("");
      setStatus("Windows Hello quick-unlock enabled for this vault.");
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleForget() {
    if (!dbPath) return;
    setError(null);
    setStatus(null);
    try {
      await biometricForget(dbPath);
      setEnrolled(false);
      setStatus("Windows Hello quick-unlock removed.");
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleExport(format: "csv" | "xml") {
    setError(null);
    setStatus(null);
    try {
      const path = await saveExportDialog(format);
      if (!path) return;
      const text = await exportDatabase(format);
      await writeFileAtomic(path, new TextEncoder().encode(text));
      setStatus(`Exported to ${path}`);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="space-y-6">
      <Section title="Windows Hello quick-unlock">
        {!helloAvailable ? (
          <p className="text-sm text-text-muted">
            Windows Hello isn't set up on this device (or this isn't a Windows
            build). Configure a PIN, fingerprint, or face in Windows settings to
            use biometric quick-unlock.
          </p>
        ) : !isUnlocked ? (
          <p className="text-sm text-text-muted">
            Unlock a database first to enable quick-unlock for it.
          </p>
        ) : enrolled ? (
          <div className="space-y-2">
            <p className="text-sm text-text-secondary">
              This vault can be unlocked with Windows Hello. Your master password
              is stored encrypted with the Windows Data Protection API.
            </p>
            <button
              type="button"
              onClick={handleForget}
              className="rounded-lg border border-status-error/40 px-3 py-1.5 text-xs font-medium text-status-error transition-colors hover:bg-status-error/10"
            >
              Remove quick-unlock
            </button>
          </div>
        ) : showEnroll ? (
          <div className="space-y-2">
            <p className="text-xs text-text-muted">
              Re-enter this vault's master password to store it securely for
              Windows Hello unlock.
            </p>
            <PasswordField
              value={enrollPassword}
              onChange={setEnrollPassword}
              placeholder="Master password"
              onEnter={handleEnroll}
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleEnroll}
                disabled={!enrollPassword}
                className="rounded-lg bg-accent-mint px-3 py-1.5 text-xs font-semibold text-background-primary transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                Confirm & enable
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowEnroll(false);
                  setEnrollPassword("");
                }}
                className="rounded-lg border border-border-sage px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-accent-mint/40"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowEnroll(true)}
            className="rounded-lg border border-border-sage bg-surface-elevated px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:border-accent-mint/40"
          >
            Set up Windows Hello for this vault
          </button>
        )}
      </Section>

      <Section title="Emergency export">
        <p className="text-xs text-status-warning">
          ⚠ Exports are <strong>unencrypted</strong> and contain every password
          in plain text. Store the file securely and delete it when done.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!isUnlocked}
            onClick={() => handleExport("csv")}
            className="rounded-lg border border-border-sage bg-surface-elevated px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:border-accent-mint/40 disabled:opacity-50"
          >
            Export to CSV
          </button>
          <button
            type="button"
            disabled={!isUnlocked}
            onClick={() => handleExport("xml")}
            className="rounded-lg border border-border-sage bg-surface-elevated px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:border-accent-mint/40 disabled:opacity-50"
          >
            Export to XML
          </button>
        </div>
        {!isUnlocked && (
          <p className="text-xs text-text-muted">Unlock a database to export.</p>
        )}
      </Section>

      <Section title="Recent files">
        <p className="text-xs text-text-muted">
          Forget the list of recently-opened databases shown on the unlock
          screen.
        </p>
        <button
          type="button"
          onClick={() => {
            clearRecentFiles();
            setRecentCleared(true);
          }}
          className="rounded-lg border border-border-sage bg-surface-elevated px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:border-accent-mint/40"
        >
          {recentCleared ? "Cleared" : "Clear recent files"}
        </button>
      </Section>

      {status && <p className="text-xs text-status-success">{status}</p>}
      {error && <p className="text-xs text-status-error">{error}</p>}
    </div>
  );
}

// ── Sync tab (PLAN Phase 8 / SYN-01, SYN-07) ──────────────────────────────────

const DEFAULT_STUN = "stun:stun.l.google.com:19302";

function SyncTab() {
  const sync = useSettingsStore((s) => s.settings.sync);
  const update = useSettingsStore((s) => s.update);

  const setSignalingUrl = (signalingUrl: string) =>
    void update({ sync: { ...sync, signalingUrl } });

  const setIce = (iceServers: typeof sync.iceServers) =>
    void update({ sync: { ...sync, iceServers } });

  const addIce = () =>
    setIce([...sync.iceServers, { urls: ["stun:"], username: null, credential: null }]);

  const removeIce = (index: number) =>
    setIce(sync.iceServers.filter((_, i) => i !== index));

  const inputCls =
    "w-full rounded-lg border border-border-sage bg-background-primary px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent-mint/50";

  return (
    <div className="space-y-6">
      <Section title="Auto-sync">
        <ToggleRow
          label="Sync automatically on open"
          hint={
            sync.room
              ? `Reconnects to room ${sync.room} when a vault is opened.`
              : "Create or join a room from the Sync panel to enable this."
          }
          checked={sync.autoSync}
          onChange={(autoSync) => void update({ sync: { ...sync, autoSync } })}
        />
        {sync.room && (
          <div className="text-xs text-text-muted">
            Remembered room: <code className="font-mono text-text-secondary">{sync.room}</code>
          </div>
        )}
      </Section>

      <Section title="Signaling server">
        <p className="text-xs text-text-muted">
          P2P sync exchanges connection details through a WebSocket signaling
          server, then transfers the encrypted vault directly between devices.
          Use the same server URL as your VaultPeer mobile app.
        </p>
        <input
          type="text"
          value={sync.signalingUrl}
          placeholder="wss://signal.example.com"
          spellCheck={false}
          onChange={(e) => setSignalingUrl(e.target.value)}
          className={inputCls}
        />
      </Section>

      <Section title="ICE servers (STUN / TURN)">
        <p className="text-xs text-text-muted">
          STUN servers help peers discover each other across NATs; a TURN server
          relays traffic when a direct connection isn't possible.
        </p>
        <div className="space-y-3">
          {sync.iceServers.map((server, i) => (
            <div
              key={i}
              className="space-y-2 rounded-lg border border-border-sage bg-background-primary/40 p-3"
            >
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={server.urls.join(", ")}
                  placeholder="stun:host:port, turn:host:port"
                  spellCheck={false}
                  onChange={(e) => {
                    const urls = e.target.value
                      .split(",")
                      .map((u) => u.trim())
                      .filter(Boolean);
                    const next = [...sync.iceServers];
                    next[i] = { ...server, urls };
                    setIce(next);
                  }}
                  className={inputCls}
                />
                <button
                  type="button"
                  onClick={() => removeIce(i)}
                  aria-label="Remove server"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-text-muted transition-colors hover:bg-status-error/10 hover:text-status-error"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  value={server.username ?? ""}
                  placeholder="TURN username (optional)"
                  spellCheck={false}
                  onChange={(e) => {
                    const next = [...sync.iceServers];
                    next[i] = { ...server, username: e.target.value || null };
                    setIce(next);
                  }}
                  className={inputCls}
                />
                <input
                  type="text"
                  value={server.credential ?? ""}
                  placeholder="TURN credential (optional)"
                  spellCheck={false}
                  onChange={(e) => {
                    const next = [...sync.iceServers];
                    next[i] = { ...server, credential: e.target.value || null };
                    setIce(next);
                  }}
                  className={inputCls}
                />
              </div>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={addIce}
            className="rounded-lg border border-border-sage bg-surface-elevated px-3 py-1.5 text-sm font-medium text-text-primary transition-colors hover:border-accent-mint/40"
          >
            Add server
          </button>
          <button
            type="button"
            onClick={() => setIce([{ urls: [DEFAULT_STUN], username: null, credential: null }])}
            className="rounded-lg border border-border-sage px-3 py-1.5 text-sm font-medium text-text-muted transition-colors hover:text-text-secondary"
          >
            Reset to default STUN
          </button>
        </div>
      </Section>
    </div>
  );
}

// ── Browser tab (PLAN Phase 9 / BRW-01..03) ───────────────────────────────────

const DEFAULT_BROWSER_PORT = 7796;

function BrowserTab() {
  const [status, setStatus] = useState<BrowserServerStatus | null>(null);
  const [port, setPort] = useState(DEFAULT_BROWSER_PORT);
  const [bundleDir, setBundleDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void browserServerStatus()
      .then((s) => {
        setStatus(s);
        if (s.running && s.port) setPort(s.port);
      })
      .catch(() => {});
  }, []);

  async function toggleServer(enabled: boolean) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      if (enabled) {
        setStatus(await browserServerStart(port, null));
      } else {
        await browserServerStop();
        setStatus(await browserServerStatus());
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyToken() {
    if (!status?.token) return;
    try {
      await navigator.clipboard.writeText(status.token);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  async function exportBundle() {
    setError(null);
    setNote(null);
    try {
      const dir = await openDirectoryDialog("Choose where to write the extension");
      if (!dir) return;
      await exportBrowserExtension(dir);
      setBundleDir(dir);
      setNote(`Extension written to ${dir}. Load it unpacked in your browser.`);
    } catch (e) {
      setError(String(e));
    }
  }

  async function register() {
    if (!bundleDir) return;
    setError(null);
    setNote(null);
    try {
      const sep = bundleDir.includes("\\") ? "\\" : "/";
      await registerNativeHost(`${bundleDir}${sep}com.vaultpeer.desktop.json`);
      setNote("Native messaging host registered for Chrome/Edge.");
    } catch (e) {
      setError(String(e));
    }
  }

  const running = status?.running ?? false;

  return (
    <div className="space-y-6">
      <Section title="Local connector server">
        <p className="text-xs text-text-muted">
          Runs a small HTTP server on <code className="font-mono">127.0.0.1</code>{" "}
          (loopback only) so a browser extension can request credentials for the
          page you're on. Off by default; secured with a per-session token.
        </p>
        <Row label="Port" hint="Restart the server to change.">
          <input
            type="number"
            value={port}
            min={1024}
            max={65535}
            disabled={running}
            onChange={(e) => setPort(Number(e.target.value) || DEFAULT_BROWSER_PORT)}
            className="w-24 rounded-lg border border-border-sage bg-background-primary px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent-mint disabled:opacity-50"
          />
        </Row>
        <ToggleRow
          label="Enable connector server"
          hint={running ? `Listening on 127.0.0.1:${status?.port}` : "Stopped"}
          checked={running}
          onChange={(v) => void toggleServer(v)}
        />
        {busy && <p className="text-xs text-text-muted">Working…</p>}
        {running && status?.token && (
          <div className="space-y-1 rounded-lg border border-border-sage bg-background-primary/40 p-3">
            <div className="text-[11px] text-text-muted">
              Connection token — paste into the extension popup:
            </div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary">
                {status.token}
              </code>
              <button
                type="button"
                onClick={copyToken}
                className="shrink-0 rounded-md border border-border-sage px-2 py-1 text-[11px] text-text-primary transition-colors hover:border-accent-mint/40"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        )}
      </Section>

      <Section title="Browser extension">
        <p className="text-xs text-text-muted">
          Write a ready-to-load extension (Chrome/Edge/Firefox) to a folder, then
          load it unpacked and paste the port + token above into its popup.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={exportBundle}
            className="rounded-lg border border-border-sage bg-surface-elevated px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:border-accent-mint/40"
          >
            Export extension files…
          </button>
          <button
            type="button"
            onClick={register}
            disabled={!bundleDir}
            className="rounded-lg border border-border-sage bg-surface-elevated px-3 py-1.5 text-xs font-medium text-text-muted transition-colors hover:border-accent-mint/40 disabled:opacity-50"
            title="Advanced & optional — the bundled extension uses the connector server above, not native messaging. Windows only."
          >
            Register native host (advanced)
          </button>
        </div>
        <p className="text-[11px] text-text-muted">
          The bundled extension uses the connector server above. “Register native
          host” is optional and only matters for a custom native-messaging
          extension — it won't change how the bundled one behaves.
        </p>
      </Section>

      {note && <p className="text-xs text-status-success">{note}</p>}
      {error && <p className="text-xs text-status-error">{error}</p>}
    </div>
  );
}

// ── Shared primitives ─────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm text-text-secondary">{label}</div>
        {hint && <div className="text-xs text-text-muted">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Row label={label} hint={hint}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
          checked ? "bg-accent-mint" : "bg-border-sage"
        }`}
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-5" : "translate-x-0.5"
          }`}
        />
      </button>
    </Row>
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex gap-1 rounded-lg border border-border-sage p-1">
      {options.map(([val, label]) => (
        <button
          key={val}
          type="button"
          onClick={() => onChange(val)}
          className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
            value === val
              ? "bg-accent-mint text-background-primary"
              : "text-text-muted hover:text-text-secondary"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function SelectBox({
  value,
  options,
  onChange,
}: {
  value: number;
  options: [number, string][];
  onChange: (v: number) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="rounded-lg border border-border-sage bg-background-primary px-2.5 py-1.5 text-sm text-text-primary outline-none transition-colors focus:border-accent-mint"
    >
      {options.map(([val, label]) => (
        <option key={val} value={val}>
          {label}
        </option>
      ))}
    </select>
  );
}

function LabeledSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
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

function LabeledNumber({
  label,
  value,
  min,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  hint?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-text-muted">
        {label}
        {hint && <span className="ml-1 text-text-muted/70">({hint})</span>}
      </span>
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
