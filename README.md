<p align="center">
  <img src="src-tauri/icons/128x128.png" alt="VaultPeer logo" width="96" height="96" />
</p>

# VaultPeer Desktop

> The desktop app for VaultPeer — an open-source, privacy-first KeePass-compatible password manager with live multi-device sync over WebRTC.

---

## Table of Contents

- [Introduction](#introduction)
- [Features](#features)
- [Installation](#installation)
- [Usage Examples](#usage-examples)
- [Testing](#testing)
- [Building](#building)
- [Dependencies](#dependencies)
- [Related Projects](#related-projects)
- [Contributing](#contributing)
- [License](#license)

---

## Introduction

VaultPeer is an open-source, privacy-first password manager that gives you full control over your credentials. It stores vaults in the standard **KDBX** format used by KeePass and KeePassXC, encrypts everything at rest, and keeps your data on your device.

Unlike cloud-first password managers, VaultPeer syncs through a lightweight **WebRTC signaling server**. Desktop, mobile, and server nodes join a room on that server, discover each other, and exchange the encrypted `.kdbx` vault directly over a peer-to-peer data channel. The signaling server relays connection metadata only — it never sees your decrypted vault contents.

VaultPeer Desktop is the Windows client in that network. It unlocks and manages your vault locally, then syncs with other live nodes on startup and after local changes.

---

## Features

- **KeePass-compatible storage** — Open, create, and save standard `.kdbx` databases with AES-256 / ChaCha20 encryption and Argon2 KDF.
- **Live multi-device sync** — Connect to a VaultPeer signaling server, join a room, and sync with desktop, mobile, and server nodes over WebRTC.
- **Offline access** — Your vault works without a network connection; sync runs when peers are available.
- **Password generator** — Generate strong random passwords and Diceware-style passphrases.
- **OTP / TOTP** — Scan QR codes or enter secrets manually for RFC 6238 one-time passwords.
- **Auto-type** — Fill credentials into other apps with global hotkeys (Windows).
- **Windows Hello** — Quick unlock with fingerprint, face, or PIN (DPAPI-protected).
- **Browser integration** — Optional localhost API for credential suggestions from a browser extension.
- **Import / export** — Bring in CSV exports from other managers; export KDBX copies for backup.
- **No telemetry** — No analytics, no cloud vault, and no network activity unless you enable sync or browser integration.

---

## Installation

### Prerequisites

- **Node.js 20+** — check `.nvmrc` and verify with:

```bash
node --version
```

- **Rust 1.79+** — install via [rustup](https://rustup.rs/).
- **Windows build tools** (for production installers):
  - Visual Studio 2022 Build Tools (MSVC)
  - WebView2 (pre-installed on Windows 10/11)

For Linux/WSL development only, install the Tauri system dependencies listed in the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/).

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/mHamzaIqbal1998/VaultPeer-Desktop.git

# 2. Go to the cloned directory
cd VaultPeer-Desktop

# 3. Install dependencies
npm install

# 4. Start the development app
npm run tauri dev
```

### End-user install (Windows)

Download the latest **MSI** or **NSIS** installer from [GitHub Releases](https://github.com/mHamzaIqbal1998/VaultPeer-Desktop/releases).

---

## Usage Examples

See the in-repo documentation for detailed guides:

| Document | Description |
| -------- | ----------- |
| [`docs/USER-GUIDE.md`](./docs/USER-GUIDE.md) | Setup, vault management, sync, auto-type, and settings |
| [`docs/FAQ.md`](./docs/FAQ.md) | Common questions about KDBX, P2P sync, and troubleshooting |
| [`docs/KEYBOARD-SHORTCUTS.md`](./docs/KEYBOARD-SHORTCUTS.md) | In-app and global shortcut reference |
| [`docs/PRIVACY-POLICY.md`](./docs/PRIVACY-POLICY.md) | Data handling and network behavior |

### Quick start

1. Launch VaultPeer and **create** or **open** a `.kdbx` database.
2. Unlock with your master password (and optional key file or Windows Hello).
3. Add entries, groups, and attachments as needed.
4. To sync, open **Settings → Sync**, enter your signaling server URL and room ID, then connect other VaultPeer nodes using the same vault filename.

---

## Testing

### Frontend

```bash
npm test
```

### Rust backend

```bash
cd src-tauri && cargo test
```

---

## Building

```bash
npm run build          # type-check + build frontend
npm run tauri build    # produce MSI / NSIS installer (on Windows)
```

---

## Dependencies

- [Tauri 2](https://v2.tauri.app/)
- [React](https://react.dev/)
- [Rust `keepass` crate](https://crates.io/crates/keepass) (KDBX read/write/merge)
- [Tailwind CSS](https://tailwindcss.com/)
- [Zustand](https://zustand.docs.pmnd.rs/)
- [Vitest](https://vitest.dev/)

---

## Related Projects

| Project | Description |
| ------- | ----------- |
| [`VaultPeer-Desktop`](https://github.com/mHamzaIqbal1998/VaultPeer-Desktop) | Windows desktop app (this repository) |
| `VaultPeer-Mobile` | Mobile client for VaultPeer |
| `VaultPeer-Server` | WebRTC signaling server used by all VaultPeer nodes |

> Related repositories will be linked here as they are published. VaultPeer nodes share the same signaling protocol and KDBX vault format.

---

## Contributing

We welcome contributions. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the development workflow and coding conventions.

---

## License

This project is licensed under the Apache License, Version 2.0. See the [LICENSE](./LICENSE) file for details.
