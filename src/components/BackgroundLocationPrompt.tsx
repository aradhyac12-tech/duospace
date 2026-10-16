import { useCallback, useEffect, useState } from "react";
import { MapPin } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  getBackgroundLocationStatus, requestBackgroundLocation,
  recordBackgroundPromptDismissed, backgroundPromptRecentlyDismissed,
  BACKGROUND_LOCATION_PROMPT_ENABLED,
} from "@/lib/backgroundLocationPermission";

/**
 * In-app explainer for Android's "Allow all the time" location (KI-12 gap 1).
 *
 * Doubles as the prominent disclosure Google Play requires before a background
 * location request: it says what is collected, that it happens while the app is
 * closed, why, and who sees it. The OS request only fires after the person taps
 * Continue. Mounted only once foreground location is already granted (see
 * LocationAccessGate). Renders nothing on iOS/web, on Android 9 and below, when
 * already granted, or within 14 days of a "Not now".
 *
 * The copy below is a DRAFT for the product owner to review. UNVERIFIED on a device.
 */
export function BackgroundLocationPrompt() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!BACKGROUND_LOCATION_PROMPT_ENABLED || backgroundPromptRecentlyDismissed()) return;
      const status = await getBackgroundLocationStatus();
      if (!cancelled && status === "denied") setOpen(true);
    })();
    return () => { cancelled = true; };
  }, []);

  const handleContinue = useCallback(async () => {
    setBusy(true);
    try {
      const status = await requestBackgroundLocation();
      setOpen(false);
      if (status !== "granted") {
        recordBackgroundPromptDismissed();
        toast({
          title: "Still not set to \"Allow all the time\"",
          description: "Open Settings → Location for DuoSpace and choose \"Allow all the time\" whenever you're ready.",
        });
      }
    } finally {
      setBusy(false);
    }
  }, [toast]);

  const handleNotNow = useCallback(() => {
    recordBackgroundPromptDismissed();
    setOpen(false);
  }, []);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleNotNow(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <MapPin className="h-6 w-6 text-primary" aria-hidden="true" />
          </div>
          <DialogTitle className="text-center">Keep your location fresh, even when the app is closed</DialogTitle>
          <DialogDescription className="text-center leading-relaxed">
            DuoSpace shares your location with your partner. When a message or call arrives while
            the app is closed, DuoSpace briefly checks your location in the background so your
            partner sees where you are right now. To allow that, Android needs you to choose
            &ldquo;Allow all the time&rdquo; for location. Only your linked partner can see it, and you can
            change this in Settings at any time.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
          <Button onClick={handleContinue} disabled={busy} className="w-full">Continue</Button>
          <Button variant="ghost" onClick={handleNotNow} disabled={busy} className="w-full">Not now</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default BackgroundLocationPrompt;
