/**
 * Surprise 3.0 §10: Sensory Director.
 *
 * "The UI should be simple and premium. Do not overwhelm the user with
 * technical terminology" — so no HapticKind/HapticDNA/rhythm-curve jargon
 * anywhere here, just the plain-language controls the brief itself names.
 * A collapsed-by-default panel (most creators should never need to open
 * it — Auto is the whole point) with a preset row up top that prefills the
 * sliders/selects below, all of which stay editable afterward.
 */
import { useState } from "react";
import { ChevronDown, Sparkles } from "lucide-react";
import type { SensorySettings, SensoryPartnerReactionMode, SensoryRhythmSpeed } from "@/lib/surpriseSensory";
import { dnaToSequence, type HapticRhythm, type HapticDNA } from "@/lib/surpriseHapticDNA";
import { playHapticSequence } from "@/lib/surpriseHaptics";
import { fireHaptic } from "@/lib/haptics";
import { SURPRISE_PRESETS } from "@/lib/surprisePresets";

interface SensoryDirectorPanelProps {
  value: SensorySettings;
  onChange: (next: SensorySettings) => void;
}

const HAPTIC_OPTIONS: { value: NonNullable<SensorySettings["haptic"]>; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "soft", label: "Soft" },
  { value: "light", label: "Light" },
  { value: "selection", label: "Sparkle" },
  { value: "medium", label: "Medium" },
  { value: "heavy", label: "Heavy" },
  { value: "double", label: "Double Pulse" },
  { value: "rigid", label: "Rigid" },
];

// §3 audit fix: a real Rhythm PATTERN selector — separate from Speed below
// — was missing entirely; the engine (dnaToSequence) has fully supported
// every one of these since §2/§3 shipped, the picker just never exposed
// them. "custom" is intentionally excluded — there's no custom-waveform
// authoring, so it isn't offered as a choice a creator could pick and have
// nothing happen; Auto is the honest default instead.
const RHYTHM_OPTIONS: { value: "auto" | HapticRhythm; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "heartbeat", label: "Heartbeat" }, { value: "breathing", label: "Breathing" },
  { value: "wave", label: "Wave" }, { value: "sparkle", label: "Sparkle" },
  { value: "pulse", label: "Pulse" }, { value: "burst", label: "Burst" },
  { value: "crescendo", label: "Crescendo" }, { value: "knock", label: "Knock" },
  { value: "ripple", label: "Ripple" },
  { value: "purr", label: "Purr" }, { value: "rain", label: "Rain" },
  { value: "firework", label: "Firework" }, { value: "waltz", label: "Waltz" },
  { value: "flutter", label: "Flutter" }, { value: "tide", label: "Tide" },
  { value: "morse", label: "Morse" }, { value: "typewriter", label: "Typewriter" },
  { value: "fizz", label: "Fizz" }, { value: "thunder", label: "Thunder" },
  { value: "lullaby", label: "Lullaby" }, { value: "fuse", label: "Fuse" },
  { value: "slots", label: "Slots" }, { value: "snow", label: "Snow" },
  { value: "drumroll", label: "Drumroll" }, { value: "shave", label: "Knock Knock" },
  { value: "duet", label: "Duet" }, { value: "whisper", label: "Whisper" },
  { value: "lockbreak", label: "Lock Break" }, { value: "gallop", label: "Racing" },
  { value: "sway", label: "Sway" },
];

/** Feel a rhythm/texture right now — same path the real surprise uses
 *  (dnaToSequence → playHapticSequence), so what you tap is what they feel. */
const PREVIEW_BASE: HapticDNA = {
  mood: "romantic", texture: "medium", resolution: "light",
  rhythm: "heartbeat", intensity: 55, anticipation: 50, climax: 75,
};
let cancelPreview: (() => void) | null = null;
const feel = (dna: HapticDNA, moment: "interact" | "majorReveal" = "interact") => {
  cancelPreview?.();
  cancelPreview = playHapticSequence(dnaToSequence(dna, moment));
};

