/**
 * Clipboard helper (PLAN Phase 3: copy username/password). A basic copy for
 * now — auto-clear and protected-clipboard modes arrive with the rest of the
 * clipboard work in Phase 6.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
