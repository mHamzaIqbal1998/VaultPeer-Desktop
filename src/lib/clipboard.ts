import { copyClipboardProtected } from "@/services/tauri";
import { useClipboardStore } from "@/stores/clipboardStore";

/**
 * Secure clipboard helper (PLAN Phase 6 / CLP-01, CLP-02).
 *
 * Copies text to the clipboard and schedules an automatic clear after a
 * timeout, so a copied password doesn't linger indefinitely. A single pending
 * clear is tracked at module scope; each new copy supersedes the previous one.
 * The `clipboardStore` mirror lets the title bar surface a live countdown.
 */

/** Default seconds before the clipboard auto-clears (configurable in Phase 7). */
export const DEFAULT_CLIPBOARD_CLEAR_SECONDS = 30;

let clearTimer: ReturnType<typeof setTimeout> | null = null;
/** The value we last wrote, so auto-clear only wipes our own secret. */
let lastWritten: string | null = null;

/**
 * Write to the clipboard, preferring the Rust "protected" copy that excludes
 * the value from Windows clipboard history / cloud sync (CLP-03). Falls back to
 * the Web Clipboard API on non-Windows or if the backend call fails.
 */
async function writeText(text: string): Promise<boolean> {
  try {
    await copyClipboardProtected(text);
    return true;
  } catch {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
}

/** Cancel any pending auto-clear and reset the store mirror. */
function cancelPendingClear() {
  if (clearTimer !== null) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
}

interface CopyOptions {
  /** Label shown in the clipboard countdown indicator (default "Copied"). */
  label?: string;
  /** Auto-clear delay in seconds; pass 0 / null to disable auto-clear. */
  clearAfterSeconds?: number | null;
}

/**
 * Copy `text` to the clipboard. Returns true on success. Empty strings are a
 * no-op (returns false). By default the clipboard auto-clears after
 * {@link DEFAULT_CLIPBOARD_CLEAR_SECONDS}.
 */
export async function copyToClipboard(
  text: string,
  opts: CopyOptions = {},
): Promise<boolean> {
  if (!text) return false;

  const ok = await writeText(text);
  if (!ok) return false;

  cancelPendingClear();

  const seconds = opts.clearAfterSeconds ?? DEFAULT_CLIPBOARD_CLEAR_SECONDS;
  const store = useClipboardStore.getState();

  if (seconds && seconds > 0) {
    lastWritten = text;
    const clearsAt = Date.now() + seconds * 1000;
    store.copied(opts.label ?? "Copied", clearsAt);
    clearTimer = setTimeout(() => {
      void clearClipboard();
    }, seconds * 1000);
  } else {
    lastWritten = null;
    store.cleared();
  }
  return ok;
}

/**
 * Clear the clipboard now, but only if it still holds the secret we wrote (so
 * we never wipe something the user copied from elsewhere in the meantime).
 * Falls back to clearing unconditionally if the clipboard can't be read.
 */
export async function clearClipboard(): Promise<void> {
  cancelPendingClear();
  const expected = lastWritten;
  lastWritten = null;
  useClipboardStore.getState().cleared();

  if (!expected) return;
  try {
    const current = await navigator.clipboard.readText();
    if (current !== expected) return; // user copied something else; leave it
  } catch {
    // Can't read (permissions) — clear anyway to be safe.
  }
  await writeText("");
}
