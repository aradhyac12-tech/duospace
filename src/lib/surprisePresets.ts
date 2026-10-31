/**
 * Surprise 3.0 §9 (Interaction Presets) + §11 (Creative Surprise Templates).
 *
 * One reusable registry, not 12 hardcoded pages. Each preset is DATA — a
 * SensorySettings starting point (§10) plus which interaction model and
 * partner-event behavior it favors — consumed generically by the existing
 * engine (SurpriseExperienceEngine + SurpriseReveal + useSurpriseTouch) the
 * same way a creator's own manual Sensory Director choices are. Selecting a
 * preset in the editor is exactly "prefill these SensorySettings fields,
 * still editable after" — there is no second, parallel rendering path a
 * preset locks a surprise into.
 *
 * `climaxPoint`/`completionBehavior` are documentation-level fields (a
 * short human-readable description shown in the picker), not new engine
 * hooks — the actual climax/completion behavior IS the `climax`/rhythm
 * fields on `sensory`, realized through the existing dnaToSequence()
 * (lib/surpriseHapticDNA.ts) and SurpriseReveal's existing MAJOR_REVEAL/
 * COMPLETE dispatch points (items 1-4). A preset doesn't need its own
 * bespoke visual code to have a distinct climax — the generic engine
 * already varies visibly across texture/rhythm/climax combinations.
 */
import type { SensorySettings } from "@/lib/surpriseSensory";

export type SurpriseInteractionModel =
  | "tap" | "long-press" | "double-tap" | "drag" | "swipe" | "tilt" | "combo";

export interface SurprisePreset {
  id: string;
  name: string;
  description: string;
  /** Which of useSurpriseTouch's gestures (§4) this preset is BUILT around —
   *  informational for the picker UI; every preset still receives every
   *  gesture callback, this just documents the primary intended one. */
  interactionModel: SurpriseInteractionModel;
  /** Small glyph shown on the picker chip so presets are recognisable at a glance. */
  emoji: string;
  sensory: SensorySettings;
  /** Whether this preset's own reveal is naturally a two-device moment —
   *  purely descriptive; wiring an actual dual-sync payoff for these is
   *  §7/§12's Couple Sync work (recordCoupleSyncEvent("surprise_major_reveal")
   *  already persists the state that would drive it), not something this
   *  registry entry does by itself. */
  coupleSync: boolean;
  climaxPoint: string;
  completionBehavior: string;
}

