# VaultPeer Desktop -- User Guide

VaultPeer Desktop is a modern, privacy-first KeePass-compatible password manager for Windows. Built with Tauri (React + Rust), it stores all data locally in the standard KDBX format and supports peer-to-peer synchronization with no cloud dependency.

---

## Table of Contents

- [Getting Started](#getting-started)
- [Unlock Screen](#unlock-screen)
- [Managing Entries](#managing-entries)
- [Managing Groups](#managing-groups)
- [Password Generator](#password-generator)
- [OTP / TOTP](#otp--totp)
- [Search](#search)
- [Auto-Type](#auto-type)
- [Clipboard](#clipboard)
- [Templates](#templates)
- [P2P Sync](#p2p-sync)
- [Import / Export](#import--export)
- [Browser Integration](#browser-integration)
- [Settings Overview](#settings-overview)
- [Themes](#themes)

---

## Getting Started

### Installation

1. Download the VaultPeer Desktop installer (MSI) from the official release page.
2. Run the installer and follow the on-screen prompts.
3. VaultPeer requires **WebView2** (pre-installed on Windows 10/11). If your system is missing it, the installer will prompt you to download it from Microsoft.

### Opening an Existing Database

1. Launch VaultPeer Desktop.
2. Click **Open Database** and browse to a `.kdbx` file on your system.
3. Enter your master password (and optionally select a key file).
4. Click **Unlock**.

Recently opened databases appear on the start screen for quick access.

### Creating a New Database

1. Click **Create Database** on the start screen.
2. Choose a save location and file name.
3. Set a strong master password. The strength meter provides real-time feedback.
4. Optionally attach a key file for two-factor protection.
5. Configure encryption settings (defaults are secure out of the box: AES-256 cipher, Argon2id KDF).
6. Click **Create**.

---

## Unlock Screen

The unlock screen supports three credential methods:

| Method | Description |
|--------|-------------|
| **Master Password** | The primary unlock credential. A visibility toggle lets you verify what you typed. |
| **Key File** | An optional secondary factor. Select a file from disk to combine with your password. |
| **Windows Hello** | Biometric or PIN-based quick unlock. Must be enrolled first in **Settings > Security**. |

After unlocking, the database remains open until you lock it manually (Ctrl+L), close the app, or the auto-lock timeout elapses.

### Windows Hello Setup

1. Open **Settings > Security**.
2. Click **Enroll Windows Hello**.
3. Authenticate with your fingerprint, face, or Windows PIN.
4. On subsequent unlocks, the **Unlock with Windows Hello** option appears on the unlock screen.

Windows Hello credentials are protected by Windows DPAPI (hardware-backed). You can remove enrollment at any time from the Security settings.

---

## Managing Entries

### Creating an Entry

1. Navigate to the target group in the sidebar.
2. Press **Ctrl+N** or click the **New Entry** button.
3. Fill in the fields: Title, Username, Password, URL, and Notes.
4. Optionally add custom fields, tags, an expiration date, or attachments.
5. Click **Save**.

You can also create entries from a template (see [Templates](#templates)).

### Editing an Entry

1. Select an entry from the list.
2. Click **Edit** in the detail pane, or double-click the entry.
3. Modify any field. Changes are tracked -- a history snapshot is created automatically on every save.
4. Click **Save**.

### Deleting an Entry

- **Soft Delete**: By default, deleted entries move to the **Recycle Bin** for recovery. Select an entry and press Delete, then confirm.
- **Permanent Delete**: From the Recycle Bin, select an entry and choose **Delete Permanently**.
- **Empty Recycle Bin**: Removes all items in the Recycle Bin at once.

### Restoring an Entry

1. Navigate to the **Recycle Bin** group in the sidebar.
2. Select the entry you want to recover.
3. Click **Restore**. The entry returns to its original group.

### Entry History

Every edit creates a historical snapshot. To view or restore a previous version:

1. Open the entry detail pane.
2. Click the **History** tab.
3. Browse timestamped snapshots.
4. Click **Restore** on any snapshot to revert the entry.

You can also delete individual history items to save space.

### Attachments

- **Add**: Click **Add Attachment** in the entry editor or detail pane and select a file.
- **Export**: Click the download icon next to an attachment to save it to disk.
- **Delete**: Click the remove icon and confirm.

Attachment metadata (name, size) is displayed inline.

---

## Managing Groups

Groups organize your entries into a hierarchical tree structure, displayed in the sidebar.

### Tree Navigation

- Click a group to view its entries.
- Click the expand/collapse arrow to show or hide child groups.
- A breadcrumb trail above the entry list shows your current position.

### Creating a Group

1. Right-click a parent group in the sidebar (or use the group menu).
2. Select **New Group**.
3. Enter a name and confirm.

### Renaming and Deleting Groups

- **Rename**: Right-click a group and select **Rename**.
- **Delete**: Right-click and select **Delete**. If the recycle bin is enabled, the group and its contents are moved there.

### Drag and Drop

- Drag an entry onto a group to move it.
- Drag a group onto another group to nest it.
- Visual indicators show valid drop targets during the drag.

---

## Password Generator

Open the password generator with **Ctrl+G** or from within the entry editor.

### Character Mode

| Option | Description |
|--------|-------------|
| **Length** | Slider from 8 to 128 characters. |
| **Uppercase (A-Z)** | Include uppercase letters. |
| **Lowercase (a-z)** | Include lowercase letters. |
| **Digits (0-9)** | Include numbers. |
| **Symbols** | Include special characters. |
| **Exclude Ambiguous** | Omit characters like `0/O`, `1/l/I` that are easily confused. |

An entropy bar shows the estimated strength of the generated password in bits.

### Passphrase Mode

Generates Diceware-style passphrases using a curated wordlist.

- Choose the number of words.
- Select a separator character (space, hyphen, period, etc.).
- The entropy estimate adjusts to the word count.

### Generator History

Previously generated passwords are retained for the current session. You can copy any past result from the history panel.

### Integration

When editing an entry, click the generator icon next to the password field. The generated password is inserted directly into the field.

---

## OTP / TOTP

VaultPeer supports Time-based One-Time Passwords (TOTP) per RFC 6238.

### Adding OTP to an Entry

**Via QR Code:**

1. Open the entry editor and click **Set Up OTP**.
2. Choose **Scan QR Code**.
3. Point your camera at the QR code provided by the service, or select a QR code image file.
4. The secret, algorithm, period, and digit count are parsed automatically.

**Manual Entry:**

1. Click **Enter Manually**.
2. Paste the Base32 secret or the full `otpauth://` URI.
3. Configure the algorithm (SHA-1, SHA-256, SHA-512), period (default 30s), and digit count (default 6) if needed.

### Viewing OTP Codes

Once configured, the entry detail pane shows an **OTP Card** with:

- The current 6-digit (or configured) code.
- A countdown ring showing time remaining until the next code.
- A copy button for quick clipboard access.

Codes refresh automatically when the period elapses.

---

## Search

### Opening Search

Press **Ctrl+K** or click the search icon in the title bar to open the global search overlay.

### How It Works

- **Fuzzy Matching**: VaultPeer searches across titles, usernames, URLs, notes, tags, and custom field names and values. Results are ranked by relevance with substring and subsequence scoring.
- **Highlighting**: Matching portions of each field are highlighted in the results.
- **Debounced**: Results update as you type with a 150ms debounce for a smooth experience.
- **Recycle Bin Excluded**: Deleted items do not appear in search results.

### Filters

- **Scope to Current Group**: Toggle to restrict results to the currently selected group and its children.
- **Tag Filter**: Click tag chips in the filter bar to narrow results by tag.
- **URL**: URLs are searched as a first-class field.

### Keyboard Navigation

| Key | Action |
|-----|--------|
| Up / Down arrows | Navigate results |
| Enter | Open the selected entry (reveals its group and selects it) |
| Escape | Close the search overlay |

---

## Auto-Type

Auto-type automatically fills credentials into other applications by simulating keystrokes. This feature is Windows-only.

### Default Behavior

1. Focus the login field in any application.
2. Press **Ctrl+Alt+A**.
3. VaultPeer matches the foreground window's title and URL against your entries.
4. The default sequence `{USERNAME}{TAB}{PASSWORD}` is typed into the focused window.

The default sequence does **not** submit the form. To auto-submit, add `{ENTER}` to the sequence.

### Selective Auto-Type

Press **Ctrl+Alt+P** to type only the password (useful when the username is pre-filled).

### Custom Sequences

1. Open the entry editor.
2. Add a custom field named **AutoType Sequence**.
3. Set its value using supported tokens:

| Token | Action |
|-------|--------|
| `{USERNAME}` | Types the entry's username |
| `{PASSWORD}` | Types the entry's password |
| `{TITLE}` | Types the entry's title |
| `{URL}` | Types the entry's URL |
| `{TOTP}` | Types the current TOTP code |
| `{TAB}` | Presses the Tab key |
| `{ENTER}` | Presses the Enter key |

Example: `{USERNAME}{TAB}{PASSWORD}{TAB}{TOTP}{ENTER}`

### Window Matching

VaultPeer matches entries by comparing the foreground window's title against entry titles and URL hostnames. The longest matching substring wins. If multiple entries match, you can select the correct one from an in-app dialog.

### In-App Auto-Type

You can also trigger auto-type from the entry detail pane. VaultPeer hides itself so the previously active application receives the keystrokes.

---

## Clipboard

### Copying Credentials

- **Ctrl+C** (with an entry selected): Copies the password.
- **Ctrl+B** (with an entry selected): Copies the username.
- These shortcuts defer to the normal clipboard when a text selection or input field is focused.

### Auto-Clear

By default, the clipboard is automatically cleared **30 seconds** after copying a credential. A countdown pill appears in the UI showing time remaining. Only values that VaultPeer placed on the clipboard are cleared -- your other clipboard content is preserved.

The timeout is configurable in **Settings > App** (10 seconds to 5 minutes, or disabled).

### Protected Clipboard

On Windows, VaultPeer uses native APIs to exclude copied passwords from:

- Clipboard history (Win+V)
- Cloud clipboard sync
- Third-party clipboard managers

This is handled transparently when you copy credentials through VaultPeer.

---

## Templates

Templates pre-populate fields when creating a new entry, saving time for common credential types.

### Available Templates

| Template | Pre-filled Fields |
|----------|-------------------|
| **Login** | Title, Username, Password, URL |
| **Credit Card** | Cardholder Name, Card Number, Expiry, CVV, PIN |
| **Email Account** | Email, Password, IMAP/SMTP Server, Port |
| **Secure Note** | Title, Notes |
| **SSH Key** | Host, Port, Username, Private Key |
| **Wi-Fi Network** | SSID, Security Type, Password |
| **Membership / ID** | Name, Member ID, Organization, Expiry |
| **Software License** | Product, License Key, Email, Purchase Date |

### Using a Template

1. Press **Ctrl+N** or click **New Entry**.
2. Select a template from the template picker.
3. The entry form populates with the template's fields.
4. Fill in the values and save.

Switching templates in the creation dialog swaps the field set without losing data you have already entered in shared fields.

---

## P2P Sync

VaultPeer synchronizes databases directly between devices over a peer-to-peer WebRTC connection. No cloud service is involved.

**Related repositories:** [VaultPeer-Desktop](https://github.com/mHamzaIqbal1998/VaultPeer-Desktop) · [VaultPeer-Mobile](https://github.com/mHamzaIqbal1998/VaultPeer-Mobile) · [VaultPeer-ServerNode](https://github.com/mHamzaIqbal1998/VaultPeer-ServerNode) · [VaultPeer-Phonebook](https://github.com/mHamzaIqbal1998/VaultPeer-Phonebook)

### How It Works

1. Both devices connect to a lightweight signaling server (configurable) to discover each other.
2. A WebRTC data channel is established for direct, encrypted communication.
3. The encrypted `.kdbx` file is transferred -- the decrypted database never leaves your device.
4. On receipt, the databases are merged using KeePass-compatible merge logic (UUID-based, newer modification wins, history-preserving).

### Setting Up Sync

1. Open the **Sync Panel** from the title bar or Settings.
2. Switch from **Offline** to **Network** mode.
3. **Create a Room**: Generates a room code. Share it with your other device.
4. **Join a Room**: Enter a room code, paste a `vaultpeer://sync?...` invite link, or scan a QR code.

### QR Invites

When you create a room, a QR code is displayed containing the room ID and signaling server URL. Scan it from another VaultPeer instance (desktop or mobile) to join instantly.

### Conflict Resolution

Sync uses KeePass-compatible merge rules:

- Entries are matched by UUID.
- When the same entry is modified on both devices, the newer modification wins.
- Entry history is preserved across merges.
- The merge summary shows counts of created, updated, relocated, and deleted items.

### Auto-Sync

Once a room is joined, VaultPeer can automatically rejoin on startup and push changes whenever you save. Configure this in **Settings > Sync** with the **Auto-Sync** toggle.

### ICE Server Configuration

By default, VaultPeer uses Google's public STUN server. You can add custom STUN/TURN servers (with credentials) in **Settings > Sync** for networks that require relay.

### Compatibility

The sync protocol is shared with VaultPeer Mobile and the VaultPeer sync node. The vault filename must match across devices for peers to identify a shared database.

---

## Import / Export

### Importing

VaultPeer can import credentials from other password managers.

**CSV Import (1Password, LastPass, Bitwarden, and others):**

1. Open the **Import/Export Panel** from the title bar.
2. Select **Import** and choose **CSV**.
3. Browse to the exported CSV file.
4. VaultPeer auto-detects the source format by inspecting column headers.
5. Review the **field mapping** -- you can re-assign any column to a different field.
6. Preview the entries. Duplicates (matching title + username + URL) are flagged.
7. Click **Import**.

**KDBX Import (Merge):**

1. Select **KDBX** as the import source.
2. Choose the `.kdbx` file and provide its master password.
3. A dry-run merge preview shows how many entries will be created, updated, or moved.
4. Click **Import** to merge non-destructively into your current database.

### Exporting

| Format | Description |
|--------|-------------|
| **CSV** | Plaintext export. A security warning is shown before proceeding. |
| **JSON** | Structured export with group paths, tags, and custom fields. |
| **KDBX** | Encrypted export with configurable KDF, cipher, and master password. Your on-disk vault is not modified. |

---

## Browser Integration

VaultPeer can fill credentials in your web browser via a companion extension.

### Setup

1. Open **Settings > Browser**.
2. Click **Enable Browser Integration** to start the local connector server.
3. Click **Export Extension** and choose a folder.
4. Load the extension in your browser:
   - **Chrome/Edge**: Go to `chrome://extensions`, enable Developer Mode, click **Load unpacked**, and select the exported folder.
   - **Firefox**: Go to `about:debugging`, click **Load Temporary Add-on**, and select the `manifest.firefox.json` file.

### How It Works

- The extension communicates with VaultPeer over a localhost-only HTTP server (127.0.0.1).
- Each session uses a unique bearer token for authentication.
- When you visit a login page, the extension queries VaultPeer for matching credentials based on the page URL.
- Host-normalized URL matching ranks exact and parent-domain matches.

### Security

- The connector server is **off by default** and binds only to localhost.
- The decrypted vault never leaves the Rust backend -- only the specific fields requested by the extension are returned.
- When the database is locked, the extension receives a 423 (Locked) response.

---

## Settings Overview

Access settings with **Ctrl+,** or from the title bar menu.

### App Settings

| Setting | Description |
|---------|-------------|
| **Theme** | Dark, Light, or System (follows Windows preference). |
| **Auto-Lock Timeout** | Lock the database after inactivity (1 minute to 1 hour, or Never). |
| **Clipboard Clear Timeout** | Clear copied credentials after 10 seconds to 5 minutes, or Never. |
| **Minimize to Tray** | When enabled, closing the window hides VaultPeer to the system tray instead of quitting. |
| **Start with Windows** | Launch VaultPeer automatically on login. |
| **Default Generator Settings** | Pre-configure the password generator defaults. |
| **Keyboard Shortcuts** | Customize all in-app keyboard shortcuts. |

### Database Settings

| Setting | Description |
|---------|-------------|
| **Cipher** | AES-256 or ChaCha20 (Twofish also supported for imported vaults). |
| **KDF** | Argon2d or Argon2id, with tunable rounds, memory, and parallelism. |
| **KDF Benchmark** | Automatically calculates optimal KDF parameters for your hardware. |
| **Compression** | GZip or None. |
| **Recycle Bin** | Enable or disable the recycle bin. |
| **History Limits** | Maximum history items per entry and maximum history size. |
| **Database Maintenance** | Trims entry history to the configured limits. |

### Security Settings

| Setting | Description |
|---------|-------------|
| **Windows Hello** | Enroll or remove biometric quick-unlock. |
| **Emergency Export** | Export all credentials (CSV or XML) for disaster recovery. |
| **Clear Recent Files** | Remove the recently-opened database history. |

### Sync Settings

| Setting | Description |
|---------|-------------|
| **Signaling Server URL** | The WebSocket server used for peer discovery. |
| **ICE Servers** | STUN/TURN servers for WebRTC connectivity. |
| **Auto-Sync** | Automatically rejoin the last room and push changes on save. |

### Browser Settings

| Setting | Description |
|---------|-------------|
| **Enable/Disable Connector** | Start or stop the local HTTP server for browser extension communication. |
| **Port** | The localhost port the connector listens on. |
| **Export Extension** | Generate the browser extension files to a folder. |

---

## Themes

VaultPeer includes three visual themes:

| Theme | Description |
|-------|-------------|
| **Dark** | A dark interface with sage-green accents. The default theme. |
| **Light** | A bright interface optimized for well-lit environments. |
| **System** | Automatically follows your Windows appearance setting. |

Switch themes in **Settings > App > Theme**. The change applies immediately.

A high-contrast theme for accessibility is planned for a future release.
