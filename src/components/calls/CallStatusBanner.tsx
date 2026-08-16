import { WifiOff } from "lucide-react";

/**
 * Small, focused status banners used inside the active-call screens
 * (Calls.tsx and chat/CallOverlay.tsx). Split out so both surfaces render
 * identical feedback for identical states instead of two hand-rolled
 * copies drifting apart, the way the rest of the call screen previously
 * had.
 */

export const ReconnectingBanner = () => (
  <div
    role="status" aria-live="polite"
    className="absolute top-16 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 rounded-full bg-warning/90 px-3 py-1.5 backdrop-blur-md"
  >
    <WifiOff className="h-3.5 w-3.5 text-warning-foreground animate-pulse" aria-hidden="true" />
    <span className="text-[11px] font-medium text-warning-foreground">Reconnecting…</span>
  </div>
);

export const AudioFallbackBanner = () => (
  <div
    role="status" aria-live="polite"
    className="absolute top-16 left-1/2 -translate-x-1/2 z-20 rounded-full bg-background/20 backdrop-blur-md px-3 py-1.5"
  >
    <span className="text-[11px] font-medium text-background">Audio-only · weak connection</span>
  </div>
);

export const PartnerLeftBanner = ({ partnerName }: { partnerName: string }) => (
  <div
    role="status" aria-live="polite"
    className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center z-10"
  >
    <p className="text-lg font-medium text-background">{partnerName} left the call</p>
    <p className="text-xs text-background/50">Tap the red button to end, or wait — they may rejoin.</p>
  </div>
);
