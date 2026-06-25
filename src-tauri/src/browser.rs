//! Browser integration (PLAN Phase 9 / PRD BRW-01..03).
//!
//! Three pieces, all opt-in and local-only:
//!
//!   • **URL matching** ([`matching_entry_ids`]) — given the URL of the page the
//!     browser is on, rank the vault entries whose own URL points at the same
//!     host, so the right credentials can be suggested (BRW-03).
//!   • **HTTP server mode** ([`BrowserServer`]) — a tiny synchronous HTTP server
//!     bound to `127.0.0.1` only, so a browser extension can ask for suggestions
//!     for the current page (BRW-02). It is **off by default**, requires a bearer
//!     token, and only ever serves over loopback.
//!   • **Native messaging + extension assets** ([`run_native_messaging_host`],
//!     [`write_extension_bundle`]) — a stdin/stdout proxy the browser can launch
//!     (BRW-01), plus generated Chrome/Edge/Firefox extension manifests and a
//!     native-messaging host manifest (BRW-01 / browser extension manifest).
//!
//! Returning a password over loopback HTTP is the whole point of an autofill
//! extension; the three guards (opt-in, loopback-only bind, per-session token)
//! keep that surface tight, and the decrypted vault still never leaves the
//! backend except as the specific field the extension asked for.

use std::io::Read;
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use keepass::{db::fields, db::EntryId, Database};
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::error::{AppError, AppResult};
use crate::otp;
use crate::session::VaultSession;

/// The application identifier (matches `tauri.conf.json`), used to locate the
/// per-user config directory without a Tauri handle (the native-messaging host
/// runs before Tauri is initialized).
const APP_IDENTIFIER: &str = "com.vaultpeer.desktop";

/// Name registered for the native-messaging host (browser manifest key).
pub const NATIVE_HOST_NAME: &str = "com.vaultpeer.desktop";

/// CLI flag that switches the binary into native-messaging host mode.
pub const NATIVE_MESSAGING_FLAG: &str = "--native-messaging-host";

// ── URL matching (BRW-03) ─────────────────────────────────────────────────────

/// Extract the lowercased host portion of a URL (scheme/userinfo/port/path
/// stripped), with a leading `www.` removed so `www.site.com` and `site.com`
/// match. Returns `None` for an empty/host-less string.
pub fn host_of(url: &str) -> Option<String> {
    let rest = url.trim().split("://").nth(1).unwrap_or(url.trim());
    let host = rest.split('/').next().unwrap_or(rest);
    let host = host.rsplit('@').next().unwrap_or(host);
    let host = host.split(':').next().unwrap_or(host);
    let host = host.trim().trim_start_matches("www.").to_lowercase();
    (!host.is_empty()).then_some(host)
}

/// Score how well an entry host matches a page host: 3 = exact, 2 = the entry is
/// a parent domain of the page (`site.com` matches `mail.site.com`), 1 = the page
/// is a parent of the entry. `0` means no match.
fn host_match_score(entry_host: &str, page_host: &str) -> u8 {
    if entry_host == page_host {
        3
    } else if page_host.ends_with(&format!(".{entry_host}")) {
        2
    } else if entry_host.ends_with(&format!(".{page_host}")) {
        1
    } else {
        0
    }
}

/// Rank entries whose URL host matches `page_url`, best match first, excluding
/// recycle-bin entries. Returns the matching entry ids.
pub fn matching_entry_ids(db: &Database, page_url: &str) -> Vec<EntryId> {
    let Some(page_host) = host_of(page_url) else {
        return Vec::new();
    };

    let mut scored: Vec<(u8, EntryId)> = db
        .iter_all_entries()
        .filter(|e| !crate::database::is_in_recycle_bin(db, e.parent().id()))
        .filter_map(|e| {
            let url = e.get(fields::URL).unwrap_or_default();
            host_of(url).and_then(|h| {
                let s = host_match_score(&h, &page_host);
                (s > 0).then_some((s, e.id()))
            })
        })
        .collect();

    scored.sort_by_key(|(score, _)| std::cmp::Reverse(*score));
    scored.into_iter().map(|(_, id)| id).collect()
}

/// A credential suggestion for the browser extension (includes the secret — the
/// API is loopback-only and token-gated).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub uuid: String,
    pub title: String,
    pub username: String,
    pub password: String,
    pub url: String,
    /// The current TOTP code, if the entry has an OTP secret (else empty).
    pub totp: String,
}

