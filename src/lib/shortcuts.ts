/**
 * Keyboard-shortcut helpers (PLAN Phase 7 / SET-11).
 *
 * Shortcuts are stored as human-readable accelerator strings like `"Ctrl+K"` or
 * `"Ctrl+,"`. These helpers parse a binding, test it against a `KeyboardEvent`,
 * and capture a binding from a keypress (for the customization UI). `Ctrl`
 * matches either Control or Command, mirroring the app's existing handlers.
 */

export interface ParsedAccelerator {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** The non-modifier key, lower-cased (e.g. "k", ",", "enter"). */
  key: string;
}

/** Parse an accelerator string into its modifier flags and key. */
export function parseAccelerator(accel: string): ParsedAccelerator {
  const parts = accel.split("+").map((p) => p.trim());
  const result: ParsedAccelerator = { ctrl: false, alt: false, shift: false, key: "" };
  for (const part of parts) {
    const low = part.toLowerCase();
    if (low === "ctrl" || low === "control" || low === "cmd" || low === "meta") {
      result.ctrl = true;
    } else if (low === "alt" || low === "option") {
      result.alt = true;
    } else if (low === "shift") {
      result.shift = true;
    } else if (part) {
      result.key = low;
    }
  }
  return result;
}

/** True when `event` exactly matches the given accelerator binding. */
export function matchesAccelerator(event: KeyboardEvent, accel: string): boolean {
  if (!accel) return false;
  const a = parseAccelerator(accel);
  const ctrl = event.ctrlKey || event.metaKey;
  if (ctrl !== a.ctrl) return false;
  if (event.altKey !== a.alt) return false;
  if (event.shiftKey !== a.shift) return false;
  return event.key.toLowerCase() === a.key;
}

/**
 * Build an accelerator string from a keydown event, or null if only modifier
 * keys are held (so the capture UI waits for a real key). Used when the user
 * records a new binding.
 */
export function captureAccelerator(event: KeyboardEvent): string | null {
  const key = event.key;
  const lower = key.toLowerCase();
  // Ignore bare modifier presses.
  if (["control", "alt", "shift", "meta", "os"].includes(lower)) return null;

  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");

  // Display single characters upper-cased; name a few common keys.
  let label: string;
  if (key === " ") label = "Space";
  else if (key.length === 1) label = key.toUpperCase();
  else label = key; // e.g. "Enter", "ArrowUp", ","-handled above as length 1
  parts.push(label);
  return parts.join("+");
}
