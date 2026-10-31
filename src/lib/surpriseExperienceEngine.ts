/**
 * Surprise 3.0 §1: SurpriseExperienceEngine.
 *
 * The single synchronization layer between haptics and every visual/motion
 * channel a surprise has (animation, particles, lighting, tilt, partner
 * events). Nothing here starts its OWN timer for anything — it fires a
 * capability-aware haptic sequence built from this surprise's deterministic
 * Haptic DNA (lib/surpriseHapticDNA.ts) synchronously with notifying
 * whatever visual code subscribed to this surprise's events, so both stay
 * anchored to the same call instead of two clocks agreeing by convention.
 *
 * Callers dispatch a semantic moment at the exact instant it already
 * happens in the UI (onClick, onAnimationComplete, a realtime event
 * landing) — same pattern SurpriseHapticEngine already used successfully,
 * extended here with id+content awareness so the sequence fired is THIS
 * surprise's own DNA rather than a shared per-mood table, plus an
 * idempotency guard so a remount/reconnect can never replay a completed
 * climax (see §14/§15 in the brief — this is the seam that work will hang
 * off of).
 *
 * Deliberately does NOT replace SurpriseHapticEngine (lib/surpriseHaptics.ts)
 * — that mood-only API stays as the simpler primitive for anywhere a full
 * surprise object isn't in scope. This engine is the richer, id+content-aware
 * coordinator that the three real call sites (SurpriseReveal, useChatSurprise)
 * now dispatch through instead, and that later items (Couple Sync partner
 * events, the Sensory Director panel, presets) will extend rather than
 * duplicate.
 */
import { analyzeSurpriseContent, type SurpriseAnalysis } from "@/lib/surpriseHaptics";
import { buildHapticDNA, dnaToSequence, type HapticDNA, type ExperienceMoment } from "@/lib/surpriseHapticDNA";
import { playCapabilityAwareSequence } from "@/lib/surpriseCapabilities";
import { applySensoryOverride } from "@/lib/surpriseSensory";

export type ExperienceEvent =
  | "RECEIVE" | "MATERIALIZE" | "OPEN" | "INTERACT"
  | "MAJOR_REVEAL" | "COMPLETE" | "CLOSE" | "PARTNER_REACTION";

export interface SurpriseContentRef {
  html_content: string;
  css_content: string;
  js_content: string;
  /** §10: optional — present when called with a full EngineSurprise. */
  sensory_settings?: import("@/lib/surpriseSensory").SensorySettings | null;
}

export type ExperienceListener = (event: ExperienceEvent, dna: HapticDNA) => void;

/** OPEN is the same moment INTERACT already models (tapped row / expanded
 *  the glass phase) — kept as a distinct event name because §1 names both,
 *  but there is only one sequence shape for it, not two competing ones. */
const EVENT_TO_MOMENT: Record<Exclude<ExperienceEvent, "PARTNER_REACTION">, ExperienceMoment> = {
  RECEIVE: "receive",
  MATERIALIZE: "materialize",
  OPEN: "interact",
  INTERACT: "interact",
  MAJOR_REVEAL: "majorReveal",
  COMPLETE: "complete",
  CLOSE: "close",
};

/** Events that must never fire their haptic twice for the same surprise —
 *  a React remount, a realtime reconnect, or a duplicate dispatch call
 *  must not replay the climax or the completion beat. RECEIVE/MATERIALIZE/
 *  OPEN/INTERACT/CLOSE can legitimately re-fire (reopening a surprise from
 *  the timeline is a real, repeatable action). */
const ONCE_PER_SURPRISE: ReadonlySet<ExperienceEvent> = new Set(["MAJOR_REVEAL", "COMPLETE"]);

const dnaCache = new Map<string, HapticDNA>();
const firedOnce = new Map<string, Set<ExperienceEvent>>();
const listeners = new Map<string, Set<ExperienceListener>>();

const getDNA = (surpriseId: string, content: SurpriseContentRef): HapticDNA => {
  let dna = dnaCache.get(surpriseId);
  if (!dna) {
    const analysis: SurpriseAnalysis = analyzeSurpriseContent(content.html_content, content.css_content, content.js_content);
    // §10: the deterministic generator always runs first — a Sensory
    // Director override reshapes its output field-by-field, it never
    // replaces the generation itself (see applySensoryOverride's own
    // comment for why: this keeps Auto fields genuinely auto instead of a
    // second code path that could drift from buildHapticDNA over time).
    dna = applySensoryOverride(buildHapticDNA(surpriseId, analysis), content.sensory_settings);
    dnaCache.set(surpriseId, dna);
  }
  return dna;
};

export const SurpriseExperienceEngine = {
  /**
   * One call per moment. Returns the DNA used (callers rarely need it —
   * mainly useful for a debug/dev surface, or a future Sensory Director
   * "Auto" preview) so this stays a single round trip rather than a
   * dispatch-then-separate-getDNA pair.
   */
  dispatch(surpriseId: string, event: ExperienceEvent, content: SurpriseContentRef): HapticDNA {
    const dna = getDNA(surpriseId, content);

    if (event !== "PARTNER_REACTION") {
      const moment = EVENT_TO_MOMENT[event];
      const already = firedOnce.get(surpriseId);
      const blocked = ONCE_PER_SURPRISE.has(event) && already?.has(event);
      if (!blocked) {
        playCapabilityAwareSequence(dnaToSequence(dna, moment));
        if (ONCE_PER_SURPRISE.has(event)) {
          if (already) already.add(event);
          else firedOnce.set(surpriseId, new Set([event]));
        }
      }
    }
    // PARTNER_REACTION has no local haptic of its own yet — §8 wires this
    // to a distinct, deliberately subtle pulse once Couple Sync's Supabase
    // event plumbing exists. Listeners still get notified below so visual
    // code can react (e.g. a small connection pulse) ahead of that.

    listeners.get(surpriseId)?.forEach((fn) => fn(event, dna));
    return dna;
  },

  /** Visual/motion code subscribes here instead of re-deriving "did the
   *  climax already fire" from its own component state. Returns an
   *  unsubscribe function. */
  subscribe(surpriseId: string, fn: ExperienceListener): () => void {
    let set = listeners.get(surpriseId);
    if (!set) {
      set = new Set();
      listeners.set(surpriseId, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) listeners.delete(surpriseId);
    };
  },

  /** Drop this surprise's cached DNA/fired-state/listeners. Call on close —
   *  keeps the maps from growing unbounded across a long chat session.
   *  Safe even if dispatch() was never called for this id. */
  release(surpriseId: string): void {
    dnaCache.delete(surpriseId);
    firedOnce.delete(surpriseId);
    listeners.delete(surpriseId);
  },
};