/// Build credential suggestions (with secrets) for a page URL.
fn suggestions_for(db: &Database, page_url: &str, limit: usize) -> Vec<Suggestion> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    matching_entry_ids(db, page_url)
        .into_iter()
        .take(limit)
        .filter_map(|id| db.entry(id))
        .map(|e| {
            let otp_secret = e.get(fields::OTP).unwrap_or_default();
            let totp = if otp_secret.trim().is_empty() {
                String::new()
            } else {
                otp::current_code(otp_secret, now).map(|c| c.code).unwrap_or_default()
            };
            Suggestion {
                uuid: e.id().uuid().to_string(),
                title: e.get(fields::TITLE).unwrap_or_default().to_string(),
                username: e.get(fields::USERNAME).unwrap_or_default().to_string(),
                password: e.get(fields::PASSWORD).unwrap_or_default().to_string(),
                url: e.get(fields::URL).unwrap_or_default().to_string(),
                totp,
            }
        })
        .collect()
}

// ── HTTP server (BRW-02) ──────────────────────────────────────────────────────

/// Per-session browser-integration config, persisted so the native-messaging
/// host (a separate process) can find the running server's port and token.
#[derive(Debug, Clone, Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationConfig {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
}

/// Running-server handle, stored in the Tauri-managed [`BrowserServer`].
struct RunningServer {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
    port: u16,
    token: String,
}

/// Tauri-managed state for the optional localhost HTTP server.
#[derive(Default)]
pub struct BrowserServer(Mutex<Option<RunningServer>>);

/// Status of the browser HTTP server, returned to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub running: bool,
    pub port: u16,
    pub token: String,
}

impl BrowserServer {
    /// Current server status (running flag + active port/token).
    pub fn status(&self) -> ServerStatus {
        let guard = self.0.lock().expect("browser server mutex poisoned");
        match guard.as_ref() {
            Some(s) => ServerStatus {
                running: true,
                port: s.port,
                token: s.token.clone(),
            },
            None => ServerStatus {
                running: false,
                port: 0,
                token: String::new(),
            },
        }
    }

    /// Stop the server if running (idempotent).
    pub fn stop<R: Runtime>(&self, app: &AppHandle<R>) {
        let mut guard = self.0.lock().expect("browser server mutex poisoned");
        if let Some(mut s) = guard.take() {
            s.stop.store(true, Ordering::SeqCst);
            if let Some(join) = s.join.take() {
                let _ = join.join();
            }
        }
        // Clear the persisted config so the native host stops proxying.
        let _ = write_integration_config(&IntegrationConfig::default());
        let _ = app; // reserved for future per-window teardown
    }

    /// Start (or restart) the server on `127.0.0.1:port` with `token`. Persists
    /// the integration config so the native-messaging host can find it.
    pub fn start<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        port: u16,
        token: String,
    ) -> AppResult<ServerStatus> {
        self.stop(app);

        let server = tiny_http::Server::http(("127.0.0.1", port))
            .map_err(|e| AppError::Other(format!("could not start browser server: {e}")))?;
        let bound_port = server
            .server_addr()
            .to_ip()
            .map(|a| a.port())
            .unwrap_or(port);

        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        let token_thread = token.clone();
        let app_thread = app.clone();

        let join = std::thread::Builder::new()
            .name("vaultpeer-browser-http".into())
            .spawn(move || serve_loop(server, stop_thread, app_thread, token_thread))
            .map_err(|e| AppError::Other(format!("could not spawn browser server thread: {e}")))?;

        write_integration_config(&IntegrationConfig {
            enabled: true,
            port: bound_port,
            token: token.clone(),
        })?;

        *self.0.lock().expect("browser server mutex poisoned") = Some(RunningServer {
            stop,
            join: Some(join),
            port: bound_port,
            token: token.clone(),
        });

        Ok(ServerStatus {
            running: true,
            port: bound_port,
            token,
        })
    }
}

/// The blocking accept loop. Polls with a timeout so the stop flag is observed
/// promptly even with no incoming requests.
fn serve_loop<R: Runtime>(
    server: tiny_http::Server,
    stop: Arc<AtomicBool>,
    app: AppHandle<R>,
    token: String,
) {
    while !stop.load(Ordering::SeqCst) {
        match server.recv_timeout(Duration::from_millis(400)) {
            Ok(Some(request)) => handle_request(request, &app, &token),
            Ok(None) => {} // timeout — re-check the stop flag
            Err(_) => break,
        }
    }
}

