import { useCallback, useEffect, useRef, useState } from "react";
import { generateTotp, type TotpCode } from "@/services/tauri";
import { formatOtpCode } from "@/lib/otp";
import { copyToClipboard } from "@/lib/clipboard";

interface Props {
  /** The entry's stored OTP value (`otpauth://` URI or bare base32 secret). */
  otp: string;
}

/**
 * One-time-password display card (PLAN Phase 5 / OTP-04, OTP-05). Shows the
 * current TOTP code with a live countdown ring and a copy button; the code is
 * regenerated natively in Rust each time the period rolls over.
 */
export function OtpCard({ otp }: Props) {
  const [data, setData] = useState<TotpCode | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Keep the latest period handy for the ticking interval without re-subscribing.
  const periodRef = useRef(30);

  const refresh = useCallback(() => {
    generateTotp(otp)
      .then((c) => {
        setData(c);
        setRemaining(c.remaining);
        periodRef.current = c.period;
        setError(null);
      })
      .catch((e) => {
        setData(null);
        setError(String(e));
      });
  }, [otp]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Count down once a second; re-fetch a fresh code when the window expires.
  useEffect(() => {
    const id = window.setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          refresh();
          return periodRef.current;
        }
        return r - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [refresh]);

  async function handleCopy() {
    if (data && (await copyToClipboard(data.code))) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }
  }

  const period = data?.period ?? periodRef.current;
  const fraction = period > 0 ? remaining / period : 0;
  // Stroke turns amber in the final few seconds as a refresh cue.
  const ringColor = remaining <= 5 ? "var(--color-status-warning)" : "var(--color-accent-mint)";

  return (
    <div className="mb-3 rounded-lg border border-border-sage bg-background-primary px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="12" cy="13" r="8" stroke="currentColor" strokeWidth="1.8" />
            <path d="M12 9v4l2.5 1.5M9 2h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          One-Time Password
        </span>
        {data && (
          <button
            type="button"
            aria-label="Copy code"
            title="Copy code"
            onClick={handleCopy}
            className={`grid h-6 w-6 place-items-center rounded-md transition-colors ${
              copied
                ? "text-status-success"
                : "text-text-muted hover:bg-accent-mint-dim hover:text-text-primary"
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
              <path d="M5 15V5a2 2 0 0 1 2-2h8" stroke="currentColor" strokeWidth="1.8" />
            </svg>
          </button>
        )}
      </div>

      {error ? (
        <p className="text-xs text-status-error">Invalid OTP secret</p>
      ) : data ? (
        <div className="flex items-center gap-3">
          <span className="font-mono text-xl font-semibold tracking-wider text-accent-mint">
            {formatOtpCode(data.code)}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <span className="font-mono text-xs text-text-muted">{remaining}s</span>
            <svg width="22" height="22" viewBox="0 0 24 24" className="-rotate-90" aria-hidden>
              <circle cx="12" cy="12" r="9" fill="none" stroke="var(--color-border-sage)" strokeWidth="3" />
              <circle
                cx="12"
                cy="12"
                r="9"
                fill="none"
                stroke={ringColor}
                strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray={2 * Math.PI * 9}
                strokeDashoffset={2 * Math.PI * 9 * (1 - fraction)}
                style={{ transition: "stroke-dashoffset 1s linear, stroke 0.3s" }}
              />
            </svg>
          </div>
        </div>
      ) : (
        <p className="text-xs text-text-muted">…</p>
      )}
    </div>
  );
}
