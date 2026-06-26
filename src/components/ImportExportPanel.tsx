import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  openCsvDialog,
  openDatabaseDialog,
  openKeyFileDialog,
  saveExportDialog,
  saveKdbxDialog,
  readFile,
  writeFileAtomic,
  exportDatabase,
  exportKdbx,
  importCsvPreview,
  importCsvApply,
  importKdbxPreview,
  importKdbxApply,
  DEFAULT_CREATE_OPTIONS,
  MAPPING_FIELDS,
  type ColumnMapping,
  type CsvPreview,
  type CreateOptions,
  type MergeResult,
  type GroupNode,
} from "@/services/tauri";
import { useDatabaseStore } from "@/stores/databaseStore";
import { useSessionStore } from "@/stores/sessionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { PasswordField } from "./PasswordField";

interface Props {
  onClose: () => void;
}

type Tab = "import" | "export";

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Decode a file's bytes as UTF-8 text, stripping a BOM if present. */
function decodeText(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8").decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Flatten the group tree into an indented list for a group <select>. */
function flattenGroups(node: GroupNode | null, depth = 0, acc: { uuid: string; label: string }[] = []) {
  if (!node) return acc;
  acc.push({ uuid: node.uuid, label: `${" ".repeat(depth)}${node.name || "(root)"}` });
  for (const child of node.children) flattenGroups(child, depth + 1, acc);
  return acc;
}

/**
 * Import / Export workspace (PLAN Phase 9): migrate from other password managers
 * (CSV with field mapping + duplicate detection, or another KeePass database via
 * merge) and export the vault (CSV / JSON / XML, or a re-encrypted `.kdbx`).
 */
export function ImportExportPanel({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>("import");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="flex h-[640px] max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border-sage bg-surface-card shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-border-sage px-5 py-3">
          <div className="flex gap-1 rounded-lg border border-border-sage p-1">
            {(["import", "export"] as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`rounded-md px-4 py-1 text-xs font-medium capitalize transition-colors ${
                  tab === t
                    ? "bg-accent-mint text-background-primary"
                    : "text-text-muted hover:text-text-secondary"
                }`}
              >
                {t}
              </button>
            ))}
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

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {tab === "import" ? <ImportTab /> : <ExportTab />}
        </div>
      </motion.div>
    </div>
  );
}

// ── Import ─────────────────────────────────────────────────────────────────────

function ImportTab() {
  const [source, setSource] = useState<"csv" | "kdbx" | null>(null);
  return (
    <div className="space-y-5">
      <Section title="Import source">
        <div className="grid grid-cols-2 gap-3">
          <SourceCard
            active={source === "csv"}
            title="CSV file"
            hint="1Password, LastPass, Bitwarden, or any CSV export."
            onClick={() => setSource("csv")}
          />
          <SourceCard
            active={source === "kdbx"}
            title="KeePass database"
            hint="Merge another .kdbx file into this vault."
            onClick={() => setSource("kdbx")}
          />
        </div>
      </Section>
      {source === "csv" && <CsvImport />}
      {source === "kdbx" && <KdbxImport />}
    </div>
  );
}

