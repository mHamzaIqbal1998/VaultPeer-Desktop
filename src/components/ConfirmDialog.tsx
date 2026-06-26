import { useState } from "react";
import { motion } from "framer-motion";

interface Props {
  title: string;
  message: string;
  /** Label for the confirm button (defaults to "Confirm"). */
  confirmLabel?: string;
  /** Render the confirm action in the destructive (red) style. */
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Small reusable confirmation modal (PLAN Phase 3: entry/group deletion with
 * confirmation). Awaits async `onConfirm` so callers can surface backend errors.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  destructive = false,
  onConfirm,
  onCancel,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-6" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="w-full max-w-sm overflow-hidden rounded-2xl border border-border-sage bg-surface-card shadow-2xl"
      >
        <div className="px-5 py-4">
          <h2 id="confirm-dialog-title" className="text-base font-semibold text-text-primary">{title}</h2>
          <p className="mt-2 text-sm text-text-secondary">{message}</p>
          {error && (
            <div className="mt-3 rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-status-error">
              {error}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border-sage px-5 py-3.5">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-border-sage px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:border-accent-mint/40 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 ${
              destructive
                ? "bg-status-error text-white"
                : "bg-accent-mint text-background-primary"
            }`}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