/// JSON HTTP response with permissive (loopback) CORS so an extension's
/// `fetch` succeeds. `origin` echoes the caller so credentialed requests work.
fn json_response(status: u16, body: String, origin: &str) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let allow_origin = if origin.is_empty() { "*" } else { origin };
    tiny_http::Response::from_string(body)
        .with_status_code(status)
        .with_header(header("Content-Type", "application/json"))
        .with_header(header("Access-Control-Allow-Origin", allow_origin))
        .with_header(header("Access-Control-Allow-Headers", "Authorization, Content-Type"))
        .with_header(header("Access-Control-Allow-Methods", "GET, OPTIONS"))
        .with_header(header("Vary", "Origin"))
}

fn header(name: &str, value: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes())
        .expect("static header is valid")
}

/// Read a header value by case-insensitive name.
fn header_value(req: &tiny_http::Request, name: &str) -> String {
    req.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
        .unwrap_or_default()
}

/// Split a request target into path and a `key=value` query map (minimal,
/// percent-decoding `%XX` and `+`).
fn parse_target(target: &str) -> (String, std::collections::HashMap<String, String>) {
    let mut parts = target.splitn(2, '?');
    let path = parts.next().unwrap_or("").to_string();
    let mut map = std::collections::HashMap::new();
    if let Some(query) = parts.next() {
        for pair in query.split('&') {
            let mut kv = pair.splitn(2, '=');
            let k = kv.next().unwrap_or("");
            let v = kv.next().unwrap_or("");
            if !k.is_empty() {
                map.insert(percent_decode(k), percent_decode(v));
            }
        }
    }
    (path, map)
}

/// Minimal percent-decoder for query values (`%XX` and `+` → space).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(hi), Some(lo)) = (hi, lo) {
                    out.push((hi * 16 + lo) as u8);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
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

/// Handle one HTTP request: health is open; everything else needs the token.
fn handle_request<R: Runtime>(request: tiny_http::Request, app: &AppHandle<R>, token: &str) {
    let origin = header_value(&request, "Origin");
    let method = request.method().as_str().to_uppercase();
    let (path, query) = parse_target(request.url());

    // CORS preflight.
    if method == "OPTIONS" {
        let _ = request.respond(json_response(204, String::new(), &origin));
        return;
    }

    let session = app.state::<VaultSession>();

    let response = match path.as_str() {
        "/vaultpeer/health" => {
            let unlocked = session.is_unlocked();
            json_response(
                200,
                format!(
                    "{{\"status\":\"ok\",\"app\":\"VaultPeer\",\"unlocked\":{unlocked}}}"
                ),
                &origin,
            )
        }
        "/vaultpeer/suggest" => {
            // Bearer-token auth.
            let auth = header_value(&request, "Authorization");
            if auth.trim() != format!("Bearer {token}") {
                json_response(401, "{\"error\":\"unauthorized\"}".into(), &origin)
            } else {
                let url = query.get("url").cloned().unwrap_or_default();
                let guard = session.0.lock().expect("vault session mutex poisoned");
                match guard.as_ref() {
                    None => json_response(423, "{\"error\":\"locked\"}".into(), &origin),
                    Some(vault) => {
                        let suggestions = suggestions_for(&vault.db, &url, 20);
                        let body = serde_json::to_string(&suggestions)
                            .unwrap_or_else(|_| "[]".into());
                        json_response(200, body, &origin)
                    }
                }
            }
        }
        _ => json_response(404, "{\"error\":\"not found\"}".into(), &origin),
    };

    let _ = request.respond(response);
}

// ── Integration config persistence ────────────────────────────────────────────

/// The per-user config directory for VaultPeer, resolved from environment so it
/// works even before Tauri is initialized (the native-messaging host path).
fn config_dir() -> AppResult<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
    };
    let dir = base
        .ok_or_else(|| AppError::Other("could not resolve a config directory".into()))?
        .join(APP_IDENTIFIER);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn integration_config_path() -> AppResult<PathBuf> {
    Ok(config_dir()?.join("browser_integration.json"))
}

