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

- [ ] Build settings architecture:
  - [ ] Rust-based settings storage (JSON file in AppData)
  - [ ] Settings migration/versioning
- [ ] Implement Database Settings tab:
  - [ ] Default KDF and cipher selection
  - [ ] KDF parameter tuning (rounds, memory, parallelism)
  - [ ] KDF benchmark tool ("Calculate for 1.0s")
  - [ ] Compression setting (GZip/None)
  - [ ] Recycle bin configuration
  - [ ] History settings (max items, max size)
  - [ ] Database maintenance (cleanup)
- [ ] Implement App Settings tab:
  - [ ] Theme selection (Dark/Light/System)
  - [ ] Auto-lock timeout (1 min - 1 hour, or Never)
  - [ ] Clipboard clear timeout (10s - 5 min, or Never)
  - [ ] Minimize to tray behavior
  - [ ] Start with Windows toggle
  - [ ] Default password generator settings
  - [ ] Keyboard shortcut customization
- [ ] Implement Security Settings:
  - [ ] Windows Hello / biometric setup
  - [ ] Emergency export
  - [ ] Clear all recent files history

**Deliverable**: Comprehensive settings matching mobile app capabilities.

---

### Phase 8: P2P Synchronization (WebRTC)

**Focus**: Peer-to-peer vault synchronization between devices.

- [ ] Research and select WebRTC Rust implementation:
  - [ ] Evaluate `webrtc-rs` vs custom data channel implementation
- [ ] Implement signaling client:
  - [ ] WebSocket connection to signaling server
  - [ ] Room creation/joining
  - [ ] QR code generation for room IDs
- [ ] Implement WebRTC peer connection:
  - [ ] RTCPeerConnection setup
  - [ ] Data channel negotiation
  - [ ] ICE candidate handling
  - [ ] Connection state management
- [ ] Implement sync protocol:
  - [ ] Metadata exchange (timestamps, checksums)
  - [ ] File chunking for large databases
  - [ ] Conflict detection and resolution
  - [ ] Progress indication
- [ ] Build sync UI:
  - [ ] Sync mode selection (Offline/Network)
  - [ ] Server URL configuration
  - [ ] Room management (create, join, leave)
  - [ ] Connected peers list with status
  - [ ] QR code scanner for joining
  - [ ] Sync status indicator in title bar
- [ ] Implement ICE server configuration:
  - [ ] Default STUN servers
  - [ ] Custom TURN server support

**Deliverable**: P2P sync working between desktop and mobile app.

---

### Phase 9: Import/Export & Browser Integration

**Focus**: Data portability and browser workflow integration.

- [ ] Implement import:
  - [ ] CSV import (1Password, LastPass, Bitwarden formats)
  - [ ] KDBX import (merge into existing)
  - [ ] Import preview with duplicate detection
  - [ ] Field mapping for CSV columns
- [ ] Implement export:
  - [ ] CSV export (with security warnings)
  - [ ] JSON export
  - [ ] KDBX export (different encryption settings)
- [ ] Implement browser integration:
  - [ ] Native Messaging host setup
  - [ ] HTTP server mode for localhost communication
  - [ ] URL matching for credential suggestions
  - [ ] Browser extension manifest (Chrome/Edge/Firefox)
- [ ] Build import/export UI:
  - [ ] File picker with format selection
  - [ ] Progress indicators for large imports
  - [ ] Success/error reporting

**Deliverable**: Can migrate from other password managers and integrate with browsers.

---

### Phase 10: Polish, Testing & Release

**Focus**: Quality assurance, accessibility, and distribution.

- [ ] Performance optimization:
  - [ ] Virtualized lists for large databases (10k+ entries)
  - [ ] Debounced search indexing
  - [ ] Lazy loading for group tree
- [ ] Accessibility:
  - [ ] Keyboard navigation (Tab order, shortcuts)
  - [ ] Screen reader labels (ARIA)
  - [ ] High contrast theme
  - [ ] Scalable UI (DPI awareness)
- [ ] Testing:
  - [ ] Rust unit tests (>90% coverage for crypto)
  - [ ] Frontend component tests (React Testing Library)
  - [ ] E2E tests with Tauri Driver
  - [ ] KeePass compatibility test suite
- [ ] Security audit:
  - [ ] Memory scanning for password exposure
  - [ ] File permission verification
  - [ ] Update mechanism security
- [ ] Distribution:
  - [ ] Windows code signing certificate
  - [ ] MSI installer creation
  - [ ] Microsoft Store submission
  - [ ] Auto-updater integration
- [ ] Documentation:
  - [ ] User guide with screenshots
  - [ ] Keyboard shortcut reference
  - [ ] Troubleshooting FAQ
  - [ ] Privacy policy

**Deliverable**: Production-ready v1.0 release.

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
