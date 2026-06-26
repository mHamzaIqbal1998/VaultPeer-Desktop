import QRCode from "qrcode";

/**
 * QR helpers for P2P sync room joining (PLAN Phase 8 / SYN-03).
 *
 * A room invite is encoded as a `vaultpeer://sync` URI carrying the signaling
 * server URL and the room id, so a peer can scan one code and have everything
 * needed to join. The mobile app shares the same scheme. Generation is fully
 * offline via the bundled `qrcode`; scanning reuses the existing `QrScanner`
 * (jsQR) component.
 */

/** Custom URI scheme for a sync room invite. */
const SYNC_SCHEME = "vaultpeer://sync";

/** Build a `vaultpeer://sync?...` invite URI from a room id + signaling URL. */
export function buildSyncInvite(room: string, signalingUrl: string): string {
  const params = new URLSearchParams({ room });
  if (signalingUrl) params.set("server", signalingUrl);
  return `${SYNC_SCHEME}?${params.toString()}`;
}

/** A parsed sync invite. */
export interface SyncInvite {
  room: string;
  signalingUrl: string | null;
}

/**
 * Parse a scanned value into a {@link SyncInvite}. Accepts a full
 * `vaultpeer://sync?room=…&server=…` URI, or a bare room id typed/pasted by the
 * user. Returns null only when no room can be recovered.
 */
export function parseSyncInvite(value: string): SyncInvite | null {
  const raw = value.trim();
  if (!raw) return null;

  if (raw.startsWith(SYNC_SCHEME) || raw.startsWith("vaultpeer://")) {
    // URL() can't parse custom schemes reliably across engines; pull the query
    // out by hand.
    const qIndex = raw.indexOf("?");
    if (qIndex === -1) return null;
    const params = new URLSearchParams(raw.slice(qIndex + 1));
    const room = params.get("room")?.trim();
    if (!room) return null;
    return { room, signalingUrl: params.get("server")?.trim() || null };
  }

  // Bare room id (alphanumeric / dashes) — accept as-is.
  if (/^[A-Za-z0-9_-]{4,}$/.test(raw)) {
    return { room: raw, signalingUrl: null };
  }
  return null;
}

/**
 * Render a payload to a QR code as an SVG string. SVG scales crisply at any DPI
 * and needs no canvas. Colors default to a dark-on-light code that scans well
 * regardless of the app theme.
 */
export async function qrToSvg(payload: string): Promise<string> {
  return QRCode.toString(payload, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    color: { dark: "#0B0F0E", light: "#FFFFFF" },
  });
}

/** Generate a short, URL-safe random room id using the Web Crypto RNG. */
export function generateRoomId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  // base32-ish, lowercase, no ambiguous chars.
  const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${out.slice(0, 4)}-${out.slice(4, 9)}`;
}