/// Persist the integration config (port + token) atomically.
fn write_integration_config(cfg: &IntegrationConfig) -> AppResult<()> {
    let path = integration_config_path()?;
    let json = serde_json::to_vec_pretty(cfg)
        .map_err(|e| AppError::Other(format!("could not serialize browser config: {e}")))?;
    crate::fs_ops::write_file_atomic(&path, &json)
}

/// Read the integration config, or a disabled default if absent/unreadable.
fn read_integration_config() -> IntegrationConfig {
    integration_config_path()
        .and_then(|p| Ok(std::fs::read(p)?))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

// ── Native messaging host (BRW-01) ────────────────────────────────────────────

/// Run the native-messaging host loop: read length-prefixed JSON messages from
/// stdin (the browser's protocol), proxy each to the running HTTP server, and
/// write the length-prefixed JSON reply to stdout. Exits when stdin closes.
///
/// This lets a browser launch VaultPeer's host without the user opening a port
/// manually; the host simply relays to the loopback server the app already runs.
pub fn run_native_messaging_host() {
    use std::io::Write;

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();

    loop {
        // 4-byte little-endian length prefix.
        let mut len_buf = [0u8; 4];
        let mut handle = stdin.lock();
        if handle.read_exact(&mut len_buf).is_err() {
            break; // stdin closed → browser disconnected
        }
        let len = u32::from_le_bytes(len_buf) as usize;
        if len == 0 || len > 1024 * 1024 {
            break;
        }
        let mut msg = vec![0u8; len];
        if handle.read_exact(&mut msg).is_err() {
            break;
        }
        drop(handle);

        let request: serde_json::Value = serde_json::from_slice(&msg).unwrap_or_default();
        let reply = handle_native_message(&request);

        let bytes = serde_json::to_vec(&reply).unwrap_or_else(|_| b"{}".to_vec());
        let mut out = stdout.lock();
        if out.write_all(&(bytes.len() as u32).to_le_bytes()).is_err()
            || out.write_all(&bytes).is_err()
            || out.flush().is_err()
        {
            break;
        }
    }
}

/// Translate one native-messaging request into an HTTP call against the running
/// server and return the parsed reply (or an error object).
fn handle_native_message(request: &serde_json::Value) -> serde_json::Value {
    let cfg = read_integration_config();
    if !cfg.enabled || cfg.port == 0 {
        return serde_json::json!({ "error": "VaultPeer browser integration is not running" });
    }

    let action = request.get("action").and_then(|a| a.as_str()).unwrap_or("");
    match action {
        "ping" => serde_json::json!({ "ok": true }),
        "suggest" => {
            let url = request.get("url").and_then(|u| u.as_str()).unwrap_or("");
            let target = format!("/vaultpeer/suggest?url={}", url_encode(url));
            match http_get(cfg.port, &target, &cfg.token) {
                Ok(body) => serde_json::from_str(&body)
                    .unwrap_or_else(|_| serde_json::json!({ "error": "bad response" })),
                Err(e) => serde_json::json!({ "error": e }),
            }
        }
        _ => serde_json::json!({ "error": "unknown action" }),
    }
}

/// Minimal percent-encoder for a query value.
fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Bare-bones loopback HTTP/1.0 GET, so the native host needs no HTTP-client
/// dependency. Returns the response body (anything 2xx) or an error string.
fn http_get(port: u16, target: &str, token: &str) -> Result<String, String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    use std::io::Write;
    let req = format!(
        "GET {target} HTTP/1.0\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;

    let mut buf = String::new();
    stream.read_to_string(&mut buf).map_err(|e| e.to_string())?;
    let body = buf.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    Ok(body)
}

// ── Extension + native-host manifest generation (BRW-01 / manifests) ────────────

/// Write a ready-to-load browser extension and its native-messaging host
/// manifest into `dir`. Returns the directory path. `exe_path` is the path to
/// the VaultPeer executable (used in the native-host manifest).
pub fn write_extension_bundle(dir: &str, exe_path: &str) -> AppResult<()> {
    let root = PathBuf::from(dir);
    std::fs::create_dir_all(&root)?;

    let write = |name: &str, contents: &str| -> AppResult<()> {
        std::fs::write(root.join(name), contents)?;
        Ok(())
    };

    write("manifest.json", CHROME_MANIFEST)?;
    write("manifest.firefox.json", FIREFOX_MANIFEST)?;
    write("background.js", BACKGROUND_JS)?;
    write("content.js", CONTENT_JS)?;
    write("popup.html", POPUP_HTML)?;
    write("popup.js", POPUP_JS)?;
    write(
        &format!("{NATIVE_HOST_NAME}.json"),
        &native_host_manifest(exe_path),
    )?;
    write("README.md", EXTENSION_README)?;
    Ok(())
}

/// Build the native-messaging host manifest, pointing the browser at this exe
/// launched with the host flag.
fn native_host_manifest(exe_path: &str) -> String {
    // JSON-escape the path (Windows backslashes).
    let escaped = exe_path.replace('\\', "\\\\").replace('"', "\\\"");
    format!(
        r#"{{
  "name": "{NATIVE_HOST_NAME}",
  "description": "VaultPeer native messaging host",
  "path": "{escaped}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://REPLACE_WITH_YOUR_EXTENSION_ID/"
  ],
  "allowed_extensions": [
    "vaultpeer@vaultpeer.app"
  ]
}}
"#
    )
}

