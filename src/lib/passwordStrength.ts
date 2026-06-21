/**
 * Lightweight password strength estimation (PRD UN-01).
 *
 * A dependency-free entropy estimate: charset size from the character classes
 * present, times length, with penalties for the cheap-to-guess patterns
 * (repeats, sequences, tiny alphabets). It is intentionally conservative — a
 * heuristic to nudge users, not a substitute for zxcvbn-grade analysis.
 */

export interface PasswordStrength {
  /** 0–4 bucket, matching the common "very weak → very strong" scale. */
  score: 0 | 1 | 2 | 3 | 4;
  /** Estimated entropy in bits. */
  bits: number;
  label: "Empty" | "Very weak" | "Weak" | "Fair" | "Strong" | "Very strong";
}

function charsetSize(pw: string): number {
  let size = 0;
  if (/[a-z]/.test(pw)) size += 26;
  if (/[A-Z]/.test(pw)) size += 26;
  if (/[0-9]/.test(pw)) size += 10;
  // Common ASCII symbols.
  if (/[^a-zA-Z0-9]/.test(pw)) size += 33;
  return size;
}

/** Fraction (0–1) of characters that are part of a run of 3+ identical chars. */
function repeatPenaltyFactor(pw: string): number {
  let repeated = 0;
  for (let i = 2; i < pw.length; i++) {
    if (pw[i] === pw[i - 1] && pw[i] === pw[i - 2]) repeated++;
  }
  return pw.length > 0 ? repeated / pw.length : 0;
}

/** Detects simple ascending/descending sequences like "abcd" or "4321". */
function hasSequentialRun(pw: string): boolean {
  const lower = pw.toLowerCase();
  for (let i = 0; i + 4 <= lower.length; i++) {
    const slice = lower.slice(i, i + 4);
    let asc = true;
    let desc = true;
    for (let j = 1; j < slice.length; j++) {
      const d = slice.charCodeAt(j) - slice.charCodeAt(j - 1);
      if (d !== 1) asc = false;
      if (d !== -1) desc = false;
    }
    if (asc || desc) return true;
  }
  return false;
}

export function estimatePasswordStrength(pw: string): PasswordStrength {
  if (pw.length === 0) return { score: 0, bits: 0, label: "Empty" };

  const size = charsetSize(pw);
  let bits = pw.length * Math.log2(Math.max(size, 1));

  // Penalize cheap patterns.
  bits *= 1 - 0.5 * repeatPenaltyFactor(pw);
  if (hasSequentialRun(pw)) bits *= 0.85;

  bits = Math.max(0, Math.round(bits));

  let score: PasswordStrength["score"];
  let label: PasswordStrength["label"];
  if (bits < 28) {
    score = 1;
    label = "Very weak";
  } else if (bits < 50) {
    score = 2;
    label = "Weak";
  } else if (bits < 70) {
    score = 3;
    label = "Fair";
  } else if (bits < 100) {
    score = 4;
    label = "Strong";
  } else {
    score = 4;
    label = "Very strong";
  }

  return { score, bits, label };
}
