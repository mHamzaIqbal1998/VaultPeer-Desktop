import { describe, it, expect } from "vitest";
import { matchesAccelerator, parseAccelerator } from "./shortcuts";

describe("parseAccelerator", () => {
  it("parses Ctrl+K", () => {
    const a = parseAccelerator("Ctrl+K");
    expect(a).toEqual({ ctrl: true, shift: false, alt: false, key: "k" });
  });

  it("parses Ctrl+Shift+A", () => {
    const a = parseAccelerator("Ctrl+Shift+A");
    expect(a).toEqual({ ctrl: true, shift: true, alt: false, key: "a" });
  });

  it("parses Ctrl+Alt+A", () => {
    const a = parseAccelerator("Ctrl+Alt+A");
    expect(a).toEqual({ ctrl: true, shift: false, alt: true, key: "a" });
  });

  it("parses simple key", () => {
    const a = parseAccelerator("F1");
    expect(a).toEqual({ ctrl: false, shift: false, alt: false, key: "f1" });
  });
});

describe("matchesAccelerator", () => {
  function makeEvent(key: string, opts: Partial<KeyboardEvent> = {}): KeyboardEvent {
    return {
      key,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ...opts,
    } as KeyboardEvent;
  }

  it("matches Ctrl+K", () => {
    expect(matchesAccelerator(makeEvent("k", { ctrlKey: true }), "Ctrl+K")).toBe(true);
  });

  it("rejects when extra modifier present", () => {
    expect(matchesAccelerator(makeEvent("k", { ctrlKey: true, shiftKey: true }), "Ctrl+K")).toBe(false);
  });

  it("rejects wrong key", () => {
    expect(matchesAccelerator(makeEvent("j", { ctrlKey: true }), "Ctrl+K")).toBe(false);
  });

  it("matches Ctrl+Shift+A", () => {
    expect(matchesAccelerator(makeEvent("A", { ctrlKey: true, shiftKey: true }), "Ctrl+Shift+A")).toBe(true);
  });
});
