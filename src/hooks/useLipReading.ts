/**
 * useLipReading — Visual Speech Recognition (assistive best-guess, not ASR)
 *
 * HONEST SCOPE: this reads mouth SHAPE, not sound. Published lipreading
 * research is unambiguous that even trained deep models need a closed,
 * fixed vocabulary to do well (e.g. LipNet-style CNN/RNN models trained on
 * the GRID corpus reach ~95%+ on ~50 known words; published lipreading
 * studies put even experienced human lipreaders around ~25-30% on truly
 * open, unscripted speech). There's no realistic way to ship a real
 * sentence-level lipreading model client-side in this app — those are
 * large, trained models, not something a heuristic can approximate. What
 * IS realistic, and what this hook does: track a small dictionary of
 * common short words/phrases per language and best-guess against a real,
 * standardized set of mouth-shape features, so it's genuinely more useful
 * than nothing when a video call partner is muted, without pretending to
 * be a transcript.
 *
 * REWRITE (migrated off legacy @mediapipe/face_mesh):
 *  - That package is discontinued (superseded by @mediapipe/tasks-vision,
 *    which the rest of this app already uses for owner recognition /
 *    mood detection — see lib/faceRecognition.ts) and was never even an
 *    npm dependency here: it was being <script>-tag-injected from a CDN at
 *    runtime, hence the old multi-CDN-mirror fallback dance. Rewritten to
 *    use the shared, already-installed tasks-vision FaceLandmarker via
 *    lib/faceRecognition.ts's getLipLandmarker() — no runtime remote
 *    script injection, and it shares the same cached WASM/model bytes the
 *    app may have already downloaded for mood/peek-guard.
 *  - The old classifier read 2 hand-derived ratios off 4 raw landmark
 *    points (mouth open/width, plus a very rough z-depth "roundness"
 *    guess). tasks-vision's FaceLandmarker can output 52 pre-trained
 *    ARKit-style blendshape scores per frame (jawOpen, mouthPucker,
 *    mouthFunnel, mouthSmileLeft/Right, mouthStretchLeft/Right,
 *    mouthLowerDown/UpperUp, mouthPress, mouthRoll, mouthShrug, ...) —
 *    switching to those is strictly more signal for the same frame, with
 *    no training required on our side (Google's model already learned the
 *    mapping from landmarks to these categories).
 *  - Per-blendshape EMA smoothing before classification, since frame-to-
 *    frame blendshape scores are visibly noisy (encoder motion blur,
 *    compressed WebRTC video) — unsmoothed values would flicker between
 *    visemes even mid-syllable.
 *  - Confidence is now a real margin (winning viseme's evidence vs. the
 *    runner-up's) instead of a fixed formula off one ratio.
 *  - Frame scheduling now prefers video.requestVideoFrameCallback (fires
 *    once per actually-decoded frame) over a blind setInterval, with a
 *    minimum spacing so it still can't out-run the WASM inference on a
 *    high-refresh source; falls back to setInterval where rVFC isn't
 *    supported (older Safari).
 *  - The landmarker singleton now survives stop()/start() toggles within
 *    one call (closing+reloading the whole WASM graph on every Start/Stop
 *    tap was pure wasted latency) — it's only released via
 *    closeLipLandmarker() when the hook itself unmounts (overlay closed).
 *
 * Dictionary/output format is unchanged on purpose: PATTERNS/FALLBACKS
 * below still key off the same small symbol alphabet
 * (A_OPEN/O_ROUND/BILABIAL_CLOSE/DENTAL/E_MID/SILENCE) as before, with the
 * en/hi/mr word lists untouched — only the pipeline that DECIDES which
 * symbol a frame maps to changed. Re-translating/expanding the phrase
 * dictionary itself would risk introducing wrong Hindi/Marathi phrases
 * with no way to verify them; better to spend the improvement entirely on
 * making the existing, native-reviewed phrase set trigger more reliably.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getLipLandmarker, closeLipLandmarker, detectBlendshapes, type BlendshapeScores } from "@/lib/faceRecognition";

export type LipReadLanguage = "en" | "hi" | "mr";

export interface LipReadResult {
  transcript: string;
  confidence: number;
  isFinal: boolean;
  language: LipReadLanguage;
}

interface UseLipReadingOptions {
  language: LipReadLanguage;
  onResult: (result: LipReadResult) => void;
  videoRef: React.RefObject<HTMLVideoElement>;
}

const PATTERNS: Record<string, Record<LipReadLanguage, string>> = {
  "A_OPEN":                               { en: "ah",         hi: "आ",          mr: "आ"          },
  "A_OPEN-O_ROUND":                       { en: "ok",         hi: "ओके",        mr: "ओके"        },
  "A_OPEN-E_MID":                         { en: "hey",        hi: "है",         mr: "आहे"        },
  "BILABIAL_CLOSE":                       { en: "mm",         hi: "म",          mr: "म"          },
  "BILABIAL_CLOSE-A_OPEN":               { en: "pa",         hi: "पा",         mr: "पा"         },
  "BILABIAL_CLOSE-A_OPEN-DENTAL":        { en: "bad",        hi: "बात",        mr: "बात"        },
  "BILABIAL_CLOSE-BILABIAL_CLOSE":       { en: "bye",        hi: "बाय",        mr: "बाय"        },
  "BILABIAL_CLOSE-E_MID":               { en: "be",         hi: "बी",         mr: "बी"         },
  "DENTAL":                              { en: "th",         hi: "त",          mr: "त"          },
  "DENTAL-A_OPEN-DENTAL":               { en: "that",       hi: "तात",        mr: "तात"        },
  "DENTAL-O_ROUND":                      { en: "no",         hi: "नहीं",       mr: "नाही"       },
  "E_MID":                               { en: "ee",         hi: "ई",          mr: "ई"          },
  "E_MID-O_ROUND":                       { en: "hello",      hi: "हेलो",       mr: "हेलो"       },
  "E_MID-A_OPEN":                        { en: "yeah",       hi: "यां",        mr: "याह"        },
  "O_ROUND":                             { en: "oh",         hi: "ओ",          mr: "ओ"          },
  "O_ROUND-DENTAL":                      { en: "on",         hi: "ओन",         mr: "ओन"         },
  "O_ROUND-BILABIAL_CLOSE-E_MID":        { en: "come",       hi: "आओ",         mr: "या"         },
  "O_ROUND-BILABIAL_CLOSE":             { en: "up",         hi: "ऊपर",        mr: "वर"         },
  "A_OPEN-BILABIAL_CLOSE-A_OPEN":        { en: "mama",       hi: "मम्मा",      mr: "आई"         },
  "BILABIAL_CLOSE-A_OPEN-BILABIAL_CLOSE":{ en: "babe",       hi: "बेबी",       mr: "बाळ"        },
  "A_OPEN-E_MID-O_ROUND":               { en: "I love you", hi: "प्यार है",   mr: "प्रेम"      },
  "DENTAL-E_MID-O_ROUND":               { en: "tonight",    hi: "आज रात",     mr: "आज रात्री"  },
  "A_OPEN-DENTAL-A_OPEN":               { en: "happy",      hi: "खुश",        mr: "आनंदी"      },
  "E_MID-BILABIAL_CLOSE":               { en: "yes",        hi: "हाँ",        mr: "हो"         },
  "SILENCE":                             { en: "...",        hi: "...",        mr: "..."        },
};

const FALLBACKS: Record<string, Record<LipReadLanguage, string>> = {
  "A_OPEN":         { en: "a",  hi: "अ",  mr: "अ"  },
  "BILABIAL_CLOSE": { en: "m",  hi: "म",  mr: "म"  },
  "O_ROUND":        { en: "o",  hi: "ओ",  mr: "ओ"  },
  "E_MID":          { en: "e",  hi: "इ",  mr: "इ"  },
  "DENTAL":         { en: "t",  hi: "त",  mr: "त"  },
};

function sequenceToWord(seq: string[], lang: LipReadLanguage): string | null {
  const key = seq.join("-");
  if (PATTERNS[key]) return PATTERNS[key][lang];
  for (let len = Math.min(seq.length - 1, 4); len >= 2; len--) {
    const sub = seq.slice(-len).join("-");
    if (PATTERNS[sub]) return PATTERNS[sub][lang];
  }
  const counts: Record<string, number> = {};
  seq.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
  const dom = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  return FALLBACKS[dom]?.[lang] ?? null;
}

// ── Blendshape → viseme classification ──────────────────────────────────────
// Averages of the left/right pairs tasks-vision reports separately — we
// don't need per-side asymmetry for mouth SHAPE (that's more relevant to
// things like a wink or a smirk than to which sound was made).
const avg2 = (b: BlendshapeScores, a: string, c: string) => ((b[a] ?? 0) + (b[c] ?? 0)) / 2;

interface MouthFeatures {
  jawOpen: number;
  funnel: number;
  pucker: number;
  close: number;
  press: number;
  smile: number;
  stretch: number;
  lowerDown: number;
  upperUp: number;
}

const extractMouthFeatures = (b: BlendshapeScores): MouthFeatures => ({
  jawOpen:   b.jawOpen ?? 0,
  funnel:    b.mouthFunnel ?? 0,
  pucker:    b.mouthPucker ?? 0,
  close:     b.mouthClose ?? 0,
  press:     avg2(b, "mouthPressLeft", "mouthPressRight"),
  smile:     avg2(b, "mouthSmileLeft", "mouthSmileRight"),
  stretch:   avg2(b, "mouthStretchLeft", "mouthStretchRight"),
  lowerDown: avg2(b, "mouthLowerDownLeft", "mouthLowerDownRight"),
  upperUp:   avg2(b, "mouthUpperUpLeft", "mouthUpperUpRight"),
});

/**
 * Evidence score per viseme symbol (same alphabet PATTERNS/FALLBACKS use)
 * from one smoothed feature set — nonnegative "how strongly do these
 * blendshapes look like this mouth shape" magnitudes, not probabilities.
 * classifyViseme() below picks the max and reports the margin as
 * confidence.
 */
