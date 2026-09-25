import { useEffect, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { cn } from "@/lib/utils";
import { openExternalUrl } from "@/lib/nativeBrowser";

interface CodeSurpriseFrameProps {
  className?: string;
  documentHtml: string;
  title: string;
  /** Uncaught script errors from inside the surprise (editor preview toasts them). */
  onRuntimeError?: (message: string) => void;
}

const OPENABLE = new Set(["https:", "http:", "mailto:", "tel:"]);

/**
 * Link taps inside the frame arrive here as `ds-open-url` messages (the
 * frame's sandbox blocks popups and top-level navigation, so a plain <a>
 * did nothing). Only web/mail/phone schemes are honoured — never
 * javascript:, data:, file:, or the app's own custom schemes.
 */
const openFromSurprise = (raw: string) => {
  let url: URL;
  try { url = new URL(raw); } catch { return; }
  if (!OPENABLE.has(url.protocol)) return;

  if (url.protocol === "mailto:" || url.protocol === "tel:") {
    window.location.href = url.toString();
    return;
  }
  if (Capacitor.isNativePlatform()) {
    void openExternalUrl(url.toString());
  } else {
    window.open(url.toString(), "_blank", "noopener,noreferrer");
  }
};

const CodeSurpriseFrame = ({ className, documentHtml, title, onRuntimeError }: CodeSurpriseFrameProps) => {
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Only trust messages from THIS frame — not any other window.
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "code-surprise-error" && typeof data.message === "string") {
        onRuntimeError?.(data.message);
      } else if (data.type === "ds-open-url" && typeof data.url === "string") {
        openFromSurprise(data.url);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onRuntimeError]);

  return (
    <iframe
      ref={frameRef}
      title={title}
      // Scripts only: no same-origin (surprise code can't touch the app's
      // storage/session), no popups, no top navigation, no forms.
      sandbox="allow-scripts"
      // The sandbox gives the frame an opaque origin, which is "cross-origin"
      // to the autoplay policy — without this delegation audio/video that
      // the browser WOULD allow in the app itself is refused in the frame.
      // Sensors are what tilt/shake-driven surprises read.
      allow="autoplay *; accelerometer *; gyroscope *; magnetometer *; fullscreen *"
      referrerPolicy="no-referrer"
      srcDoc={documentHtml}
      className={cn("w-full h-full rounded-2xl border border-border/30 bg-background", className)}
    />
  );
};

export default CodeSurpriseFrame;
