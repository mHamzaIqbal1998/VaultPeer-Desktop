# VaultPeer Desktop -- Frequently Asked Questions

---

## General

### What file format does VaultPeer use?

VaultPeer uses the **KDBX** format (KeePass 2.x compatible). Your database files have the `.kdbx` extension and can be opened by any KeePass-compatible application, including KeePass 2, KeePassXC, KeePass DX, and VaultPeer Mobile.

### Is my data encrypted?

Yes. VaultPeer supports the following encryption standards:

| Component | Options |
|-----------|---------|
| **Cipher** | AES-256-CBC, ChaCha20, Twofish |
| **Key Derivation (KDF)** | Argon2id, Argon2d, AES-KDF |
| **Compression** | GZip (optional) |

Your master password is never stored in plaintext. The KDF (Argon2 by default) is a memory-hard function designed to resist brute-force attacks. You can tune KDF parameters in Settings to increase protection at the cost of unlock time.

### Can I use VaultPeer with other KeePass applications?

Yes. VaultPeer produces standard KDBX 4.0 files. You can open a VaultPeer database in KeePass 2, KeePassXC, KeePass DX, or any KDBX-compatible application, and vice versa. Features like entry history, custom fields, attachments, and the recycle bin are fully preserved.

### Does VaultPeer connect to the internet?

VaultPeer makes **no network calls** by default. The only network activity occurs when you explicitly enable:

- **P2P Sync** -- connects to a signaling server and peers via WebRTC.
- **Browser Integration** -- runs a localhost-only HTTP server for communication with the browser extension.

There is no telemetry, no analytics, and no cloud service.

---

## P2P Sync

**Related repositories:** [VaultPeer-Desktop](https://github.com/mHamzaIqbal1998/VaultPeer-Desktop) · [VaultPeer-Mobile](https://github.com/mHamzaIqbal1998/VaultPeer-Mobile) · [VaultPeer-ServerNode](https://github.com/mHamzaIqbal1998/VaultPeer-ServerNode) · [VaultPeer-Phonebook](https://github.com/mHamzaIqbal1998/VaultPeer-Phonebook)

### How does P2P sync work?

1. Both devices connect to a lightweight WebSocket signaling server to discover each other.
2. A direct WebRTC data channel is established between the peers.
3. The **encrypted** `.kdbx` file is transferred over the DTLS-encrypted data channel. The decrypted database never leaves your device.
4. On receipt, the databases are merged using KeePass-compatible merge logic.

No cloud storage is involved. The signaling server only relays connection metadata -- it never sees your vault data.

### What happens if there is a sync conflict?

VaultPeer uses KeePass-compatible merge rules:

- Entries are matched by UUID across both databases.
- When the same entry was modified on both devices, the **newer modification timestamp wins**.
- Entry history from both sides is preserved.
- New entries, moved entries, and deleted entries are reconciled automatically.

A merge summary is displayed showing counts of created, updated, relocated, and deleted items plus any warnings.

### Do vault filenames need to match across devices?

Yes. Peers identify a shared database by filename. The vault's basename (e.g., `MyVault.kdbx`) must be the same on all devices participating in sync.

---

## Troubleshooting

### Windows Hello is not working

1. **Verify hardware support**: Ensure your device has a fingerprint reader, IR camera, or supports Windows Hello PIN.
2. **Check Windows Settings**: Go to Windows Settings > Accounts > Sign-in options and confirm Windows Hello is set up.
3. **Re-enroll in VaultPeer**: Open Settings > Security, click **Remove Windows Hello**, then **Enroll Windows Hello** again.
4. **Windows updates**: Some Windows updates can reset biometric enrollments. Re-enroll after major updates.
5. **Administrator accounts**: Windows Hello may behave differently on domain-joined or administrator accounts. Ensure DPAPI is functional.

If the issue persists, you can always unlock with your master password.

### Auto-type is not working

Auto-type is a **Windows-only** feature that simulates keystrokes. If it is not working:

1. **Correct hotkey**: The default global hotkey is **Ctrl+Alt+A**. Ensure no other application has claimed this combination.
2. **Database must be unlocked**: Auto-type only works when a database is open and unlocked.
3. **Window matching**: Auto-type matches the foreground window title against entry titles and URL hostnames. Ensure your entry has a title or URL that matches the target application.
4. **Run as administrator**: Some elevated (administrator) applications block keystroke injection from non-elevated processes. Try running VaultPeer as administrator.
5. **Antivirus interference**: Some security software blocks simulated keystrokes. Add VaultPeer to your antivirus allow list.
6. **Custom sequence**: If the default `{USERNAME}{TAB}{PASSWORD}` does not match the login form layout, set a custom **AutoType Sequence** on the entry.

### How do I import from 1Password, LastPass, or Bitwarden?

1. Export your data from the source application as a **CSV file**:
   - **1Password**: File > Export > CSV
   - **LastPass**: Advanced Options > Export > CSV
   - **Bitwarden**: Tools > Export vault > CSV
2. In VaultPeer, open the **Import/Export Panel** from the title bar.
3. Select **Import > CSV** and browse to the exported file.
4. VaultPeer auto-detects the source format from column headers.
5. Review the field mapping and adjust if needed.
6. Preview the entries and check for duplicates.
7. Click **Import**.

The CSV importer is header-driven, so exports from other managers (not just the three listed) will generally import correctly. You can manually re-map columns if auto-detection misses a field.

### How do I back up my database?

Your VaultPeer database is a single `.kdbx` file on disk. To back up:

1. **Manual copy**: Copy the `.kdbx` file to a backup drive, USB stick, or cloud storage folder.
2. **KDBX export**: Use **Import/Export > Export > KDBX** to create a copy with different encryption settings or a different master password.
3. **Automated backup**: Place your `.kdbx` file in a folder synced by a cloud service (OneDrive, Dropbox, etc.) for automatic backups.

Because the file is fully encrypted, it is safe to store backups on cloud services or external media.

### The clipboard keeps getting cleared

VaultPeer automatically clears the clipboard after copying a credential to prevent sensitive data from lingering. This is expected behavior.

- The default timeout is **30 seconds**.
- A countdown indicator appears in the app showing time remaining.
- VaultPeer only clears values it placed on the clipboard -- your other clipboard content is not affected.

To adjust or disable:

1. Open **Settings > App**.
2. Change **Clipboard Clear Timeout** (10 seconds to 5 minutes, or **Never** to disable).

### The app will not start or crashes on launch

1. **Install WebView2**: VaultPeer requires the Microsoft Edge WebView2 Runtime. Download it from [Microsoft](https://developer.microsoft.com/en-us/microsoft-edge/webview2/). It is pre-installed on most Windows 10/11 systems.
2. **Check for corrupted settings**: Delete or rename the `settings.json` file in VaultPeer's app data folder (`%APPDATA%\vaultpeer-desktop\`) and relaunch. VaultPeer will recreate it with defaults.
3. **Update Windows**: Ensure your Windows installation is up to date, especially the Visual C++ Redistributable.
4. **Graphics driver issues**: WebView2 uses GPU acceleration. Update your graphics drivers or try launching with the `--disable-gpu` flag.
5. **Antivirus quarantine**: Some antivirus tools may flag new or unsigned applications. Check your antivirus quarantine and add an exception for VaultPeer.
6. **Reinstall**: Uninstall VaultPeer, delete the app data folder, and reinstall from a fresh download.

If the issue persists, check the application logs in the app data folder for error details.
