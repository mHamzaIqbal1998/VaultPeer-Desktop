# Product Requirements Document (PRD)
# VaultPeerDesktop — KeePass-Compatible Password Manager for Windows

**Version:** 1.0  
**Date:** June 2026  
**Platform:** Windows Desktop (Tauri Stack: React + Rust)  
**Target Compatibility:** Windows 10/11

---

## 1. Executive Summary

VaultPeerDesktop is a modern, minimal, premium KeePass-compatible password manager built for Windows desktop using the Tauri stack (React frontend + Rust backend). It provides seamless access to standard `.kdbx` database files with full read/write capabilities, enabling users to maintain their password vaults across mobile (VaultPeerMobile) and desktop environments.

### Core Value Propositions
- **Native Performance**: Rust-powered cryptography with sub-second database decryption
- **Cross-Platform Sync**: Use the same `.kdbx` files across mobile and desktop via cloud sync (OneDrive, Dropbox, Google Drive, Syncthing)
- **Premium UX**: Cyber-Sage aesthetic with dark/light theme support
- **P2P Synchronization**: Direct peer-to-peer vault synchronization without cloud dependency
- **Enterprise-Grade Security**: Hardware-backed encryption, Argon2 KDF, AES-256/ChaCha20 ciphers

---

## 2. User Personas

### Primary: Security-Conscious Professional (Alex, 32)
- Uses password manager for work and personal accounts
- Needs quick access via desktop during work hours
- Values biometric convenience (Windows Hello)
- Syncs vault via OneDrive between work PC and personal devices

### Secondary: IT Administrator (Sam, 45)
- Manages hundreds of credentials across systems
- Needs offline-first capability with occasional sync
- Values detailed entry organization (groups, tags, custom fields)
- Uses SSH keys, certificates, and complex attachment workflows

### Tertiary: Privacy-Focused User (Jordan, 28)
- Avoids cloud services, uses local-only or P2P sync
- Wants maximum encryption settings (Argon2id, ChaCha20)
- Uses the app across multiple self-owned devices
- Values open standards and file format compatibility

---

## 3. Functional Requirements

### 3.1 Core Database Operations

#### 3.1.1 File Management
| ID | Requirement | Priority |
|----|-------------|----------|
| FM-01 | Open existing `.kdbx` files via native file picker | P0 |
| FM-02 | Create new `.kdbx` databases with custom encryption settings | P0 |
| FM-03 | Save databases in-place (atomic write with temp file + rename) | P0 |
| FM-04 | Recent files list with quick access | P0 |
| FM-05 | Support for key file authentication (in addition to password) | P1 |
| FM-06 | Auto-save on change (configurable) | P1 |
| FM-07 | Backup creation on save (configurable retention) | P2 |

#### 3.1.2 Database Unlock/Security
| ID | Requirement | Priority |
|----|-------------|----------|
| UN-01 | Master password unlock with visual strength indicator | P0 |
| UN-02 | Windows Hello biometric unlock (PIN, Fingerprint, Face) | P0 |
| UN-03 | Hardware-backed credential encryption using Windows Data Protection API (DPAPI) | P0 |
| UN-04 | Auto-lock after configurable inactivity timeout | P0 |
| UN-05 | Master password change with re-encryption | P1 |
| UN-06 | Emergency database export (XML, CSV - unencrypted warning) | P2 |

#### 3.1.3 Encryption & Algorithms
| ID | Requirement | Priority |
|----|-------------|----------|
| ENC-01 | AES-256-CBC and ChaCha20 encryption cipher support | P0 |
| ENC-02 | Argon2id, Argon2d, and AES-KDF key derivation | P0 |
| ENC-03 | Native Rust implementation of Argon2 (argon2-rs crate) | P0 |
| ENC-04 | Configurable KDF parameters (memory, iterations, parallelism) | P1 |
| ENC-05 | KDF benchmark tool to calibrate for ~1 second delay | P1 |
| ENC-06 | Compression options (GZip/None) | P2 |

### 3.2 Entry & Group Management

#### 3.2.1 Entry Operations
| ID | Requirement | Priority |
|----|-------------|----------|
| ENT-01 | Create new password entries | P0 |
| ENT-02 | Edit entry fields: Title, Username, Password, URL, Notes | P0 |
| ENT-03 | Custom fields support (plaintext and protected) | P0 |
| ENT-04 | Entry tags for organization | P0 |
| ENT-05 | Entry expiration dates with visual indicators | P0 |
| ENT-06 | Password generator with strength estimation | P0 |
| ENT-07 | Entry icons (standard KeePass icon set) | P1 |
| ENT-08 | Binary attachments (add, view, export) | P1 |
| ENT-09 | Entry history (view, restore, delete snapshots) | P1 |
| ENT-10 | Duplicate entry detection | P2 |
| ENT-11 | Bulk entry operations (move, delete, tag) | P2 |

