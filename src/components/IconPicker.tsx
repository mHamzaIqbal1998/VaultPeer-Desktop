import { useEffect, useRef, useState } from "react";
import { ICON_CHOICES, VaultIcon } from "@/lib/icons";

interface Props {
  /** Currently-selected KeePass icon index, or null for the default. */
  value: number | null;
  onChange: (icon: number | null) => void;
}

/**
 * Compact icon picker (PLAN Phase 3: icon picker, KeePass standard icons).
 * Renders the current icon as a button that opens a grid popover; selecting an
 * icon stores its KeePass built-in index so files stay format-compatible.
 */
export function IconPicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Choose icon"
        title="Choose icon"
        className="grid h-11 w-11 place-items-center rounded-lg border border-border-sage bg-background-primary text-accent-mint transition-colors hover:border-accent-mint/50"
      >
        <VaultIcon icon={value} size={22} />
      </button>

      {open && (
        <div className="absolute left-0 top-12 z-50 w-64 rounded-xl border border-border-sage bg-surface-elevated p-2 shadow-2xl">
          <div className="grid grid-cols-6 gap-1">
            {ICON_CHOICES.map((choice) => {
              const active = value === choice.id;
              return (
                <button
                  key={choice.id}
                  type="button"
                  title={choice.name}
                  onClick={() => {
                    onChange(choice.id);
                    setOpen(false);
                  }}
                  className={`grid h-9 w-9 place-items-center rounded-md transition-colors ${
                    active
                      ? "bg-accent-mint text-background-primary"
                      : "text-text-secondary hover:bg-accent-mint-dim hover:text-text-primary"
                  }`}
                >
                  <VaultIcon icon={choice.id} size={18} />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