/** Horizontal, scrollable row of chips. Tapping one selects it AND plays it. */
function ChipRow<T extends string>({
  options, selected, onPick,
}: { options: { value: T; label: string; emoji?: string }[]; selected?: T; onPick: (v: T) => void }) {
  return (
    <div className="-mx-4 overflow-x-auto overscroll-x-contain px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
         style={{ WebkitOverflowScrolling: "touch" }}>
      <div className="flex w-max gap-1.5">
        {options.map((o) => (
          <button
            key={o.value} type="button" aria-pressed={selected === o.value}
            onClick={() => onPick(o.value)}
            className={`shrink-0 h-8 rounded-full px-3 text-[11px] font-medium active:scale-95 transition-transform ${
              selected === o.value ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
          >
            {o.emoji ? `${o.emoji} ` : ""}{o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const RHYTHM_SPEED_OPTIONS: { value: SensoryRhythmSpeed; label: string }[] = [
  { value: "slow", label: "Slow" }, { value: "medium", label: "Medium" }, { value: "fast", label: "Fast" },
];

// §3 audit fix: "Custom" removed — sendPartnerReaction has never had a
// distinct behavior for it (falls back to Auto), so offering it as a
// pickable option falsely implied a feature that isn't there.
const PARTNER_REACTION_OPTIONS: { value: Exclude<SensoryPartnerReactionMode, "custom">; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "on_receive", label: "On Receive" },
  { value: "on_open", label: "On Open" },
  { value: "on_complete", label: "On Complete" },
];

const Slider = ({ label, value, onChange }: { label: string; value?: number; onChange: (v: number) => void }) => (
  <label className="flex flex-col gap-1">
    <span className="flex items-center justify-between text-[11px] text-muted-foreground">
      <span>{label}</span>
      <span>{value ?? "Auto"}</span>
    </span>
    <input
      type="range" min={0} max={100} value={value ?? 50}
      onChange={(e) => onChange(Number(e.target.value))}
      aria-label={label}
      onPointerUp={() => fireHaptic("selection")}
      className="h-1.5 w-full accent-primary"
    />
  </label>
);

const SensoryDirectorPanel = ({ value, onChange }: SensoryDirectorPanelProps) => {
  const [open, setOpen] = useState(false);
  const set = <K extends keyof SensorySettings>(key: K, v: SensorySettings[K]) => onChange({ ...value, [key]: v });

  return (
    <div className="border-b border-border/20">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-2 text-[11px] font-medium text-muted-foreground"
        aria-expanded={open}
      >
        <span className="flex items-center gap-1.5"><Sparkles className="h-3 w-3" /> Sensory Director</span>
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="flex flex-col gap-3 px-4 pb-3">
          {/* Presets — prefill only, never a locked mode. Picking one just
              calls onChange with that preset's sensory object; every
              control below stays live and editable afterward, same as any
              other change to `value`. */}
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">Presets · tap to feel</span>
            <div className="-mx-4 overflow-x-auto overscroll-x-contain px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                 style={{ WebkitOverflowScrolling: "touch" }}>
              <div className="flex w-max gap-1.5">
                {SURPRISE_PRESETS.map((p) => (
                  <button
                    key={p.id} type="button" title={p.description}
                    onClick={() => {
                      onChange(p.sensory);
                      feel({
                        ...PREVIEW_BASE,
                        texture: p.sensory.haptic && p.sensory.haptic !== "auto" ? p.sensory.haptic : PREVIEW_BASE.texture,
                        rhythm: p.sensory.rhythm && p.sensory.rhythm !== "auto" && p.sensory.rhythm !== "custom" ? p.sensory.rhythm : PREVIEW_BASE.rhythm,
                        intensity: p.sensory.intensity ?? PREVIEW_BASE.intensity,
                        anticipation: p.sensory.anticipation ?? PREVIEW_BASE.anticipation,
                        climax: p.sensory.climax ?? PREVIEW_BASE.climax,
                      }, "majorReveal");
                    }}
                    className="shrink-0 h-8 rounded-full bg-muted px-3 text-[11px] font-medium text-muted-foreground active:scale-95 transition-transform hover:bg-muted/70"
                  >
                    {p.emoji} {p.name}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">Haptic · tap to feel</span>
            <ChipRow
              options={HAPTIC_OPTIONS}
              selected={value.haptic ?? "auto"}
              onPick={(v) => {
                set("haptic", v);
                if (v !== "auto") fireHaptic(v as never); else fireHaptic("selection");
              }}
            />
          </div>

          <Slider label="Intensity" value={value.intensity} onChange={(v) => set("intensity", v)} />

          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">Rhythm · tap to feel</span>
            <ChipRow
              options={RHYTHM_OPTIONS}
              selected={value.rhythm ?? "auto"}
              onPick={(v) => {
                set("rhythm", v);
                if (v === "auto") { fireHaptic("selection"); return; }
                feel({
                  ...PREVIEW_BASE, rhythm: v as HapticRhythm,
                  texture: value.haptic && value.haptic !== "auto" ? value.haptic : PREVIEW_BASE.texture,
                  intensity: value.intensity ?? PREVIEW_BASE.intensity,
                });
              }}
            />
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">Rhythm Speed</span>
            <div className="flex gap-1.5">
              {RHYTHM_SPEED_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => { set("rhythmSpeed", o.value); fireHaptic(o.value === "fast" ? "light" : o.value === "slow" ? "soft" : "selection"); }}
                  className={`h-7 flex-1 rounded-lg text-[11px] font-medium ${value.rhythmSpeed === o.value ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </label>

          <Slider label="3D Depth" value={value.depth3d} onChange={(v) => set("depth3d", v)} />
          <Slider label="Tilt Response" value={value.tiltResponse} onChange={(v) => set("tiltResponse", v)} />
          <Slider label="Anticipation" value={value.anticipation} onChange={(v) => set("anticipation", v)} />
          <Slider label="Climax" value={value.climax} onChange={(v) => set("climax", v)} />

          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">Partner Reaction</span>
            <select
              value={value.partnerReaction ?? "off"}
              onChange={(e) => set("partnerReaction", e.target.value as SensoryPartnerReactionMode)}
              className="h-8 rounded-lg border border-border/40 bg-background px-2 text-xs"
            >
              {PARTNER_REACTION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>

          <button
            type="button"
            onClick={() => onChange({})}
            className="self-start text-[10px] font-medium text-muted-foreground underline underline-offset-2"
          >
            Reset to Auto
          </button>
        </div>
      )}
    </div>
  );
};

export default SensoryDirectorPanel;
