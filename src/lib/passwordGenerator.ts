/**
 * Cryptographically-secure password generation (PLAN Phase 3 + Phase 5).
 *
 * Randomness comes from the Web Crypto API (`crypto.getRandomValues`) with
 * rejection sampling so every character is drawn from a uniform distribution —
 * no modulo bias. Phase 5 adds Diceware-style passphrases and entropy estimates
 * for both modes, used by the standalone generator tool.
 */

import { WORDLIST } from "./wordlist";

/** Smallest and largest password length the UI allows. */
export const MIN_LENGTH = 8;
export const MAX_LENGTH = 128;

export interface GeneratorOptions {
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  digits: boolean;
  symbols: boolean;
  /** Exclude visually ambiguous characters (O/0, l/1/I, etc.). */
  excludeAmbiguous: boolean;
}

export const DEFAULT_GENERATOR_OPTIONS: GeneratorOptions = {
  length: 20,
  uppercase: true,
  lowercase: true,
  digits: true,
  symbols: true,
  excludeAmbiguous: false,
};

const SETS = {
  uppercase: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  lowercase: "abcdefghijklmnopqrstuvwxyz",
  digits: "0123456789",
  symbols: "!@#$%^&*()-_=+[]{};:,.<>?/",
};

const AMBIGUOUS = new Set("O0oIl1|`'\".,;:".split(""));

/** Build the active character pool from the selected options. */
export function buildCharset(opts: GeneratorOptions): string {
  let pool = "";
  if (opts.uppercase) pool += SETS.uppercase;
  if (opts.lowercase) pool += SETS.lowercase;
  if (opts.digits) pool += SETS.digits;
  if (opts.symbols) pool += SETS.symbols;
  if (opts.excludeAmbiguous) {
    pool = pool
      .split("")
      .filter((c) => !AMBIGUOUS.has(c))
      .join("");
  }
  return pool;
}

/** Draw a uniformly-random integer in [0, max) using rejection sampling. */
export function randomIndex(max: number): number {
  // Largest multiple of `max` that fits in a byte; reject above it to stay uniform.
  const limit = Math.floor(256 / max) * max;
  const buf = new Uint8Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buf);
    value = buf[0];
  } while (value >= limit);
  return value % max;
}

/**
 * Generate a password of the requested length from the selected character
 * classes. Returns "" when no character class is enabled.
 */
export function generatePassword(opts: GeneratorOptions): string {
  const pool = buildCharset(opts);
  if (pool.length === 0 || opts.length <= 0) return "";

  let out = "";
  for (let i = 0; i < opts.length; i++) {
    out += pool[randomIndex(pool.length)];
  }
  return out;
}

/** Theoretical entropy (bits) of a random password over the selected charset. */
export function passwordEntropyBits(opts: GeneratorOptions): number {
  const pool = buildCharset(opts);
  if (pool.length === 0 || opts.length <= 0) return 0;
  return opts.length * Math.log2(pool.length);
}

// ── Passphrase mode (Diceware-style) ─────────────────────────────────────────

export interface PassphraseOptions {
  /** Number of words to chain together. */
  words: number;
  /** Delimiter placed between words (e.g. "-", " ", "."). */
  separator: string;
  /** Capitalize the first letter of each word. */
  capitalize: boolean;
  /** Append a random two-digit number as an extra word. */
  includeNumber: boolean;
}

export const DEFAULT_PASSPHRASE_OPTIONS: PassphraseOptions = {
  words: 5,
  separator: "-",
  capitalize: true,
  includeNumber: false,
};

export const MIN_WORDS = 3;
export const MAX_WORDS = 12;

/**
 * Generate a Diceware-style passphrase by drawing words uniformly from the
 * embedded wordlist (same Web Crypto randomness as the character generator).
 */
export function generatePassphrase(opts: PassphraseOptions): string {
  if (opts.words <= 0 || WORDLIST.length === 0) return "";

  const parts: string[] = [];
  for (let i = 0; i < opts.words; i++) {
    let word = WORDLIST[randomIndex(WORDLIST.length)];
    if (opts.capitalize) word = word[0].toUpperCase() + word.slice(1);
    parts.push(word);
  }
  if (opts.includeNumber) parts.push(String(randomIndex(90) + 10));

  return parts.join(opts.separator);
}

/** Theoretical entropy (bits) of a passphrase from the wordlist size. */
export function passphraseEntropyBits(opts: PassphraseOptions): number {
  if (WORDLIST.length === 0 || opts.words <= 0) return 0;
  let bits = opts.words * Math.log2(WORDLIST.length);
  if (opts.includeNumber) bits += Math.log2(90);
  return bits;
}

/** Map an entropy estimate to a 0–4 strength bucket + label, matching the meter. */
export function entropyStrength(bits: number): {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
} {
  if (bits <= 0) return { score: 0, label: "Empty" };
  if (bits < 40) return { score: 1, label: "Very weak" };
  if (bits < 60) return { score: 2, label: "Weak" };
  if (bits < 80) return { score: 3, label: "Fair" };
  if (bits < 110) return { score: 4, label: "Strong" };
  return { score: 4, label: "Very strong" };
}
