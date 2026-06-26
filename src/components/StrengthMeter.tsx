import { estimatePasswordStrength } from "@/lib/passwordStrength";

/** Visual password-strength meter: four segments + a bits/label readout. */
export function StrengthMeter({ password }: { password: string }) {
  const { score, bits, label } = estimatePasswordStrength(password);

  // Color ramps from error → warning → success as the score climbs.
  const color =
    score <= 1
      ? "var(--color-status-error)"
      : score === 2
        ? "var(--color-status-warning)"
        : score === 3
          ? "var(--color-accent-mint)"
          : "var(--color-status-success)";

  return (
    <div>
      <div className="flex gap-1.5" aria-hidden>
        {[1, 2, 3, 4].map((seg) => (
          <div
            key={seg}
            className="h-1.5 flex-1 rounded-full transition-colors"
            style={{
              backgroundColor: seg <= score ? color : "var(--color-border-sage)",
            }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex items-center justify-between text-xs">
        <span style={{ color }} className="font-medium">
          {label}
        </span>
        {password.length > 0 && (
          <span className="text-text-muted">~{bits} bits</span>
        )}
      </div>
    </div>
  );
}
