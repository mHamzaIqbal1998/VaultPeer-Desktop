import { useEffect, useState } from "react";
import {
  closeWindow,
  isMaximized,
  minimizeWindow,
  onMaximizeChange,
  toggleMaximizeWindow,
} from "@/services/window";

/** Windows-style minimize / maximize-restore / close buttons. */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    isMaximized().then(setMaximized).catch(() => {});
    onMaximizeChange(setMaximized)
      .then((fn) => (unlisten = fn))
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  return (
    <div className="flex h-full items-stretch" data-tauri-drag-region={false}>
      <ControlButton label="Minimize" onClick={() => minimizeWindow()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
        </svg>
      </ControlButton>

      <ControlButton
        label={maximized ? "Restore" : "Maximize"}
        onClick={() => toggleMaximizeWindow()}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <rect x="0" y="2" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1" />
            <rect x="2.5" y="0" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </ControlButton>

      <ControlButton label="Close" danger onClick={() => closeWindow()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0 0 L10 10 M10 0 L0 10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </ControlButton>
    </div>
  );
}

function ControlButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={[
        "flex w-12 items-center justify-center text-text-muted transition-colors",
        danger
          ? "hover:bg-status-error hover:text-white"
          : "hover:bg-accent-mint-dim hover:text-text-primary",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