export const SURPRISE_PRESETS: SurprisePreset[] = [
  // ── Original set — re-tuned so no two presets share a rhythm any more ──
  {
    id: "heartbeat", name: "Heartbeat", emoji: "💓",
    description: "The message slowly appears according to a heartbeat rhythm.",
    interactionModel: "long-press",
    sensory: { haptic: "soft", rhythm: "heartbeat", rhythmSpeed: "slow", climax: 55 },
    coupleSync: false,
    climaxPoint: "The message finishes resolving on the final beat.",
    completionBehavior: "Settles to a single soft pulse.",
  },
  {
    id: "breathing", name: "Breathing", emoji: "🌬️",
    description: "A slow in-and-out rhythm carries the whole reveal.",
    interactionModel: "tilt",
    sensory: { haptic: "soft", rhythm: "breathing", rhythmSpeed: "slow", intensity: 30, climax: 35 },
    coupleSync: false,
    climaxPoint: "No sharp peak by design — the climax IS the calm.",
    completionBehavior: "Fades out on an exhale.",
  },
  {
    id: "distance-pulse", name: "Distance Pulse", emoji: "📡",
    description: "Sender interaction creates a visual ripple on the partner's device.",
    interactionModel: "tap",
    sensory: { haptic: "medium", rhythm: "ripple", partnerReaction: "on_receive" },
    coupleSync: true,
    climaxPoint: "Each tap ripple, not one single peak — repeatable.",
    completionBehavior: "Ripples settle when the recipient stops interacting.",
  },
  {
    id: "secret-touch", name: "Secret Touch", emoji: "🤫",
    description: "Recipient must reproduce a gesture to unlock the message.",
    interactionModel: "long-press",
    sensory: { haptic: "rigid", rhythm: "knock", anticipation: 70, climax: 90 },
    coupleSync: false,
    climaxPoint: "The unlock moment itself — deliberately the biggest beat.",
    completionBehavior: "One firm confirming pulse once unlocked.",
  },
  {
    id: "mood-orb", name: "Mood Orb", emoji: "🔮",
    description: "Tilt the device to guide an orb toward the reveal.",
    interactionModel: "tilt",
    sensory: { haptic: "light", rhythm: "wave", depth3d: 100, tiltResponse: 100, anticipation: 60 },
    coupleSync: false,
    climaxPoint: "The orb reaching its target.",
    completionBehavior: "A gentle settle as the orb comes to rest.",
  },
  {
    id: "constellation", name: "Constellation", emoji: "✨",
    description: "Every interaction creates stars until the hidden message appears.",
    interactionModel: "tap",
    sensory: { haptic: "selection", rhythm: "sparkle", anticipation: 65, climax: 60 },
    coupleSync: false,
    climaxPoint: "The last star completing the pattern.",
    completionBehavior: "The full constellation holds, then dims slightly.",
  },
  {
    id: "treasure-hunt", name: "Treasure Hunt", emoji: "🗺️",
    description: "One surprise unlocks the next clue.",
    interactionModel: "combo",
    sensory: { haptic: "medium", rhythm: "crescendo", partnerReaction: "on_complete" },
    coupleSync: true,
    climaxPoint: "Each unlock is its own small climax; the last one is the big one.",
    completionBehavior: "A double pulse that reads as 'go to the next one'.",
  },
  {
    id: "living-photograph", name: "Living Photograph", emoji: "🖼️",
    description: "Layered photo with depth/parallax and a gentle, swaying touch.",
    interactionModel: "tilt",
    // was wave (same as Mood Orb) — now its own slow sway of soft/tick pairs.
    sensory: { haptic: "light", rhythm: "sway", intensity: 25, depth3d: 100, tiltResponse: 80 },
    coupleSync: false,
    climaxPoint: "No single peak — the depth itself is the point.",
    completionBehavior: "Parallax simply stops responding once closed.",
  },
  {
    id: "countdown-reveal", name: "Countdown Reveal", emoji: "⏳",
    description: "Tactile rhythm accelerates toward the reveal.",
    interactionModel: "tap",
    // was crescendo (same as Treasure Hunt) — now an even, mechanical pulse train.
    sensory: { haptic: "heavy", rhythm: "pulse", rhythmSpeed: "fast", anticipation: 85, climax: 95 },
    coupleSync: false,
    climaxPoint: "The final beat of the accelerating countdown.",
    completionBehavior: "One decisive final pulse, no fade.",
  },
  {
    id: "two-screen-heart", name: "Two-Screen Heart", emoji: "🫶",
    description: "Semantic synchronization between both partners creates the final state.",
    interactionModel: "combo",
    // was heartbeat (same as Heartbeat) — now TWO interleaved heartbeats, yours then theirs.
    sensory: { haptic: "double", rhythm: "duet", partnerReaction: "on_open", climax: 80 },
    coupleSync: true,
    climaxPoint: "Both partners' semantic states landing (see §12's persisted-state model).",
    completionBehavior: "A shared heartbeat pulse on both devices once synchronized.",
  },
  {
    id: "message-from-future", name: "Message From the Future", emoji: "🔒",
    description: "Locked message with a dramatic unlock interaction.",
    interactionModel: "long-press",
    // was knock+rigid (identical to Secret Touch) — now lock-pick clicks ending in a crack.
    sensory: { haptic: "rigid", rhythm: "lockbreak", anticipation: 90, climax: 100 },
    coupleSync: false,
    climaxPoint: "The lock breaking open.",
    completionBehavior: "A single heavy pulse, then quiet.",
  },
  {
    id: "infinite-surprise", name: "Infinite Surprise", emoji: "♾️",
    description: "Completing the first interaction reveals a hidden second layer.",
    interactionModel: "double-tap",
    sensory: { haptic: "double", rhythm: "burst", anticipation: 40, climax: 70 },
    coupleSync: false,
    climaxPoint: "Two climaxes — the first reveal, then the hidden layer beneath it.",
    completionBehavior: "A second, softer pulse confirms the hidden layer was found.",
  },
  {
    id: "just-because", name: "Just Because", emoji: "🤍",
    description: "Minimal romantic scene with extremely subtle tactile interaction.",
    interactionModel: "tap",
    // was breathing (same as Breathing) — now three barely-there ticks.
    sensory: { haptic: "soft", rhythm: "whisper", intensity: 20, anticipation: 30, climax: 20 },
    coupleSync: false,
    climaxPoint: "Deliberately none — this preset has no big moment on purpose.",
    completionBehavior: "Simply fades. Nothing to \"complete\".",
  },

  // ── New in v3.12 — every one owns a rhythm nobody else uses ──
  {
    id: "purr", name: "Purr", emoji: "🐈",
    description: "A warm, rolling buzz under your thumb — like a cat settling into your lap.",
    interactionModel: "long-press",
    sensory: { haptic: "soft", rhythm: "purr", intensity: 35, anticipation: 45, climax: 30 },
    coupleSync: false,
    climaxPoint: "The purr deepens, then simply keeps going.",
    completionBehavior: "Tapers off slowly, like drifting to sleep.",
  },
  {
    id: "rainfall", name: "Rainfall", emoji: "🌧️",
    description: "Sparse drops that thicken into a shower, then clear.",
    interactionModel: "drag",
    sensory: { haptic: "light", rhythm: "rain", intensity: 40, rhythmSpeed: "medium", climax: 45 },
    coupleSync: false,
    climaxPoint: "The downpour peak, right before it clears.",
    completionBehavior: "One last drop, then quiet.",
  },
  {
    id: "fireworks", name: "Fireworks", emoji: "🎆",
    description: "A rising whistle, a huge boom, then a crackle of sparks.",
    interactionModel: "tap",
    sensory: { haptic: "heavy", rhythm: "firework", anticipation: 75, climax: 100, partnerReaction: "on_complete" },
    coupleSync: true,
    climaxPoint: "The boom — deliberately the loudest thing felt anywhere in the app.",
    completionBehavior: "Sparks crackle down and fade.",
  },
  {
    id: "waltz", name: "Waltz", emoji: "💃",
    description: "ONE-two-three, ONE-two-three — a strong beat and two soft ones, turning.",
    interactionModel: "swipe",
    sensory: { haptic: "medium", rhythm: "waltz", rhythmSpeed: "slow", intensity: 55, climax: 50 },
    coupleSync: true,
    climaxPoint: "The final turn lands on a strong beat.",
    completionBehavior: "A curtsy: one soft beat.",
  },
  {
    id: "butterflies", name: "Butterflies", emoji: "🦋",
    description: "Erratic, feather-light flutters — nervous excitement you can feel.",
    interactionModel: "tap",
    sensory: { haptic: "light", rhythm: "flutter", intensity: 30, anticipation: 55, climax: 40 },
    coupleSync: false,
    climaxPoint: "A flurry, then one settled beat.",
    completionBehavior: "Wings fold: a single soft tap.",
  },
  {
    id: "ocean-tide", name: "Ocean Tide", emoji: "🌊",
    description: "A long swell that builds from a whisper to a crash, then pulls back out.",
    interactionModel: "drag",
    sensory: { haptic: "medium", rhythm: "tide", rhythmSpeed: "slow", anticipation: 80, climax: 65 },
    coupleSync: false,
    climaxPoint: "The crest — the heaviest beat, then the recede.",
    completionBehavior: "Recedes to a soft foam-fizz.",
  },
  {
    id: "morse-love", name: "Morse Love", emoji: "📟",
    description: "Dots and dashes tapped out on the screen — L…V… — a message in code.",
    interactionModel: "combo",
    sensory: { haptic: "rigid", rhythm: "morse", rhythmSpeed: "medium", anticipation: 50, climax: 75 },
    coupleSync: true,
    climaxPoint: "The last dash — the one you decode.",
    completionBehavior: "Transmission ends: one clean tick.",
  },
  {
    id: "typewriter", name: "Typewriter", emoji: "⌨️",
    description: "Uneven key clacks as the words appear, ending with the carriage-return ding.",
    interactionModel: "tap",
    sensory: { haptic: "light", rhythm: "typewriter", rhythmSpeed: "medium", climax: 60 },
    coupleSync: false,
    climaxPoint: "The carriage-return ding at the end of the line.",
    completionBehavior: "Paper feeds: a double tick.",
  },
  {
    id: "champagne", name: "Champagne", emoji: "🍾",
    description: "Fizzing bubbles climbing to a cork pop.",
    interactionModel: "long-press",
    sensory: { haptic: "selection", rhythm: "fizz", anticipation: 70, climax: 85, partnerReaction: "on_open" },
    coupleSync: true,
    climaxPoint: "The pop.",
    completionBehavior: "Fizz settles into a few last bubbles.",
  },
  {
    id: "thunderstorm", name: "Thunderstorm", emoji: "⛈️",
    description: "A low distant rumble that builds until the sky cracks.",
    interactionModel: "long-press",
    sensory: { haptic: "heavy", rhythm: "thunder", rhythmSpeed: "slow", intensity: 80, anticipation: 85, climax: 100 },
    coupleSync: false,
    climaxPoint: "The lightning crack, followed by its echo.",
    completionBehavior: "Rumble rolls away.",
  },
  {
    id: "lullaby", name: "Lullaby", emoji: "🌙",
    description: "A slow rocking — long, short, long, short — to settle a busy mind.",
    interactionModel: "tilt",
    sensory: { haptic: "soft", rhythm: "lullaby", rhythmSpeed: "slow", intensity: 25, anticipation: 90, climax: 15 },
    coupleSync: false,
    climaxPoint: "None — each rock is quieter than the last.",
    completionBehavior: "Goodnight: one very soft beat.",
  },
  {
    id: "lit-fuse", name: "Lit Fuse", emoji: "🧨",
    description: "A crackling, speeding-up spark travelling toward the surprise.",
    interactionModel: "tap",
    sensory: { haptic: "medium", rhythm: "fuse", rhythmSpeed: "fast", anticipation: 95, climax: 90 },
    coupleSync: false,
    climaxPoint: "The fuse reaching the end.",
    completionBehavior: "Smoke: a single light tap.",
  },
  {
    id: "slot-machine", name: "Slot Machine", emoji: "🎰",
    description: "A fast whirr, then three reels locking in — thunk, thunk, THUNK.",
    interactionModel: "swipe",
    sensory: { haptic: "heavy", rhythm: "slots", rhythmSpeed: "fast", anticipation: 60, climax: 95 },
    coupleSync: false,
    climaxPoint: "The third reel locking in.",
    completionBehavior: "Coins: a fast double tick.",
  },
  {
    id: "snowflake", name: "Snowflake", emoji: "❄️",
    description: "Single, ultra-light touches, far apart — like flakes landing on your sleeve.",
    interactionModel: "tap",
    sensory: { haptic: "selection", rhythm: "snow", rhythmSpeed: "slow", intensity: 15, climax: 10 },
    coupleSync: false,
    climaxPoint: "Deliberately none.",
    completionBehavior: "The last flake melts.",
  },
  {
    id: "drumroll", name: "Drumroll", emoji: "🥁",
    description: "A fast rattling roll, a beat of silence, then the cymbal hit.",
    interactionModel: "long-press",
    sensory: { haptic: "medium", rhythm: "drumroll", rhythmSpeed: "fast", anticipation: 90, climax: 100 },
    coupleSync: false,
    climaxPoint: "The hit after the pause.",
    completionBehavior: "Cymbal rings out: a slow soft fade.",
  },
  {
    id: "knock-knock", name: "Knock Knock", emoji: "🚪",
    description: "Shave-and-a-haircut … two bits. The partner has to knock back.",
    interactionModel: "double-tap",
    sensory: { haptic: "medium", rhythm: "shave", partnerReaction: "on_receive", anticipation: 55, climax: 70 },
    coupleSync: true,
    climaxPoint: "The two closing knocks.",
    completionBehavior: "Door opens: one soft creak of a beat.",
  },
  {
    id: "racing-heart", name: "Racing Heart", emoji: "🏃",
    description: "Lub-dub, lub-dub, lub-dub — fast, close together and getting away from you.",
    interactionModel: "tap",
    sensory: { haptic: "medium", rhythm: "gallop", rhythmSpeed: "fast", intensity: 70, anticipation: 20, climax: 75 },
    coupleSync: false,
    climaxPoint: "The third beat pair, then a held breath.",
    completionBehavior: "Heart slows: two soft pulses.",
  },
];

export const getSurprisePreset = (id: string): SurprisePreset | undefined =>
  SURPRISE_PRESETS.find((p) => p.id === id);
