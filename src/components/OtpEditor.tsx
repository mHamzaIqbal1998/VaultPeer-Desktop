import { useEffect, useState } from "react";
import {
  DEFAULT_OTP_CONFIG,
  OTP_ALGORITHMS,
  buildOtpUri,
  isValidBase32,
  parseOtp,
  type OtpAlgorithm,
  type OtpConfig,
} from "@/lib/otp";
import { generateTotp } from "@/services/tauri";
import { PasswordField } from "./PasswordField";
import { QrScanner } from "./QrScanner";

interface Props {
  /** Current stored OTP value (`otpauth://` URI or bare secret). */
  value: string;
  /** Called with the rebuilt canonical URI (or "" when the secret is cleared). */
  onChange: (otp: string) => void;
}

const DIGIT_CHOICES = [6, 7, 8];
const PERIOD_CHOICES = [30, 60];

/**
 * OTP setup section for the entry editor (PLAN Phase 5 / OTP-03, OTP-06). Takes
 * a base32 secret (or a pasted `otpauth://` URI) plus optional algorithm/digit/
 * period overrides and emits a canonical `otpauth://` URI. A live preview code
 * confirms the secret is valid before saving.
 */
export function OtpEditor({ value, onChange }: Props) {
  const [cfg, setCfg] = useState<OtpConfig>(() => parseOtp(value));
  const [showAdvanced, setShowAdvanced] = useState(
    () =>
      cfg.algorithm !== DEFAULT_OTP_CONFIG.algorithm ||
      cfg.digits !== DEFAULT_OTP_CONFIG.digits ||
      cfg.period !== DEFAULT_OTP_CONFIG.period,
  );
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [scanning, setScanning] = useState(false);

  const hasSecret = cfg.secret.trim().length > 0;
  const secretValid = !hasSecret || isValidBase32(cfg.secret);

  function update(patch: Partial<OtpConfig>) {
    const next = { ...cfg, ...patch };
    setCfg(next);
    onChange(buildOtpUri(next));
  }

  // If the user pastes a full otpauth:// URI into the secret box, expand it.
  function handleSecretInput(raw: string) {
    if (raw.trim().toLowerCase().startsWith("otpauth://")) {
      const parsed = parseOtp(raw.trim());
      setCfg(parsed);
      setShowAdvanced(
        parsed.algorithm !== DEFAULT_OTP_CONFIG.algorithm ||
          parsed.digits !== DEFAULT_OTP_CONFIG.digits ||
          parsed.period !== DEFAULT_OTP_CONFIG.period,
      );
      onChange(buildOtpUri(parsed));
    } else {
      update({ secret: raw });
    }
  }

  // Live preview of the current code (validates the secret end-to-end via Rust).
  useEffect(() => {
    const uri = buildOtpUri(cfg);
    if (!uri || !secretValid) {
      setPreview(null);
      setPreviewError(hasSecret && !secretValid);
      return;
    }
    let active = true;
    generateTotp(uri)
      .then((c) => {
        if (active) {
          setPreview(c.code);
          setPreviewError(false);
        }
      })
      .catch(() => {
        if (active) {
          setPreview(null);
          setPreviewError(true);
        }
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.secret, cfg.algorithm, cfg.digits, cfg.period]);

  return (
    <div className="space-y-2 rounded-lg border border-border-sage bg-background-primary/40 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-text-muted">Setup key</span>
        <button
          type="button"
          onClick={() => setScanning(true)}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-accent-mint transition-colors hover:bg-accent-mint-dim"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
            <rect x="3" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
            <path d="M14 14h3v3M21 14v7h-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Scan QR
        </button>
      </div>
      <PasswordField
        value={cfg.secret}
        onChange={handleSecretInput}
        placeholder="Base32 secret or otpauth:// URI"
      />

      {hasSecret && !secretValid && (
        <p className="text-xs text-status-error">Secret is not valid base32.</p>
      )}
      {hasSecret && secretValid && preview && (
        <p className="text-xs text-text-muted">
          Current code:{" "}
          <span className="font-mono text-accent-mint">{preview}</span>
        </p>
      )}
      {hasSecret && previewError && secretValid && (
        <p className="text-xs text-status-error">Couldn't generate a code from this secret.</p>
      )}

      <button
        type="button"
        onClick={() => setShowAdvanced((s) => !s)}
        className="flex items-center gap-1 text-xs text-text-muted transition-colors hover:text-text-secondary"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden
          className={`transition-transform ${showAdvanced ? "rotate-90" : ""}`}
        >
          <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Advanced settings
      </button>

      {showAdvanced && (
        <div className="grid grid-cols-3 gap-2 pt-1">
          <Select
            label="Algorithm"
            value={cfg.algorithm}
            options={OTP_ALGORITHMS.map((a) => ({ value: a, label: a }))}
            onChange={(v) => update({ algorithm: v as OtpAlgorithm })}
          />
          <Select
            label="Digits"
            value={String(cfg.digits)}
            options={DIGIT_CHOICES.map((d) => ({ value: String(d), label: String(d) }))}
            onChange={(v) => update({ digits: Number(v) })}
          />
          <Select
            label="Period"
            value={String(cfg.period)}
            options={PERIOD_CHOICES.map((p) => ({ value: String(p), label: `${p}s` }))}
            onChange={(v) => update({ period: Number(v) })}
          />
        </div>
      )}

      {scanning && (
        <QrScanner
          onScan={handleSecretInput}
          onClose={() => setScanning(false)}
        />
      )}
    </div>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-text-muted">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-border-sage bg-background-primary px-2 py-2 text-sm text-text-primary outline-none transition-colors focus:border-accent-mint"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
