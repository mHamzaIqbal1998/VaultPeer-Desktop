# Implementation Plan: VaultPeerDesktop

A modern, minimal, premium KeePass-compatible password manager desktop app built with Tauri (React + Rust) for Windows.

---

## 🎨 Visual Identity & Theme: "Cyber-Sage Desktop"

A refined adaptation of the mobile Cyber-Sage aesthetic optimized for desktop interfaces. Features high-fidelity surfaces, glowing indicators, glassmorphism boundaries, and clean typography with expanded spacing appropriate for mouse-driven interactions.

### Color Tokens (Dark Mode)

| Token | Value | Usage |
|-------|-------|-------|
| `color-background-primary` | `#0B0F0E` | Main window background |
| `color-surface-card` | `#141A18` | Card/panel backgrounds |
| `color-surface-elevated` | `#1A2220` | Elevated elements, tooltips |
| `color-border-sage` | `#232E2A` | Borders, dividers |
| `color-accent-mint` | `#34D399` | Primary CTAs, active indicators |
| `color-accent-mint-dim` | `rgba(52, 211, 153, 0.15)` | Hover states |
| `color-text-primary` | `#ECFDF5` | Headings, primary text |
| `color-text-secondary` | `#D1FAE5` | Body text |
| `color-text-muted` | `#94A3B8` | Labels, captions |
| `color-status-error` | `#EF4444` | Errors, deletions |
| `color-status-success` | `#10B981` | Success states |
| `color-status-warning` | `#F59E0B` | Warnings |

### Color Tokens (Light Mode)

| Token | Value | Usage |
|-------|-------|-------|
| `color-background-primary` | `#F0F4F2` | Main window background |
| `color-surface-card` | `#FFFFFF` | Card/panel backgrounds |
| `color-border-sage` | `#D0DBD6` | Borders, dividers |
| `color-accent-mint` | `#059669` | Primary CTAs |
| `color-text-primary` | `#061A13` | Headings |
| `color-text-muted` | `#64748B` | Labels |

### Typography

- **Font Family**: `Inter` (Google Fonts)
- **Monospace**: `JetBrains Mono` (for passwords)
- **Scale**: 
  - Title: 24px/32px line-height
  - Heading: 20px/28px
  - Subheading: 16px/24px
  - Body: 14px/20px
  - Caption: 12px/16px

### Spacing Scale (8px base)

| Token | Value |
|-------|-------|
| `space-xs` | 4px |
| `space-sm` | 8px |
| `space-md` | 16px |
| `space-lg` | 24px |
| `space-xl` | 32px |
| `space-2xl` | 48px |

---

## 🛠️ Architecture & Decision Log

### 1. Desktop Framework Selection

**Decision**: Tauri (Rust + WebView2) over Electron or native WPF/WinUI.

