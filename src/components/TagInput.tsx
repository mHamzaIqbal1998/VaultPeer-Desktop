import { useMemo, useRef, useState } from "react";
import { tagColor } from "@/lib/tags";

interface Props {
  /** Current tags on the entry. */
  value: string[];
  onChange: (tags: string[]) => void;
  /** All known tags in the database, used for autocomplete suggestions. */
  suggestions?: string[];
}

/**
 * Tag editor with autocomplete (PLAN Phase 4: tag input with autocomplete,
 * colour-coded tags). Enter or comma commits the current text; Backspace on an
 * empty field removes the last tag. Suggestions filter as you type.
 */
export function TagInput({ value, onChange, suggestions = [] }: Props) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const q = text.trim().toLowerCase();
    return suggestions
      .filter((s) => !value.includes(s))
      .filter((s) => (q ? s.toLowerCase().includes(q) : true))
      .slice(0, 6);
  }, [suggestions, value, text]);

  function add(tag: string) {
    const t = tag.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setText("");
    setOpen(false);
    inputRef.current?.focus();
  }

  function remove(tag: string) {
    onChange(value.filter((t) => t !== tag));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (text.trim()) add(text);
    } else if (e.key === "Backspace" && !text && value.length) {
      remove(value[value.length - 1]);
    }
  }

  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border-sage bg-background-primary px-2 py-1.5 focus-within:border-accent-mint">
        {value.map((tag) => {
          const c = tagColor(tag);
          return (
            <span
              key={tag}
              className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
              style={{ backgroundColor: c.bg, color: c.fg, border: `1px solid ${c.border}` }}
            >
              {tag}
              <button
                type="button"
                onClick={() => remove(tag)}
                aria-label={`Remove ${tag}`}
                className="opacity-70 hover:opacity-100"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                </svg>
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          placeholder={value.length ? "" : "Add tags…"}
          className="min-w-[6rem] flex-1 bg-transparent py-0.5 text-sm text-text-primary outline-none placeholder:text-text-muted"
        />
      </div>

      {open && matches.length > 0 && (
        <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-lg border border-border-sage bg-surface-elevated p-1 shadow-2xl">
          {matches.map((s) => (
            <button
              key={s}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                add(s);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-text-secondary transition-colors hover:bg-accent-mint-dim"
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: tagColor(s).fg }}
              />
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
