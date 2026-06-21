/**
 * Cryptographically-secure password generation (PLAN Phase 3: generator
 * integration in the entry form; the full standalone tool lands in Phase 5).
 *
 * Randomness comes from the Web Crypto API (`crypto.getRandomValues`) with
 * rejection sampling so every character is drawn from a uniform distribution —
 * no modulo bias.
 */

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
function randomIndex(max: number): number {
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
