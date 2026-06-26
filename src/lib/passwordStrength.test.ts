import { describe, it, expect } from "vitest";
import { estimatePasswordStrength } from "./passwordStrength";

describe("estimatePasswordStrength", () => {
  it("returns Empty for empty string", () => {
    const s = estimatePasswordStrength("");
    expect(s.score).toBe(0);
    expect(s.label).toBe("Empty");
    expect(s.bits).toBe(0);
  });

  it("rates short lowercase-only as Very weak", () => {
    const s = estimatePasswordStrength("abc");
    expect(s.score).toBeLessThanOrEqual(1);
  });

  it("rates longer mixed passwords higher", () => {
    const short = estimatePasswordStrength("abc");
    const long = estimatePasswordStrength("aB1!cD2@eF3#");
    expect(long.bits).toBeGreaterThan(short.bits);
    expect(long.score).toBeGreaterThan(short.score);
  });

  it("penalizes repeated characters", () => {
    const varied = estimatePasswordStrength("abcdefghij");
    const repeated = estimatePasswordStrength("aaaaaaaaaa");
    expect(varied.bits).toBeGreaterThan(repeated.bits);
  });

  it("penalizes sequential runs", () => {
    const random = estimatePasswordStrength("qwxzplmn");
    const sequential = estimatePasswordStrength("abcdefgh");
    expect(random.bits).toBeGreaterThan(sequential.bits);
  });

  it("rates very strong passwords correctly", () => {
    const s = estimatePasswordStrength("aB3!xZ9@kL7#mN5$pQ1%");
    expect(s.score).toBe(4);
    expect(s.label).toMatch(/strong/i);
  });

  it("considers special characters for higher charset", () => {
    const noSpecial = estimatePasswordStrength("abcdefghijABCD");
    const withSpecial = estimatePasswordStrength("abcdefg!@#$ABD");
    expect(withSpecial.bits).toBeGreaterThan(noSpecial.bits);
  });
});