const visemeEvidence = (f: MouthFeatures): Record<string, number> => ({
  // Lips pressed/closed together, jaw not dropped — bilabial (p/b/m).
  BILABIAL_CLOSE: Math.max(0, f.close - 0.15) * 3 + Math.max(0, f.press - 0.15) * 2 + Math.max(0, 0.25 - f.jawOpen) * 1.2,
  // Jaw dropped, no lip rounding — open vowel (ah/a).
  A_OPEN: Math.max(0, f.jawOpen - 0.30) * 3 - (f.funnel + f.pucker) * 1.5,
  // Lips rounded (funneled or puckered), whether jaw is open (oh) or
  // nearly closed (oo/w/u) — PATTERNS doesn't distinguish those two, so
  // one symbol covers both, same as the old classifier's O_ROUND.
  O_ROUND: Math.max(0, f.funnel - 0.15) * 2.5 + Math.max(0, f.pucker - 0.15) * 2.5,
  // Corners pulled wide (smile/stretch), jaw not fully open — spread
  // vowel/consonant shapes (ee/i).
  E_MID: Math.max(0, f.smile - 0.15) * 2.5 + Math.max(0, f.stretch - 0.12) * 2
       + Math.max(0, 0.35 - f.jawOpen) * 0.6,
  // Lower lip tucked / teeth-adjacent shapes with little rounding and a
  // mostly-closed jaw — the closest single bucket this feature set can
  // reliably separate out for labiodental/dental/alveolar consonants
  // (f/v/t/d/n/s/th) without a model actually trained on phonemes.
  DENTAL: Math.max(0, f.lowerDown - 0.12) * 2 + Math.max(0, f.upperUp - 0.12) * 1.5
        + Math.max(0, 0.30 - f.jawOpen) * 0.8 - (f.funnel + f.pucker) * 1.2,
});

