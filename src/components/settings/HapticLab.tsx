import { useEffect, useState } from "react";
import { fireNamed, getHapticCapabilities, hapticTier, type HapticPatternName } from "@/lib/hapticEngine";

/**
 * Settings → "Feel the haptics". Lets the owner play every pattern in the
 * haptic design language on a real device and see which engine tier is
 * actually active (so "feels cheap" can be diagnosed in one glance: "Basic"
 * means the installed app predates the native haptics plugin).
 */
const LAB: { label: string; name: HapticPatternName }[] = [
  { label: "Tap", name: "light" },
  { label: "Press", name: "medium" },
  { label: "Tick", name: "tick" },
  { label: "Toggle on", name: "toggleOn" },
  { label: "Toggle off", name: "toggleOff" },
  { label: "Send", name: "send" },
  { label: "Receive", name: "receive" },
  { label: "Reaction", name: "reaction" },
  { label: "Heartbeat", name: "heartbeat" },
  { label: "Long press", name: "longPress" },
  { label: "Sheet", name: "sheetOpen" },
  { label: "Shutter", name: "shutter" },
  { label: "Success", name: "success" },
  { label: "Warning", name: "warning" },
  { label: "Error", name: "error" },
  { label: "Delivered", name: "delivered" },
  { label: "Reply swipe", name: "replyArmed" },
  { label: "Copy", name: "copy" },
  { label: "Pin", name: "pin" },
  { label: "Delete", name: "deleteMsg" },
  { label: "Nudge", name: "nudge" },
  { label: "Voice start", name: "voiceStart" },
  { label: "Voice cancel", name: "voiceCancel" },
  { label: "Call connect", name: "callConnect" },
  { label: "Call end", name: "callEnd" },
  { label: "Call ring", name: "ringPulse" },
];

const HapticLab = () => {
  const [engine, setEngine] = useState<string>("");

  useEffect(() => {
    let alive = true;
    void getHapticCapabilities().then((caps) => {
      if (!alive) return;
      const tier = hapticTier();
      if (tier === "duo") {
        setEngine(
          caps?.rich
            ? caps.platform === "ios" ? "Premium · Core Haptics" : "Premium · device haptic engine"
            : "Enhanced · basic motor (short pulses)",
        );
      } else if (tier === "capacitor") setEngine("Basic · update the app for premium haptics");
      else if (tier === "web") setEngine("Browser vibration");
      else setEngine("Not available on this device");
    });
    return () => { alive = false; };
  }, []);

  return (
    <div className="px-4 py-3" data-haptic="off">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium">Feel the haptics</p>
        {engine && <p className="text-[11px] text-muted-foreground text-right">{engine}</p>}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {LAB.map(({ label, name }) => (
          <button
            key={name}
            type="button"
            data-haptic="off"
            onClick={() => void fireNamed(name, { bypassGate: true })}
            className="h-7 px-3 rounded-full bg-muted text-[11px] text-foreground active:bg-accent active:text-accent-foreground transition-colors"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
};

export default HapticLab;
