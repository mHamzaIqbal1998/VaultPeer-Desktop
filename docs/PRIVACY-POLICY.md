# VaultPeer Desktop -- Privacy Policy

**Effective Date**: June 2026

---

## Summary

VaultPeer Desktop is designed with a strict privacy-first architecture. Your data never leaves your device unless you explicitly initiate a peer-to-peer sync session. There are no analytics, no telemetry, no cloud services, and no network calls of any kind during normal operation.

---

## Data Storage

All data is stored **locally on your device**:

| Data | Location |
|------|----------|
| Vault database | User-chosen `.kdbx` file path |
| Application settings | `%APPDATA%\vaultpeer-desktop\settings.json` |
| Windows Hello credentials | `%APPDATA%\vaultpeer-desktop\quickunlock.json` (DPAPI-encrypted) |
| Browser integration config | `%APPDATA%\vaultpeer-desktop\browser_integration.json` |
| Sync timestamps | `%APPDATA%\vaultpeer-desktop\sync_mtimes.json` |

VaultPeer does not use cloud storage, remote databases, or any form of server-side data persistence.

---

## Encryption

Your vault is encrypted at rest using industry-standard cryptography:

- **Ciphers**: AES-256-CBC or ChaCha20 (user-configurable; Twofish also supported for imported vaults).
- **Key Derivation**: Argon2id or Argon2d with configurable memory, iteration, and parallelism parameters. Argon2 is a memory-hard function designed to resist GPU and ASIC-based brute-force attacks.
- **Master Password**: Your master password is never stored in plaintext. It is used solely to derive the encryption key and is discarded from memory after unlock.

---

## Windows Hello / Biometric Authentication

When you enroll Windows Hello:

- Your master password is encrypted using **Windows DPAPI** (`CryptProtectData`), which binds the encrypted blob to your Windows user account and, where available, to hardware security (TPM).
- The encrypted credential is stored locally in `quickunlock.json`.
- Decryption requires a successful Windows Hello authentication (fingerprint, face, or PIN) on the same user account and device.
- VaultPeer does not transmit biometric data. All biometric processing is handled by the Windows operating system.

You can remove the stored credential at any time from **Settings > Security > Remove Windows Hello**.

---

## Network Activity

VaultPeer makes **zero network calls** during normal operation. The only network activity occurs when you explicitly enable one of the following opt-in features:

### Peer-to-Peer Sync

- Connects to a **WebSocket signaling server** (configurable URL; see [VaultPeer-ServerNode](https://github.com/mHamzaIqbal1998/VaultPeer-ServerNode) and [VaultPeer-Phonebook](https://github.com/mHamzaIqbal1998/VaultPeer-Phonebook)) to discover peers.
- Establishes a direct **WebRTC data channel** between your devices.
- Only the **encrypted** `.kdbx` file is transmitted over the DTLS-encrypted data channel. The decrypted database never leaves the Rust backend.
- The signaling server relays connection metadata only (room IDs, ICE candidates). It does not receive, store, or have access to your vault data.
- Sync is disabled by default and must be explicitly activated.

### Browser Integration

- Runs a **localhost-only HTTP server** (bound to `127.0.0.1`) for communication with the VaultPeer browser extension.
- The server is **disabled by default** and must be enabled in Settings.
- Each session uses a unique bearer token for authentication.
- Only the specific credential fields requested by the extension are returned. The full decrypted vault is never exposed.
- No data leaves your machine -- all communication is on the loopback interface.

---

## Telemetry and Analytics

VaultPeer collects **no telemetry** and **no analytics**. Specifically:

- No usage statistics are gathered.
- No crash reports are transmitted.
- No device fingerprints or identifiers are collected.
- No third-party analytics SDKs are included.
- No advertising networks are integrated.

---

## Third-Party Services

VaultPeer does not depend on any third-party cloud services. The only external dependency is a STUN server (default: `stun.l.google.com:19302`) used during P2P sync to facilitate NAT traversal. STUN requests contain only your device's network address -- no vault data is transmitted. You can configure custom STUN/TURN servers or disable sync entirely.

---

## Open Source

VaultPeer Desktop is open-source software. The complete source code is publicly available for review, audit, and verification. You are encouraged to inspect the codebase to confirm these privacy claims.

---

## Data Portability

Your data is stored in the standard KDBX format, which is supported by numerous KeePass-compatible applications. You are not locked into VaultPeer. You can export your data at any time as CSV, JSON, or KDBX and use it with any compatible application.

---

## Changes to This Policy

Any changes to this privacy policy will be documented in the application release notes and reflected in an updated effective date at the top of this document.

---

## Contact

For privacy-related questions or concerns, please open an issue on the VaultPeer Desktop repository.
