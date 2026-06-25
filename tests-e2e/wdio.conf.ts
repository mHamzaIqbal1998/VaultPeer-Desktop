/**
 * WebdriverIO configuration for VaultPeer Desktop E2E tests (Phase 10).
 *
 * Prerequisites:
 *   1. Build the app: `cargo tauri build`
 *   2. Install tauri-driver: `cargo install tauri-driver`
 *   3. Run: `npx wdio run tests-e2e/wdio.conf.ts`
 */
import { join } from "path";

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./specs/**/*.spec.ts"],
  maxInstances: 1,
  capabilities: [
    {
      "tauri:options": {
        application: join(
          __dirname,
          "..",
          "src-tauri",
          "target",
          "release",
          "VaultPeer.exe"
        ),
      },
    } as any,
  ],
  logLevel: "info",
  bail: 0,
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,
  services: ["tauri"],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 60000,
  },
};
