/**
 * Surprise content → haptic composer.
 *
 * IMPORTANT ON NAMING: this is deliberately NOT an ML/LLM model. It's a
 * deterministic, rule-based pattern scanner over the surprise's own
 * html/css/js source — regex + keyword scoring, no network call, no
 * inference, runs instantly and offline. "Detects patterns and writes
 * haptics accordingly" is accurate; framing it as "AI" would overclaim
 * what's actually happening, so the exports below are named and documented
 * as a heuristic analyzer. If real model-based inference is wanted later,
 * this module is the seam to swap in a call to one — the interface
 * (analyzeSurpriseContent → HapticSequence) wouldn't need to change.
 *
 * The five moods below aren't arbitrary — they're the finest distinction
 * this kind of keyword/color scoring can support reliably. A real ML
 * model reading full context could support finer shades; a regex scanner
 * guessing between 15 moods would mostly guess wrong. Same reasoning
 * caps confidence-driven behavior: below MIN_CONFIDENCE the analyzer
 * doesn't pretend certainty it doesn't have (see resolveMood).
 */
import type { HapticKind } from "@/lib/haptics";

export type SurpriseMood = "romantic" | "celebratory" | "playful" | "calm" | "intense";

export interface SurpriseAnalysis {
  mood: SurpriseMood;
  /** Runner-up mood by score — null only when there's no signal at all.
   *  Used for confidence-blended sequences, see buildHapticScore below. */
  secondaryMood: SurpriseMood | null;
  /** 0-1, how confidently the scan landed on `mood` vs. the runner-up —
   *  low-confidence results still return a mood (there's always a
   *  best-scoring bucket) but callers can use this to blend or go gentler. */
  confidence: number;
  /** Emoji actually found in the surprise's own content, for reuse in the
   *  floating-particle layer — reflects what THIS surprise contains
   *  rather than a generic mood-only fallback set. */
  emojisFound: string[];
  /** Longest CSS animation/transition duration this surprise declares, in
   *  ms — null when none was found. Paces the ambient haptic loop against
   *  how long the surprise's own content actually plays for. */
  contentDurationMs: number | null;
}

interface HapticStep {
  kind: HapticKind;
  delayMs: number;
}
export type HapticSequence = HapticStep[];

// ── Emoji → mood buckets ────────────────────────────────────────────────────
const EMOJI_MOOD: Record<string, SurpriseMood> = {
  "💕": "romantic", "❤️": "romantic", "😍": "romantic", "🥰": "romantic", "💖": "romantic",
  "💗": "romantic", "💘": "romantic", "😘": "romantic", "💝": "romantic", "🌹": "romantic",
  "🎉": "celebratory", "🎊": "celebratory", "✨": "celebratory", "🥳": "celebratory", "🎈": "celebratory",
  "🎆": "celebratory", "🏆": "celebratory", "🎁": "celebratory",
  "😂": "playful", "🤪": "playful", "😜": "playful", "🎮": "playful", "🕹️": "playful", "😝": "playful",
  "🌙": "calm", "⭐": "calm", "🕊️": "calm", "🍃": "calm", "☁️": "calm", "🌊": "calm", "😌": "calm",
  "🔥": "intense", "💥": "intense", "⚡": "intense", "💪": "intense",
};
const EMOJI_REGEX = /\p{Extended_Pictographic}/gu;

// ── CSS keyword → mood weight ───────────────────────────────────────────────
const CSS_KEYWORD_WEIGHTS: { pattern: RegExp; mood: SurpriseMood; weight: number }[] = [
  { pattern: /heartbeat|pulse/i, mood: "romantic", weight: 2 },
  { pattern: /float|drift|sway/i, mood: "calm", weight: 1.5 },
  { pattern: /confetti|burst|pop-?in/i, mood: "celebratory", weight: 2 },
  { pattern: /bounce|wiggle|jelly/i, mood: "playful", weight: 1.5 },
  { pattern: /shake|glitch|flash/i, mood: "intense", weight: 1.5 },
  { pattern: /fade-?in|glow-?soft/i, mood: "calm", weight: 1 },
  { pattern: /spin-?fast|rapid/i, mood: "intense", weight: 1 },
];

