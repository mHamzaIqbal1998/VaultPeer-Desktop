import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import jsQR from "jsqr";
import { openImageDialog, readFile } from "@/services/tauri";

interface Props {
  /** Called with the decoded QR payload (typically an `otpauth://` URI). */
  onScan: (value: string) => void;
  onClose: () => void;
}

/**
 * QR code scanner for OTP setup (PLAN Phase 5 / OTP-02). Scans live from the
 * camera when one is available, and always offers decoding from a saved image
 * file as a fallback (useful on desktops without a camera, or for scanning a
 * QR shown on the same screen). Decoding is fully offline via the bundled jsQR.
 */
export function QrScanner({ onScan, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const doneRef = useRef(false);

  const [status, setStatus] = useState<"starting" | "scanning" | "no-camera">("starting");
  const [error, setError] = useState<string | null>(null);

  const finish = useCallback(
    (value: string) => {
      if (doneRef.current) return;
      doneRef.current = true;
      onScan(value);
      onClose();
    },
    [onScan, onClose],
  );

  // Decode whatever ImageData we're given; returns true if a code was found.
  const decode = useCallback(
    (data: ImageData): boolean => {
      const result = jsQR(data.data, data.width, data.height);
      if (result?.data) {
        finish(result.data.trim());
        return true;
      }
      return false;
    },
    [finish],
  );

  // Live camera scanning.
  useEffect(() => {
    let cancelled = false;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("no-camera");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        setStatus("scanning");

        const canvas = canvasRef.current!;
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        const tick = () => {
          if (doneRef.current || cancelled) return;
          if (video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            if (canvas.width > 0 && canvas.height > 0) {
              const found = decode(ctx.getImageData(0, 0, canvas.width, canvas.height));
              if (found) return;
            }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch {
        // Permission denied or no device — fall back to image-file scanning.
        if (!cancelled) setStatus("no-camera");
      }
    }

    void start();
    return () => {
      cancelled = true;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [decode]);

  async function handleScanImage() {
    setError(null);
    try {
      const path = await openImageDialog();
      if (!path) return;
      const bytes = await readFile(path);
      const blob = new Blob([bytes as unknown as BlobPart], { type: mimeFor(path) });

      // Decode the bytes to a bitmap. `createImageBitmap` reads the Blob
      // directly, so it isn't subject to the webview's `img-src` CSP (which
      // blocks `blob:` URLs); fall back to a CSP-allowed `data:` URL otherwise.
      const bitmap = await loadBitmap(blob);
      const canvas = canvasRef.current ?? document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(bitmap as CanvasImageSource, 0, 0);
      if ("close" in bitmap) bitmap.close();

      const found = decode(ctx.getImageData(0, 0, canvas.width, canvas.height));
      if (!found) setError("No QR code found in that image.");
    } catch {
      setError("Could not read that image file.");
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="flex w-full max-w-sm flex-col overflow-hidden rounded-2xl border border-border-sage bg-surface-card shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-border-sage px-5 py-4">
          <h2 className="text-base font-semibold text-text-primary">Scan QR Code</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-7 w-7 place-items-center rounded-md text-text-muted transition-colors hover:bg-accent-mint-dim hover:text-text-primary"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          <div className="relative aspect-square w-full overflow-hidden rounded-xl border border-border-sage bg-background-primary">
            {/* Hidden canvas used for frame grabbing / image decoding. */}
            <canvas ref={canvasRef} className="hidden" />
            {status === "no-camera" ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" className="text-text-muted" aria-hidden>
                  <rect x="3" y="6" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="1.8" />
                  <circle cx="12" cy="12.5" r="3.5" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M3 4l18 16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
                <p className="text-xs text-text-muted">
                  No camera available. Scan a QR code from a saved image instead.
                </p>
              </div>
            ) : (
              <>
                <video ref={videoRef} muted playsInline className="h-full w-full object-cover" />
                {/* Scan-frame overlay */}
                <div className="pointer-events-none absolute inset-0 grid place-items-center">
                  <div className="h-2/3 w-2/3 rounded-lg border-2 border-accent-mint/70 shadow-[0_0_0_9999px_rgba(0,0,0,0.25)]" />
                </div>
                {status === "starting" && (
                  <div className="absolute inset-0 grid place-items-center bg-background-primary/60">
                    <span className="text-xs text-text-muted">Starting camera…</span>
                  </div>
                )}
              </>
            )}
          </div>

          {error && (
            <div className="rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-status-error">
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={handleScanImage}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-border-sage px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:border-accent-mint/40"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
              <rect x="3" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
              <path d="M14 14h3v3M21 14v7h-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Scan from image file
          </button>
        </div>
      </motion.div>
    </div>
  );
}

/** Guess an image MIME type from a file path's extension. */
function mimeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

/** Read pixels-bearing image bytes, decoding without a CSP-blocked `blob:` URL. */
async function loadBitmap(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(blob);
  }
  // Fallback: a `data:` URL is permitted by the webview CSP, unlike `blob:`.
  const dataUrl = await blobToDataUrl(blob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = dataUrl;
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read image"));
    reader.readAsDataURL(blob);
  });
}
