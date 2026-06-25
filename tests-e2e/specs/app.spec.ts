/**
 * E2E test scaffolding for VaultPeer Desktop (Phase 10).
 *
 * These tests use WebdriverIO with the Tauri driver to test the full
 * application. Run after `cargo tauri build` with:
 *   npx wdio run wdio.conf.ts
 *
 * The Tauri driver binary must be installed:
 *   cargo install tauri-driver
 */

describe("VaultPeer Desktop", () => {
  it("should display the unlock screen on launch", async () => {
    // The app should show the VaultPeer branding and Open/Create buttons
    const title = await $("h1");
    await expect(title).toHaveText("VaultPeer");
  });

  it("should have a title bar with VaultPeer branding", async () => {
    const header = await $("header[role='banner']");
    await expect(header).toBeDisplayed();
  });

  it("should open settings panel with keyboard shortcut", async () => {
    await browser.keys(["Control", ","]);
    const settingsPanel = await $("[role='dialog']");
    await expect(settingsPanel).toBeDisplayed();
    await browser.keys("Escape");
  });

  it("should show password generator", async () => {
    await browser.keys(["Control", "g"]);
    const generator = await $("[role='dialog']");
    await expect(generator).toBeDisplayed();
    await browser.keys("Escape");
  });

  it("should have window controls visible", async () => {
    const minimize = await $("button[aria-label='Minimize']");
    await expect(minimize).toBeDisplayed();
  });
});
