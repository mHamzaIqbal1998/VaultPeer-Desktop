import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Wrappers around the current Tauri window for the custom (frameless) title
 * bar controls. Each call is a no-op-safe async against the live window.
 */
const appWindow = getCurrentWindow();

export const minimizeWindow = () => appWindow.minimize();
export const toggleMaximizeWindow = () => appWindow.toggleMaximize();
export const closeWindow = () => appWindow.close();
export const isMaximized = () => appWindow.isMaximized();

/** Subscribe to maximize/unmaximize changes; returns an unlisten fn. */
export async function onMaximizeChange(
  cb: (maximized: boolean) => void,
): Promise<() => void> {
  return appWindow.onResized(async () => {
    cb(await appWindow.isMaximized());
  });
}
