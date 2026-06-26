import { describe, it, expect } from "vitest";
import {
  generatePassword,
  passwordEntropyBits,
  entropyStrength,
  generatePassphrase,
  buildCharset,
  type GeneratorOptions,
  type PassphraseOptions,
} from "./passwordGenerator";

function opts(overrides: Partial<GeneratorOptions> = {}): GeneratorOptions {
  return { length: 20, uppercase: true, lowercase: true, digits: true, symbols: true, excludeAmbiguous: false, ...overrides };
}

describe("generatePassword", () => {
  it("respects length option", () => {
    const pw = generatePassword(opts({ length: 20 }));
    expect(pw).toHaveLength(20);
  });

  it("includes only lowercase when only lowercase is selected", () => {
    const pw = generatePassword(opts({ length: 50, uppercase: false, digits: false, symbols: false }));
    expect(pw).toMatch(/^[a-z]+$/);
  });

  it("includes only digits when only digits is selected", () => {
    const pw = generatePassword(opts({ length: 50, uppercase: false, lowercase: false, digits: true, symbols: false }));
    expect(pw).toMatch(/^[0-9]+$/);
  });

  it("excludes ambiguous characters when enabled", () => {
    for (let i = 0; i < 10; i++) {
      const pw = generatePassword(opts({ length: 200, excludeAmbiguous: true, symbols: false }));
      expect(pw).not.toMatch(/[O0Ill1]/);
    }
  });

  it("returns empty when no charset selected", () => {
    expect(generatePassword(opts({ uppercase: false, lowercase: false, digits: false, symbols: false }))).toBe("");
  });

  it("generates different passwords each call", () => {
    const set = new Set(Array.from({ length: 20 }, () => generatePassword(opts())));
    expect(set.size).toBeGreaterThan(1);
  });
});

describe("buildCharset", () => {
  it("builds a pool from selected character sets", () => {
    const pool = buildCharset(opts({ symbols: false }));
    expect(pool).toContain("A");
    expect(pool).toContain("a");
    expect(pool).toContain("0");
    expect(pool).not.toContain("!");
  });
});

describe("passwordEntropyBits", () => {
  it("returns 0 for empty charset", () => {
    expect(passwordEntropyBits(opts({ uppercase: false, lowercase: false, digits: false, symbols: false }))).toBe(0);
  });

  it("returns higher entropy for longer passwords", () => {
    const short = passwordEntropyBits(opts({ length: 4 }));
    const long = passwordEntropyBits(opts({ length: 20 }));
    expect(long).toBeGreaterThan(short);
  });

  it("returns higher entropy for larger charset", () => {
    const small = passwordEntropyBits(opts({ uppercase: false, digits: false, symbols: false }));
    const big = passwordEntropyBits(opts());
    expect(big).toBeGreaterThan(small);
  });
});

describe("entropyStrength", () => {
  it("rates 0 bits as Empty", () => {
    expect(entropyStrength(0).label).toBe("Empty");
  });

  it("rates low entropy as Very weak", () => {
    expect(entropyStrength(20).score).toBe(1);
  });

  it("rates high entropy as Strong or Very strong", () => {
    const s = entropyStrength(100);
    expect(s.score).toBe(4);
  });
});

describe("generatePassphrase", () => {
  const ppOpts = (overrides: Partial<PassphraseOptions> = {}): PassphraseOptions => ({
    words: 5, separator: "-", capitalize: true, includeNumber: false, ...overrides,
  });

  it("generates specified number of words", () => {
    const phrase = generatePassphrase(ppOpts({ words: 5 }));
    const words = phrase.split("-");
    expect(words).toHaveLength(5);
  });

  it("capitalizes words when option is set", () => {
    const phrase = generatePassphrase(ppOpts({ capitalize: true }));
    const words = phrase.split("-");
    for (const w of words) {
      expect(w[0]).toBe(w[0].toUpperCase());
    }
  });

  it("includes a number when requested", () => {
    const phrase = generatePassphrase(ppOpts({ includeNumber: true }));
    const parts = phrase.split("-");
    const last = parts[parts.length - 1];
    expect(Number(last)).toBeGreaterThanOrEqual(10);
    expect(Number(last)).toBeLessThan(100);
  });

  it("produces different passphrases each time", () => {
    const set = new Set(Array.from({ length: 10 }, () => generatePassphrase(ppOpts())));
    expect(set.size).toBeGreaterThan(1);
  });
});
