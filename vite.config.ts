import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  // Vitest configuration (Phase 10: frontend component tests)
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },

  // Production bundle tuning: split heavyweight vendor deps into separate
  // chunks so the main entry stays under Vite's 500 kB warning threshold.
  // For a Tauri desktop app these are still bundled into the MSI/NSIS payload
  // (no network cost), but smaller chunks parallelise WebView parse/compile
  // and keep the build output readable.
  build: {
    // Tauri's WebView2/WebKit ships modern Chromium/Safari — target esnext
    // skips unnecessary ES5/ES2020 transpilation passes for faster builds.
    target: "esnext",
    // Asset inlining threshold; small SVGs/icons inline as base64 data URIs.
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom"],
          "framer-motion": ["framer-motion"],
          "tauri-vendor": [
            "@tauri-apps/api",
            "@tauri-apps/plugin-dialog",
            "@tauri-apps/plugin-websocket",
          ],
          "qr-vendor": ["qrcode", "jsqr"],
        },
      },
    },
  },

  // Vite options tailored for Tauri development.
  // 1. prevent Vite from obscuring Rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
