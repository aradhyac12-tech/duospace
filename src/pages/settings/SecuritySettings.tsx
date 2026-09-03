import { useState } from "react";
import { motion } from "framer-motion";
import PageHeader from "@/components/PageHeader";
import { Fingerprint, Bell, Vibrate, EyeOff, Scan, Smile, KeyRound, RefreshCw } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useTheme } from "@/contexts/ThemeContext";
import { useToast } from "@/hooks/use-toast";
import storage from "@/lib/storage";
import { hashPin, verifyPin } from "@/lib/crypto";
import { hapticLight, getHapticIntensity, setHapticIntensity, type HapticIntensity, hapticSelection } from "@/lib/haptics";
import PeekConfigDialog from "@/components/PeekConfigDialog";
import ConfirmActionDialog from "@/components/settings/ConfirmActionDialog";

const settingsItems = [
  { key: "biometricLock" as const, icon: Fingerprint, label: "App Lock", desc: "Face ID / Fingerprint + PIN fallback" },
  { key: "notifications" as const, icon: Bell, label: "Notifications", desc: "Message & call alerts" },
  { key: "hapticFeedback" as const, icon: Vibrate, label: "Haptics", desc: "Vibrate on interactions" },
  { key: "privacyMode" as const, icon: EyeOff, label: "Privacy", desc: "Blur in task switcher" },
  { key: "peekGuard" as const, icon: Scan, label: "Peek Guard", desc: "Lock when stranger looks at screen" },
  { key: "moodDetection" as const, icon: Smile, label: "Daily Mood", desc: "Camera checks your mood once a day" },
];

/**
 * Security & Privacy — a dedicated page rather than a collapsible section.
 * Every toggle here changes something that protects (or exposes) the
 * couple's private data, so it gets its own screen instead of living
 * halfway down a giant Settings scroll. PIN verify → enter → confirm
 * behavior is unchanged from the previous inline implementation — this
 * is a placement/layout change only, not an auth change.
 */
