/**
 * useBackgroundMoodDetection
 * ───────────────────────────
 * The "Daily Mood" card (MoodDetector.tsx) always shows a full-screen
 * prompt, a countdown, and a confirm/feedback step before it ever writes to
 * mood_logs. That's the right default, but it means the mood trend line is
 * only ever one sample a day, taken at whatever moment the person happens
 * to tap through a popup.
 *
 * This hook is the opposite of that: a SEPARATE opt-in ("Background
 * auto-detect" in Security & Privacy settings, off by default and only
 * offered once "Daily Mood" itself is on) that periodically takes a short,
 * silent read using the exact same math as the manual card (see
 * lib/moodScoring.ts) and writes it straight to mood_logs — no dialog, no
 * countdown, no confirmation, nothing rendered at all. If a read comes back
 * ambiguous (no face, too dark, model not ready) it's just skipped — unlike
 * the manual flow, there's no one watching to say "actually I'm not
 * feeling anything" or correct a bad guess, so a silent low-confidence
 * write would only pollute the trend with noise nobody can see coming.
 *
 * Same privacy contract as the manual card: the camera frame itself is
 * never saved or sent anywhere, only the resulting mood + confidence
 * numbers, and it shares the app's single camera stream via cameraBus.ts
 * rather than opening a second one.
 */
import { useEffect, useRef } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useTheme } from "@/contexts/ThemeContext";
import { supabase } from "@/integrations/supabase/client";
import storage from "@/lib/storage";
// NOTE: supabase is still used for mood_logs inserts (the actual mood
// reading is stored server-side for the mood history UI), but calibration
// feedback data stays entirely on-device via getLocalDistrust().
import { acquireCamera } from "@/lib/cameraBus";
import { detectFaces, getLandmarker } from "@/lib/faceRecognition";
import {
  type ExpressionSample, extractExpression, moodToValence,
  scoreMoods, softmaxScores, filterBlinks, weightedAvg,
  getLocalDistrust, sampleLuma, moodFrameIssue, MOOD_MIN_LUMA, topMoodWithMargin,
} from "@/lib/moodScoring";

// Deliberately gentler than the manual card's 5s/14-sample window — this
// runs unattended and unannounced, so it should be as brief as the math
// allows rather than optimizing for read quality the way a supervised,
// feedback-corrected capture can afford to.
const CAPTURE_MS = 2500;
const SAMPLE_INTERVAL_MS = 350;
const MIN_USABLE_SAMPLES = 4;

// A trend needs a handful of points a day, not a firehose — capping both
// how often and how many-per-day keeps this from draining battery, opening
// the camera more than the person would expect from "runs sometimes in the
// background", or logging so densely that outliers dominate the graph.
const INTERVAL_MS = 2 * 60 * 60 * 1000; // one attempt every 2h while eligible
const FIRST_RUN_DELAY_MS = 60 * 1000; // small delay after becoming eligible, not instant-on-load
const MAX_PER_DAY = 6;
const COUNT_KEY_PREFIX = "mood-bg-count-"; // + YYYY-MM-DD

const todayKey = () => COUNT_KEY_PREFIX + new Date().toDateString();

const readCountToday = (): number => Number(storage.get(todayKey()) || "0");
const bumpCountToday = () => storage.set(todayKey(), String(readCountToday() + 1));

