/** Small helpers for the CE screens: CSV downloads, fonts, and the camera QR scanner. */
import { useEffect, useRef, useState } from "react";

/** Saves CSV text as a file. */
export function downloadCsv(file: { filename: string; csv: string }) {
  const blob = new Blob(["﻿", file.csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Loads the certificate fonts (serif text and a light script signature) once. */
export function useCertificateFonts() {
  useEffect(() => {
    if (document.getElementById("ce-cert-fonts")) return;
    const link = document.createElement("link");
    link.id = "ce-cert-fonts";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@400;700&family=Dancing+Script:wght@400&display=swap";
    document.head.appendChild(link);
  }, []);
}

type Detector = { detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
type DetectorCtor = new (opts: { formats: string[] }) => Detector;

/** Whether this browser can read QR codes from the camera (BarcodeDetector). */
export const canScanQr = () => typeof window !== "undefined" && "BarcodeDetector" in window && !!navigator.mediaDevices?.getUserMedia;

/**
 * Camera QR scanner. Calls onCode once per new code it reads (the same code
 * is ignored for 3 seconds so one scan does not fire twice).
 */
export function QrScanner({ onCode, size = 240, facing = "environment" }: { onCode: (code: string) => void; size?: number | string; facing?: "environment" | "user" }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  const last = useRef({ code: "", at: 0 });
  const cb = useRef(onCode);
  cb.current = onCode;

  useEffect(() => {
    if (!canScanQr()) {
      setError("This browser cannot scan with the camera. Type the code instead.");
      return;
    }
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer = 0;
    const Ctor = (window as unknown as { BarcodeDetector: DetectorCtor }).BarcodeDetector;
    const detector = new Ctor({ formats: ["qr_code"] });
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: facing }, audio: false })
      .then(async (s) => {
        if (stopped) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        const v = video.current;
        if (!v) return;
        v.srcObject = s;
        await v.play().catch(() => undefined);
        const tick = async () => {
          if (stopped) return;
          try {
            if (v.readyState >= 2) {
              const found = await detector.detect(v);
              const code = found[0]?.rawValue;
              const now = Date.now();
              if (code && (code !== last.current.code || now - last.current.at > 3000)) {
                last.current = { code, at: now };
                cb.current(code);
              }
            }
          } catch {
            /* frame not ready */
          }
          timer = window.setTimeout(tick, 250);
        };
        tick();
      })
      .catch(() => setError("Allow the camera to scan, or type the code instead."));
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [facing]);

  return (
    <div style={{ width: size, maxWidth: "100%", aspectRatio: "1 / 1", borderRadius: 16, background: "var(--ink)", position: "relative", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
      {error ? (
        <div className="small" style={{ color: "var(--side-text)", padding: 18, textAlign: "center", fontWeight: 600 }}>{error}</div>
      ) : (
        <>
          <video ref={video} muted playsInline style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
          <div aria-hidden="true" style={{ width: "70%", height: "70%", border: "3px solid #FFFFFF", borderRadius: 14, position: "relative" }} />
        </>
      )}
    </div>
  );
}

/** Opens a print page in a new window. Must be called right inside a click so the browser allows it. */
export function openPrintWindow(url: string) {
  const w = window.open(url, "_blank", "noopener=no,width=520,height=640");
  return w;
}
