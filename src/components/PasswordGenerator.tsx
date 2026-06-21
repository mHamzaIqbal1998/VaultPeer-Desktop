import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  DEFAULT_GENERATOR_OPTIONS,
  DEFAULT_PASSPHRASE_OPTIONS,
  MAX_LENGTH,
  MAX_WORDS,
  MIN_LENGTH,
  MIN_WORDS,
  entropyStrength,
  generatePassphrase,
  generatePassword,
  passphraseEntropyBits,
  passwordEntropyBits,
  type GeneratorOptions,
  type PassphraseOptions,
} from "@/lib/passwordGenerator";
import { copyToClipboard } from "@/lib/clipboard";
import { useGeneratorStore } from "@/stores/generatorStore";

interface Props {
  onClose: () => void;
}

type Mode = "password" | "passphrase";

const SEPARATORS: { value: string; label: string }[] = [
  { value: "-", label: "Dash" },
  { value: ".", label: "Dot" },
  { value: "_", label: "Underscore" },
  { value: " ", label: "Space" },
];

/**
 * Standalone password / passphrase generator tool (PLAN Phase 5). Offers both a
 * character-set password mode and a Diceware-style passphrase mode, an entropy
 * readout, copy-to-clipboard, and a session-only history of generated values.
 */
export function PasswordGenerator({ onClose }: Props) {
  const [mode, setMode] = useState<Mode>("password");
  const [pwOpts, setPwOpts] = useState<GeneratorOptions>(DEFAULT_GENERATOR_OPTIONS);
  const [ppOpts, setPpOpts] = useState<PassphraseOptions>(DEFAULT_PASSPHRASE_OPTIONS);
  const [value, setValue] = useState("");
  const [copied, setCopied] = useState(false);

  const history = useGeneratorStore((s) => s.history);
  const remember = useGeneratorStore((s) => s.remember);
  const clearHistory = useGeneratorStore((s) => s.clear);

  const bits =
    mode === "password"
      ? passwordEntropyBits(pwOpts)
      : passphraseEntropyBits(ppOpts);
  const { score, label } = entropyStrength(bits);

  const regenerate = useCallback(() => {
    const next =
      mode === "password" ? generatePassword(pwOpts) : generatePassphrase(ppOpts);
    setValue(next);
    setCopied(false);
    if (next) remember(next);
  }, [mode, pwOpts, ppOpts, remember]);

  // Regenerate whenever the mode or any option changes.
  useEffect(() => {
    regenerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pwOpts, ppOpts]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleCopy(text: string) {
    if (text && (await copyToClipboard(text))) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }
  }

  const meterColor =
    score <= 1
      ? "var(--color-status-error)"
      : score === 2
        ? "var(--color-status-warning)"
        : score === 3
          ? "var(--color-accent-mint)"
          : "var(--color-status-success)";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border-sage bg-surface-card shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-border-sage px-5 py-4">
          <h2 className="text-base font-semibold text-text-primary">Password Generator</h2>
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

        <div className="space-y-4 overflow-auto px-5 py-4">
          {/* Mode tabs */}
          <div className="grid grid-cols-2 gap-1 rounded-lg border border-border-sage p-1">
            {(["password", "passphrase"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded-md py-1.5 text-xs font-medium capitalize transition-colors ${
                  mode === m
                    ? "bg-accent-mint text-background-primary"
                    : "text-text-muted hover:text-text-secondary"
                }`}
              >
                {m}
              </button>
            ))}
          </div>

          {/* Output */}
          <div className="rounded-xl border border-border-sage bg-background-primary p-3">
            <div className="flex items-start gap-2">
              <p className="min-h-[2.5rem] flex-1 break-all font-mono text-sm text-text-primary">
                {value || <span className="text-text-muted">…</span>}
              </p>
              <div className="flex shrink-0 gap-1">
                <ToolButton label="Regenerate" onClick={regenerate}>
                  <path
                    d="M4 12a8 8 0 0 1 14-5m2-2v4h-4M20 12a8 8 0 0 1-14 5m-2 2v-4h4"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </ToolButton>
                <ToolButton
                  label="Copy"
                  flashed={copied}
                  onClick={() => handleCopy(value)}
                >
                  <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M5 15V5a2 2 0 0 1 2-2h8" stroke="currentColor" strokeWidth="1.8" />
                </ToolButton>
              </div>
            </div>

            {/* Entropy meter */}
            <div className="mt-3">
              <div className="flex gap-1.5" aria-hidden>
                {[1, 2, 3, 4].map((seg) => (
                  <div
                    key={seg}
                    className="h-1.5 flex-1 rounded-full transition-colors"
                    style={{
                      backgroundColor: seg <= score ? meterColor : "var(--color-border-sage)",
                    }}
                  />
                ))}
              </div>
              <div className="mt-1.5 flex items-center justify-between text-xs">
                <span style={{ color: meterColor }} className="font-medium">
                  {label}
                </span>
                <span className="text-text-muted">~{Math.round(bits)} bits</span>
              </div>
            </div>
          </div>

          {/* Mode-specific options */}
          {mode === "password" ? (
            <PasswordOptions opts={pwOpts} onChange={setPwOpts} />
          ) : (
            <PassphraseOptionsPanel opts={ppOpts} onChange={setPpOpts} />
          )}

          {/* History */}
          {history.length > 0 && (
            <div className="border-t border-border-sage pt-3">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-medium text-text-muted">
                  Recent (this session)
                </span>
                <button
                  type="button"
                  onClick={clearHistory}
                  className="text-xs text-text-muted transition-colors hover:text-status-error"
                >
                  Clear
                </button>
              </div>
              <div className="space-y-1">
                {history.slice(0, 8).map((h, i) => (
                  <button
                    key={`${i}-${h}`}
                    type="button"
                    onClick={() => handleCopy(h)}
                    title="Copy"
                    className="flex w-full items-center gap-2 rounded-md border border-border-sage bg-background-primary px-2.5 py-1.5 text-left transition-colors hover:border-accent-mint/40"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary">
                      {h}
                    </span>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" className="shrink-0 text-text-muted" aria-hidden>
                      <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
                      <path d="M5 15V5a2 2 0 0 1 2-2h8" stroke="currentColor" strokeWidth="1.8" />
                    </svg>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}

function PasswordOptions({
  opts,
  onChange,
}: {
  opts: GeneratorOptions;
  onChange: (o: GeneratorOptions) => void;
}) {
  const toggles: [keyof GeneratorOptions, string][] = [
    ["uppercase", "A–Z"],
    ["lowercase", "a–z"],
    ["digits", "0–9"],
    ["symbols", "!@#"],
  ];
  // Don't let the user disable the last remaining character class.
  const enabledCount = toggles.filter(([k]) => opts[k]).length;

  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1.5 flex items-center justify-between text-xs">
          <span className="font-medium text-text-muted">Length</span>
          <span className="font-mono text-text-primary">{opts.length}</span>
        </div>
        <input
          type="range"
          min={MIN_LENGTH}
          max={MAX_LENGTH}
          value={opts.length}
          onChange={(e) => onChange({ ...opts, length: Number(e.target.value) })}
          className="w-full accent-[var(--color-accent-mint)]"
        />
      </div>

      <div className="grid grid-cols-4 gap-2">
        {toggles.map(([key, txt]) => {
          const active = opts[key] as boolean;
          const lockedOff = active && enabledCount === 1;
          return (
            <button
              key={key}
              type="button"
              disabled={lockedOff}
              onClick={() => onChange({ ...opts, [key]: !active })}
              className={`rounded-md border px-2 py-1.5 text-xs font-medium transition-colors disabled:cursor-default ${
                active
                  ? "border-accent-mint bg-accent-mint-dim text-text-primary"
                  : "border-border-sage text-text-muted hover:text-text-secondary"
              }`}
            >
              {txt}
            </button>
          );
        })}
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-xs text-text-secondary">
        <input
          type="checkbox"
          checked={opts.excludeAmbiguous}
          onChange={(e) => onChange({ ...opts, excludeAmbiguous: e.target.checked })}
          className="accent-[var(--color-accent-mint)]"
        />
        Exclude ambiguous characters
      </label>
    </div>
  );
}

function PassphraseOptionsPanel({
  opts,
  onChange,
}: {
  opts: PassphraseOptions;
  onChange: (o: PassphraseOptions) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1.5 flex items-center justify-between text-xs">
          <span className="font-medium text-text-muted">Words</span>
          <span className="font-mono text-text-primary">{opts.words}</span>
        </div>
        <input
          type="range"
          min={MIN_WORDS}
          max={MAX_WORDS}
          value={opts.words}
          onChange={(e) => onChange({ ...opts, words: Number(e.target.value) })}
          className="w-full accent-[var(--color-accent-mint)]"
        />
      </div>

      <div>
        <span className="mb-1.5 block text-xs font-medium text-text-muted">Separator</span>
        <div className="grid grid-cols-4 gap-2">
          {SEPARATORS.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => onChange({ ...opts, separator: s.value })}
              className={`rounded-md border px-2 py-1.5 text-xs font-medium transition-colors ${
                opts.separator === s.value
                  ? "border-accent-mint bg-accent-mint-dim text-text-primary"
                  : "border-border-sage text-text-muted hover:text-text-secondary"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-xs text-text-secondary">
        <input
          type="checkbox"
          checked={opts.capitalize}
          onChange={(e) => onChange({ ...opts, capitalize: e.target.checked })}
          className="accent-[var(--color-accent-mint)]"
        />
        Capitalize each word
      </label>
      <label className="flex cursor-pointer items-center gap-2 text-xs text-text-secondary">
        <input
          type="checkbox"
          checked={opts.includeNumber}
          onChange={(e) => onChange({ ...opts, includeNumber: e.target.checked })}
          className="accent-[var(--color-accent-mint)]"
        />
        Append a number
      </label>
    </div>
  );
}

function ToolButton({
  label,
  flashed,
  onClick,
  children,
}: {
  label: string;
  flashed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`grid h-8 w-8 place-items-center rounded-md transition-colors ${
        flashed
          ? "text-status-success"
          : "text-text-muted hover:bg-accent-mint-dim hover:text-text-primary"
      }`}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
        {children}
      </svg>
    </button>
  );
}
