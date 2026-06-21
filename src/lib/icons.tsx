import type { ReactNode } from "react";

/**
 * KeePass built-in icon set (PLAN Phase 3: icon picker, standard KeePass icons).
 *
 * The `.kdbx` format stores an entry/group icon as an index into a fixed
 * 0–68 list. We render a curated subset as line glyphs that match the
 * Cyber-Sage aesthetic; any index without a glyph (or a null icon) falls back
 * to the key. The stored value is always the real KeePass index, so files stay
 * compatible with KeePass and VaultPeerMobile.
 */

/** Inner SVG markup for each supported KeePass icon index (24×24, stroke). */
const GLYPHS: Record<number, ReactNode> = {
  // 0 — Key
  0: (
    <>
      <circle cx="8" cy="15" r="3.2" />
      <path d="M10.3 12.7 20 3M16 7l2 2M18 5l2 2" />
    </>
  ),
  // 1 — Globe
  1: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.5 2.4 2.5 14.6 0 17M12 3.5c-2.5 2.4-2.5 14.6 0 17" />
    </>
  ),
  // 2 — Warning
  2: (
    <>
      <path d="M12 4 21 19H3L12 4Z" />
      <path d="M12 10v4M12 16.5v.01" />
    </>
  ),
  // 3 — Network server
  3: (
    <>
      <rect x="4" y="4" width="16" height="6.5" rx="1.5" />
      <rect x="4" y="13.5" width="16" height="6.5" rx="1.5" />
      <path d="M7.5 7.2v.01M7.5 16.7v.01" />
    </>
  ),
  // 7 — Notepad
  7: (
    <>
      <rect x="5" y="3.5" width="14" height="17" rx="2" />
      <path d="M8.5 8h7M8.5 12h7M8.5 16h4" />
    </>
  ),
  // 9 — Identity card
  9: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="11" r="2" />
      <path d="M13 9.5h5M13 13h5M5.5 15.5c.6-1.4 4.4-1.4 5 0" />
    </>
  ),
  // 11 — Camera
  11: (
    <>
      <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7H7l1.5-2h7L17 7h2.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-9Z" />
      <circle cx="12" cy="13" r="3.2" />
    </>
  ),
  // 14 — Energy / power
  14: <path d="M13 3 5 13h5l-1 8 8-10h-5l1-8Z" />,
  // 19 — Email
  19: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  // 20 — Settings (sliders)
  20: (
    <>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2.2" />
      <circle cx="8" cy="17" r="2.2" />
    </>
  ),
  // 26 — Disk (save)
  26: (
    <>
      <path d="M5 4h11l3 3v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4Z" />
      <path d="M8 4v5h7V4M8 19v-5h8v5" />
    </>
  ),
  // 27 — Drive
  27: (
    <>
      <rect x="3" y="8.5" width="18" height="7" rx="2" />
      <path d="M16.5 12h.01" />
    </>
  ),
  // 30 — Console / terminal
  30: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="m7 10 3 2.5L7 15M12.5 15.5H16" />
    </>
  ),
  // 31 — Printer
  31: (
    <>
      <path d="M7 9V4h10v5" />
      <rect x="4" y="9" width="16" height="7" rx="1.5" />
      <path d="M7 14h10v6H7z" />
    </>
  ),
  // 33 — Run (application)
  33: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="m10 9 5 3-5 3V9Z" />
    </>
  ),
  // 36 — Archive
  36: (
    <>
      <path d="M4 7h16v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7Z" />
      <rect x="3" y="4" width="18" height="3.5" rx="1" />
      <path d="M10 11h4" />
    </>
  ),
  // 37 — Homebanking (bank)
  37: (
    <>
      <path d="M4 9 12 4l8 5" />
      <path d="M5 9v8M9.5 9v8M14.5 9v8M19 9v8M3.5 20h17" />
    </>
  ),
  // 39 — Clock
  39: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  // 43 — Trash bin
  43: (
    <>
      <path d="M4 7h16M9 7V4.5h6V7M6 7l1 13h10l1-13" />
      <path d="M10 11v5M14 11v5" />
    </>
  ),
  // 47 — Package
  47: (
    <>
      <path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z" />
      <path d="m4 7 8 4 8-4M12 11v10" />
    </>
  ),
  // 48 — Folder
  48: (
    <path d="M4 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Z" />
  ),
  // 52 — Paper locked
  52: (
    <>
      <rect x="5" y="3.5" width="14" height="17" rx="2" />
      <rect x="9" y="12" width="6" height="5" rx="1" />
      <path d="M10.5 12v-1.5a1.5 1.5 0 0 1 3 0V12" />
    </>
  ),
  // 53 — Checked
  53: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </>
  ),
  // 56 — Book
  56: (
    <>
      <path d="M5 4.5h11a2 2 0 0 1 2 2V20H7a2 2 0 0 1-2-2V4.5Z" />
      <path d="M5 17.5a2 2 0 0 1 2-2h11" />
    </>
  ),
  // 58 — User key (person)
  58: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
    </>
  ),
  // 59 — Tool (wrench)
  59: (
    <path d="M15.5 4a5 5 0 0 0-5.9 6.2L4 15.8 8.2 20l5.6-5.6A5 5 0 0 0 20 8.5l-3 3-2.5-2.5 3-3A5 5 0 0 0 15.5 4Z" />
  ),
  // 60 — Home
  60: (
    <>
      <path d="m4 11 8-7 8 7" />
      <path d="M6 9.5V20h12V9.5" />
      <path d="M10 20v-5h4v5" />
    </>
  ),
  // 61 — Star
  61: (
    <path d="m12 4 2.5 5.2 5.5.8-4 3.9 1 5.6-5-2.7-5 2.7 1-5.6-4-3.9 5.5-.8L12 4Z" />
  ),
  // 66 — Money
  66: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v10M14.5 9.2c-.6-.9-1.6-1.2-2.5-1.2-1.4 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.9 2.5 2-1.1 2-2.5 2c-1 0-2-.4-2.5-1.2" />
    </>
  ),
  // 67 — Certificate
  67: (
    <>
      <circle cx="12" cy="9.5" r="5" />
      <path d="M9 13.5 8 21l4-2 4 2-1-7.5" />
    </>
  ),
  // 68 — Phone
  68: (
    <>
      <rect x="6.5" y="3" width="11" height="18" rx="2.5" />
      <path d="M10.5 18h3" />
    </>
  ),
};

