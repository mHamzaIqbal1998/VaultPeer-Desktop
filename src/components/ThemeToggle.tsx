import { useThemeStore } from "@/stores/themeStore";

/** Cycles dark → light → high-contrast → system and shows an icon for the resolved theme. */
export function ThemeToggle() {
  const preference = useThemeStore((s) => s.preference);
  const resolved = useThemeStore((s) => s.resolved);
  const setPreference = useThemeStore((s) => s.setPreference);

  const CYCLE: Record<string, "dark" | "light" | "high-contrast" | "system"> = {
    dark: "light",
    light: "high-contrast",
    "high-contrast": "system",
    system: "dark",
  };
  const next = CYCLE[preference] ?? "dark";

  return (
    <button
      type="button"
      aria-label={`Theme: ${preference}. Switch to ${next}.`}
      title={`Theme: ${preference} (click for ${next})`}
      onClick={() => setPreference(next)}
      className="grid h-7 w-7 place-items-center rounded-md text-text-muted transition-colors hover:bg-accent-mint-dim hover:text-text-primary"
    >
      {resolved === "high-contrast" ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
          <path d="M12 3v18" stroke="currentColor" strokeWidth="2" />
          <path d="M12 3a9 9 0 0 1 0 18" fill="currentColor" />
        </svg>
      ) : resolved === "dark" ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="2" />
          <path
            d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
}