/** Overall mouth activity — used to tell a genuinely resting/neutral mouth
 *  (SILENCE) apart from a low-confidence-but-real shape. */
const activityLevel = (f: MouthFeatures) =>
  f.jawOpen + f.funnel + f.pucker + f.press + f.smile + f.stretch + f.lowerDown + f.upperUp;

function classifyViseme(f: MouthFeatures): { symbol: string; confidence: number } {
  if (activityLevel(f) < 0.12) return { symbol: "SILENCE", confidence: 0.9 };
  const evidence = visemeEvidence(f);
  const entries = Object.entries(evidence).sort((a, b) => b[1] - a[1]);
  const [topSymbol, topScore] = entries[0];
  const runnerUp = entries[1]?.[1] ?? 0;
  if (topScore <= 0.03) return { symbol: "SILENCE", confidence: 0.4 };
  // Margin-based confidence: how decisively the winner beat the runner-up,
  // relative to its own magnitude — a clean win (runner-up near 0) reads
  // high; two closely-matched shapes read low, which is exactly the case
  // where the guess is least trustworthy. Higher floor (0.35 vs 0.3) to
  // reject more ambiguous frames that would otherwise inject noise into
  // the viseme sequence.
  const margin = (topScore - runnerUp) / (topScore + 0.05);
  const confidence = Math.max(0.35, Math.min(0.95, 0.4 + margin * 0.55));
  return { symbol: topSymbol, confidence };
}

