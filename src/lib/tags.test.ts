import { describe, it, expect } from "vitest";
import { tagColor } from "./tags";

describe("tagColor", () => {
  it("returns consistent colors for the same tag", () => {
    const a = tagColor("work");
    const b = tagColor("work");
    expect(a).toEqual(b);
  });

  it("returns different colors for different tags", () => {
    const a = tagColor("work");
    const b = tagColor("personal");
    expect(a.fg).not.toBe(b.fg);
  });

  it("is case-insensitive", () => {
    const a = tagColor("Work");
    const b = tagColor("work");
    expect(a).toEqual(b);
  });

  it("returns valid CSS color strings", () => {
    const c = tagColor("test");
    expect(c.fg).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(c.bg).toMatch(/^(#|rgba?\()/);
  });
});