/// On Windows, register the native-messaging host manifest under HKCU so Chrome
/// and Edge discover it. No-op (Ok) elsewhere.
#[cfg(windows)]
pub fn register_native_host(manifest_path: &str) -> AppResult<()> {
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    let keys = [
        format!("Software\\Google\\Chrome\\NativeMessagingHosts\\{NATIVE_HOST_NAME}"),
        format!("Software\\Microsoft\\Edge\\NativeMessagingHosts\\{NATIVE_HOST_NAME}"),
    ];
    let value = manifest_path.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();

    for subkey in keys {
        unsafe {
            let mut hkey = HKEY::default();
            let status = RegCreateKeyExW(
                HKEY_CURRENT_USER,
                &HSTRING::from(subkey.as_str()),
                0,
                None,
                REG_OPTION_NON_VOLATILE,
                KEY_WRITE,
                None,
                &mut hkey,
                None,
            );
            if status.is_err() {
                return Err(AppError::Other(format!(
                    "could not create registry key: {subkey}"
                )));
            }
            // Default value (empty name) = path to the manifest file.
            let bytes = std::slice::from_raw_parts(
                value.as_ptr() as *const u8,
                value.len() * std::mem::size_of::<u16>(),
            );
            let _ = RegSetValueExW(hkey, None, 0, REG_SZ, Some(bytes));
            let _ = RegCloseKey(hkey);
        }
    }
    Ok(())
}

/// Non-Windows stub: native-messaging host registration is performed manually
/// (the bundle's README explains where the manifest must be copied).
#[cfg(not(windows))]
pub fn register_native_host(_manifest_path: &str) -> AppResult<()> {
    Err(AppError::Other(
        "Automatic native-host registration is Windows-only. See the bundle README to install the manifest on this OS.".into(),
    ))
}

const CHROME_MANIFEST: &str = r#"{
  "manifest_version": 3,
  "name": "VaultPeer Connector",
  "version": "1.0.0",
  "description": "Suggest VaultPeer credentials for the current page.",
  "permissions": ["activeTab", "storage", "scripting", "nativeMessaging"],
  "host_permissions": ["http://127.0.0.1/*"],
  "action": { "default_popup": "popup.html", "default_title": "VaultPeer" },
  "background": { "service_worker": "background.js" },
  "content_scripts": [
    { "matches": ["<all_urls>"], "js": ["content.js"] }
  ]
}
"#;

const FIREFOX_MANIFEST: &str = r#"{
  "manifest_version": 2,
  "name": "VaultPeer Connector",
  "version": "1.0.0",
  "description": "Suggest VaultPeer credentials for the current page.",
  "browser_specific_settings": { "gecko": { "id": "vaultpeer@vaultpeer.app" } },
  "permissions": ["activeTab", "storage", "nativeMessaging", "http://127.0.0.1/*"],
  "browser_action": { "default_popup": "popup.html", "default_title": "VaultPeer" },
  "background": { "scripts": ["background.js"] },
  "content_scripts": [
    { "matches": ["<all_urls>"], "js": ["content.js"] }
  ]
}
"#;

const BACKGROUND_JS: &str = r#"// VaultPeer connector background worker.
// Talks to the local VaultPeer HTTP server. Configure the port/token in the popup.
const api = (typeof browser !== "undefined") ? browser : chrome;
const DEFAULT_PORT = 7796;

