//! TOTP (RFC 6238) one-time-password generation (PLAN Phase 5 / OTP-01).
//!
//! Pure, Tauri-free helpers: parse an entry's stored OTP value — either a full
//! `otpauth://` URI (the KeePassXC convention) or a bare base32 secret — and
//! generate the current time-based code. Kept self-contained (manual base32
//! decoding + HMAC) so codes are computed natively and match other RFC 6238
//! clients, including VaultPeerMobile.

use hmac::{Hmac, Mac};
use serde::Serialize;
use sha1::Sha1;
use sha2::{Sha256, Sha512};

use crate::error::{AppError, AppResult};

/// Hash algorithm backing the HMAC step (PRD OTP-06).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Algorithm {
    Sha1,
    Sha256,
    Sha512,
}

/// Fully-resolved TOTP parameters, ready for code generation.
#[derive(Debug, Clone)]
pub struct TotpParams {
    pub secret: Vec<u8>,
    pub algorithm: Algorithm,
    pub digits: u32,
    pub period: u64,
}

/// A generated code plus the timing the UI needs to render a countdown.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TotpCode {
    pub code: String,
    pub period: u64,
    pub digits: u32,
    /// Seconds remaining until the current code rolls over.
    pub remaining: u64,
}

/// Decode an RFC 4648 base32 secret, ignoring case, padding, spaces and hyphens.
fn decode_base32(s: &str) -> AppResult<Vec<u8>> {
    const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let invalid = || AppError::InvalidOperation("OTP secret is not valid base32".into());

    let mut acc: u64 = 0;
    let mut bits: u32 = 0;
    let mut out = Vec::new();
    for c in s.chars() {
        if c.is_whitespace() || c == '=' || c == '-' {
            continue;
        }
        if !c.is_ascii() {
            return Err(invalid());
        }
        let up = c.to_ascii_uppercase() as u8;
        let v = ALPHABET.iter().position(|&a| a == up).ok_or_else(invalid)? as u64;
        acc = (acc << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    if out.is_empty() {
        return Err(AppError::InvalidOperation("OTP secret is empty".into()));
    }
    Ok(out)
}

/// Minimal percent-decoding for `otpauth://` URI query values.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => match u8::from_str_radix(&s[i + 1..i + 3], 16) {
                Ok(b) => {
                    out.push(b);
                    i += 3;
                }
                Err(_) => {
                    out.push(b'%');
                    i += 1;
                }
            },
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parse an entry's stored OTP value into concrete parameters.
///
/// Accepts a full `otpauth://totp/...` URI or a bare base32 secret (which falls
/// back to the RFC 6238 defaults: SHA-1, 6 digits, 30-second period).
pub fn parse(input: &str) -> AppResult<TotpParams> {
    let input = input.trim();
    if input.is_empty() {
        return Err(AppError::InvalidOperation("no OTP secret set".into()));
    }

    if let Some(rest) = input.strip_prefix("otpauth://") {
        return parse_uri(rest);
    }
    // Anything that isn't a URI is treated as a bare base32 secret.
    Ok(TotpParams {
        secret: decode_base32(input)?,
        algorithm: Algorithm::Sha1,
        digits: 6,
        period: 30,
    })
}

fn parse_uri(rest: &str) -> AppResult<TotpParams> {
    let query = rest.split_once('?').map(|(_, q)| q).unwrap_or("");

    let mut secret = None;
    let mut algorithm = Algorithm::Sha1;
    let mut digits: u32 = 6;
    let mut period: u64 = 30;

    for pair in query.split('&') {
        let Some((k, v)) = pair.split_once('=') else {
            continue;
        };
        let value = percent_decode(v);
        match k.to_ascii_lowercase().as_str() {
            "secret" => secret = Some(decode_base32(&value)?),
            "algorithm" => {
                algorithm = match value.to_ascii_uppercase().as_str() {
                    "SHA256" => Algorithm::Sha256,
                    "SHA512" => Algorithm::Sha512,
                    _ => Algorithm::Sha1,
                }
            }
            "digits" => digits = value.parse().unwrap_or(6).clamp(6, 8),
            "period" => period = value.parse().unwrap_or(30).max(1),
            _ => {}
        }
    }

    let secret =
        secret.ok_or_else(|| AppError::InvalidOperation("OTP URI is missing its secret".into()))?;
    Ok(TotpParams {
        secret,
        algorithm,
        digits,
        period,
    })
}

fn hmac_digest(algorithm: Algorithm, key: &[u8], msg: &[u8]) -> Vec<u8> {
    match algorithm {
        Algorithm::Sha1 => {
            let mut mac = Hmac::<Sha1>::new_from_slice(key).expect("HMAC accepts any key length");
            mac.update(msg);
            mac.finalize().into_bytes().to_vec()
        }
        Algorithm::Sha256 => {
            let mut mac =
                Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
            mac.update(msg);
            mac.finalize().into_bytes().to_vec()
        }
        Algorithm::Sha512 => {
            let mut mac =
                Hmac::<Sha512>::new_from_slice(key).expect("HMAC accepts any key length");
            mac.update(msg);
            mac.finalize().into_bytes().to_vec()
        }
    }
}

/// Generate the TOTP code for `unix_secs` (RFC 6238 §4, with the RFC 4226
/// dynamic-truncation step).
pub fn generate(params: &TotpParams, unix_secs: u64) -> String {
    let counter = unix_secs / params.period;
    let hash = hmac_digest(params.algorithm, &params.secret, &counter.to_be_bytes());

    // Dynamic truncation (RFC 4226 §5.3).
    let offset = (hash[hash.len() - 1] & 0x0f) as usize;
    let bin = ((hash[offset] as u32 & 0x7f) << 24)
        | ((hash[offset + 1] as u32) << 16)
        | ((hash[offset + 2] as u32) << 8)
        | (hash[offset + 3] as u32);

    let modulo = 10u32.pow(params.digits);
    format!("{:0width$}", bin % modulo, width = params.digits as usize)
}

/// Parse an entry's OTP value and generate the current code, returning the
/// timing needed to drive the countdown UI. `now_secs` is the current Unix time.
pub fn current_code(input: &str, now_secs: u64) -> AppResult<TotpCode> {
    let params = parse(input)?;
    let code = generate(&params, now_secs);
    let remaining = params.period - (now_secs % params.period);
    Ok(TotpCode {
        code,
        period: params.period,
        digits: params.digits,
        remaining,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(secret: &[u8], algorithm: Algorithm, digits: u32) -> TotpParams {
        TotpParams {
            secret: secret.to_vec(),
            algorithm,
            digits,
            period: 30,
        }
    }

    #[test]
    fn rfc6238_sha1_vectors() {
        let s = b"12345678901234567890";
        assert_eq!(generate(&params(s, Algorithm::Sha1, 8), 59), "94287082");
        assert_eq!(generate(&params(s, Algorithm::Sha1, 8), 1111111109), "07081804");
        // The 6-digit code is the trailing digits of the 8-digit one.
        assert_eq!(generate(&params(s, Algorithm::Sha1, 6), 59), "287082");
    }

    #[test]
    fn rfc6238_sha256_and_sha512_vectors() {
        assert_eq!(
            generate(
                &params(b"12345678901234567890123456789012", Algorithm::Sha256, 8),
                59
            ),
            "46119246"
        );
        assert_eq!(
            generate(
                &params(
                    b"1234567890123456789012345678901234567890123456789012345678901234",
                    Algorithm::Sha512,
                    8
                ),
                59
            ),
            "90693936"
        );
    }

    #[test]
    fn base32_decodes_rfc4648_vector() {
        // RFC 4648: base32("foobar") == "MZXW6YTBOI" (padding stripped).
        assert_eq!(decode_base32("MZXW6YTBOI").unwrap(), b"foobar");
        // Case-insensitive; spaces and hyphens are ignored.
        assert_eq!(decode_base32("mzxw 6ytb-oi").unwrap(), b"foobar");
    }

    #[test]
    fn parses_full_otpauth_uri() {
        let uri = "otpauth://totp/ACME:alice?secret=MZXW6YTBOI&issuer=ACME&algorithm=SHA256&digits=8&period=45";
        let p = parse(uri).unwrap();
        assert_eq!(p.secret, b"foobar");
        assert_eq!(p.algorithm, Algorithm::Sha256);
        assert_eq!(p.digits, 8);
        assert_eq!(p.period, 45);
    }

    #[test]
    fn parses_bare_secret_with_defaults() {
        let p = parse("MZXW6YTBOI").unwrap();
        assert_eq!(p.secret, b"foobar");
        assert_eq!(p.algorithm, Algorithm::Sha1);
        assert_eq!(p.digits, 6);
        assert_eq!(p.period, 30);
    }

    #[test]
    fn current_code_reports_remaining_seconds() {
        let c = current_code("MZXW6YTBOI", 25).unwrap();
        assert_eq!(c.period, 30);
        assert_eq!(c.remaining, 5);
        assert_eq!(c.digits, 6);
        assert_eq!(c.code.len(), 6);
    }

    #[test]
    fn rejects_invalid_or_empty_secrets() {
        assert!(parse("@@@@").is_err());
        assert!(parse("").is_err());
        assert!(parse("otpauth://totp/x?issuer=ACME").is_err()); // no secret
    }
}
