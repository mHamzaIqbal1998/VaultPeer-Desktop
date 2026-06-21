/**
 * Deterministic colour assignment for tags (PLAN Phase 4: colour-coded tags).
 *
 * Each tag maps to one of a fixed palette by hashing its (lower-cased) name, so
 * a given tag always renders in the same colour across the app without needing
 * to store any per-tag colour in the database.
 */

interface TagColor {
  /** Background tint (with alpha) for the chip. */
  bg: string;
  /** Text/foreground colour for the chip. */
  fg: string;
  /** Border colour for the chip. */
  border: string;
}

// A small palette tuned to read well on the Cyber-Sage dark surfaces while
// staying legible in light mode (the foreground colours are mid-tones).
const PALETTE: TagColor[] = [
  { bg: "rgba(52, 211, 153, 0.15)", fg: "#34D399", border: "rgba(52, 211, 153, 0.4)" },
  { bg: "rgba(96, 165, 250, 0.15)", fg: "#60A5FA", border: "rgba(96, 165, 250, 0.4)" },
  { bg: "rgba(244, 114, 182, 0.15)", fg: "#F472B6", border: "rgba(244, 114, 182, 0.4)" },
  { bg: "rgba(251, 191, 36, 0.15)", fg: "#FBBF24", border: "rgba(251, 191, 36, 0.4)" },
  { bg: "rgba(167, 139, 250, 0.15)", fg: "#A78BFA", border: "rgba(167, 139, 250, 0.4)" },
  { bg: "rgba(45, 212, 191, 0.15)", fg: "#2DD4BF", border: "rgba(45, 212, 191, 0.4)" },
  { bg: "rgba(248, 113, 113, 0.15)", fg: "#F87171", border: "rgba(248, 113, 113, 0.4)" },
  { bg: "rgba(129, 140, 248, 0.15)", fg: "#818CF8", border: "rgba(129, 140, 248, 0.4)" },
];

/** Stable, non-cryptographic string hash (FNV-1a style). */
function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Pick the palette colour for a tag name. */
export function tagColor(tag: string): TagColor {
  return PALETTE[hash(tag.toLowerCase()) % PALETTE.length];
}