// storage.local.get works with both promise (Chrome MV3 / Firefox) and callback styles.
function storageGet(keys) {
  return new Promise((resolve) => {
    try {
      const maybe = api.storage.local.get(keys, resolve);
      if (maybe && typeof maybe.then === "function") maybe.then(resolve);
    } catch (e) { resolve({}); }
  });
}

async function getConfig() {
  const { port, token } = await storageGet(["port", "token"]);
  return { port: port || DEFAULT_PORT, token: token || "" };
}

async function suggest(url) {
  const { port, token } = await getConfig();
  const res = await fetch(`http://127.0.0.1:${port}/vaultpeer/suggest?url=${encodeURIComponent(url)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 423) throw new Error("VaultPeer is locked");
  if (!res.ok) throw new Error(`VaultPeer: HTTP ${res.status}`);
  return res.json();
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "suggest") {
    suggest(msg.url).then((r) => sendResponse({ ok: true, suggestions: r }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async
  }
});
"#;

const CONTENT_JS: &str = r#"// VaultPeer connector content script.
// Fills the page's login form from VaultPeer — automatically on load (best
// effort), and on demand when the popup's "Fill current page" button is clicked.
(function () {
  const api = (typeof browser !== "undefined") ? browser : chrome;

  function fill(suggestion) {
    const user = document.querySelector(
      'input[type="email"], input[name*="user" i], input[id*="user" i], input[name*="email" i], input[autocomplete="username"]'
    );
    const pass = document.querySelector('input[type="password"]');
    let filled = 0;
    if (user && suggestion.username) {
      user.focus();
      user.value = suggestion.username;
      user.dispatchEvent(new Event("input", { bubbles: true }));
      user.dispatchEvent(new Event("change", { bubbles: true }));
      filled++;
    }
    if (pass && suggestion.password) {
      pass.focus();
      pass.value = suggestion.password;
      pass.dispatchEvent(new Event("input", { bubbles: true }));
      pass.dispatchEvent(new Event("change", { bubbles: true }));
      filled++;
    }
    return filled;
  }

  function getSuggestions() {
    return new Promise((resolve) => {
      try {
        api.runtime.sendMessage({ type: "suggest", url: location.href }, (resp) =>
          resolve(resp || { ok: false, error: "no response from extension" })
        );
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  // On-demand fill, triggered from the popup. Replies with a status object.
  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "vaultpeer-fill") {
      getSuggestions().then((resp) => {
        if (!resp.ok) {
          sendResponse({ ok: false, error: resp.error || "lookup failed" });
        } else if (!resp.suggestions || resp.suggestions.length === 0) {
          sendResponse({ ok: false, error: "no-match" });
        } else {
          const s = resp.suggestions[0];
          const n = fill(s);
          sendResponse({ ok: n > 0, title: s.title, fields: n, count: resp.suggestions.length });
        }
      });
      return true; // async
    }
  });

  // Best-effort auto-fill on load (silent — the popup button is the reliable path).
  getSuggestions().then((resp) => {
    if (resp.ok && resp.suggestions && resp.suggestions.length) fill(resp.suggestions[0]);
  });
})();
"#;

const POPUP_HTML: &str = r#"<!doctype html>
<html><head><meta charset="utf-8"><title>VaultPeer</title>
<style>
  body{font:13px system-ui;width:260px;padding:12px;margin:0}
  h3{margin:0 0 8px}
  label{display:block;margin:6px 0 2px;color:#555}
  input{width:100%;box-sizing:border-box;padding:4px 6px}
  button{margin-top:8px;padding:6px 10px;cursor:pointer}
  #fill{width:100%;background:#10b981;color:#fff;border:0;border-radius:6px;font-weight:600}
  #status{margin:10px 0 0;min-height:1em;color:#333}
  details{margin-top:12px}
  summary{cursor:pointer;color:#555}
  .row{display:flex;gap:6px}
  .row button{flex:1}
</style>
</head><body>
<h3>VaultPeer Connector</h3>
<button id="fill">Fill current page</button>
<p id="status"></p>
<details>
  <summary>Connection settings</summary>
  <label>Port</label><input id="port" type="number" value="7796">
  <label>Token</label><input id="token" type="text" placeholder="paste from VaultPeer → Settings → Browser">
  <div class="row">
    <button id="save">Save</button>
    <button id="test">Test connection</button>
  </div>
</details>
<script src="popup.js"></script>
</body></html>
"#;

const POPUP_JS: &str = r#"const api = (typeof browser !== "undefined") ? browser : chrome;
const $ = (id) => document.getElementById(id);
const setStatus = (msg) => { $("status").textContent = msg; };

function storageGet(keys) {
  return new Promise((resolve) => {
    try {
      const maybe = api.storage.local.get(keys, resolve);
      if (maybe && typeof maybe.then === "function") maybe.then(resolve);
    } catch (e) { resolve({}); }
  });
}
function storageSet(obj) {
  return new Promise((resolve) => {
    try {
      const maybe = api.storage.local.set(obj, resolve);
      if (maybe && typeof maybe.then === "function") maybe.then(resolve);
    } catch (e) { resolve(); }
  });
}

// Attach handlers immediately so a storage hiccup can never disable the buttons.
$("save").addEventListener("click", async () => {
  await storageSet({ port: Number($("port").value) || 7796, token: $("token").value.trim() });
  setStatus("Saved.");
});

$("test").addEventListener("click", async () => {
  setStatus("Testing…");
  try {
    const res = await fetch(`http://127.0.0.1:${Number($("port").value) || 7796}/vaultpeer/health`);
    const j = await res.json();
    setStatus(j.unlocked ? "Connected — vault unlocked." : "Connected — vault is locked.");
  } catch (e) {
    setStatus("Not reachable. Is the connector server enabled in VaultPeer? " + e);
  }
});