#### 3.2.2 Group Operations
| ID | Requirement | Priority |
|----|-------------|----------|
| GRP-01 | Create, rename, delete groups (folders) | P0 |
| GRP-02 | Nested group hierarchy with tree navigation | P0 |
| GRP-03 | Group icons and customization | P1 |
| GRP-04 | Drag-and-drop entry/group reordering | P1 |
| GRP-05 | Search/filter within specific groups | P1 |

#### 3.2.3 Template System
| ID | Requirement | Priority |
|----|-------------|----------|
| TMP-01 | Pre-defined templates: Credit Card, Email Account, Secure Note, SSH Server, Wi-Fi Router, Membership/ID, Software License | P1 |
| TMP-02 | Custom template creation from existing entries | P2 |
| TMP-03 | Template group configuration | P1 |

### 3.3 OTP (One-Time Password) Support

| ID | Requirement | Priority |
|----|-------------|----------|
| OTP-01 | TOTP code generation (RFC 6238 compliant) | P0 |
| OTP-02 | QR code scanning via camera for OTP setup | P1 |
| OTP-03 | Manual OTP secret entry | P0 |
| OTP-04 | Visual countdown timer for TOTP refresh | P0 |
| OTP-05 | Copy OTP to clipboard | P0 |
| OTP-06 | Support for multiple OTP algorithms (SHA1, SHA256, SHA512) | P1 |

### 3.4 Search & Discovery

| ID | Requirement | Priority |
|----|-------------|----------|
| SRC-01 | Global search across all entry fields | P0 |
| SRC-02 | Fuzzy search with typo tolerance | P0 |
| SRC-03 | Advanced search filters (group, tag, URL, creation date) | P1 |
| SRC-04 | Search history and saved searches | P2 |
| SRC-05 | Quick find with keyboard shortcut (Ctrl+K) | P1 |

### 3.5 Clipboard & Auto-Type

| ID | Requirement | Priority |
|----|-------------|----------|
| CLP-01 | Copy username/password to clipboard | P0 |
| CLP-02 | Auto-clear clipboard after configurable timeout | P0 |
| CLP-03 | Protected clipboard mode (bypasses clipboard managers) | P1 |
| ATY-01 | Global auto-type hotkey (Ctrl+Alt+A) | P0 |
| ATY-02 | Auto-type sequence customization per entry | P1 |
| ATY-03 | Window title matching for auto-type | P1 |
| ATY-04 | Selective field auto-type (username only, password only, etc.) | P1 |

### 3.6 Browser Integration

| ID | Requirement | Priority |
|----|-------------|----------|
| BRW-01 | Native Messaging support for browser extensions | P1 |
| BRW-02 | HTTP server mode for localhost-based extension communication | P2 |
| BRW-03 | URL matching for credential suggestions | P1 |

### 3.7 P2P Synchronization (WebRTC)

| ID | Requirement | Priority |
|----|-------------|----------|
| SYN-01 | WebSocket signaling server connection | P1 |
| SYN-02 | Room/channel creation and joining | P1 |
| SYN-03 | QR code for easy room joining | P1 |
| SYN-04 | WebRTC data channel for encrypted P2P transfer | P1 |
| SYN-05 | Automatic conflict resolution (newer wins, manual merge option) | P1 |
| SYN-06 | Sync status indicator with connected peer count | P1 |
| SYN-07 | Configurable ICE servers (STUN/TURN) | P2 |

### 3.8 Import/Export

| ID | Requirement | Priority |
|----|-------------|----------|
| IMP-01 | Import from CSV (1Password, LastPass, Bitwarden formats) | P1 |
| IMP-02 | Import from other KeePass databases | P1 |
| EXP-01 | Export to CSV (with security warnings) | P2 |
| EXP-02 | Export to JSON | P2 |
| EXP-03 | Entry sharing via encrypted QR/short link | P3 |

### 3.9 Settings & Preferences

