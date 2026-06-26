import "@testing-library/jest-dom/vitest";

/**
 * Mock the Tauri IPC layer so frontend tests can run without a Rust backend.
 * Each test can override specific commands via `vi.mocked(invoke).mockResolvedValue`.
 */
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("Tauri IPC not available in tests")),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(null),
}));

vi.mock("@tauri-apps/plugin-websocket", () => ({
  default: class MockWebSocket {
    send = vi.fn();
    disconnect = vi.fn();
    addListener = vi.fn().mockResolvedValue(vi.fn());
  },
}));

if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}
