import { useState } from "react";
import { motion } from "framer-motion";

interface Props {
  title: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  onConfirm: (value: string) => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Single-line text prompt modal, used for creating and renaming groups
 * (PLAN Phase 3: create/rename groups). Trims input and rejects empty values.
 */
export function PromptDialog({
  title,
  label,
  initialValue = "",
  placeholder,
  confirmLabel = "Save",
  onConfirm,
  onCancel,
}: Props) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    const trimmed = value.trim();
    if (!trimmed) {
      setError("Enter a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConfirm(trimmed);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="w-full max-w-sm overflow-hidden rounded-2xl border border-border-sage bg-surface-card shadow-2xl"
      >
        <div className="px-5 py-4">
          <h2 className="mb-3 text-base font-semibold text-text-primary">{title}</h2>
          <span className="mb-1.5 block text-xs font-medium text-text-muted">
            {label}
          </span>
          <input
            value={value}
            autoFocus
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleConfirm();
              if (e.key === "Escape") onCancel();
            }}
            className="w-full rounded-lg border border-border-sage bg-background-primary px-3 py-2.5 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent-mint"
          />
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
            className="rounded-lg bg-accent-mint px-4 py-2 text-sm font-semibold text-background-primary transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