/** Ordered list of pickable icons (index + human label) for the icon picker. */
export const ICON_CHOICES: { id: number; name: string }[] = [
  { id: 0, name: "Key" },
  { id: 1, name: "Globe" },
  { id: 19, name: "Email" },
  { id: 58, name: "Account" },
  { id: 9, name: "Identity" },
  { id: 66, name: "Money" },
  { id: 37, name: "Bank" },
  { id: 67, name: "Certificate" },
  { id: 3, name: "Server" },
  { id: 27, name: "Drive" },
  { id: 30, name: "Terminal" },
  { id: 33, name: "Application" },
  { id: 31, name: "Printer" },
  { id: 11, name: "Camera" },
  { id: 68, name: "Phone" },
  { id: 14, name: "Power" },
  { id: 20, name: "Settings" },
  { id: 59, name: "Tools" },
  { id: 7, name: "Notes" },
  { id: 56, name: "Book" },
  { id: 52, name: "Secure doc" },
  { id: 47, name: "Package" },
  { id: 36, name: "Archive" },
  { id: 26, name: "Disk" },
  { id: 48, name: "Folder" },
  { id: 39, name: "Clock" },
  { id: 60, name: "Home" },
  { id: 61, name: "Favorite" },
  { id: 53, name: "Done" },
  { id: 2, name: "Warning" },
  { id: 43, name: "Trash" },
];

/** Render a KeePass icon by index; falls back to the key for unknown indices. */
export function VaultIcon({
  icon,
  size = 18,
  className,
}: {
  icon: number | null | undefined;
  size?: number;
  className?: string;
}) {
  const glyph = (icon != null && GLYPHS[icon]) || GLYPHS[0];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {glyph}
    </svg>
  );
}
