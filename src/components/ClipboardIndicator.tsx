import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useClipboardStore } from "@/stores/clipboardStore";
import { clearClipboard } from "@/lib/clipboard";

/**
 * Title-bar pill showing the live auto-clear countdown for the clipboard
 * (PLAN Phase 6 / CLP-02). Clicking it clears the clipboard immediately.
 */
export function ClipboardIndicator() {
  const label = useClipboardStore((s) => s.label);
  const clearsAt = useClipboardStore((s) => s.clearsAt);
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (clearsAt == null) return;
    const tick = () =>
      setRemaining(Math.max(0, Math.ceil((clearsAt - Date.now()) / 1000)));
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [clearsAt]);

  const visible = label != null && clearsAt != null && remaining > 0;

  return (
    <AnimatePresence>
      {visible && (
        <motion.button
          type="button"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ duration: 0.15 }}
          onClick={() => void clearClipboard()}
          title="Clipboard clears automatically — click to clear now"
          className="flex items-center gap-1.5 rounded-full border border-border-sage bg-surface-elevated px-2.5 py-1 text-[11px] font-medium text-text-muted transition-colors hover:border-status-error/50 hover:text-status-error"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
            <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.8" />
            <path d="M5 15V5a2 2 0 0 1 2-2h8" stroke="currentColor" strokeWidth="1.8" />
          </svg>
          <span>
            {label} · {remaining}s
          </span>
        </motion.button>
      )}
    </AnimatePresence>
  );
}