| ID | Requirement | Priority |
|----|-------------|----------|
| SET-01 | Dark/Light/System theme selection | P0 |
| SET-02 | Auto-lock timeout configuration | P0 |
| SET-03 | Clipboard clear timeout | P0 |
| SET-04 | Minimize to system tray | P0 |
| SET-05 | Start with Windows option | P1 |
| SET-06 | Database default settings (KDF, cipher) | P1 |
| SET-07 | Recycle Bin configuration | P1 |
| SET-08 | History settings (max items, max size) | P1 |
| SET-09 | Default password generator rules | P1 |
| SET-10 | UI language selection | P2 |
| SET-11 | Keyboard shortcut customization | P2 |

---

## 4. Non-Functional Requirements

### 4.1 Performance
- Database unlock: < 1 second for standard Argon2 settings
- Search results: < 100ms for 10,000 entries
- UI render: 60 FPS smooth animations
- Memory usage: < 200MB typical operation
- Binary file handling: Support for 50MB+ attachments

### 4.2 Security
- Master password never stored in plain text
- Memory locking for sensitive data (using Rust's secure memory practices)
- Automatic memory clearing on lock/exit
- No telemetry or external network calls (except explicit sync)
- Code signing for Windows executable

### 4.3 Compatibility
- **File Format**: KeePass 2.x (KDBX 3.1, 4.0, 4.1)
- **Windows**: Windows 10 (1903+) and Windows 11
- **Architecture**: x64 primary, ARM64 secondary
- **Cloud Sync**: Compatible with OneDrive, Dropbox, Google Drive, Syncthing, etc.

### 4.4 Reliability
- Atomic database writes (no corruption on crash)
- Automatic backup before save operations
- Crash recovery with last known good state
- Write-ahead logging for sync operations

### 4.5 Accessibility
- WCAG 2.1 AA compliance
- Keyboard-only navigation support
- Screen reader compatibility (Windows Narrator, NVDA, JAWS)
- High contrast theme support
- Scalable UI (100%-200% DPI support)

---

## 5. UI/UX Design Specification

### 5.1 Visual Identity: "Cyber-Sage Desktop"

A refined adaptation of the mobile Cyber-Sage aesthetic for desktop:

#### Color Tokens
```
Dark Mode:
- background-primary:   #0B0F0E (Near-black emerald slate)
- surface-card:         #141A18 (Dark emerald surface)
- border-sage:          #232E2A (Muted sage border)
- accent-mint:          #34D399 (Vibrant mint green)
- text-primary:         #ECFDF5 (High-contrast mint-white)
- text-muted:           #94A3B8 (Soft slate gray)
- status-error:         #EF4444 (Soft red)
- status-success:       #10B981 (Standard emerald)

Light Mode:
- background-primary:   #F0F4F2 (Crisp light sage)
- surface-card:         #FFFFFF (Clean white)
- border-sage:          #D0DBD6 (Light sage border)
- accent-mint:          #059669 (Rich mint green)
- text-primary:         #061A13 (Deep dark green-black)
- text-muted:           #64748B (Slate-500)
```

#### Typography
- **Primary Font**: Inter (Google Fonts)
- **Monospace**: JetBrains Mono (for passwords)
- **Font Sizes**: 
  - Title: 24px
  - Heading: 20px
  - Subheading: 16px
  - Body: 14px
  - Caption: 12px

### 5.2 Layout Structure

```
┌─────────────────────────────────────────────────────────┐
│ [Icon] VaultPeer    [Search Bar]    [Sync] [Lock] [=]   │ ← Title Bar
├─────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌─────────────────────────────────────┐  │
│  │          │  │  Breadcrumb: Root > Work > Email    │  │
│  │  GROUP   │  ├─────────────────────────────────────┤  │
│  │  TREE    │  │                                     │  │
│  │          │  │  [Entry Cards / List View Toggle]   │  │
│  │ [+] New  │  │                                     │  │
│  │  Group   │  │  ┌─────────────────────────────┐   │  │
│  │          │  │  │ [Icon] Gmail Account          │   │  │
│  │          │  │  │ user@gmail.com  [Copy] [Edit] │   │  │
│  │          │  │  └─────────────────────────────┘   │  │
│  │          │  │                                     │  │
│  │          │  │  ┌─────────────────────────────┐   │  │
│  │          │  │  │ [Icon] AWS Console          │   │  │
│  │          │  │  │ admin@company.com [...]     │   │  │
│  │          │  │  └─────────────────────────────┘   │  │
│  │          │  │                                     │  │
│  └──────────┘  └─────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 5.3 Key Interactions

| Action | Shortcut | Description |
|--------|----------|-------------|
| Global Search | `Ctrl+K` | Open quick search dialog |
| Lock Database | `Ctrl+L` | Lock and clear memory |
| Auto-Type | `Ctrl+Alt+A` | Trigger auto-type for selected/matched entry |
| Copy Password | `Ctrl+C` | Copy password of selected entry |
| Copy Username | `Ctrl+B` | Copy username of selected entry |
| New Entry | `Ctrl+N` | Create new entry in current group |
| Save Database | `Ctrl+S` | Save changes to file |
| Settings | `Ctrl+,` | Open settings |
| Quit | `Ctrl+Q` | Quit application |

---

## 6. Technical Architecture

### 6.1 Stack Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    React 19 + TypeScript                     │
│                   (UI Layer - Frontend)                      │
│  - Zustand for state management                             │
│  - Tailwind CSS for styling                                 │
│  - Framer Motion for animations                             │
├─────────────────────────────────────────────────────────────┤
│                    Tauri Bridge                             │
│              (IPC Commands & Events)                        │
├─────────────────────────────────────────────────────────────┤
│                      Rust Backend                           │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────┐   │
│  │   kdbx-rs   │  │  argon2-rs  │  │  WebRTC (webrs)  │   │
│  │  (KDBX lib) │  │    (KDF)    │  │    (P2P Sync)    │   │
│  └─────────────┘  └─────────────┘  └──────────────────┘   │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────┐   │
│  │  aes/chacha │  │ windows-hello│  │   tokio (async)  │   │
│  │  (ciphers)  │  │  (biometric) │  │   runtime        │   │
│  └─────────────┘  └─────────────┘  └──────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 Key Rust Crates

| Crate | Purpose |
|-------|---------|
| `keepass-rs` | KDBX file parsing and manipulation |
| `argon2` | Argon2 KDF implementation |
| `aes-gcm` | AES-256 encryption |
| `chacha20poly1305` | ChaCha20 encryption |
| `tokio` | Async runtime |
| `tauri` | Desktop framework |
| `windows` | Windows API bindings (Hello, DPAPI) |
| `webrtc-rs` or `webrs` | WebRTC for P2P sync |
| `rfd` | Native file dialogs |
| `global-hotkey` | Global keyboard shortcuts |

### 6.3 Data Flow

```
User Action → React Component → Zustand Store → Tauri Command
                                                    ↓
                                            Rust Core Logic
                                                    ↓
                                            File System / Windows API
                                                    ↓
                                            Return Result → UI Update
```

---

## 7. Success Metrics

### 7.1 User Adoption
- 1,000+ downloads in first 3 months
- 70%+ retention after 7 days
- 4.5+ star rating on Microsoft Store

### 7.2 Performance
- < 500ms average unlock time
- Zero data corruption reports
- < 1% crash rate

### 7.3 Quality
- 90%+ test coverage for crypto operations
- Pass all KeePass compatibility tests
- WCAG 2.1 AA accessibility compliance

---

## 8. Out of Scope (V1.0)

The following features are explicitly excluded from the initial release:

- macOS and Linux support (Windows only for V1)
- Browser extension (post-V1 via Native Messaging)
- Team/shared vault features
- Password breach monitoring (HaveIBeenPwned integration)
- YubiKey/ hardware key support
- Command-line interface (CLI)
- Plugin/extension system
- Mobile companion features (already exists as separate app)

---

## 9. Appendix

### 9.1 Glossary

| Term | Definition |
|------|------------|
| KDBX | KeePass Database XML format - the standard KeePass file format |
| KDF | Key Derivation Function - transforms password into encryption key |
| Argon2 | Modern memory-hard KDF algorithm (winner of Password Hashing Competition) |
| TOTP | Time-based One-Time Password - algorithm for 2FA codes |
| WebRTC | Web Real-Time Communication - protocol for P2P connections |
| DPAPI | Data Protection API - Windows built-in encryption for user data |
| Auto-Type | Simulates keystrokes to fill credentials into other applications |

### 9.2 References

- [KeePass File Format Specification](https://keepass.info/help/kb/kdbx.html)
- [Tauri Documentation](https://tauri.app/)
- [WebRTC Specification](https://www.w3.org/TR/webrtc/)
- [Windows Data Protection API](https://docs.microsoft.com/en-us/windows/win32/api/dpapi/)

---

**Document Status:** Draft  
**Next Review:** After Phase 2 completion
