# VaultPeerDesktop

A modern, minimal, premium **KeePass-compatible** password manager for Windows, built with **Tauri (React + Rust)**.

> **Status:** Phase 1 complete — project scaffolding, Rust crypto-ready core structure, atomic file I/O, theme system, frameless title bar, and system-tray integration. See [`PLAN-Desktop.md`](./PLAN-Desktop.md) for the full roadmap.

---

## Tech Stack

| Layer | Choice |
|-------|--------|
| Shell | Tauri 2 (WebView2 on Windows) |
| Frontend | React 19 + TypeScript + Vite 6 |
| Styling | Tailwind CSS v4 (`@theme` tokens) — "Cyber-Sage" palette |
| State | Zustand (with `persist`) |
| Animation | Framer Motion |
| Backend | Rust 2021 (Tauri commands, atomic FS, modular core) |

## Project Structure

```
.
├── index.html
├── package.json
├── vite.config.ts
├── src/                       # React frontend
│   ├── main.tsx               # entry; boots theme listener
│   ├── App.tsx
│   ├── components/
│   │   ├── TitleBar.tsx       # frameless custom title bar
│   │   ├── WindowControls.tsx # min / max / close
│   │   ├── ThemeToggle.tsx
│   │   └── WelcomeScreen.tsx  # Phase 1 landing + file I/O self-test
│   ├── stores/
│   │   ├── themeStore.ts      # dark/light/system, persisted
│   │   └── vaultStore.ts      # selected path + recent files
│   ├── services/
│   │   ├── tauri.ts           # typed IPC wrappers
│   │   └── window.ts          # window-control wrappers
│   └── styles/globals.css     # Cyber-Sage CSS variables + Tailwind theme
└── src-tauri/                 # Rust backend
    ├── Cargo.toml
    ├── tauri.conf.json        # frameless window, tray, bundle config
    ├── capabilities/default.json
    ├── icons/                 # generated icon set (source.png is the master)
    └── src/
        ├── main.rs            # desktop entrypoint
        ├── lib.rs             # builder: single-instance, dialog, tray, commands
        ├── commands.rs        # greet / read_file / write_file / stat_file
        ├── fs_ops.rs          # atomic write + read + stat (+ unit tests)
        ├── tray.rs            # system tray icon & context menu
        └── error.rs           # serializable AppError
```

## Phase 1 Deliverables

- ✅ Tauri + React + TS + Tailwind v4 project scaffold
- ✅ `tauri.conf.json`: frameless window, single-instance, tray icon, MSI/NSIS bundle targets
- ✅ Rust commands: `greet`, `read_file`, `write_file` (**atomic**: temp file → fsync → rename), `stat_file`
- ✅ Zustand stores: theme (dark/light/system, persisted) and vault (recent files)
- ✅ Cyber-Sage theme system via CSS variables + Tailwind `@theme`
- ✅ Frameless title bar with custom window controls + draggable region
- ✅ System tray with Show / Lock (stub) / Quit + minimize-to-tray on close
- ✅ Rust unit tests for file I/O (round-trip, overwrite, no temp leftover, mkdir, stat, error path)

## Prerequisites

- **Node.js 20+** and **npm**
- **Rust 1.79+** (`rustup`)
- **A C toolchain + WebView (platform-specific):**
  - **Windows (the V1 target):** Visual Studio 2022 Build Tools (MSVC) + WebView2 (pre-installed on Win 10/11).
  - **Linux / WSL (for dev only):**
    ```bash
    sudo apt-get update && sudo apt-get install -y \
      build-essential curl wget file libssl-dev pkg-config \
      libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev \
      libayatana-appindicator3-dev
    ```
    > Note: a GUI build also needs a display. Headless WSL can compile/test the Rust core but cannot show the window — run the GUI on Windows.

## Development

```bash
npm install            # install frontend deps
npm run tauri dev      # run the desktop app with hot reload
```

## Building

```bash
npm run build          # type-check + build frontend
npm run tauri build    # produce MSI / NSIS installer (on Windows)
```

## Testing

```bash
# Frontend type-check + bundle
npm run build

# Rust unit tests (run from src-tauri/)
cd src-tauri && cargo test
```

## Regenerating Icons

The icon set is generated from `src-tauri/icons/source.png`:

```bash
npm run tauri icon src-tauri/icons/source.png
```

---

**License:** TBD · **Compatibility:** KeePass 2.x (KDBX 3.1 / 4.0 / 4.1)