function tabsQueryActive() {
  return new Promise((resolve) => {
    try {
      const maybe = api.tabs.query({ active: true, currentWindow: true }, resolve);
      if (maybe && typeof maybe.then === "function") maybe.then(resolve);
    } catch (e) { resolve([]); }
  });
}

function hostOf(url) {
  try { return new URL(url).host.replace(/^www\./, ""); } catch (e) { return url; }
}

// "Fill current page": ask the page's content script to fill from VaultPeer, and
// show a clear result. This is the reliable, on-demand path.
$("fill").addEventListener("click", async () => {
  setStatus("Looking up…");
  const tabs = await tabsQueryActive();
  const tab = tabs && tabs[0];
  if (!tab) { setStatus("No active tab."); return; }
  try {
    api.tabs.sendMessage(tab.id, { type: "vaultpeer-fill" }, (resp) => {
      const err = api.runtime.lastError;
      if (err) {
        setStatus("Reload this page, then try again. (" + err.message + ")");
        return;
      }
      if (!resp) { setStatus("No response from the page."); return; }
      if (resp.ok) {
        setStatus(`Filled “${resp.title}” (${resp.fields} field${resp.fields === 1 ? "" : "s"}).`);
      } else if (resp.error === "no-match") {
        setStatus("No VaultPeer entry's URL matches " + hostOf(tab.url || "") + ".");
      } else if (resp.error === "VaultPeer is locked") {
        setStatus("VaultPeer is locked — unlock it and retry.");
      } else {
        setStatus("Couldn't fill: " + resp.error);
      }
    });
  } catch (e) {
    setStatus("Reload this page, then try again. (" + e + ")");
  }
});

// Prefill saved values (non-blocking).
storageGet(["port", "token"]).then(({ port, token }) => {
  if (port) $("port").value = port;
  if (token) $("token").value = token;
});
"#;

const EXTENSION_README: &str = r#"# VaultPeer Browser Connector

This folder is a ready-to-load browser extension plus a native-messaging host
manifest, generated by VaultPeer.

## How it works

VaultPeer runs a small HTTP server on `127.0.0.1` (loopback only) when browser
integration is enabled in Settings → Browser. The extension asks that server for
credentials matching the current page's URL. All traffic stays on your machine.

## Using it

1. Make sure the entry in VaultPeer has the site in its **URL field** (e.g.
   `https://fill.dev` or `fill.dev`). Matching is by the URL's **host**, not the
   entry title.
2. Go to the login page, click the VaultPeer toolbar icon, and press
   **Fill current page**. The popup tells you what it filled — or "no entry's URL
   matches this site" / "VaultPeer is locked".