function CsvImport() {
  const tree = useDatabaseStore((s) => s.tree);
  const selectedGroupUuid = useDatabaseStore((s) => s.selectedGroupUuid);
  const refreshAll = useDatabaseStore;
  const setDirty = useSessionStore((s) => s.setDirty);

  const groups = useMemo(() => flattenGroups(tree?.root ?? null), [tree]);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [text, setText] = useState<string>("");
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [groupUuid, setGroupUuid] = useState<string>("");
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<{ imported: number; skipped: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!groupUuid) setGroupUuid(selectedGroupUuid ?? tree?.root.uuid ?? "");
  }, [selectedGroupUuid, tree, groupUuid]);

  async function pickFile() {
    setError(null);
    setReport(null);
    try {
      const path = await openCsvDialog();
      if (!path) return;
      const bytes = await readFile(path);
      const csv = decodeText(bytes);
      const pv = await importCsvPreview(csv, null);
      setFilePath(path);
      setText(csv);
      setPreview(pv);
      setMapping(pv.mapping);
    } catch (e) {
      setError(String(e));
    }
  }

  async function refreshPreview(nextMapping: ColumnMapping) {
    setMapping(nextMapping);
    try {
      const pv = await importCsvPreview(text, nextMapping);
      setPreview(pv);
    } catch (e) {
      setError(String(e));
    }
  }

  function setField(key: keyof ColumnMapping, value: number | null) {
    if (!mapping) return;
    void refreshPreview({ ...mapping, [key]: value });
  }

  async function doImport() {
    if (!mapping || !groupUuid) return;
    setBusy(true);
    setError(null);
    try {
      const r = await importCsvApply(text, mapping, groupUuid, skipDuplicates);
      setReport(r);
      setDirty(true);
      // Refresh tree/entries/tags so the imported entries appear immediately.
      await Promise.all([
        refreshAll.getState().refreshTree(),
        refreshAll.getState().refreshEntries(),
        refreshAll.getState().refreshTags(),
      ]);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <Section title="CSV file">
        <PickButton path={filePath} placeholder="Choose a CSV file…" onClick={pickFile} />
      </Section>

      {preview && mapping && (
        <>
          <Section title={`Field mapping — detected ${preview.format}`}>
            <p className="text-xs text-text-muted">
              Map each VaultPeer field to a column from the file. Adjust if the
              guess is wrong.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {MAPPING_FIELDS.map(({ key, label }) => (
                <label key={key} className="block">
                  <span className="mb-1 block text-[11px] text-text-muted">{label}</span>
                  <select
                    value={mapping[key] ?? ""}
                    onChange={(e) =>
                      setField(key, e.target.value === "" ? null : Number(e.target.value))
                    }
                    className="w-full rounded-lg border border-border-sage bg-background-primary px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent-mint"
                  >
                    <option value="">— none —</option>
                    {preview.headers.map((h, i) => (
                      <option key={i} value={i}>
                        {h || `Column ${i + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </Section>

          <Section title="Preview">
            <div className="flex items-center gap-3 text-xs text-text-muted">
              <span>
                <strong className="text-text-primary">{preview.total}</strong> entries
              </span>
              {preview.duplicateCount > 0 && (
                <span className="text-status-warning">
                  {preview.duplicateCount} duplicate{preview.duplicateCount === 1 ? "" : "s"}
                </span>
              )}
            </div>
            <div className="max-h-44 overflow-auto rounded-lg border border-border-sage">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-surface-elevated text-text-muted">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">Title</th>
                    <th className="px-2 py-1.5 font-medium">Username</th>
                    <th className="px-2 py-1.5 font-medium">URL</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.candidates.slice(0, 50).map((c, i) => (
                    <tr key={i} className="border-t border-border-sage/60">
                      <td className="px-2 py-1.5 text-text-secondary">
                        {c.title || <span className="text-text-muted">—</span>}
                        {c.duplicate && (
                          <span className="ml-1.5 rounded bg-status-warning/15 px-1 py-0.5 text-[10px] text-status-warning">
                            dup
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-text-muted">{c.username}</td>
                      <td className="max-w-[12rem] truncate px-2 py-1.5 text-text-muted" title={c.url}>
                        {c.url}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="Destination">
            <label className="block">
              <span className="mb-1 block text-[11px] text-text-muted">Import into group</span>
              <select
                value={groupUuid}
                onChange={(e) => setGroupUuid(e.target.value)}
                className="w-full rounded-lg border border-border-sage bg-background-primary px-2.5 py-2 text-sm text-text-primary outline-none focus:border-accent-mint"
              >
                {groups.map((g) => (
                  <option key={g.uuid} value={g.uuid}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-text-secondary">
              <input
                type="checkbox"
                checked={skipDuplicates}
                onChange={(e) => setSkipDuplicates(e.target.checked)}
                className="accent-[var(--color-accent-mint)]"
              />
              Skip entries that duplicate an existing one
            </label>
          </Section>

          <button
            type="button"
            onClick={doImport}
            disabled={busy || !groupUuid || preview.total === 0}
            className="rounded-lg bg-accent-mint px-4 py-2 text-sm font-semibold text-background-primary transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Importing…" : `Import ${preview.total} entr${preview.total === 1 ? "y" : "ies"}`}
          </button>
        </>
      )}

      {report && (
        <p className="text-xs text-status-success">
          Imported {report.imported} entr{report.imported === 1 ? "y" : "ies"}
          {report.skipped > 0 ? `, skipped ${report.skipped} duplicate${report.skipped === 1 ? "" : "s"}` : ""}.
          Don't forget to <strong>Save</strong> the database.
        </p>
      )}
      {error && <p className="text-xs text-status-error">{error}</p>}
    </div>
  );
}

function KdbxImport() {
  const setDirty = useSessionStore((s) => s.setDirty);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [password, setPassword] = useState("");
  const [keyFile, setKeyFile] = useState<string | null>(null);
  const [preview, setPreview] = useState<MergeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<MergeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pickFile() {
    setError(null);
    setPreview(null);
    setReport(null);
    const path = await openDatabaseDialog();
    if (!path) return;
    try {
      setBytes(await readFile(path));
      setFilePath(path);
    } catch (e) {
      setError(String(e));
    }
  }

  async function doPreview() {
    if (!bytes) return;
    setBusy(true);
    setError(null);
    try {
      setPreview(await importKdbxPreview(bytes, password || null, keyFile));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    if (!bytes) return;
    setBusy(true);
    setError(null);
    try {
      const r = await importKdbxApply(bytes, password || null, keyFile);
      setReport(r);
      setDirty(true);
      await Promise.all([
        useDatabaseStore.getState().refreshTree(),
        useDatabaseStore.getState().refreshEntries(),
        useDatabaseStore.getState().refreshTags(),
      ]);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <Section title="KeePass database (.kdbx)">
        <PickButton path={filePath} placeholder="Choose a .kdbx file…" onClick={pickFile} />
        <p className="text-xs text-text-muted">
          The file is merged into your open vault (newer entries win, history is
          preserved). Nothing is deleted.
        </p>
      </Section>

      {filePath && (
        <Section title="Credentials of the imported file">
          <PasswordField value={password} onChange={setPassword} placeholder="Master password" />
          {keyFile ? (
            <div className="flex items-center gap-2 rounded-lg border border-border-sage bg-background-primary px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-xs text-text-secondary" title={keyFile}>
                {basename(keyFile)}
              </span>
              <button type="button" onClick={() => setKeyFile(null)} className="text-xs text-text-muted hover:text-status-error">
                Remove
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={async () => {
                const k = await openKeyFileDialog();
                if (k) setKeyFile(k);
              }}
              className="w-full rounded-lg border border-dashed border-border-sage px-3 py-2 text-left text-xs text-text-muted transition-colors hover:border-accent-mint/50 hover:text-text-secondary"
            >
              Add a key file (optional)…
            </button>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={doPreview}
              disabled={busy}
              className="rounded-lg border border-border-sage bg-surface-elevated px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:border-accent-mint/40 disabled:opacity-50"
            >
              {busy ? "Working…" : "Preview merge"}
            </button>
          </div>
        </Section>
      )}

      {preview && (
        <Section title="Merge preview">
          <p className="text-xs text-text-secondary">
            {preview.changed
              ? `${preview.created} new, ${preview.updated} updated, ${preview.locationUpdated} moved.`
              : "Already in sync — nothing to import."}
          </p>
          {preview.warnings.length > 0 && (
            <ul className="list-inside list-disc text-xs text-status-warning">
              {preview.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={doImport}
            disabled={busy || !preview.changed}
            className="rounded-lg bg-accent-mint px-4 py-2 text-sm font-semibold text-background-primary transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Importing…" : "Merge into vault"}
          </button>
        </Section>
      )}

      {report && (
        <p className="text-xs text-status-success">
          Merged: {report.created} new, {report.updated} updated. Remember to <strong>Save</strong>.
        </p>
      )}
      {error && <p className="text-xs text-status-error">{error}</p>}
    </div>
  );
}

// ── Export ─────────────────────────────────────────────────────────────────────

function ExportTab() {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function exportText(format: "csv" | "json" | "xml") {
    setStatus(null);
    setError(null);
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
    <div className="space-y-5">
      <Section title="Plaintext export">
        <p className="text-xs text-status-warning">
          ⚠ CSV, JSON, and XML exports are <strong>unencrypted</strong> and contain
          every password in plain text. Store securely and delete when done.
        </p>
        <div className="flex flex-wrap gap-2">
          <OutlineButton onClick={() => exportText("csv")}>Export CSV</OutlineButton>
          <OutlineButton onClick={() => exportText("json")}>Export JSON</OutlineButton>
          <OutlineButton onClick={() => exportText("xml")}>Export XML</OutlineButton>
        </div>
      </Section>

      <div className="-mx-5 border-t border-border-sage" />

      <KdbxExport onStatus={setStatus} onError={setError} />

      {status && <p className="text-xs text-status-success">{status}</p>}
      {error && <p className="text-xs text-status-error">{error}</p>}
    </div>
  );
}

function KdbxExport({
  onStatus,
  onError,
}: {
  onStatus: (s: string) => void;
  onError: (s: string) => void;
}) {
  const defaults = useSettingsStore((s) => s.settings.defaultCreateOptions);
  const [options, setOptions] = useState<CreateOptions>(() => defaults ?? DEFAULT_CREATE_OPTIONS);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  async function doExport() {
    if (!password) {
      onError("Set a master password for the exported database.");
      return;
    }
    if (password !== confirm) {
      onError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const path = await saveKdbxDialog();
      if (!path) return;
      await exportKdbx(path, options, password, null);
      onStatus(`Encrypted copy exported to ${path}`);
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Encrypted KeePass copy (.kdbx)">
      <p className="text-xs text-text-muted">
        Export an encrypted copy with its own password and encryption settings —
        e.g. a stronger KDF, or a separate password to share a vault.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <LabeledSelect
          label="Key derivation"
          value={options.kdf}
          onChange={(v) => setOptions((o) => ({ ...o, kdf: v as CreateOptions["kdf"] }))}
          options={[
            ["argon2id", "Argon2id"],
            ["argon2d", "Argon2d"],
            ["aes", "AES-KDF"],
          ]}
        />
        <LabeledSelect
          label="Cipher"
          value={options.cipher}
          onChange={(v) => setOptions((o) => ({ ...o, cipher: v as CreateOptions["cipher"] }))}
          options={[
            ["aes256", "AES-256"],
            ["chacha20", "ChaCha20"],
            ["twofish", "Twofish"],
          ]}
        />
      </div>
      {(options.kdf === "aes" || options.cipher === "twofish") && (
        <p className="text-[11px] text-status-warning">
          ⚠ AES-KDF and Twofish can't be opened by VaultPeer mobile or other
          KeePass apps. Use Argon2d (or Argon2id) with AES-256 or ChaCha20 for a
          portable copy.
        </p>
      )}
      <PasswordField value={password} onChange={setPassword} placeholder="New master password" />
      <PasswordField value={confirm} onChange={setConfirm} placeholder="Confirm password" />
      <button
        type="button"
        onClick={doExport}
        disabled={busy}
        className="rounded-lg bg-accent-mint px-4 py-2 text-sm font-semibold text-background-primary transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Exporting…" : "Export encrypted .kdbx"}
      </button>
    </Section>
  );
}

// ── Shared primitives ────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">{title}</h3>
      {children}
    </section>
  );
}

function SourceCard({
  active,
  title,
  hint,
  onClick,
}: {
  active: boolean;
  title: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border p-3 text-left transition-colors ${
        active
          ? "border-accent-mint bg-accent-mint-dim"
          : "border-border-sage hover:border-accent-mint/40"
      }`}
    >
      <div className="text-sm font-medium text-text-primary">{title}</div>
      <div className="mt-0.5 text-xs text-text-muted">{hint}</div>
    </button>
  );
}

function PickButton({
  path,
  placeholder,
  onClick,
}: {
  path: string | null;
  placeholder: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={path ?? undefined}
      className="w-full truncate rounded-lg border border-dashed border-border-sage px-3 py-2.5 text-left text-xs transition-colors hover:border-accent-mint/50"
    >
      {path ? (
        <span className="text-text-secondary">{path}</span>
      ) : (
        <span className="text-text-muted">{placeholder}</span>
      )}
    </button>
  );
}

function OutlineButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border border-border-sage bg-surface-elevated px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:border-accent-mint/40"
    >
      {children}
    </button>
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
        className="w-full rounded-lg border border-border-sage bg-background-primary px-2.5 py-2 text-sm text-text-primary outline-none focus:border-accent-mint"
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
