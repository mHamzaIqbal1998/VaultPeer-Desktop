/**
 * OTP helpers for the entry editor (PLAN Phase 5). The frontend lets the user
 * enter a TOTP secret (or paste an `otpauth://` URI) and tune the algorithm,
 * digit count, and period; code generation itself happens natively in Rust.
 *
 * Entries store the OTP as a canonical `otpauth://totp/…` URI in the standard
 * KeePass `otp` field (the KeePassXC convention), keeping files compatible with
 * other clients.
 */

export type OtpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export const OTP_ALGORITHMS: OtpAlgorithm[] = ["SHA1", "SHA256", "SHA512"];

/** Editable OTP settings parsed from / serialized to an entry's `otp` value. */
export interface OtpConfig {
  /** Base32 secret, as typed (may include spaces/hyphens; normalized on save). */
  secret: string;
  algorithm: OtpAlgorithm;
  digits: number;
  period: number;
  issuer?: string;
  account?: string;
}

export const DEFAULT_OTP_CONFIG: OtpConfig = {
  secret: "",
  algorithm: "SHA1",
  digits: 6,
  period: 30,
};

const BASE32 = /^[A-Z2-7]+$/;

/** Strip spaces/hyphens and uppercase, the form expected by a TOTP secret. */
export function normalizeSecret(secret: string): string {
  return secret.replace(/[\s-]/g, "").toUpperCase();
}

/** True if `secret` is a syntactically valid base32 string (ignoring spacing). */
export function isValidBase32(secret: string): boolean {
  const cleaned = normalizeSecret(secret).replace(/=+$/, "");
  return cleaned.length > 0 && BASE32.test(cleaned);
}

/** Clamp a digit count to the supported 6–8 range. */
function clampDigits(d: number): number {
  if (!Number.isFinite(d) || d <= 6) return 6;
  if (d >= 8) return 8;
  return Math.round(d);
}

/** Parse a stored OTP value (`otpauth://` URI or bare secret) into editable config. */
export function parseOtp(value: string): OtpConfig {
  const v = value.trim();
  if (!v) return { ...DEFAULT_OTP_CONFIG };
  if (!v.toLowerCase().startsWith("otpauth://")) {
    return { ...DEFAULT_OTP_CONFIG, secret: v };
  }
  try {
    const url = new URL(v);
    const params = url.searchParams;
    const algorithm = (params.get("algorithm") ?? "SHA1").toUpperCase();
    const period = Number(params.get("period"));
    const label = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    const account = label.includes(":") ? label.slice(label.indexOf(":") + 1) : label;
    return {
      secret: params.get("secret") ?? "",
      algorithm: (OTP_ALGORITHMS as string[]).includes(algorithm)
        ? (algorithm as OtpAlgorithm)
        : "SHA1",
      digits: clampDigits(Number(params.get("digits"))),
      period: period > 0 ? period : 30,
      issuer: params.get("issuer") ?? undefined,
      account: account || undefined,
    };
  } catch {
    // Not a parseable URI — treat the whole thing as a bare secret.
    return { ...DEFAULT_OTP_CONFIG, secret: v };
  }
}

/**
 * Build a canonical `otpauth://totp/…` URI from editable config, or "" when no
 * secret is set. The secret is normalized (uppercased, spacing removed).
 */
export function buildOtpUri(cfg: OtpConfig): string {
  const secret = normalizeSecret(cfg.secret);
  if (!secret) return "";

  const account = cfg.account?.trim() || "VaultPeer";
  const label = cfg.issuer?.trim() ? `${cfg.issuer.trim()}:${account}` : account;

  const params = new URLSearchParams();
  params.set("secret", secret);
  if (cfg.issuer?.trim()) params.set("issuer", cfg.issuer.trim());
  params.set("algorithm", cfg.algorithm);
  params.set("digits", String(clampDigits(cfg.digits)));
  params.set("period", String(cfg.period > 0 ? cfg.period : 30));

  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

/** Format a numeric code with a mid-point space for readability (e.g. "123 456"). */
export function formatOtpCode(code: string): string {
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
  if (code.length === 7) return `${code.slice(0, 4)} ${code.slice(4)}`;
  return code;
}