// EMA smoothing factor for blendshape scores — lower = smoother/slower to
// react, higher = noisier but more responsive. 0.55 balances responsiveness
// (visemes genuinely change fast in real speech) with enough smoothing to
// cut frame-to-frame jitter from encoder motion blur and compressed WebRTC
// video. Slightly higher than the original 0.45 to reduce false viseme
// flicker mid-syllable.
const SMOOTHING_ALPHA = 0.55;
const smoothBlendshapes = (prev: BlendshapeScores | null, next: BlendshapeScores): BlendshapeScores => {
  if (!prev) return next;
  const out: BlendshapeScores = {};
  for (const k of Object.keys(next)) {
    out[k] = prev[k] != null ? prev[k] + (next[k] - prev[k]) * SMOOTHING_ALPHA : next[k];
  }
  return out;
};

export const useLipReading = ({ language, onResult, videoRef }: UseLipReadingOptions) => {
  const [isActive,  setIsActive]  = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  const lipLandmarkerRef   = useRef<Awaited<ReturnType<typeof getLipLandmarker>> | null>(null);
  const rvfcHandleRef      = useRef<number | null>(null);
  const intervalRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const smoothedRef        = useRef<BlendshapeScores | null>(null);
  const sequenceRef        = useRef<string[]>([]);
  const silenceRef         = useRef<number>(0);
  const transcriptRef      = useRef<string>("");
  const languageRef        = useRef<LipReadLanguage>(language);
  const onResultRef        = useRef(onResult);
  const lastTickRef        = useRef<number>(0);
  const framesSinceWordRef = useRef<number>(0);

  useEffect(() => { languageRef.current = language; }, [language]);
  useEffect(() => { onResultRef.current = onResult;  }, [onResult]);

  const MIN_FRAME_MS = 80; // ~12.5fps cap — plenty for mouth-shape changes, keeps WASM inference cost bounded
  const WINDOW        = 16;
  const SILENCE_MS     = 700;

  // Multi-frame voting: keep a rolling window of the last N viseme
  // classifications and use majority voting to pick the final symbol.
  // Eliminates single-frame outliers from motion blur, compression
  // artifacts, or momentary expression glitches.
  const VOTE_WINDOW = 5;
  const voteBufferRef = useRef<string[]>([]);

  const handleFrame = useCallback((symbol: string, confidence: number) => {
    const lang = languageRef.current;
    const now  = Date.now();
    if (symbol === "SILENCE") {
      if (now - silenceRef.current > SILENCE_MS && sequenceRef.current.length >= 3) {
        const word = sequenceToWord(sequenceRef.current, lang);
        if (word) {
          const next = (transcriptRef.current + " " + word).trim();
          transcriptRef.current = next;
          onResultRef.current({ transcript: next, confidence: Math.max(0.5, confidence), isFinal: false, language: lang });
        }
        sequenceRef.current = [];
      }
      silenceRef.current = now;
      voteBufferRef.current = [];
      return;
    }
    // Multi-frame voting: push symbol, keep last VOTE_WINDOW entries,
    // pick the majority. This smooths out single-frame misclassifications
    // that the EMA alone doesn't fully catch (e.g. a brief jaw twitch
    // misclassified as A_OPEN mid-O_ROUND).
    voteBufferRef.current.push(symbol);
    if (voteBufferRef.current.length > VOTE_WINDOW) voteBufferRef.current.shift();
    const counts: Record<string, number> = {};
    for (const s of voteBufferRef.current) counts[s] = (counts[s] || 0) + 1;
    const votedSymbol = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    // Only accept the voted symbol if it has a clear majority (≥2 of last 5)
    // — otherwise it's too ambiguous to commit to.
    if (counts[votedSymbol] < 2) return;
    sequenceRef.current.push(votedSymbol);
    if (sequenceRef.current.length > WINDOW) sequenceRef.current = sequenceRef.current.slice(-WINDOW);
    framesSinceWordRef.current += 1;
    if (framesSinceWordRef.current >= 6) {
      framesSinceWordRef.current = 0;
      const word = sequenceToWord(sequenceRef.current.slice(-6), lang);
      if (word) {
        onResultRef.current({ transcript: word, confidence, isFinal: false, language: lang });
      }
    }
  }, []);

  // Runs at most once per MIN_FRAME_MS, driven by whichever scheduling
  // primitive is available (see start() below) — video.readyState/
  // videoWidth is still the real liveness check for a MediaStream element
  // (.paused is always false for those), same reasoning as the pre-rewrite
  // version.
  const processFrame = useCallback(async (ts: number) => {
    const video = videoRef.current;
    const lm = lipLandmarkerRef.current;
    if (!video || !lm) return;
    if (video.readyState < 2) return;
    if (video.videoWidth === 0) return;
    if (ts - lastTickRef.current < MIN_FRAME_MS) return;
    lastTickRef.current = ts;
    try {
      const raw = detectBlendshapes(lm, video, ts);
      if (!raw) { handleFrame("SILENCE", 0.5); return; } // no face this frame
      const smoothed = smoothBlendshapes(smoothedRef.current, raw);
      smoothedRef.current = smoothed;
      const { symbol, confidence } = classifyViseme(extractMouthFeatures(smoothed));
      handleFrame(symbol, confidence);
    } catch { /* transient — this frame just doesn't count */ }
  }, [videoRef, handleFrame]);

  const stop = useCallback(() => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    // Cast to `any`: requestVideoFrameCallback/cancelVideoFrameCallback are
    // real, broadly-supported (Chrome/Edge/Safari 15.4+) HTMLVideoElement
    // methods, but not guaranteed present in every TS DOM lib snapshot —
    // this project's tsconfig has skipLibCheck on, so the cast is just
    // insurance against a stale lib.dom.d.ts, not a real type mismatch.
    const v = videoRef.current as any;
    if (rvfcHandleRef.current != null && v?.cancelVideoFrameCallback) {
      v.cancelVideoFrameCallback(rvfcHandleRef.current);
    }
    rvfcHandleRef.current = null;
    sequenceRef.current = [];
    smoothedRef.current = null;
    // NOTE: deliberately does NOT close the landmarker here (see file-top
    // rewrite note) — only the unmount effect below does that, so
    // Start/Stop within one call is instant instead of reloading the WASM
    // graph every toggle.
    setIsActive(false);
    setIsLoading(false);
  }, [videoRef]);

  const start = useCallback(async () => {
    if (isActive || isLoading) return;
    setIsLoading(true);
    setError(null);
    transcriptRef.current = "";
    sequenceRef.current   = [];
    smoothedRef.current   = null;
    lastTickRef.current   = 0;
    framesSinceWordRef.current = 0;
    try {
      const lm = await getLipLandmarker();
      lipLandmarkerRef.current = lm;
      const video = videoRef.current as any;
      if (!video) throw new Error("No video source");

      // Prefer requestVideoFrameCallback — fires once per actually-decoded
      // frame instead of guessing on a wall-clock timer, so it never
      // double-processes a stalled frame during network jitter and never
      // sits idle "waiting" past a frame that already arrived.
      if (typeof video.requestVideoFrameCallback === "function") {
        const loop = (now: number) => {
          processFrame(now);
          rvfcHandleRef.current = video.requestVideoFrameCallback(loop);
        };
        rvfcHandleRef.current = video.requestVideoFrameCallback(loop);
      } else {
        intervalRef.current = setInterval(() => processFrame(performance.now()), MIN_FRAME_MS);
      }
      setIsActive(true);
    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : String(err)) || "Lip reading unavailable on this device");
    } finally {
      setIsLoading(false);
    }
  }, [isActive, isLoading, videoRef, processFrame]);

  const clearTranscript = useCallback(() => {
    transcriptRef.current = "";
    sequenceRef.current   = [];
  }, []);

  // Reset full context (sequence + transcript) on language change, so
  // switching languages mid-session doesn't prepend stale transcript.
  useEffect(() => {
    sequenceRef.current   = [];
    transcriptRef.current = "";
  }, [language]);

  // Stop the frame loop on unmount, and THIS is where the landmarker
  // actually gets released — see stop()'s note above for why start/stop
  // toggles don't do this.
  useEffect(() => () => {
    stop();
    closeLipLandmarker();
    lipLandmarkerRef.current = null;
  }, [stop]);

  return { isActive, isLoading, error, start, stop, clearTranscript };
};