// ── JS keyword → mood weight ────────────────────────────────────────────────
const JS_KEYWORD_WEIGHTS: { pattern: RegExp; mood: SurpriseMood; weight: number }[] = [
  { pattern: /confetti|particles?burst|fireworks?/i, mood: "celebratory", weight: 2.5 },
  { pattern: /new Audio\(|playSound|beep/i, mood: "intense", weight: 1 },
  { pattern: /typewriter|typeText/i, mood: "romantic", weight: 1 },
  { pattern: /shake|vibrate|rumble/i, mood: "intense", weight: 1.5 },
];

// ── Color hue bucket → mood weight (very rough, HSL-hue-only) ──────────────
const HEX_REGEX = /#([0-9a-f]{3}|[0-9a-f]{6})\b/gi;
const hexToHue = (hex: string): number | null => {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return null; // greyscale, no hue signal
  const d = max - min;
  let hue: number;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue *= 60;
  return hue < 0 ? hue + 360 : hue;
};
const hueToMood = (hue: number): SurpriseMood | null => {
  if (hue >= 320 || hue < 15) return "romantic";   // pink/red/magenta
  if (hue >= 15 && hue < 50) return "celebratory"; // orange/gold
  if (hue >= 50 && hue < 90) return "playful";     // yellow-green
  if (hue >= 180 && hue < 260) return "calm";      // cyan/blue
  return null; // green/purple mid-range — not distinctive enough to score
};

const MIN_CONFIDENCE = 0.15;

/**
 * Scans the surprise's own html/css/js for emoji, animation-keyword, color,
 * and interaction-pace patterns, scores each of the 5 moods, and returns
 * the winner AND the runner-up (for confidence-blended sequences — see
 * buildHapticScore below). Pure function, no I/O — safe to call on every
 * render (callers should still memoize on the surprise id since it's not
 * free).
 */
export const analyzeSurpriseContent = (html: string, css: string, js: string): SurpriseAnalysis => {
  const scores: Record<SurpriseMood, number> = {
    romantic: 0, celebratory: 0, playful: 0, calm: 0, intense: 0,
  };

  const emojisFound = Array.from(new Set((html.match(EMOJI_REGEX) ?? [])));
  for (const e of emojisFound) {
    const mood = EMOJI_MOOD[e];
    if (mood) scores[mood] += 1.5;
  }

  for (const { pattern, mood, weight } of CSS_KEYWORD_WEIGHTS) {
    if (pattern.test(css)) scores[mood] += weight;
  }
  for (const { pattern, mood, weight } of JS_KEYWORD_WEIGHTS) {
    if (pattern.test(js)) scores[mood] += weight;
  }
  // Fast setInterval/setTimeout (<150ms) reads as energetic/intense; slow
  // ones (>800ms) read as calm/deliberate pacing.
  const intervalMatches = [...js.matchAll(/set(?:Interval|Timeout)\([^,]+,\s*(\d+)/gi)];
  for (const m of intervalMatches) {
    const ms = Number(m[1]);
    if (Number.isFinite(ms)) {
      if (ms < 150) scores.intense += 1;
      else if (ms > 800) scores.calm += 0.5;
    }
  }

  const hexMatches = [...css.matchAll(HEX_REGEX)].map(m => m[0]);
  for (const hex of hexMatches) {
    const hue = hexToHue(hex);
    if (hue === null) continue;
    const mood = hueToMood(hue);
    if (mood) scores[mood] += 0.5;
  }

  const entries = Object.entries(scores) as [SurpriseMood, number][];
  entries.sort((a, b) => b[1] - a[1]);
  const [topMood, topScore] = entries[0];
  const [secondMood] = entries[1];
  const total = entries.reduce((s, [, v]) => s + v, 0);
  const confidence = total > 0 ? topScore / total : 0;

  // No signal at all (blank/minimal custom code) — default to romantic
  // rather than an arbitrary array-order pick, since this is a couples app
  // and that's the safer prior for an unreadable surprise.
  const mood = total === 0 ? "romantic" : topMood;
  const secondaryMood = total === 0 ? null : secondMood;

  // Rough duration signal — longest CSS animation/transition duration this
  // surprise declares, used to pace the ambient haptic loop against how
  // long the content actually plays for rather than a fixed guess. Falls
  // back to a sane default when nothing's found (static content, or a
  // duration expressed some other way the regex can't see).
  const durationMatches = [...css.matchAll(/(?:animation|transition)[^;]*?(\d+(?:\.\d+)?)(s|ms)\b/gi)];
  const durationsMs = durationMatches
    .map(m => Number(m[1]) * (m[2].toLowerCase() === "s" ? 1000 : 1))
    .filter(Number.isFinite);
  const contentDurationMs = durationsMs.length ? Math.max(...durationsMs) : null;

  return {
    mood,
    secondaryMood,
    confidence: total === 0 ? MIN_CONFIDENCE : confidence,
    emojisFound,
    contentDurationMs,
  };
};

/**
 * Per-mood haptic "score" — not one burst but four distinct beats across
 * the surprise's lifecycle, the way a film's score has an opening sting, a
 * scene bed, a climax, and a resolution rather than one sound cue:
 *
 *  - open:    fires once, right as the card lands (the "sting")
 *  - ambient: a SHORT sequence that loops softly and infrequently while
 *             the surprise stays open in glass phase — a heartbeat that
 *             keeps beating, not a one-off. Deliberately gentler than
 *             `open` so it reads as presence, not a repeated alert.
 *  - expand:  fires when the partner taps to go full-screen — a bigger,
 *             more confident beat than `open`, since committing to the
 *             full experience is itself a moment.
 *  - close:   a small, soft farewell tap — the only step that should
 *             NEVER be loud regardless of mood, since it plays as the
 *             partner is already leaving.
 *
 * Each step reuses the app's existing haptic primitives (lib/haptics.ts) —
 * this module never touches navigator.vibrate/Capacitor Haptics directly,
 * so the user's haptics on/off + intensity preferences still apply exactly
 * as they do everywhere else in the app; this only decides WHICH
 * primitives to fire and when.
 */
export interface HapticScore {
  open: HapticSequence;
  ambient: HapticSequence;
  expand: HapticSequence;
  close: HapticSequence;
}

const SCORES: Record<SurpriseMood, HapticScore> = {
  // Two soft beats then a fuller one — reads as an actual heartbeat, not a
  // generic buzz. Ambient repeats just the two soft beats, quietly, so the
  // "heart" keeps beating the whole time the card is open.
  romantic: {
    open: [
      { kind: "soft", delayMs: 0 },
      { kind: "soft", delayMs: 180 },
      { kind: "medium", delayMs: 520 },
      { kind: "double", delayMs: 1000 },
    ],
    ambient: [
      { kind: "soft", delayMs: 0 },
      { kind: "soft", delayMs: 180 },
    ],
    expand: [
      { kind: "medium", delayMs: 0 },
      { kind: "soft", delayMs: 200 },
      { kind: "double", delayMs: 450 },
    ],
    close: [{ kind: "soft", delayMs: 0 }],
  },
  // Ramping burst — light, light, medium, heavy, settle. Ambient is a
  // smaller version of the same shape, like confetti still drifting down
  // after the big burst.
  celebratory: {
    open: [
      { kind: "light", delayMs: 0 },
      { kind: "light", delayMs: 90 },
      { kind: "medium", delayMs: 190 },
      { kind: "heavy", delayMs: 320 },
      { kind: "double", delayMs: 620 },
    ],
    ambient: [
      { kind: "tick", delayMs: 0 },
      { kind: "light", delayMs: 140 },
    ],
    expand: [
      { kind: "heavy", delayMs: 0 },
      { kind: "medium", delayMs: 120 },
      { kind: "heavy", delayMs: 260 },
      { kind: "double", delayMs: 520 },
    ],
    close: [{ kind: "light", delayMs: 0 }],
  },
  // Quick, uneven ticks — a bit of a giggle in vibration form. Ambient
  // keeps just one playful tick so it doesn't get twitchy over time.
  playful: {
    open: [
      { kind: "tick", delayMs: 0 },
      { kind: "tick", delayMs: 110 },
      { kind: "selection", delayMs: 260 },
      { kind: "light", delayMs: 430 },
    ],
    ambient: [{ kind: "tick", delayMs: 0 }],
    expand: [
      { kind: "selection", delayMs: 0 },
      { kind: "light", delayMs: 130 },
      { kind: "tick", delayMs: 260 },
    ],
    close: [{ kind: "tick", delayMs: 0 }],
  },
  // Just two widely-spaced soft taps — a breath, not an alert. Ambient is
  // ONE tap even more spaced out — calm means calm throughout, not just
  // at the start.
  calm: {
    open: [
      { kind: "soft", delayMs: 0 },
      { kind: "soft", delayMs: 700 },
    ],
    ambient: [{ kind: "soft", delayMs: 0 }],
    expand: [
      { kind: "soft", delayMs: 0 },
      { kind: "soft", delayMs: 400 },
    ],
    close: [{ kind: "soft", delayMs: 0 }],
  },
  // Two heavy hits then a rigid snap — the most forceful open, used
  // sparingly (only when the content itself earns it). Ambient still
  // stays restrained — a sustained heavy buzz every few seconds would be
  // unpleasant, not premium, so ambient for intense is deliberately the
  // gentlest-relative-to-its-own-open of all five moods.
  intense: {
    open: [
      { kind: "heavy", delayMs: 0 },
      { kind: "heavy", delayMs: 220 },
      { kind: "rigid", delayMs: 480 },
    ],
    ambient: [{ kind: "light", delayMs: 0 }],
    expand: [
      { kind: "rigid", delayMs: 0 },
      { kind: "heavy", delayMs: 180 },
    ],
    close: [{ kind: "soft", delayMs: 0 }],
  },
};

/**
 * Resolves the full haptic score for an analysis result. Below
 * MIN_BLEND_CONFIDENCE, the scan didn't land confidently on one mood over
 * the runner-up — rather than commit fully to a guess it's not sure of,
 * the `open` step interleaves the top TWO moods' open sequences (halved
 * delays, merged) so the result reads as "warm and a little playful"
 * instead of confidently wrong. Ambient/expand/close stay on the winning
 * mood alone — blending those too would make the whole experience feel
 * indecisive rather than just the opening beat being nuanced.
 */
const MIN_BLEND_CONFIDENCE = 0.4;

export const buildHapticScore = (analysis: SurpriseAnalysis): HapticScore => {
  const primary = SCORES[analysis.mood];
  if (analysis.confidence >= MIN_BLEND_CONFIDENCE || !analysis.secondaryMood) return primary;

  const secondary = SCORES[analysis.secondaryMood];
  const blendedOpen: HapticSequence = [
    ...primary.open.slice(0, 2),
    ...secondary.open.slice(0, 2).map(s => ({ ...s, delayMs: s.delayMs + 260 })),
  ].sort((a, b) => a.delayMs - b.delayMs);

  return { ...primary, open: blendedOpen };
};

/** Back-compat single-shot accessor — most callers want the full score via
 *  buildHapticScore now, but this keeps the simpler "just the open beat"
 *  shape available where a full score would be overkill. */
export const buildHapticSequence = (mood: SurpriseMood): HapticSequence => SCORES[mood].open;

/**
 * Fires a sequence via the app's existing fireHaptic() — respects the
 * global haptics on/off + intensity settings already baked into every
 * primitive, so this needs no preference-checking of its own. Returns a
 * cancel function; callers should invoke it on unmount/surprise-change so
 * a sequence from a closed surprise never fires late into whatever's open
 * next.
 */
export const playHapticSequence = (sequence: HapticSequence): (() => void) => {
  // Lazy import avoids a hard circular-ish coupling at module-eval time —
  // haptics.ts has no dependency on this file, so this is just being
  // consistent with how the rest of the app keeps haptics.ts leaf-level.
  const timers: ReturnType<typeof setTimeout>[] = [];
  import("@/lib/haptics").then(({ fireHaptic }) => {
    for (const step of sequence) {
      timers.push(setTimeout(() => fireHaptic(step.kind), step.delayMs));
    }
  });
  return () => { for (const t of timers) clearTimeout(t); };
};

/**
 * The "movie experience" layer: plays `open` once immediately, then loops
 * `ambient` on a slow, mood-paced interval for as long as the returned
 * stop function hasn't been called. Interval length is informed by
 * contentDurationMs when the surprise's own CSS gave a real signal (paced
 * to roughly match how long its own animation plays for, capped to a
 * sensible range so a surprise with a 40ms micro-transition doesn't turn
 * into a buzzing mess) — falls back to a fixed calm default otherwise.
 * ALWAYS stop this on unmount, on close, and when the card expands (the
 * expand step's own one-shot beat takes over from there) — a forgotten
 * interval is the one way this whole layer could become annoying instead
 * of premium.
 */
export const playHapticMovie = (score: HapticScore, contentDurationMs: number | null): (() => void) => {
  const cancelOpen = playHapticSequence(score.open);
  const openDuration = score.open.length ? Math.max(...score.open.map(s => s.delayMs)) + 300 : 0;
  const ambientIntervalMs = Math.max(2600, Math.min(6000, (contentDurationMs ?? 3800) * 1.4));

  let cancelled = false;
  let ambientTimer: ReturnType<typeof setInterval> | null = null;
  const startTimer = setTimeout(() => {
    if (cancelled) return;
    ambientTimer = setInterval(() => playHapticSequence(score.ambient), ambientIntervalMs);
  }, openDuration);

  return () => {
    cancelled = true;
    cancelOpen();
    clearTimeout(startTimer);
    if (ambientTimer) clearInterval(ambientTimer);
  };
};