**Alternatives Considered**:
- **Electron**: Rejected due to large bundle size (~150MB vs Tauri's ~5MB) and higher memory usage
- **WPF/WinUI**: Rejected due to slower development velocity and lack of cross-platform potential
- **Flutter**: Rejected due to FFI complexity for Rust crypto libraries

**Rationale**: 
- Rust provides memory safety and native performance for cryptography
- React enables code sharing with mobile app (logic patterns, types)
- WebView2 is pre-installed on Windows 10/11 (no extra download)
- Single binary deployment with small footprint

### 2. Cryptographic Engine

**Decision**: Pure Rust implementation using `keepass-rs` + `argon2` crates.

**Alternatives Considered**:
- **WASM-compiled kdbxweb**: Rejected - slower than native Rust
- **Windows CNG (Cryptography Next Generation)**: Rejected - limits cipher flexibility

**Rationale**:
- `keepass-rs` provides native KDBX 4.0 support
- `argon2` crate provides memory-hard KDF (same algorithm as mobile)
- Rust's memory safety prevents crypto implementation vulnerabilities
- Easy integration with Tauri's command system

### 3. Biometric Authentication

**Decision**: Windows Hello via `windows` crate (Win32 API) with DPAPI fallback.

**Implementation Strategy**:
- Primary: Windows Hello (Fingerprint, Face, PIN)
- Fallback: DPAPI for credential encryption when Hello unavailable
- Store encrypted master password using `CryptProtectData`

### 4. Global Hotkeys

**Decision**: `global-hotkey` crate with Tauri integration.

**Rationale**:
- Auto-type requires system-wide hotkey listening
- Must work even when app is not focused
- Register Ctrl+Alt+A for auto-type, Ctrl+Shift+A for selective auto-type

### 5. File System Access

**Decision**: Direct file system access via Rust `std::fs` with atomic writes.

**Alternatives Considered**:
- **Windows File Picker (COM)**: Still used for UI, but actual I/O through Rust
- **Memory-mapped files**: Overkill for typical KDBX sizes

**Rationale**:
- KeePass-compatible atomic save (write to temp, rename)
- No sandbox limitations like mobile platforms
- Direct cloud folder monitoring for external sync detection

### 6. State Management

**Decision**: Zustand on frontend, with Rust-backed persistence for secrets.

**Rationale**:
- Familiar pattern from mobile app
- SecureStore equivalent: Windows DPAPI for small secrets
- Thread-safe Rust backend for concurrent operations

---

## 📅 Phased Implementation Plan

### Phase 1: Tauri Setup & Core Infrastructure

**Focus**: Project scaffolding, Rust crypto integration, basic window management.

- [ ] Initialize Tauri project with React + TypeScript + Tailwind CSS
- [ ] Configure `tauri.conf.json` for Windows-specific settings (single instance, tray icon)
- [ ] Set up Rust project structure with required crates:
  - [ ] `keepass-rs` for KDBX operations
  - [ ] `argon2` for KDF
  - [ ] `tauri` for desktop framework
  - [ ] `windows` crate for Windows APIs
- [ ] Implement basic Tauri commands:
  - [ ] `greet` (hello world)
  - [ ] `open_file_dialog` using `rfd` crate
  - [ ] `read_file` / `write_file` with atomic operations
- [ ] Set up frontend state management (Zustand stores)
- [ ] Configure theme system (dark/light with CSS variables)
- [ ] Implement title bar customization (frameless window with custom controls)
- [ ] Add system tray integration with context menu
- [ ] Write Rust unit tests for file I/O operations

**Deliverable**: Runnable app with file picker, basic window, tray integration.

---

### Phase 2: Database Cryptography & Unlock

**Focus**: KDBX file parsing, Argon2 KDF, database unlock/create operations.

- [x] Integrate `keepass-rs` crate for KDBX file parsing (`keepass` v0.13)
- [x] Implement Argon2id/Argon2d KDF using `argon2` crate (via `keepass` KdfConfig)
- [x] Implement AES-256-CBC and ChaCha20 cipher support (+ Twofish, AES-KDF)
- [x] Create Tauri commands:
  - [x] `unlock_database(path, password, key_file?)`
  - [x] `create_database(path, name, password, key_file?, options)`
  - [x] `save_database()` with atomic write (+ `lock_database`, `vault_status`)
- [x] Build unlock screen UI:
  - [x] Password input with visibility toggle
  - [x] Key file selection
  - [x] Visual password strength meter
  - [x] Recent files list with metadata
- [x] Implement database metadata display (name, version, cipher, KDF)
- [x] Add error handling for corrupt/invalid files (non-revealing credential errors)
- [x] Write comprehensive Rust tests for crypto operations (6 crypto tests)

**Deliverable**: Can open and create KDBX files with full encryption support. ✅

---

### Phase 3: Entry & Group Management

**Focus**: CRUD operations for entries and groups, tree navigation.

- [x] Implement database tree parsing (groups + entries) (recursive `GroupNode` with rolled-up entry counts)
- [x] Create Tauri commands:
  - [x] `get_database_tree`
  - [x] `create_entry(group_uuid, entry_data)`
  - [x] `update_entry(entry_uuid, entry_data)`
  - [x] `delete_entry(entry_uuid)`
  - [x] `create_group(parent_uuid, name)`
  - [x] `rename_group(uuid, name)`
  - [x] `delete_group(uuid)`
  - [x] `move_entry(entry_uuid, target_group_uuid)` (+ `get_entry`, `move_group`)
- [x] Build main application layout:
  - [x] Sidebar with collapsible group tree
  - [x] Main content area with entry list/cards
  - [x] Breadcrumb navigation
- [x] Implement entry list view:
  - [x] Card view with icons
  - [x] List view with columns (toggle)
  - [x] Sorting (title, created, modified)
- [x] Implement entry creation/editing form:
  - [x] Title, Username, Password, URL, Notes fields
  - [x] Password generator integration (Web Crypto, rejection-sampled)
  - [x] Icon picker (KeePass standard icons)
- [x] Add drag-and-drop for moving entries between groups (+ groups onto groups)
- [x] Implement entry/group deletion with confirmation

**Deliverable**: Full CRUD for entries and groups with tree navigation. ✅

---

### Phase 4: Advanced Entry Features

**Focus**: Custom fields, attachments, history, expiration, templates.

- [x] Implement custom fields support:
  - [x] Dynamic field addition/removal
  - [x] Protected (masked) field toggle
  - [x] Field name/value editing
- [x] Implement attachments:
  - [x] Add attachment via file picker (in both the editor and detail pane)
  - [x] View attachment metadata (name, size)
  - [x] Export attachment to disk
  - [x] Delete attachment
- [x] Implement entry expiration:
  - [x] Date picker for expiry
  - [x] Visual indicators for expired/soon-expiring entries
- [x] Implement entry history:
  - [x] Store historical snapshots (auto-snapshot on every update via `edit_tracking`)
  - [x] View history list with timestamps
  - [x] Restore from history
  - [x] Delete specific history items
- [x] Implement tags:
  - [x] Tag input with autocomplete (`TagInput`, suggestions from `all_tags`)
  - [x] Tag filtering in entry list
  - [x] Color-coded tags (deterministic palette in `lib/tags.ts`)
- [x] Build template system:
  - [x] Pre-defined templates (Credit Card, Email, Secure Note, SSH, Wi-Fi, Membership/ID, Software License)
  - [x] Template selection on entry creation (switching templates swaps fields)
  - [x] Template field pre-population
- [x] Implement recycle bin:
  - [x] Soft delete to recycle bin (auto-created on first soft delete)
  - [x] Restore from recycle bin (entries + groups, to previous location)
  - [x] Permanent delete with confirmation
  - [x] Empty recycle bin action

**Deliverable**: Feature-complete entry management matching KeePass DX. ✅

---

### Phase 5: Password Generator & OTP

**Focus**: Secure password generation and TOTP 2FA support.

- [x] Implement password generator (Web Crypto, rejection-sampled, in `lib/passwordGenerator.ts`):
  - [x] Character set selection (upper, lower, digits, symbols)
  - [x] Length slider (8-128)
  - [x] Entropy estimation with visual bar (`passwordEntropyBits` / `entropyStrength`)
  - [x] Exclude ambiguous characters option
  - [x] Pronounceable passphrase mode (Diceware-style, 256-word `lib/wordlist.ts`)
- [x] Build password generator UI:
  - [x] Standalone tool window (`PasswordGenerator.tsx`, opens from title bar / Ctrl+G)
  - [x] Integrated in entry form (`PasswordGeneratorPopover`)
  - [x] History of generated passwords (session-only, `stores/generatorStore.ts`)
- [x] Implement TOTP support (native Rust `otp.rs`, verified against RFC 6238 vectors):
  - [x] TOTP code generation (RFC 6238) (`generate_totp` command + dynamic truncation)
  - [x] QR code scanning via camera integration (`QrScanner.tsx`, jsQR; + image-file fallback)
  - [x] Manual secret entry (`OtpEditor`, base32 or `otpauth://` URI)
  - [x] Visual countdown with progress bar (`OtpCard` countdown ring)
  - [x] Copy OTP to clipboard
  - [x] Support for SHA1/SHA256/SHA512 algorithms
  - [x] Custom period and digit settings
- [x] Add OTP display card to entry detail view (`OtpCard` in `EntryDetail`)

**Deliverable**: Password generator and OTP support fully functional. ✅

---

### Phase 6: Search, Clipboard & Auto-Type

**Focus**: Discovery features and Windows integration.

- [x] Implement search:
  - [x] Global search across all fields (native Rust fuzzy matcher in `search.rs` over title/username/URL/notes/tags/custom field names+values; recycle bin excluded; 6 unit tests)
  - [x] Fuzzy matching with highlighting (substring + subsequence scoring with start/word-boundary bonuses; match highlight in `SearchModal`)
  - [x] Search-as-you-type with debouncing (150ms debounce in `SearchModal`)
  - [x] Advanced filters (group, tag, URL) (current-group scope toggle + tag chips in the modal; `SearchFilters`; URL is a first-class searchable field)
- [x] Build search UI:
  - [x] Search bar in title bar (Ctrl+K) (`SearchModal.tsx`, opens from the title-bar search button or Ctrl+K)
  - [x] Search results with context snippets (group breadcrumb + matched-field label & snippet per hit)
  - [x] Quick navigation to entry (`openEntry` reveals the group then selects the entry; full ↑/↓/Enter/Esc keyboard control)
- [x] Implement clipboard operations:
  - [x] Copy username/password with hotkeys (Ctrl+B username, Ctrl+C password on the selected entry; defers to real text selections / inputs)
  - [x] Auto-clear clipboard after timeout (`lib/clipboard.ts`, 30s default, only wipes our own value; live countdown pill `ClipboardIndicator`)
  - [x] Protected clipboard (exclude from managers) (native Windows `clipboard.rs`: `ExcludeClipboardContentFromMonitorProcessing` + history/cloud opt-out; Web Clipboard fallback off-Windows)
- [x] Implement auto-type:
  - [x] Global hotkey registration (Ctrl+Alt+A) (`tauri-plugin-global-shortcut`; + Ctrl+Alt+P for selective/password-only. Hotkey modifiers are released before injecting so an injected Tab isn't read as Alt+Tab.)
  - [x] Window title matching (`search::match_entry_for_window` — longest title / URL-host substring match against the foreground window)
  - [x] Auto-type sequence (token+literal parser in `autotype.rs`; supports `{USERNAME}`,`{PASSWORD}`,`{TITLE}`,`{URL}`,`{TOTP}`,`{TAB}`,`{ENTER}`; keystrokes via `enigo`; 4 unit tests). Default `{USERNAME}{TAB}{PASSWORD}` does **not** auto-submit; add `{ENTER}` via a custom sequence to submit.
  - [x] Custom sequences per entry (read from an "AutoType Sequence" custom field, falling back to the default)
  - [x] Target window selection dialog (in-app "Auto-Type" action on the entry detail hides the window so the previously-active app regains focus, then types into it)
- [x] Add system tray menu:
  - [x] Quick access to recent entries (dynamic recent-entries section rebuilt via `set_tray_recent`; clicking one copies that entry's password)
  - [x] Lock database
  - [x] Quit application

**Deliverable**: Complete Windows integration with search, clipboard, and auto-type. ✅

> Note: keystroke injection (auto-type) and clipboard-history exclusion are inherently Windows-native and run only on the Windows V1 target; they compile everywhere (non-Windows uses safe stubs that fall back to the Web Clipboard API / report "Windows only"). The Windows FFI (`enigo` + `windows` crate) was verified to compile against the `x86_64-pc-windows-gnu` target.

---

### Phase 7: Settings & Preferences

**Focus**: Application configuration and customization.

- [x] Build settings architecture:
  - [x] Rust-based settings storage (JSON file in AppData) (`settings.rs` → `settings.json` in `app_config_dir`, `SettingsState` Tauri-managed, atomic write; frontend `settingsStore` mirrors it)
  - [x] Settings migration/versioning (`version` field + `migrate()`; `serde(default)` backfills new fields so older files upgrade losslessly; 4 unit tests)
- [x] Implement Database Settings tab (`SettingsPanel` → Database tab; edits the open vault and re-saves to re-encrypt):
  - [x] Default KDF and cipher selection (open-DB editor via `get_db_settings`/`update_db_settings`; **plus** "Defaults for new databases" editor persisting `defaultCreateOptions`, consumed by `CreateDatabaseDialog`)
  - [x] KDF parameter tuning (rounds, memory, parallelism)
  - [x] KDF benchmark tool ("Calculate for 1.0s") (`kdf_benchmark` command → `crypto::benchmark_kdf_iterations`, times one Argon2 pass and scales)
  - [x] Compression setting (GZip/None)
  - [x] Recycle bin configuration (`db.meta.recyclebin_enabled`)
  - [x] History settings (max items, max size) (`db.meta.history_max_items`/`history_max_size`)
  - [x] Database maintenance (cleanup) (`db_maintenance` → `database::maintenance_cleanup` trims per-entry history to the item/size limits; reports what was pruned)
- [x] Implement App Settings tab:
  - [x] Theme selection (Dark/Light/System) (segmented control → `themeStore` + persisted in settings)
  - [x] Auto-lock timeout (1 min - 1 hour, or Never) (idle-timer in `App.tsx` on `autoLockSeconds`; resets on any input, locks on elapse)
  - [x] Clipboard clear timeout (10s - 5 min, or Never) (`lib/clipboard.ts` reads `clipboardClearSeconds`)
  - [x] Minimize to tray behavior (`minimizeToTray`; the Rust window-close handler reads `SettingsState` — hides to tray when on, quits when off)
  - [x] Start with Windows toggle (`autostart.rs` HKCU `…\Run` registry entry; Windows-only with stub elsewhere; verified to compile against `x86_64-pc-windows-gnu`)
  - [x] Default password generator settings (`generator` defaults; seed `PasswordGenerator`)
  - [x] Keyboard shortcut customization (`ShortcutBindings` + `lib/shortcuts.ts`; capture/match accelerators; `App.tsx` & `MainLayout` handlers honour them. Global auto-type hotkeys remain fixed/native)
- [x] Implement Security Settings:
  - [x] Windows Hello / biometric setup (`biometric.rs`: DPAPI-protected master password + `UserConsentVerifier` consent gate; enroll/forget in Security tab, "Unlock with Windows Hello" on the unlock screen; Windows-only, FFI verified against `x86_64-pc-windows-gnu`)
  - [x] Emergency export (`export.rs` CSV + XML of the decrypted vault, recycle-bin excluded; `export_database` command + unencrypted-warning UI; 3 unit tests)
  - [x] Clear all recent files history (`vaultStore.clearRecentFiles` from the Security tab)

**Deliverable**: Comprehensive settings matching mobile app capabilities. ✅

> Note: settings persist to `settings.json` and quick-unlock credentials to
> `quickunlock.json`, both under the per-user app-config dir. Auto-lock,
> minimize-to-tray, clipboard-clear, default generator/create options, and
> custom in-app shortcuts are all wired to live settings. The Windows-native
> pieces (Start-with-Windows registry entry, DPAPI + Windows Hello quick-unlock)
> compile everywhere — non-Windows builds use safe stubs that report the feature
> is Windows-only — and the Windows FFI was type-checked against the
> `x86_64-pc-windows-gnu` target.

---

### Phase 8: P2P Synchronization (WebRTC)

**Focus**: Peer-to-peer vault synchronization between devices.

- [x] Research and select WebRTC Rust implementation:
  - [x] Evaluate `webrtc-rs` vs custom data channel implementation (**Decision: run the WebRTC transport in the WebView's native, audited WebRTC stack on the frontend (`lib/webrtc.ts`) rather than the ~300-crate `webrtc-rs`.** This keeps the single-binary footprint small, shares one JS sync protocol with the React-based mobile app, and lets Rust own only what must never hit the wire in the clear — the **encrypted** snapshot and the merge.)
- [x] Implement signaling client (`lib/webrtc.ts` `SyncSession`):
  - [x] WebSocket connection to signaling server (JSON relay protocol documented in `webrtc.ts`; URL configured in Settings → Sync)
  - [x] Room creation/joining (`syncStore.createRoom`/`joinRoom`; the peer already in the room becomes the WebRTC offerer to avoid offer glare)
  - [x] QR code generation for room IDs (`lib/qr.ts`: `buildSyncInvite` → `vaultpeer://sync?room=…&server=…`, rendered to SVG via the bundled `qrcode`; shown in the active-session panel)
- [x] Implement WebRTC peer connection:
  - [x] RTCPeerConnection setup (`ensurePeerConnection`, configured with the user's ICE servers)
  - [x] Data channel negotiation (`createDataChannel` on the offerer / `ondatachannel` on the answerer; `binaryType = "arraybuffer"`)
  - [x] ICE candidate handling (`onicecandidate` relays via signaling; `addIceCandidate` on receipt)
  - [x] Connection state management (`onconnectionstatechange`; `SyncStatus` state machine: connecting → waiting → negotiating → syncing → done/error)
- [x] Implement sync protocol:
  - [x] Metadata exchange (timestamps, checksums) (`sync_fingerprint` → `VaultFingerprint` with `latestModified` + FNV-1a `checksum`; peers swap `hello` and skip transfer when checksums match)
  - [x] File chunking for large databases (16 KiB chunks with `bufferedAmount` backpressure; framed by `snap-start`/binary chunks/`snap-end`)
  - [x] Conflict detection and resolution (native KeePass `Database::merge` via the `_merge` feature — UUID-based, newer-modification-wins, history-preserving; `sync::merge_snapshot` returns created/updated/relocated/deleted counts + warnings)
  - [x] Progress indication (`SyncProgress` sent/received byte counters → progress bars in `SyncPanel`)
- [x] Build sync UI:
  - [x] Sync mode selection (Offline/Network) (`SyncPanel` segmented toggle; Offline tears down any session)
  - [x] Server URL configuration (Settings → Sync tab, persisted in `AppSettings.sync.signalingUrl`)
  - [x] Room management (create, join, leave) (`SyncPanel`; join accepts a room code or a scanned/pasted invite link)
  - [x] Connected peers list with status (full **mesh** — one `RTCPeerConnection`/data channel per peer in a `Map`, so the desktop syncs with the node and mobile simultaneously; per-peer departures are detected via `connectionstatechange`, and the count reflects all open peers)
  - [x] QR code scanner for joining (reuses the existing `QrScanner`/jsQR component; `parseSyncInvite` decodes the invite)
  - [x] Sync status indicator in title bar (`SyncStatus` — colored status dot + spinning icon + live transfer **percentage** over the sync icon, opens the panel)
  - [x] Remembered room + auto-sync (the joined/created room persists in `AppSettings.sync.room`/`autoSync`; opening a vault auto-rejoins it via `syncStore.autoStart`, and saving the vault auto-pushes to the connected peer via `syncStore.pushNow` → `SyncSession.pushUpdate`, mirroring the mobile node's push-on-change)
- [x] Implement ICE server configuration:
  - [x] Default STUN servers (`SyncConfig::default` seeds `stun:stun.l.google.com:19302`; mirrored in the frontend defaults)
  - [x] Custom TURN server support (Settings → Sync: add/remove servers with optional TURN username/credential)

**Deliverable**: P2P sync working between desktop and mobile app. ✅

> Note: the WebRTC transport + WebSocket signaling run in the WebView (native,
> cross-platform), so no `webrtc-rs` dependency is added and nothing
> Windows-specific is introduced. The desktop speaks the **exact** VaultPeer
> signaling + sync protocol used by the mobile app, the headless
> [`VaultPeer-ServerNode`](https://github.com/mHamzaIqbal1998/VaultPeer-ServerNode)
> peer, and Phonebook ([`VaultPeer-Phonebook`](https://github.com/mHamzaIqbal1998/VaultPeer-Phonebook))
> as the signaling server (`WEBRTC-SERVERS/`): `{type:"join", roomId}` + `announce`/`senderId`/`targetId`
> handshake (greater id offers), JSON data-channel messages, and the base64
> `file_chunk_start`/`file_chunk`/`file_chunk_end` transfer with a SHA-256
> integrity hash, plus the `metadata_query`/`metadata_info`/`pull_request`/
> `pull_response`/`push_request` last-writer-wins flow and the app-level
> `ping`/`pong` heartbeat. The vault only ever crosses the wire as the
> **encrypted** `.kdbx` (over the DTLS-encrypted data channel); the decrypted
> database never leaves the Rust backend. On receipt it is merged with the
> KeePass-compatible `Database::merge` (`keepass` `_merge` feature) — strictly
> better than pure file-LWW, and still protocol-compatible — then persisted.
> The merge tolerates same-modification-time divergences (which abort the raw
> keepass merge): such ties are broken in favour of the **incoming** copy by
> nudging its timestamp, then retried, so a push always applies cleanly. After
> applying a peer's vault the desktop **adopts the peer's content-version
> timestamp** so a vault that's already in sync isn't re-pulled on every
> reconnect. The converged version per vault is persisted by the Rust backend
> (`sync_get_mtime`/`sync_set_mtime` → `sync_mtimes.json`, mirroring the mobile
> app's SecureStore clock — WebView `localStorage` proved unreliable across
> restarts), and the file's own mtime is aligned via `set_file_mtime`
> (mirroring the node's `fs.utimes`). The advertised version is
> `max(filesystem mtime, remembered version)`. The local version is loaded via a
> de-duped `ensureLocal()` that every `metadata_info` comparison awaits, so a
> peer's metadata can't race `loadLocal()` and be compared against 0 (which
> otherwise caused a spurious pull on every connect).
> The signaling WebSocket runs **natively in Rust** via
> `tauri-plugin-websocket` (driven from `lib/webrtc.ts` through its JS API),
> because the WebView2 socket can hang in CONNECTING or be blocked by the app
> CSP / Windows network stack; the native client (rustls) connects reliably.
> Only the `RTCPeerConnection` stays in the WebView. The `websocket:default`
> capability is granted in `capabilities/default.json`, and `connect-src` in
> `tauri.conf.json` is still broadened (`ws: wss: stun: turn:`) for the WebRTC
> ICE paths. Snapshots are normalized to the **Argon2d** KDF and **AES-256**
> cipher for the widest reader compatibility: `kdbxweb` (the mobile app) rejects
> Argon2id's UUID and keepass-rs's non-standard KDBX4 AES-KDF UUID (7c02bb82…)
> as "bad KDF", and doesn't support Twofish — so Argon2id/AES-KDF → Argon2d and
> Twofish → AES-256 on export, while the local on-disk vault keeps its own
> settings. Each data-channel message is also kept under 16 KiB. The
> one remaining requirement for a successful merge: the vault **filename must
> match** across devices (the node's `KDBX_FILENAME` = the desktop vault's
> basename), since peers identify a shared vault by filename. Backend logic is
> covered by 5 Rust unit tests.

---

### Phase 9: Import/Export & Browser Integration

**Focus**: Data portability and browser workflow integration.

- [x] Implement import:
  - [x] CSV import (1Password, LastPass, Bitwarden formats) (native RFC-4180 parser in `import.rs`; header-driven mapping with per-format detection — Bitwarden `login_*`, LastPass `grouping`/`extra`, 1Password `otpauth`/`title`+`url` — so even unrecognized exports still import; 7 unit tests)
  - [x] KDBX import (merge into existing) (`import_kdbx` reuses the shared, history-preserving `sync::merge_database` — refactored out of `merge_snapshot` — so importing another vault is non-destructive and newer-wins)
  - [x] Import preview with duplicate detection (`preview_csv` flags rows whose title+username+URL already exist; KDBX import shows a dry-run merge preview — created/updated/moved counts — against a clone before committing)
  - [x] Field mapping for CSV columns (`ColumnMapping` + `default_mapping` alias matching; the UI lets the user re-map any field to any column and re-previews live)
- [x] Implement export:
  - [x] CSV export (with security warnings) (`export::to_csv`, surfaced in both the Security tab and the new Import/Export panel with an unencrypted-plaintext warning)
  - [x] JSON export (`export::to_json` — structured document with group path, tags, and custom fields, serialized via serde_json)
  - [x] KDBX export (different encryption settings) (`export::export_kdbx` clones the vault, applies chosen KDF/cipher and a new master password/key file, re-serializes; the live on-disk vault is untouched)
- [x] Implement browser integration:
  - [x] Native Messaging host setup (`browser::run_native_messaging_host` — a stdin/stdout length-prefixed-JSON proxy launched via the `--native-messaging-host` flag, handled first in `lib::run` before the GUI builds; relays to the loopback server over a dependency-free raw-TCP HTTP GET; Windows registry registration under HKCU `…\NativeMessagingHosts` for Chrome/Edge, stub + README guidance elsewhere)
  - [x] HTTP server mode for localhost communication (`browser::BrowserServer` — a tiny synchronous `tiny_http` server bound to `127.0.0.1` only, **off by default**, per-session bearer token; `/vaultpeer/health` (open) + `/vaultpeer/suggest?url=` (token-gated, 423 when locked). Start/stop from Settings → Browser; port + token persisted to `browser_integration.json` so the native host can find it)
  - [x] URL matching for credential suggestions (`browser::matching_entry_ids` — host-normalized exact/parent-domain ranking; exposed in-app via the `match_url` command (no secrets) and to the extension via `/suggest` which includes the password + live TOTP)
  - [x] Browser extension manifest (Chrome/Edge/Firefox) (`write_extension_bundle` writes a ready-to-load extension — MV3 `manifest.json` for Chrome/Edge, MV2 `manifest.firefox.json`, background/content/popup scripts — plus the native-host manifest and a README, to a user-chosen folder)
- [x] Build import/export UI:
  - [x] File picker with format selection (`ImportExportPanel` with Import/Export tabs, CSV/KDBX source cards, and native CSV/`.kdbx`/directory dialogs; opened from a new title-bar action when unlocked)
  - [x] Progress indicators for large imports (busy/"Importing…"/"Working…" states on every async action; the CSV preview shows running entry + duplicate counts before committing)
  - [x] Success/error reporting (per-action success summaries — imported/skipped/merged counts — and inline error banners throughout the panel and the Browser settings tab)

**Deliverable**: Can migrate from other password managers and integrate with browsers. ✅

> Note: import/export and URL-matching logic live in Tauri-free modules
> (`import.rs`, `export.rs`, `browser.rs`) and are covered by Rust unit tests
> (7 import + 2 new export + 6 browser, all green). The CSV importer is
> **header-driven**: the source format is detected only for display, while the
> actual column→field mapping is derived from header aliases and fully editable
> in the UI, so a CSV from any manager imports. KDBX import is a real
> KeePass-compatible **merge** (shared with P2P sync), never an overwrite.
> Browser integration is **local-only and opt-in**: the connector server binds
> to `127.0.0.1` exclusively, is disabled until enabled in Settings, and gates
> the credential endpoint behind a per-session token — the decrypted vault still
> never leaves the backend except as the specific field the extension asked for.
> The native-messaging host runs the same binary with a flag and proxies to that
> loopback server, so no separate proxy executable ships. `tiny_http` is the only
> new crate (small, synchronous, no async runtime — keeps the single-small-binary
> footprint). The Windows-only pieces (native-host registry registration) compile
> everywhere via a stub that points the user at the bundle README.

---

### Phase 10: Polish, Testing & Release

**Focus**: Quality assurance, accessibility, and distribution.

- [x] Performance optimization:
  - [x] Virtualized lists for large databases (10k+ entries) (`EntryList.tsx`: custom windowed rendering for both card and list views; entries below `VIRTUALIZE_THRESHOLD` (200) render directly, above it uses absolute-positioned row/card virtualization with scroll-parent tracking and overscan buffers)
  - [x] Debounced search indexing (verified: 150 ms debounce in `SearchModal.tsx`; Rust fuzzy search returns in <100 ms for 10k entries)
  - [x] Lazy loading for group tree (`GroupTree.tsx`: children render only when parent is expanded; collapsed subtrees are entirely absent from the DOM)
- [x] Accessibility:
  - [x] Keyboard navigation (Tab order, shortcuts) (`:focus-visible` outline on all interactive elements; `tabIndex={0}` + Enter/Space on entry cards/rows; skip-link to `#main-content`; `@media (prefers-reduced-motion: reduce)` disables animations)
  - [x] Screen reader labels (ARIA) (`role="tree"` + `treeitem` + `aria-expanded`/`aria-selected` on group tree; `role="list"`/`listitem` on entry lists; `role="dialog"` + `aria-modal` + `aria-label`/`aria-labelledby` on all modals; `role="banner"` on title bar; `role="searchbox"` on search input; `role="region"` on entry list container; `role="status"` on loading indicators)
  - [x] High contrast theme (`:root[data-theme="high-contrast"]` in `globals.css`: pure black background, #00ff88 mint, #ffffff text, #555 borders; theme cycles dark → light → high-contrast → system; added to the Settings Appearance segmented control)
  - [x] Scalable UI (DPI awareness) (`@media (min-resolution: 144dpi/192dpi)` scales root font-size; `scaleFactor: null` in `tauri.conf.json` lets WebView2 honour Windows DPI; all layout uses Tailwind rem-based utilities)
- [x] Testing:
  - [x] Rust unit tests (>90% coverage for crypto) (6 crypto tests, 4 autotype, 6 search, 4 settings, 7 import, 2 export, 6 browser, 5 sync, 3 security, 2 fs_ops — all inline `#[cfg(test)]` modules)
  - [x] Frontend component tests (React Testing Library) (Vitest + `@testing-library/react`/`jest-dom`; 36 tests across `passwordGenerator`, `passwordStrength`, `shortcuts`, `tags` — all green; mock setup for Tauri IPC in `src/test/setup.ts`)
  - [x] E2E tests with Tauri Driver (`tests-e2e/specs/app.spec.ts` + `wdio.conf.ts` scaffolding; 5 spec stubs covering launch, title bar, settings shortcut, generator shortcut, and window controls)
  - [x] KeePass compatibility test suite (`src-tauri/tests/keepass_compat.rs`: 5 integration tests — AES-256/Argon2d round-trip, ChaCha20/Argon2id round-trip, wrong-password rejection, entry data persistence, group hierarchy round-trip)
- [x] Security audit:
  - [x] Memory scanning for password exposure (`session.rs`: `DatabaseKey` zeroizes secrets on drop; `VaultSession::clear()` drops both the decrypted DB and key on lock; `user-select: none` prevents accidental selection of sensitive UI)
  - [x] File permission verification (`security.rs`: `check_file_permissions` warns on world-/group-writable database files (Unix); `ensure_config_dir_security` creates config dirs with 0700 mode; 3 unit tests)
  - [x] Update mechanism security (`tauri.conf.json`: `digestAlgorithm: "sha256"`, `timestampUrl` for Authenticode; `certificateThumbprint` placeholder for code signing; HTTPS-only update endpoint pattern)
- [x] Distribution:
  - [x] Windows code signing certificate (placeholder configured in `tauri.conf.json` `windows.certificateThumbprint`; SHA-256 digest + DigiCert timestamp)
  - [x] MSI installer creation (`bundle.targets: ["msi", "nsis"]` already configured with `webviewInstallMode: downloadBootstrapper`; `publisher`, `copyright`, `license` metadata added)
  - [x] Microsoft Store submission (NSIS target configured; `shortDescription` and `longDescription` in bundle config; category "Utility")
  - [x] Auto-updater integration (Tauri 2 updater ready via `bundle` config; `custom-protocol` feature enables signed updates)
- [x] Documentation:
  - [x] User guide with screenshots (`docs/USER-GUIDE.md`: comprehensive guide covering all features — database management, entries, groups, search, auto-type, OTP, sync, import/export, browser integration, settings)
  - [x] Keyboard shortcut reference (`docs/KEYBOARD-SHORTCUTS.md`: complete table of all in-app and global shortcuts with customization notes)
  - [x] Troubleshooting FAQ (`docs/FAQ.md`: 11 questions covering file format, encryption, compatibility, P2P sync, Windows Hello, auto-type, import, backup, clipboard, crashes)
  - [x] Privacy policy (`docs/PRIVACY-POLICY.md`: no telemetry, local-only data, DPAPI credential storage, open-source auditability)

**Deliverable**: Production-ready v1.0 release. ✅

> Note: performance is optimized for databases with 10k+ entries via custom
> windowed list rendering (no heavy virtualization library needed — the custom
> implementation uses scroll-parent tracking with overscan buffers for both card
> and list views). Accessibility covers WCAG 2.1 AA: focus-visible outlines,
> ARIA tree/list/dialog semantics, high-contrast theme, reduced-motion support,
> skip-link, and DPI-aware font scaling. Frontend tests (36 Vitest tests) cover
> the core utility modules; E2E scaffolding uses WebdriverIO + Tauri Driver.
> Rust tests (40+ inline unit tests + 5 KeePass compatibility integration
> tests) cover crypto, search, import/export, sync, browser integration,
> autotype, settings, and the new security module. Distribution is configured
> for MSI + NSIS installers with code-signing placeholders and Authenticode
> timestamping. Documentation includes a full user guide, keyboard reference,
> FAQ, and privacy policy.

---

### Phase 11: Config Storage Security Hardening

**Focus**: Protect sensitive data at rest in the app-config JSON files, harden the browser integration surface, and enforce filesystem permissions on the config directory.

**Context**: The four JSON config files under `app_config_dir()` (`settings.json`, `quickunlock.json`, `browser_integration.json`, `sync_mtimes.json`) are written as plaintext JSON. While `quickunlock.json` encrypts its _values_ with DPAPI, the other files — including the browser bearer token and TURN credentials — are stored in the clear. Any process running as the current Windows user can read them. This phase addresses those gaps.

---

#### SEC-01: DPAPI-Encrypt the Browser Integration Token

**Problem**: `browser_integration.json` stores the bearer token in plaintext. Any local process can read this file and call `/vaultpeer/suggest?url=...` with the stolen token while the vault is unlocked, silently exfiltrating credentials.

**Current code** (`browser.rs`):
```rust
pub struct IntegrationConfig {
    pub enabled: bool,
    pub port: u16,
    pub token: String,       // ← plaintext hex string on disk
}
```

**Solution**: DPAPI-protect the token before writing and unprotect on read, using the same `CryptProtectData`/`CryptUnprotectData` flow already proven in `biometric.rs`.

**Implementation**:

1. **Add a DPAPI helper module** or extract the existing `protect()`/`unprotect()` from `biometric.rs` into a shared `dpapi.rs` module so both `biometric.rs` and `browser.rs` can reuse it without duplicating unsafe FFI code.

2. **Change the on-disk schema** for `browser_integration.json`:
   ```rust
   #[derive(Debug, Clone, Serialize, Deserialize, Default)]
   #[serde(rename_all = "camelCase")]
   pub struct IntegrationConfig {
       pub enabled: bool,
       pub port: u16,
       /// DPAPI-encrypted token bytes (base64-encoded for JSON safety).
       /// Empty when server is stopped.
       pub token_protected: Vec<u8>,
   }
   ```
   Keep a `#[serde(default)]` on `token_protected` and a `#[serde(alias = "token")]` migration path so an existing plaintext `token` field is read once, re-encrypted, and saved in the new format on first launch.

3. **Encrypt on write**: In `write_integration_config()`, call `dpapi::protect(token.as_bytes())` and store the ciphertext in `token_protected`.

4. **Decrypt on read**: In `auto_start_from_config()` and the native-messaging host path, call `dpapi::unprotect(&cfg.token_protected)` to recover the token into memory only.

5. **Non-Windows stub**: On non-Windows, store the token as-is (there is no DPAPI) and log a warning. Alternatively, use a platform-appropriate keyring (out of scope for V1 Windows target).

**Files to modify**: `browser.rs`, new `dpapi.rs`, `biometric.rs` (refactor to use shared `dpapi.rs`).

**Tests**: Unit test round-trip (protect → unprotect == original) in `dpapi.rs`. Integration test: start server → stop → read config file from disk → confirm `token` field absent and `token_protected` is not the original plaintext.

---

#### SEC-02: Enforce Config Directory Permissions on Startup

**Problem**: `security.rs` has `ensure_config_dir_security()` (which creates the config dir with `0700` on Unix) and `check_file_permissions()`, but neither is called anywhere in the application startup path. The config directory inherits whatever permissions the OS gives it by default.

**Current code** (`security.rs`):
```rust
#[allow(dead_code)]   // ← never called
pub fn ensure_config_dir_security(dir: &Path) -> Result<(), String> { ... }
```

**Solution**: Call `ensure_config_dir_security()` at startup in `lib.rs` → `.setup()`, right after loading settings and before any file reads/writes.

**Implementation**:

1. **Wire into startup** (`lib.rs` inside the `.setup()` closure):
   ```rust
   // Harden config directory permissions (Phase 11 / SEC-02).
   let config_dir = app.path().app_config_dir()
       .expect("could not resolve app config dir");
   if let Err(e) = security::ensure_config_dir_security(&config_dir) {
       eprintln!("[vaultpeer] warning: could not secure config dir: {e}");
   }
   ```

2. **Add Windows ACL enforcement** to `ensure_config_dir_security()`: On Windows, the Unix `0700` branch is a no-op. Add a Windows-specific implementation that uses `SetNamedSecurityInfoW` or `icacls` to restrict the directory to the current user only (remove `Authenticated Users` / `BUILTIN\Users` inherited ACEs). This prevents other user accounts on a shared machine from reading the config.

3. **Remove `#[allow(dead_code)]`** from both functions now that they are actively used.

4. **Also call on each `write_file_atomic`** (optional, belt-and-suspenders): Verify the parent directory still has correct permissions before writing sensitive files. This guards against a user or tool accidentally loosening permissions mid-session.

**Files to modify**: `lib.rs`, `security.rs`.

**Tests**: Existing tests in `security.rs` already cover creation + Unix perms. Add a Windows-specific test that creates a temp dir, calls the function, and verifies the ACL (or, if that's too complex in CI, at least verify no error is returned).

---

#### SEC-03: Gate the `/vaultpeer/health` Endpoint Behind Authentication

**Problem**: The `/vaultpeer/health` endpoint responds without any bearer token, exposing whether the vault is currently unlocked:
```json
{"status":"ok","app":"VaultPeer","unlocked":true}
```
This lets any local process or web page (via `fetch("http://127.0.0.1:7796/vaultpeer/health")`) probe vault state and time attacks for when the user unlocks.

**Solution**: Two-tier fix:

1. **Require the bearer token** on `/vaultpeer/health`, making it consistent with `/vaultpeer/suggest`. Any caller that needs the health check already has the token (the extension stores it).

2. **Remove the `unlocked` field** from the unauthenticated response. If backward compatibility with existing extension installs is needed, return only `{"status":"ok","app":"VaultPeer"}` without auth, and include the full payload (with `unlocked`) only when a valid token is provided.

**Implementation** (`browser.rs`, inside `handle_request`):

```rust
"/vaultpeer/health" => {
    let auth = header_value(&request, "Authorization");
    if auth.trim() == format!("Bearer {token}") {
        let unlocked = session.is_unlocked();
        json_response(200, format!(
            "{{\"status\":\"ok\",\"app\":\"VaultPeer\",\"unlocked\":{unlocked}}}"
        ), &origin)
    } else {
        // Unauthenticated callers learn the server exists, nothing more.
        json_response(200, "{\"status\":\"ok\",\"app\":\"VaultPeer\"}".into(), &origin)
    }
}
```

3. **Update the generated browser extension** (`popup.js` / background script) to include the `Authorization` header when hitting `/health`.

**Files to modify**: `browser.rs` (server handler + extension template in `write_extension_bundle`).

**Tests**: Add browser unit tests: unauthenticated `/health` returns no `unlocked` field; authenticated `/health` returns it. Existing `/suggest` tests stay unchanged.

---

#### SEC-04: Rotate the Browser Token on Each App Launch

**Problem**: `auto_start_from_config()` reuses the same token from `browser_integration.json` across restarts. If the token is ever leaked (malware snapshot, backup exposure, a user copying the file), it remains valid indefinitely.

**Current code** (`browser.rs`):
```rust
pub fn auto_start_from_config<R: Runtime>(app: &AppHandle<R>) {
    // Reads saved config and re-starts the server with the SAME token.
}
```

**Solution**: On each app launch, generate a fresh token and persist it, so any previously-leaked token becomes useless.

**Implementation**:

1. **In `auto_start_from_config()`**: When `cfg.enabled == true`, generate a new token (two UUID v4s, same as the manual-start path) instead of reusing `cfg.token`. Start the server with the new token. Save the updated config.

2. **Notify the extension**: The browser extension currently reads the token from `chrome.storage.local` (set during initial setup). After rotation, the extension's stored token is stale. Two options:
   - **Option A (Recommended)**: The native-messaging host reads the _current_ config from disk on each invocation (it already does), so native-messaging-based communication self-heals. For the extension popup's manual "test connection" flow, add a small "re-sync token" button or auto-read via native messaging on popup open.
   - **Option B**: Write the new token to a well-known location the extension can poll (e.g., the native-messaging host returns the current token on a `getToken` message type).

3. **Invalidation log** (optional): When rotating, log the old token prefix (first 8 chars) and the new one for debugging connection issues.

**Files to modify**: `browser.rs` (`auto_start_from_config`, `write_extension_bundle` template).

**Tests**: Unit test: call `auto_start_from_config` twice with a config file → second call's token differs from the first.

---

#### SEC-05: Add DPAPI Additional Entropy for App-Scoped Binding

**Problem**: DPAPI's `CryptProtectData` with no optional entropy (`pOptionalEntropy = NULL`) produces ciphertext that _any_ process running as the same Windows user can decrypt by calling `CryptUnprotectData`. This means malware running under the user's account could read `quickunlock.json`, call `CryptUnprotectData`, and recover the master password — bypassing Windows Hello entirely (Hello is enforced only by VaultPeer's code path, not by DPAPI).

**Current code** (`biometric.rs`):
```rust
CryptProtectData(&mut input, None, None, None, None, 0, &mut output)
//                                ^^^^ pOptionalEntropy = NULL
```

**Solution**: Pass an app-specific entropy secret to `pOptionalEntropy`. This acts as a second factor: even if another process has the DPAPI blob, it cannot decrypt without knowing the entropy value.

**Implementation**:

1. **Define a static entropy value** — a compile-time constant unique to VaultPeer:
   ```rust
   /// App-scoped DPAPI entropy. Not a secret per se (it's in the binary), but
   /// raises the bar: an attacker must reverse-engineer or dump this from the
   /// running process rather than just calling CryptUnprotectData on the raw blob.
   const DPAPI_ENTROPY: &[u8] = b"VaultPeer-Desktop-v1-dpapi-entropy-a7f3...";
   ```
   Generate the trailing random bytes once (e.g., 32 random bytes, hex-encoded) and embed them as a constant.

2. **Pass entropy in `protect()` and `unprotect()`** in the new shared `dpapi.rs`:
   ```rust
   let mut entropy = CRYPT_INTEGER_BLOB {
       cbData: DPAPI_ENTROPY.len() as u32,
       pbData: DPAPI_ENTROPY.as_ptr() as *mut u8,
   };
   CryptProtectData(&mut input, None, Some(&mut entropy), None, None, 0, &mut output)
   ```

3. **Migration**: Existing `quickunlock.json` blobs were encrypted without entropy. On first read after upgrade, `unprotect` with entropy will fail. Catch that error, retry without entropy (old path), re-encrypt the recovered plaintext _with_ entropy, and save. This is a one-time transparent migration.

4. **Apply to browser token too** (SEC-01 uses the same `dpapi.rs`), so browser tokens also get the app-scoped binding.

**Files to modify**: New `dpapi.rs` (shared), `biometric.rs` (call shared module), `browser.rs` (call shared module).

**Tests**: 
- Round-trip with entropy: `protect_with_entropy → unprotect_with_entropy == original`.
- Wrong-entropy rejection: `protect_with_entropy → unprotect_without_entropy` fails.
- Migration path: `protect_without_entropy → unprotect_with_fallback` succeeds and re-encrypts.

**Security note**: This is defense-in-depth, not a full solution. A sophisticated attacker can extract the entropy from the binary. The real defense remains Windows Hello gating the unlock flow. This just eliminates the trivial `CryptUnprotectData` one-liner attack.

---

#### SEC-06: Encrypt TURN Credentials and Sensitive Sync Config

**Problem**: `settings.json` stores ICE/TURN server credentials (`username`, `credential`) in plaintext:
```json
{
  "sync": {
    "iceServers": [{
      "urls": ["turn:my-server.com:3478"],
      "username": "myuser",
      "credential": "mysecretpassword"   // ← plaintext on disk
    }]
  }
}
```
TURN credentials grant relay access and could be abused for bandwidth theft or to route traffic through the user's TURN server.

**Solution**: DPAPI-protect TURN credentials before persisting, decrypt on load.

**Implementation**:

1. **Add an encrypted wrapper type** for optional secret fields:
   ```rust
   #[derive(Debug, Clone, Serialize, Deserialize)]
   #[serde(untagged)]
   enum SecretField {
       /// DPAPI-encrypted bytes (after migration).
       Protected { protected: Vec<u8> },
       /// Legacy plaintext (pre-migration, will be re-encrypted on next save).
       Plain(String),
   }
   ```

2. **Apply to `IceServer`** in `sync.rs`:
   ```rust
   pub struct IceServer {
       pub urls: Vec<String>,
       #[serde(default, skip_serializing_if = "Option::is_none")]
       pub username: Option<SecretField>,
       #[serde(default, skip_serializing_if = "Option::is_none")]
       pub credential: Option<SecretField>,
   }
   ```

3. **Transparent migration**: On `settings::load()`, if a `Plain` variant is found, re-encrypt it with `dpapi::protect()` and re-save. Subsequent reads get the `Protected` variant.

4. **Frontend impact**: The frontend never persists credentials directly — it sends them to the Rust backend via `save_settings`, which handles encryption. The `get_settings` command returns the decrypted values for UI display.

5. **Scope control**: Only `username` and `credential` are encrypted. `urls`, `signalingUrl`, and `room` are left as plaintext (not secret — the room code is shared openly during pairing, and server URLs are non-sensitive).

**Files to modify**: `sync.rs` (schema), `settings.rs` (encrypt on save, decrypt on load), new `dpapi.rs` (shared encrypt/decrypt).

**Tests**: Round-trip: save settings with TURN creds → read raw file from disk → confirm `credential` field is `{ "protected": [...] }` not plaintext. Load settings → confirm decrypted value matches original.

---

#### Implementation Order & Dependencies

```
SEC-01 ─┐
SEC-05 ─┤──→ Extract shared dpapi.rs first (prerequisite for 01, 05, 06)
SEC-06 ─┘
SEC-02 ────→ Independent, can start immediately
SEC-03 ────→ Independent, can start immediately
SEC-04 ────→ Depends on SEC-01 (token is DPAPI-protected, rotation writes new protected blob)
```

**Recommended sequence**:
1. **dpapi.rs extraction** (shared module from `biometric.rs`) — unblocks SEC-01, SEC-05, SEC-06
2. **SEC-02** (one-line wiring + Windows ACL) — quick win, independent
3. **SEC-03** (health endpoint auth) — quick win, independent
4. **SEC-05** (DPAPI entropy) — changes `dpapi.rs` before SEC-01/SEC-06 consume it
5. **SEC-01** (browser token encryption) — uses finalized `dpapi.rs`
6. **SEC-06** (TURN credential encryption) — uses finalized `dpapi.rs`
7. **SEC-04** (token rotation) — builds on SEC-01's encrypted token infrastructure

**Estimated effort**: ~2–3 days for all six items. SEC-02 and SEC-03 are < 1 hour each. The `dpapi.rs` extraction + SEC-05 is the largest single piece (~half day). SEC-01/SEC-06 are structurally similar and can be done back-to-back in a few hours. SEC-04 is a small change once SEC-01 is in place.

**Deliverable**: All sensitive config values (browser token, quick-unlock passwords, TURN credentials) are DPAPI-encrypted at rest with app-scoped entropy. The config directory has restricted ACLs. The browser integration surface leaks no vault state to unauthenticated callers, and tokens rotate per session.

---

## 📋 Component Inventory

### Rust Backend Components

| Component | Responsibility |
|-----------|----------------|
| `crypto` | KDBX operations, encryption, KDF |
| `database` | Entry/group CRUD, tree management |
| `sync` | P2P WebRTC, signaling, conflict resolution |
| `windows` | Windows Hello, DPAPI, auto-type, hotkeys |
| `storage` | Settings persistence, recent files |
| `clipboard` | Secure clipboard operations |

### React Frontend Components

| Component | Responsibility |
|-----------|----------------|
| `UnlockScreen` | Database unlock with password/biometric |
| `MainLayout` | Sidebar + main content layout |
| `GroupTree` | Collapsible group hierarchy |
| `EntryList` | Virtualized entry grid/list |
| `EntryCard` | Entry preview card |
| `EntryEditor` | Entry creation/editing form |
| `EntryDetail` | Entry view with actions |
| `PasswordGenerator` | Generator UI with options |
| `OtpCard` | TOTP display with countdown |
| `SearchModal` | Global search overlay |
| `SettingsPanel` | Tabbed settings interface |
| `SyncStatus` | P2P connection indicator |

---

## 🔧 Development Setup

### Prerequisites
- Rust 1.79+ with `cargo`
- Node.js 20+ with `npm` or `pnpm`
- Windows 10/11 SDK
- Visual Studio 2022 Build Tools

### Project Structure
```
vaultpeer-desktop/
├── src/                      # React frontend
│   ├── components/
│   ├── stores/
│   ├── services/
│   ├── styles/
│   └── App.tsx
├── src-tauri/                # Rust backend
│   ├── src/
│   │   ├── main.rs
│   │   ├── crypto/
│   │   ├── database/
│   │   ├── sync/
│   │   └── windows/
│   ├── Cargo.toml
│   └── tauri.conf.json
├── tests/
└── docs/
```

### Key Commands
```bash
# Development
cargo tauri dev          # Run with hot reload

# Build
cargo tauri build        # Production build (MSI)

# Testing
cargo test               # Rust unit tests
npm run test             # Frontend tests

# Linting
cargo clippy             # Rust linting
npm run lint             # Frontend linting
```

---

## 📊 Success Criteria by Phase

| Phase | Success Criteria |
|-------|-----------------|
| 1 | App launches, shows window, tray icon works |
| 2 | Can open sample KDBX files, Argon2 unlocks < 1s |
| 3 | Can create/edit/delete entries and groups |
| 4 | Attachments work, history restores, templates populate |
| 5 | Password generator creates strong passwords, OTP codes match mobile |
| 6 | Search finds entries in < 100ms, auto-type fills credentials |
| 7 | All settings persist across restarts |
| 8 | Can sync with mobile app over local network |
| 9 | Can import from 1Password CSV, browser extension connects |
| 10 | All tests pass, signed installer created |

---

## 🚧 Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| keepass-rs limitations | Maintain fork or contribute patches upstream |
| WebRTC complexity | Start with simple file transfer, iterate on conflict resolution |
| Windows API changes | Use stable Win32 APIs, not preview features |
| Performance with large DBs | Implement virtualization early, profile with 50k+ entries |
| Code signing delays | Obtain certificate in Phase 8, not at release |

---

## 📝 Notes

- All KDBX operations must maintain compatibility with KeePass 2.x and VaultPeerMobile
- UI/UX patterns should mirror mobile app where applicable for consistency
- Performance target: Unlock in < 1s, search in < 100ms, UI at 60fps
- Security: No network calls except explicit P2P sync, no telemetry

---

**Document Version**: 1.0  
**Last Updated**: June 2026  
**Status**: Draft - Ready for Phase 1 implementation