export const useBackgroundMoodDetection = () => {
  const { user } = useAuth();
  const { appSettings } = useTheme();
  const enabled = !!(user && appSettings.moodDetection && appSettings.moodBackgroundDetection);

  // Guards against two capture cycles overlapping (e.g. interval fires
  // again while a slow previous attempt is still holding the camera).
  const runningRef = useRef(false);
  const distrustRef = useRef<Record<string, number>>({});

  // Calibration from on-device storage — mood feedback never leaves the device.
  useEffect(() => {
    if (!enabled) return;
    distrustRef.current = getLocalDistrust();
    const refresh = setInterval(() => { distrustRef.current = getLocalDistrust(); }, 30000);
    return () => clearInterval(refresh);
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !user) return;

    const runOnce = async () => {
      if (runningRef.current) return;
      if (document.hidden) return; // app backgrounded — don't wake the camera for nothing
      if (readCountToday() >= MAX_PER_DAY) return;
      runningRef.current = true;

      let lease: Awaited<ReturnType<typeof acquireCamera>> | null = null;
      let video: HTMLVideoElement | null = null;
      let canvas: HTMLCanvasElement | null = null;
      try {
        video = document.createElement("video");
        video.setAttribute("playsinline", "");
        video.setAttribute("autoplay", "");
        video.muted = true;
        // Fully off-screen — this mode's entire point is that nothing
        // renders, so there's no preview, no scan animation, nothing.
        video.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
        document.body.appendChild(video);
        canvas = document.createElement("canvas"); // scratch for sampleLuma, never rendered

        lease = await acquireCamera("user");
        video.srcObject = lease.stream;
        await video.play().catch(() => {});
        await getLandmarker().catch(() => { throw new Error("model unavailable"); });

        const samples: ExpressionSample[] = [];
        const deadline = Date.now() + CAPTURE_MS;
        let ts = performance.now();
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, SAMPLE_INTERVAL_MS));
          if (!video || video.readyState < 2) continue;
          try {
            ts = Math.max(ts + 1, performance.now());
            const faces = await detectFaces(video, ts);
            // Same quality gate as the manual card (see moodFrameIssue in
            // lib/moodScoring.ts) — this path has no human in the loop to
            // notice a bad read and pick manually instead, so it's the ONE
            // place it's most important not to average noise into a
            // silent write. Previously this accepted any single-face frame
            // unconditionally, with no brightness or blur/angle check at
            // all — meaningfully less scrutiny than the manual flow, which
            // is backwards given nobody's watching this one.
            if (faces.length === 1 && canvas) {
              const luma = sampleLuma(video, canvas);
              const tooDark = luma != null && luma < MOOD_MIN_LUMA;
              if (!tooDark && !moodFrameIssue(faces[0])) {
                const expr = extractExpression(faces[0].embedding);
                expr.eyeOpenness = faces[0].ear;
                samples.push(expr);
              }
            }
            // Unlike the manual card, multi-face / no-face / low-quality
            // frames are just not counted — there's no live hint to show
            // for them here.
          } catch { /* transient — this frame just doesn't count */ }
        }

        if (samples.length < MIN_USABLE_SAMPLES) return; // too little signal — skip silently, no low-quality write

        const pool = filterBlinks(samples);
        const mouthCurve  = weightedAvg(pool, (s) => s.mouthCurve);
        const mouthOpen   = weightedAvg(pool, (s) => s.mouthOpen);
        const browRaise   = weightedAvg(pool, (s) => s.browRaise);
        const eyeOpenness = weightedAvg(pool, (s) => s.eyeOpenness);

        const evidence = scoreMoods({ mouthCurve, mouthOpen, browRaise, eyeOpenness }, distrustRef.current);
        const probs = softmaxScores(evidence);
        const ranked = topMoodWithMargin(probs);

        // No human in the loop here to catch a bad guess (see file doc
        // comment), so this is the ONE path where a near-tied top-two
        // margin (see topMoodWithMargin) should skip the write outright
        // rather than falling back to logging "Neutral" — a low-margin
        // read isn't evidence the person is neutral, it's evidence the
        // classifier couldn't tell, and there's nobody here to notice and
        // correct it the way the manual card's confirm step allows.
        if (ranked.ambiguous) return;

        const { mood, topProb } = ranked;
        const confidence = Math.max(0.3, Math.min(0.95, mood === "Neutral" ? Math.max(0.4, topProb) : 0.4 + topProb * 0.55));

        // A background read is inherently lower-trust than a supervised one
        // (nobody can say "that's wrong" in the moment) — skip writing
        // anything the classifier itself is unsure about rather than
        // silently seeding the trend with a coin-flip guess.
        if (confidence < 0.45) return;

        const va = moodToValence[mood] || { valence: 0, arousal: 0.5 };
        const { error } = await supabase.from("mood_logs").insert({
          user_id: user.id,
          mood,
          confidence,
          valence: va.valence,
          arousal: va.arousal,
          features: {
            source: "background",
            mouth_curve: mouthCurve, mouth_open: mouthOpen, brow_raise: browRaise,
            eye_openness: eyeOpenness, sample_count: samples.length,
            mood_probabilities: probs, top_margin: ranked.margin,
          },
        });
        if (!error) bumpCountToday();
        else console.debug("[mood-bg] insert skipped:", error.message);
      } catch (err) {
        console.debug("[mood-bg] capture skipped:", err instanceof Error ? err.message : err);
      } finally {
        if (video) { video.srcObject = null; video.remove(); }
        lease?.release();
        runningRef.current = false;
      }
    };

    const firstRun = setTimeout(runOnce, FIRST_RUN_DELAY_MS);
    const interval = setInterval(runOnce, INTERVAL_MS);
    return () => { clearTimeout(firstRun); clearInterval(interval); };
  }, [enabled, user]);
};