const SecuritySettings = () => {
  const { appSettings, updateSetting } = useTheme();
  const { toast } = useToast();

  const [showPinDialog, setShowPinDialog] = useState(false);
  const [pinInput, setPinInput] = useState("");
  const [pinStep, setPinStep] = useState<"verify" | "enter" | "confirm">("enter");
  const [pinFirst, setPinFirst] = useState("");
  const [pinVerifyError, setPinVerifyError] = useState(false);
  const [pinVerifyAttempts, setPinVerifyAttempts] = useState(0);
  const [showPeekConfig, setShowPeekConfig] = useState(false);
  const [hapticIntensity, setHapticIntensityState] = useState<HapticIntensity>(() => getHapticIntensity());
  // Confirming BEFORE turning App Lock off — this is the one toggle flip
  // here that reduces protection rather than adding it, so it gets the
  // same disclosure treatment as a destructive action even though nothing
  // is deleted.
  const [confirmDisableLock, setConfirmDisableLock] = useState(false);

  const resetPinFlow = () => {
    setPinInput(""); setPinStep("enter"); setPinFirst("");
    setPinVerifyError(false); setPinVerifyAttempts(0);
  };

  const openChangePin = () => {
    setPinInput("");
    setPinStep(storage.get("duo-lock-pin") ? "verify" : "enter");
    setPinFirst("");
    setPinVerifyError(false); setPinVerifyAttempts(0);
    setShowPinDialog(true);
  };

  const chooseHapticIntensity = (level: HapticIntensity) => {
    setHapticIntensity(level);
    setHapticIntensityState(level);
    hapticSelection();
  };

  // Unchanged from the previous inline version: verify current PIN before
  // allowing a change, 5-attempt lockout with a short shake+clear on a
  // wrong digit-set, and hashPin() on final save. No crypto behavior here
  // was touched during this redesign pass.
  const handlePinDigit = async (d: string) => {
    if (pinStep === "verify" && pinVerifyAttempts >= 5) return;
    if (d === "⌫") { setPinInput(p => p.slice(0, -1)); return; }
    const next = pinInput + d;
    if (next.length > 6) return;
    setPinInput(next);
    if (next.length === 6) {
      if (pinStep === "verify") {
        const stored = storage.get("duo-lock-pin");
        const ok = stored ? await verifyPin(next, stored) : true;
        if (ok) {
          setPinVerifyError(false); setPinVerifyAttempts(0);
          setPinInput(""); setPinStep("enter");
        } else {
          const attempts = pinVerifyAttempts + 1;
          setPinVerifyAttempts(attempts);
          setPinVerifyError(true);
          setTimeout(() => { setPinInput(""); setPinVerifyError(false); }, 500);
          if (attempts >= 5) toast({ title: "Too many attempts", description: "Close and try again later.", variant: "destructive" });
        }
        return;
      }
      if (pinStep === "enter") {
        setPinFirst(next); setPinInput(""); setPinStep("confirm");
      } else {
        if (next === pinFirst) {
          const hashed = await hashPin(next);
          storage.set("duo-lock-pin", hashed);
          setShowPinDialog(false); hapticLight();
          toast({ title: "PIN saved ✓" });
        } else {
          setPinInput(""); setPinStep("enter"); setPinFirst("");
          toast({ title: "PINs didn't match, try again", variant: "destructive" });
        }
      }
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-24 bg-background"
    >
      <PageHeader title="Security & Privacy" subtitle="Controls what protects your data on this device" />

      <div className="px-5 pt-5 space-y-2">
        <div className="bg-card rounded-2xl border border-border/60 divide-y divide-border/40">
          {settingsItems.map(item => (
            <div key={item.key} className="flex items-center gap-3 px-4 py-3">
              <item.icon className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{item.label}</p>
                <p className="text-[11px] text-muted-foreground">{item.desc}</p>
              </div>
              <Switch
                checked={appSettings[item.key] || false}
                onCheckedChange={v => {
                  // Turning App Lock off is the one flip that weakens
                  // protection — confirm it explicitly instead of applying
                  // instantly like the other toggles.
                  if (item.key === "biometricLock" && !v && appSettings.biometricLock) {
                    setConfirmDisableLock(true);
                    return;
                  }
                  hapticLight(); updateSetting(item.key, v);
                  if (item.key === "biometricLock" && v && !storage.get("duo-lock-pin")) {
                    resetPinFlow();
                    setShowPinDialog(true);
                  }
                  if (item.key === "moodDetection") storage.set("mood-detection-enabled", v ? "true" : "false");
                }}
              />
            </div>
          ))}
          {appSettings.hapticFeedback && (
            <div className="flex items-center gap-3 px-4 py-3">
              <div className="h-4 w-4 shrink-0" aria-hidden="true" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">Haptic intensity</p>
                <p className="text-[11px] text-muted-foreground">How strong feedback feels</p>
              </div>
              <div className="flex items-center gap-1 rounded-full bg-muted p-1" role="radiogroup" aria-label="Haptic intensity">
                {(["subtle", "standard", "strong"] as HapticIntensity[]).map(level => (
                  <button
                    key={level}
                    role="radio"
                    aria-checked={hapticIntensity === level}
                    onClick={() => chooseHapticIntensity(level)}
                    className={`px-2.5 py-1 rounded-full text-[11px] capitalize transition-colors ${
                      hapticIntensity === level ? "bg-accent text-accent-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {level}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="flex items-center gap-3 px-4 py-3">
            <KeyRound className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0"><p className="text-sm font-medium">Change PIN</p><p className="text-[11px] text-muted-foreground">Update your 6-digit lock PIN</p></div>
            <button onClick={openChangePin} className="h-7 px-3 rounded-full bg-muted text-[11px] text-foreground">Change</button>
          </div>
          {appSettings.peekGuard && (
            <div className="flex items-center gap-3 px-4 py-3">
              <Scan className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0"><p className="text-sm font-medium">Peek Guard setup</p><p className="text-[11px] text-muted-foreground">Enroll face, sensitivity & triggers</p></div>
              <button onClick={() => { setShowPeekConfig(true); }} className="h-7 px-3 rounded-full bg-muted text-[11px] text-foreground">Configure</button>
            </div>
          )}
          {appSettings.moodDetection && (
            <>
              {/* Separate opt-in from "Daily Mood" above: that toggle governs
                  the once-a-day popup card; this one — off by default, only
                  offered once Daily Mood itself is on — runs a short capture
                  periodically with NO popup, NO countdown, nothing shown at
                  all, straight to the mood log. See
                  hooks/useBackgroundMoodDetection.ts. */}
              <div className="flex items-center gap-3 px-4 py-3">
                <RefreshCw className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">Background auto-detect</p>
                  <p className="text-[11px] text-muted-foreground">Silently logs your mood a few times a day — no popup, ever</p>
                </div>
                <Switch
                  checked={appSettings.moodBackgroundDetection || false}
                  onCheckedChange={v => { hapticLight(); updateSetting("moodBackgroundDetection", v); }}
                />
              </div>
            </>
          )}
        </div>
      </div>

      {/* PIN Setup / Change / Verify dialog */}
      <Dialog open={showPinDialog} onOpenChange={v => { if (!v) resetPinFlow(); setShowPinDialog(v); }}>
        <DialogContent className="rounded-2xl max-w-[320px]">
          <DialogHeader>
            <DialogTitle className="text-base">
              {pinStep === "verify" ? "Enter current PIN" : pinStep === "enter" ? "Enter new PIN" : "Confirm PIN"}
            </DialogTitle>
            <DialogDescription>
              {pinStep === "verify" ? "Confirm it's you before changing your PIN" : pinStep === "enter" ? "Choose a 6-digit PIN" : "Enter the same PIN again"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className={`flex gap-2 justify-center ${pinVerifyError ? "animate-[shake_0.3s]" : ""}`}>
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className={`h-4 w-4 rounded-full border-2 transition-all ${
                  pinVerifyError ? "bg-destructive border-destructive" :
                  pinInput.length > i ? "bg-primary border-primary" : "border-border"
                }`} />
              ))}
            </div>
            {pinStep === "verify" && pinVerifyError && (
              <p className="text-center text-[11px] text-destructive">Wrong PIN — {5 - pinVerifyAttempts} attempt{5 - pinVerifyAttempts === 1 ? "" : "s"} left</p>
            )}
            <div className="grid grid-cols-3 gap-3">
              {["1","2","3","4","5","6","7","8","9","","0","⌫"].map((d, i) => (
                <button key={i} onClick={() => handlePinDigit(d)}
                  disabled={pinStep === "verify" && pinVerifyAttempts >= 5}
                  className={`h-14 rounded-xl flex items-center justify-center text-lg font-medium transition-all active:scale-90 disabled:opacity-40 ${d ? "bg-card border border-border text-foreground" : "invisible"}`}>
                  {d}
                </button>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmActionDialog
        open={confirmDisableLock}
        onOpenChange={setConfirmDisableLock}
        title="Turn off App Lock?"
        whatHappens="Anyone who picks up this device will be able to open the app without Face ID, fingerprint, or your PIN."
        dataAffected="No data is deleted — this only removes the unlock requirement for this device."
        reversible={true}
        reversibleNote="turn it back on anytime"
        authRequired={false}
        destructive={true}
        confirmLabel="Turn off"
        onConfirm={() => { hapticLight(); updateSetting("biometricLock", false); }}
      />

      <PeekConfigDialog open={showPeekConfig} onClose={() => setShowPeekConfig(false)} />

    </motion.div>
  );
};

export default SecuritySettings;
