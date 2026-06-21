import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_GENERATOR_OPTIONS,
  generatePassword,
  type GeneratorOptions,
} from "@/lib/passwordGenerator";

interface Props {
  /** Apply a freshly-generated password back to the field. */
  onApply: (password: string) => void;
  onClose: () => void;
}

/**
 * Inline password-generator popover (PLAN Phase 3: generator integration in the
 * entry form). Adjusting any option regenerates immediately and applies the
 * result to the bound field; the standalone generator tool arrives in Phase 5.
 */
export function PasswordGeneratorPopover({ onApply, onClose }: Props) {
  const [opts, setOpts] = useState<GeneratorOptions>(DEFAULT_GENERATOR_OPTIONS);
  const ref = useRef<HTMLDivElement>(null);

  function regenerate(next: GeneratorOptions) {
    setOpts(next);
    onApply(generatePassword(next));
  }

  // Generate once on open.
  useEffect(() => {
    onApply(generatePassword(DEFAULT_GENERATOR_OPTIONS));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const toggles: [keyof GeneratorOptions, string][] = [
    ["uppercase", "A–Z"],
    ["lowercase", "a–z"],
    ["digits", "0–9"],
    ["symbols", "!@#"],
  ];

  return (
    <div
      ref={ref}
      className="absolute right-0 top-12 z-50 w-72 rounded-xl border border-border-sage bg-surface-elevated p-4 shadow-2xl"
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-semibold text-text-primary">
          Generate password
        </span>
        <span className="font-mono text-xs text-text-muted">{opts.length}</span>
      </div>

      <input
        type="range"
        min={8}
        max={64}
        value={opts.length}
        onChange={(e) => regenerate({ ...opts, length: Number(e.target.value) })}
        className="mb-3 w-full accent-[var(--color-accent-mint)]"
      />

      <div className="mb-3 grid grid-cols-2 gap-2">
        {toggles.map(([key, label]) => {
          const active = opts[key] as boolean;
          return (
            <button
              key={key}
              type="button"
              onClick={() => regenerate({ ...opts, [key]: !active })}
              className={`rounded-md border px-2 py-1.5 text-xs font-medium transition-colors ${
                active
                  ? "border-accent-mint bg-accent-mint-dim text-text-primary"
                  : "border-border-sage text-text-muted hover:text-text-secondary"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      <label className="mb-3 flex cursor-pointer items-center gap-2 text-xs text-text-secondary">
        <input
          type="checkbox"
          checked={opts.excludeAmbiguous}
          onChange={(e) =>
            regenerate({ ...opts, excludeAmbiguous: e.target.checked })
          }
          className="accent-[var(--color-accent-mint)]"
        />
        Exclude ambiguous characters
      </label>

      <button
        type="button"
        onClick={() => regenerate(opts)}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent-mint px-3 py-2 text-xs font-semibold text-background-primary transition-opacity hover:opacity-90"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M4 12a8 8 0 0 1 14-5m2-2v4h-4M20 12a8 8 0 0 1-14 5m-2 2v-4h4"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Regenerate
      </button>
    </div>
  );
}