3. The extension also tries to auto-fill silently when a page loads, but the
   button is the reliable path (use it if a page was already open).

## Install the extension (Chrome / Edge)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Open the extension's popup, enter the **port** and **token** shown in
   VaultPeer → Settings → Browser, and click **Save** then **Test connection**.

## Install the extension (Firefox)

1. Rename `manifest.firefox.json` to `manifest.json` (back up the Chrome one).
2. Open `about:debugging` → **This Firefox** → **Load Temporary Add-on** and
   pick any file in this folder.

## Native messaging (optional / advanced)

**You do not need this for the bundled extension** — it already talks to
VaultPeer over the local HTTP server above. Native messaging is only useful if
you write your own extension that uses `chrome.runtime.connectNative` instead of
`fetch`. Registering the host therefore has no visible effect on this extension.

`com.vaultpeer.desktop.json` is the native-messaging host manifest. On Windows,
VaultPeer can register it for you (Settings → Browser → *Register native host*).
On other systems, copy it to your browser's NativeMessagingHosts directory and
replace `REPLACE_WITH_YOUR_EXTENSION_ID` with your unpacked extension's ID.

## Troubleshooting

- **Save/Test do nothing** — you're on an old export. Re-export the extension
  from VaultPeer (Settings → Browser) and reload it unpacked; the new manifest
  includes the `storage` permission the popup needs.
- **"Not reachable"** — make sure *Enable connector server* is on in VaultPeer,
  and the port in the popup matches the one shown there.
- **"vault is locked"** — unlock your database in VaultPeer, then retry.
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::{create_entry, EntryInput};

    fn db_with_urls() -> Database {
        let mut db = Database::new();
        let gid = db.root_mut().add_group().edit(|g| g.name = "G".into()).id();
        let gid = gid.uuid().to_string();
        let mut mk = |title: &str, url: &str| {
            create_entry(
                &mut db,
                &gid,
                &EntryInput {
                    title: title.into(),
                    username: format!("{title}-user"),
                    password: "pw".into(),
                    url: url.into(),
                    ..Default::default()
                },
            )
            .unwrap();
        };
        mk("GitHub", "https://github.com/login");
        mk("GitHub Gist", "https://gist.github.com");
        mk("Example", "https://www.example.com");
        db
    }

    #[test]
    fn host_of_strips_scheme_port_and_www() {
        assert_eq!(host_of("https://www.example.com:443/path"), Some("example.com".into()));
        assert_eq!(host_of("http://user@host.test/x"), Some("host.test".into()));
        assert_eq!(host_of(""), None);
    }

    #[test]
    fn matches_exact_and_subdomain() {
        let db = db_with_urls();
        // Exact host → GitHub ranks above the gist subdomain entry.
        let ids = matching_entry_ids(&db, "https://github.com/settings");
        assert!(!ids.is_empty());
        let top = db.entry(ids[0]).unwrap();
        assert_eq!(top.get(fields::TITLE), Some("GitHub"));

        // A page on a subdomain matches the parent-domain entry too.
        let ids = matching_entry_ids(&db, "https://mail.example.com");
        let titles: Vec<_> = ids
            .iter()
            .map(|id| db.entry(*id).unwrap().get(fields::TITLE).unwrap().to_string())
            .collect();
        assert!(titles.contains(&"Example".to_string()));
    }

    #[test]
    fn no_match_returns_empty() {
        let db = db_with_urls();
        assert!(matching_entry_ids(&db, "https://unrelated.test").is_empty());
    }

    #[test]
    fn suggestions_include_credentials() {
        let db = db_with_urls();
        let s = suggestions_for(&db, "https://github.com", 10);
        assert!(!s.is_empty());
        assert_eq!(s[0].title, "GitHub");
        assert_eq!(s[0].password, "pw");
    }

    #[test]
    fn percent_decode_handles_escapes() {
        assert_eq!(percent_decode("a%20b+c"), "a b c");
        assert_eq!(percent_decode("https%3A%2F%2Fx"), "https://x");
    }

    #[test]
    fn native_host_manifest_is_valid_json() {
        let m = native_host_manifest(r"C:\Program Files\VaultPeer\vaultpeer.exe");
        let v: serde_json::Value = serde_json::from_str(&m).unwrap();
        assert_eq!(v["name"], NATIVE_HOST_NAME);
        assert_eq!(v["type"], "stdio");
    }
}
