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
  /** §7: dual-activation state (Two-Screen Heart and any future template
   *  using the same `window.DuoSpaceCoupleSync` bridge) — pushed into the
   *  frame via postMessage whenever it changes. */
  coupleSyncState?: { mine: boolean; partner: boolean; both: boolean };
  /** Fires when the surprise's own content calls
   *  `DuoSpaceCoupleSync.activate()` — the host records this as a Couple
   *  Sync event; the frame itself has no persistence of its own. */
  onCoupleSyncActivate?: () => void;
  /** §8: surprise content requesting a real device haptic for an
   *  in-content gesture (hold-to-reveal, unlock) the host has no other
   *  visibility into. `kind` is pre-validated against the known
   *  HapticKind vocabulary by the injected runtime before it ever posts. */
  onHapticRequest?: (kind: string) => void;
  /** §8 (Living Photograph): bump this (any changing number — a counter,
   *  a timestamp) to post one `ds-partner-ripple` message into the frame.
   *  Not part of coupleSyncState because a ripple is a one-shot live
   *  event, not persisted state to restore on remount. */
  rippleTick?: number;
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

const CodeSurpriseFrame = ({ className, documentHtml, title, onRuntimeError, coupleSyncState, onCoupleSyncActivate, onHapticRequest, rippleTick }: CodeSurpriseFrameProps) => {
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Read inside the "ds-ready" handler below via .current, not a closure
  // over the coupleSyncState prop directly — the message listener effect
  // only re-subscribes when onRuntimeError/onCoupleSyncActivate change, so
  // a stale closure would otherwise push whatever state existed at MOUNT
  // time rather than the latest one, if the frame reloads later.
  const coupleSyncStateRef = useRef(coupleSyncState);
  coupleSyncStateRef.current = coupleSyncState;

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
      } else if (data.type === "ds-couple-sync-activate") {
        onCoupleSyncActivate?.();
      } else if (data.type === "ds-haptic" && typeof data.kind === "string") {
        onHapticRequest?.(data.kind);
      } else if (data.type === "ds-ready" && coupleSyncStateRef.current) {
        // A fresh mount/reload never received the state-change effect
        // below if the state's VALUES happen to be unchanged from before
        // (e.g. reopening a surprise where `mine` was already true) — this
        // is what actually guarantees the frame gets its initial state.
        frameRef.current.contentWindow?.postMessage({ type: "ds-couple-sync-state", ...coupleSyncStateRef.current }, "*");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onRuntimeError, onCoupleSyncActivate, onHapticRequest]);

  // Also re-push on any actual change while the frame is already alive
  // (e.g. the partner just activated their half while I'm looking at it).
  useEffect(() => {
    if (!coupleSyncState) return;
    frameRef.current?.contentWindow?.postMessage({ type: "ds-couple-sync-state", ...coupleSyncState }, "*");
  }, [coupleSyncState?.mine, coupleSyncState?.partner, coupleSyncState?.both]);

  // §8: one-shot ripple — deliberately NOT sent on initial mount (only on
  // a CHANGE to rippleTick), a fresh open has nothing to replay.
  const mountedRippleRef = useRef(false);
  useEffect(() => {
    if (rippleTick === undefined) return;
    if (mountedRippleRef.current) {
      frameRef.current?.contentWindow?.postMessage({ type: "ds-partner-ripple" }, "*");
    }
    mountedRippleRef.current = true;
  }, [rippleTick]);

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
