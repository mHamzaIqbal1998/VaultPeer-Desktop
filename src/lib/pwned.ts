/**
 * Have I Been Pwned password breach check (k-anonymity "range" API).
 *
 * Mirrors the classic pwned-passwords script: SHA-1 the password locally,
 * send ONLY the first 5 hex characters of the digest to
 * https://api.pwnedpasswords.com/range/<prefix>, and match the remaining
 * suffix against the returned hash:count lines. The full hash — and the
 * plaintext password — never leave the device.
 */

const HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range/";

/** SHA-1 digest of `text` as an uppercase hex string. */
async function sha1HexUpper(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/**
 * Number of times `password` appears in known data breaches (Despite k-anonymity,
 * only the 5-char hash prefix is sent, so the password itself stays local).
 *
 * @returns The breach occurrence count (0 when the password is not known-pwned).
 * @throws Error when the request fails or the API responds with a non-200 status.
 */
export async function pwnedPasswordCount(password: string): Promise<number> {
  const sha1 = await sha1HexUpper(password);
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  let res: Response;
  try {
    // "Add-Padding" asks the API to pad the response so response size
    // cannot be used to narrow down the queried range.
    res = await fetch(HIBP_RANGE_URL + prefix, {
      headers: { Accept: "text/plain", "Add-Padding": "true" },
    });
  } catch (e) {
    throw new Error(`network error: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status !== 200) {
    throw new Error(`Error fetching: ${res.status}, check the api and try again`);
  }

  const body = await res.text();
  for (const line of body.split("\n")) {
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    if (line.slice(0, sep).trim() === suffix) {
      return Number.parseInt(line.slice(sep + 1).trim(), 10) || 0;
    }
  }
  return 0;
}
