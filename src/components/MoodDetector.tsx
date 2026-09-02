import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Camera, X, ThumbsUp, ThumbsDown, CameraOff, Settings2, RefreshCw, CheckCircle2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import storage from "@/lib/storage";
import { hapticLight, hapticWarning, hapticSuccess } from "@/lib/haptics";
import { useToast } from "@/hooks/use-toast";
import { acquireCamera, explainGumError, type CameraLease } from "@/lib/cameraBus";
import { detectFaces, getLandmarker } from "@/lib/faceRecognition";
import { openAppSettings } from "@/lib/mediaPermissions";
import { Capacitor } from "@capacitor/core";
import {
  type ExpressionSample, type MoodLabel, extractExpression, moods, moodToValence,
  scoreMoods, softmaxScores, sampleLuma, weightedAvg, filterBlinks,
  recordMoodFeedback, getLocalDistrust, moodFrameIssue, MOOD_MIN_LUMA,
} from "@/lib/moodScoring";
import { useBackgroundMoodDetection } from "@/hooks/useBackgroundMoodDetection";

const MOOD_KEY = "last-mood-check-date";
const SAMPLE_INTERVAL_MS = 350; // ~14 samples across the 5s window

const MoodDetector = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  // Silent/background auto mood detection — entirely separate from the
  // card below (own opt-in toggle, own schedule, zero UI). Mounted here
  // because MoodDetector is already the one always-on component this
  // feature area gets rendered from (see AppLayout.tsx) — see the hook
  // itself for why it never shows anything.
  useBackgroundMoodDetection();
  const [show, setShow] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectedMood, setDetectedMood] = useState<string | null>(null);
  const [lowConfidence, setLowConfidence] = useState(false);
  // Numeric confidence (0-100) for the last detected/confirmed mood, so the
  // UI can say "≈68% confident" instead of just a hidden boolean. Manual
  // picks are 100 and marked `confirmed` — camera reads start `detected`
  // and only become `confirmed` once the person taps "Real alert"/👍.
  const [confidencePct, setConfidencePct] = useState<number | null>(null);
  const [moodSource, setMoodSource] = useState<"detected" | "confirmed">("detected");
  const [lastLogId, setLastLogId] = useState<string | null>(null);
  const [feedbackGiven, setFeedbackGiven] = useState(false);
  const [countdown, setCountdown] = useState(5);
  // Live, in-progress hint shown under the video during the scan itself —
  // separate from the post-scan readIssue message, so multi-face/no-face
  // is caught early instead of only explained after all 5s are wasted.
  const [liveHint, setLiveHint] = useState<string | null>(null);
  // Distinguishes *why* a read failed so the message is actionable instead
  // of a generic "didn't work": camera blocked at the OS/browser level vs.
  // the on-device model failing to load vs. a genuinely ambiguous read
  // (no face / too many faces / too dark) once the window closes.
  const [cameraIssue, setCameraIssue] = useState<{ code: string; message: string } | null>(null);
  const [readIssue, setReadIssue] = useState<"model_failed" | "too_dark" | "multi_face" | "no_face" | "low_quality" | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const leaseRef = useRef<CameraLease | null>(null);
  const countdownTickRef = useRef<number | null>(null);
  // Per-attempt diagnostic counters, reset at the start of each detection window.
  const noFaceCountRef = useRef(0);
  const multiFaceCountRef = useRef(0);
  const darkFrameCountRef = useRef(0);
  // A face WAS detected but rejected as unusable (too small/blurry/off-angle)
  // — see moodFrameIssue in lib/moodScoring.ts. Tracked separately from
  // darkFrameCount/noFaceCount so the post-scan message can say "hold
  // still/get closer" instead of the misleading "can't find your face".
  const lowQualityCountRef = useRef(0);
  const modelFailCountRef = useRef(0);
  const tickCountRef = useRef(0);
  const scratchCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Rolling window of mood probability distributions for temporal smoothing.
  const moodProbHistoryRef = useRef<Record<MoodLabel, number>[]>([]);

  // Fix #Bug11: only auto-show if user has explicitly opted in via Settings toggle.
  // Previously the camera permission dialog appeared 5s after every login — no consent.
  const MOOD_OPT_IN_KEY = "mood-detection-enabled";

  // Check if we need to show mood detection today
  useEffect(() => {
    if (!user) return;
    if (storage.get(MOOD_OPT_IN_KEY) !== "true") return; // not opted in
    const lastCheck = storage.get(MOOD_KEY);
    const today = new Date().toDateString();
    if (lastCheck !== today) {
      const timer = setTimeout(() => setShow(true), 5000);
      return () => clearTimeout(timer);
    }
  }, [user]);

  // Stable ref so startDetection always calls the *current* analyzeMood —
  // otherwise a stale closure captured before `user` loads would silently
  // skip saving.
  const analyzeMoodRef = useRef<() => Promise<void>>(async () => {});
  const samplesRef = useRef<ExpressionSample[]>([]);
  const sampleTickRef = useRef<number | null>(null);
  const tsRef = useRef(0);
  // Per-mood distrust multiplier (1 = no adjustment) derived from this
  // user's own "was this accurate?" feedback history — a mood this specific
  // user has frequently corrected requires a stronger signal next time
  // before we commit to it again, instead of repeating the same mistake.
  const distrustRef = useRef<Record<string, number>>({});

  // Pull calibration data from on-device storage — mood feedback never
  // leaves the device for privacy. No Supabase query needed.
  useEffect(() => {
    if (!show) return;
    distrustRef.current = getLocalDistrust();
  }, [show]);

  const startDetection = useCallback(async () => {
    setDetecting(true);
    setCameraIssue(null);
    setReadIssue(null);
    setCountdown(5);
    setLowConfidence(false);
    setLiveHint(null);
    samplesRef.current = [];
    moodProbHistoryRef.current = [];
    tsRef.current = 0;
    noFaceCountRef.current = 0;
    multiFaceCountRef.current = 0;
    darkFrameCountRef.current = 0;
    lowQualityCountRef.current = 0;
    modelFailCountRef.current = 0;
    tickCountRef.current = 0;
    if (!scratchCanvasRef.current) scratchCanvasRef.current = document.createElement("canvas");

    try {
      const lease = await acquireCamera("user");
      leaseRef.current = lease;
      if (videoRef.current) {
        videoRef.current.srcObject = lease.stream;
        await videoRef.current.play().catch(() => {});
      }
      // Warm up the landmark model in parallel — first call is otherwise slow.
      // If the model itself can't load (no network on first run, CDN
      // blocked, etc.), every later detectFaces() call will also reject —
      // we surface that distinctly rather than blaming it on lighting.
      getLandmarker().catch(() => { modelFailCountRef.current += 999; });

      // Sample real facial landmarks throughout the window instead of
      // reading a single final frame — smooths out blinks, motion blur,
      // and momentary expressions into a stable read.
      sampleTickRef.current = window.setInterval(async () => {
        const v = videoRef.current;
        if (!v || v.readyState < 2) return;
        tickCountRef.current += 1;
        try {
          tsRef.current = Math.max(tsRef.current + 1, performance.now());
          const faces = await detectFaces(v, tsRef.current);
          // Sample brightness every tick now, not just on missing-face ticks —
          // dim light degrades landmark precision even when a face IS still
          // detected, and mood scoring's deltas are small enough that this
          // matters (see moodFrameIssue's doc comment in lib/moodScoring.ts).
          let luma: number | null = null;
          if (scratchCanvasRef.current) {
            luma = sampleLuma(v, scratchCanvasRef.current);
            if (luma != null && luma < MOOD_MIN_LUMA) darkFrameCountRef.current += 1;
          }
          const tooDarkForFace = luma != null && luma < MOOD_MIN_LUMA;
          if (faces.length === 1 && !tooDarkForFace) {
            const issue = moodFrameIssue(faces[0]);
            if (issue) {
              lowQualityCountRef.current += 1;
            } else {
              const expr = extractExpression(faces[0].embedding);
              expr.eyeOpenness = faces[0].ear;
              samplesRef.current.push(expr);
            }
          } else if (faces.length === 1 && tooDarkForFace) {
            // Face nominally detected but the frame's too dark to trust it —
            // already counted above via darkFrameCountRef.
          } else if (faces.length === 0) {
            noFaceCountRef.current += 1;
          } else {
            multiFaceCountRef.current += 1;
          }
        } catch {
          modelFailCountRef.current += 1; // real detector failure, not just "no face this frame"
        }
      }, SAMPLE_INTERVAL_MS);

      let remaining = 5;
      countdownTickRef.current = window.setInterval(() => {
        remaining--;
        setCountdown(remaining);
        // Cheap early signal so multi-face/no-face doesn't waste the whole
        // window before the person finds out — only speaks up once there's
        // enough ticks to be a real pattern, not one bad frame.
        const ticks = tickCountRef.current;
        if (ticks >= 3) {
          if (multiFaceCountRef.current / ticks > 0.5) setLiveHint("Multiple faces in view — try to be the only one visible");
          else if (noFaceCountRef.current / ticks > 0.6) setLiveHint("Can't find your face — move fully into frame");
          else if (darkFrameCountRef.current / ticks > 0.5) setLiveHint("Too dark for a clear read — try somewhere brighter");
          else if (lowQualityCountRef.current / ticks > 0.5) setLiveHint("Hold the phone steady and face it directly");
          else setLiveHint(null);
        }
        if (remaining <= 0) {
          if (countdownTickRef.current) { clearInterval(countdownTickRef.current); countdownTickRef.current = null; }
          if (sampleTickRef.current) { clearInterval(sampleTickRef.current); sampleTickRef.current = null; }
          analyzeMoodRef.current();
        }
      }, 1000);
    } catch (err) {
      setDetecting(false);
      hapticWarning();
      const info = explainGumError(err);
      setCameraIssue(info);
    }
  }, []);

  const analyzeMood = useCallback(async () => {
    stopCamera();

    const samples = samplesRef.current;
    const faceRatio = samples.length / Math.max(1, Math.round(5000 / SAMPLE_INTERVAL_MS));

    // Not enough real signal — be honest about it instead of guessing, and
    // say *why* when we can tell: model never loaded, mostly too dark,
    // mostly multiple faces, or just nobody in frame long enough.
    if (samples.length < 3) {
      const ticks = Math.max(1, tickCountRef.current);
      let issue: typeof readIssue = "no_face";
      if (modelFailCountRef.current >= ticks * 0.6) issue = "model_failed";
      else if (multiFaceCountRef.current >= noFaceCountRef.current && multiFaceCountRef.current > 0) issue = "multi_face";
      else if (darkFrameCountRef.current >= noFaceCountRef.current * 0.6 && darkFrameCountRef.current > 0) issue = "too_dark";
      else if (lowQualityCountRef.current > 0 && lowQualityCountRef.current >= noFaceCountRef.current) issue = "low_quality";
      setReadIssue(issue);
      setDetectedMood("Neutral");
      setMoodSource("detected");
      setConfidencePct(null); // no numeric confidence to show — this isn't a real read
      setLowConfidence(true);
      if (user) {
        const { error: logErr } = await supabase.from("mood_logs").insert({
          user_id: user.id, mood: "Neutral", confidence: 0.25, valence: 0, arousal: 0.4,
          features: { sample_count: samples.length, face_presence_ratio: faceRatio, reason: issue ?? "insufficient_face_samples" },
        }).select("id").single().then(({ data, error }) => {
          if (data) setLastLogId((data as { id: string }).id);
          return { error };
        });
        if (logErr) console.error("mood_logs insert failed:", logErr.message);
        storage.set(MOOD_KEY, new Date().toDateString());
      }
      hapticWarning();
      return;
    }

    // Reject blink frames before averaging, then take a recency-weighted
    // average — expressions typically settle over the 5s window (the first
    // ~1s often still carries "surprised by the camera turning on"), so
    // later samples count more toward the final read. Shared with the
    // background detector — see lib/moodScoring.ts.
    const pool = filterBlinks(samples);
    const mouthCurve  = weightedAvg(pool, (s) => s.mouthCurve);
    const mouthOpen   = weightedAvg(pool, (s) => s.mouthOpen);
    const browRaise   = weightedAvg(pool, (s) => s.browRaise);
    const eyeOpenness = weightedAvg(pool, (s) => s.eyeOpenness);

    const distrust = distrustRef.current;
    const evidence = scoreMoods({ mouthCurve, mouthOpen, browRaise, eyeOpenness }, distrust);
    const probs = softmaxScores(evidence);
    // Temporal smoothing: keep a rolling window of the last 5 probability
    // distributions and average them before final classification. This
    // prevents single-frame expression glitches (a brief smile during a
    // mostly-neutral read, a momentary frown from looking down) from
    // changing the detected mood.
    const SMOOTH_WINDOW = 5;
    moodProbHistoryRef.current.push(probs);
    if (moodProbHistoryRef.current.length > SMOOTH_WINDOW) moodProbHistoryRef.current.shift();
    const hist = moodProbHistoryRef.current;
    const smoothed: Record<MoodLabel, number> = { Happy: 0, Loving: 0, Surprised: 0, Frustrated: 0, Sad: 0, Calm: 0, Neutral: 0 };
    for (const h of hist) {
      for (const k of Object.keys(h) as MoodLabel[]) smoothed[k] += h[k];
    }
    for (const k of Object.keys(smoothed) as MoodLabel[]) smoothed[k] /= hist.length;
    const [mood, topProb] = (Object.entries(smoothed) as [MoodLabel, number][])
      .reduce((best, cur) => (cur[1] > best[1] ? cur : best));

    // Confidence blends the softmax probability of the winning mood (how
    // clearly it beat the alternatives) with how much of the window
    // actually had a usable face in frame.
    const magnitudeConf = mood === "Neutral" ? Math.max(0.4, topProb) : Math.min(0.97, 0.4 + topProb * 0.6);
    const confidence = Math.max(0.3, Math.min(0.97, magnitudeConf * Math.min(1, faceRatio + 0.3)));

    setDetectedMood(mood);
    setMoodSource("detected");
    setConfidencePct(Math.round(confidence * 100));
    setLowConfidence(confidence < 0.5);
    setReadIssue(null);
    hapticLight();

    if (user) {
      const va = moodToValence[mood] || { valence: 0, arousal: 0.5 };
      const { data: logData, error: logErr } = await supabase.from("mood_logs").insert({
        user_id: user.id,
        mood,
        confidence,
        valence: va.valence,
        arousal: va.arousal,
        features: {
          mouth_curve: mouthCurve, mouth_open: mouthOpen, brow_raise: browRaise,
          eye_openness: eyeOpenness, sample_count: samples.length, face_presence_ratio: faceRatio,
          distrust_applied: distrust[mood] ?? 1,
          blink_filtered_samples: samples.length - pool.length,
          mood_probabilities: probs,
        },
      }).select("id").single();
      if (logErr) console.error("mood_logs insert failed:", logErr.message);
      if (logData) setLastLogId(logData.id);
      storage.set(MOOD_KEY, new Date().toDateString());

      // Also update profile mood
      const moodItem = moods.find(m => m.label === mood);
      await supabase.from("profiles").update({
        mood_emoji: moodItem?.emoji || "😐",
        mood_text: `Feeling ${mood.toLowerCase()}`,
        mood_updated_at: new Date().toISOString(),
      }).eq("user_id", user.id);
    }
  }, [user, toast]);

  // Fix #Bug5: keep ref in sync so startDetection always calls the latest analyzeMood
  useEffect(() => { analyzeMoodRef.current = analyzeMood; }, [analyzeMood]);

  const selectManualMood = async (mood: string) => {
    hapticLight();
    setDetectedMood(mood);
    setMoodSource("confirmed");
    setConfidencePct(100);
    setLowConfidence(false);
    setReadIssue(null);
    if (user) {
      const moodItem = moods.find(m => m.label === mood);
      const va = moodToValence[mood] || { valence: 0, arousal: 0.5 };
      const { data: logData, error: logErr } = await supabase.from("mood_logs").insert({
        user_id: user.id,
        mood,
        confidence: 1.0,
        valence: va.valence,
        arousal: va.arousal,
      }).select("id").single();
      if (logErr) console.error("mood_logs insert failed:", logErr.message);
      if (logData) setLastLogId(logData.id);
      await supabase.from("profiles").update({
        mood_emoji: moodItem?.emoji || "😐",
        mood_text: `Feeling ${mood.toLowerCase()}`,
        mood_updated_at: new Date().toISOString(),
      }).eq("user_id", user.id);
      storage.set(MOOD_KEY, new Date().toDateString());
    }
    setTimeout(() => { setShow(false); setDetectedMood(null); }, 1500);
  };

  const giveFeedback = async (accurate: boolean) => {
    if (!lastLogId || !detectedMood) return;
    hapticLight();
    // Store feedback locally for on-device calibration — never sent to server.
    recordMoodFeedback(detectedMood, accurate);
    // A "yes, that's right" confirms the read — reflect that in the label.
    if (accurate) { setMoodSource("confirmed"); setConfidencePct(100); }
    setFeedbackGiven(true);
    toast({ title: accurate ? "Thanks! 👍" : "Got it, we'll improve" });
    setTimeout(() => { setShow(false); setDetectedMood(null); setFeedbackGiven(false); setLastLogId(null); }, 1000);
  };

  const stopCamera = () => {
    if (countdownTickRef.current) { clearInterval(countdownTickRef.current); countdownTickRef.current = null; }
    if (sampleTickRef.current) { clearInterval(sampleTickRef.current); sampleTickRef.current = null; }
    if (leaseRef.current) {
      leaseRef.current.release();
      leaseRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  const handleClose = () => {
    stopCamera();
    setShow(false);
    setDetecting(false);
    setDetectedMood(null);
    setCameraIssue(null);
    setReadIssue(null);
    storage.set(MOOD_KEY, new Date().toDateString());
  };

  // Cleanup camera + timers on unmount
  useEffect(() => {
    return () => {
      if (countdownTickRef.current) clearInterval(countdownTickRef.current);
      if (sampleTickRef.current) clearInterval(sampleTickRef.current);
      if (leaseRef.current) {
        leaseRef.current.release();
        leaseRef.current = null;
      }
    };
  }, []);

  if (!show) return null;

  const READ_ISSUE_COPY: Record<NonNullable<typeof readIssue>, { title: string; hint: string }> = {
    model_failed: { title: "Detection couldn't load", hint: "Check your connection and try again, or pick a mood manually." },
    too_dark: { title: "Too dark to get a clear read", hint: "Try again somewhere brighter, or pick manually." },
    multi_face: { title: "Multiple faces in view", hint: "Try again with just you in frame, or pick manually." },
    no_face: { title: "Couldn't find a face", hint: "Make sure you're centered in frame, or pick manually." },
    low_quality: { title: "Frame too blurry or off-angle", hint: "Hold the phone steady, facing you directly, or pick manually." },
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 50 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 50 }}
        // BUG FIX (dock collision — same pattern as Gallery.tsx's bulk-action
        // bar and MapView.tsx's status row): `bottom-20` + `safe-bottom` only
        // padded this card's own content, it never actually offset the card's
        // *position* away from the floating dock, which is visible on /calls
        // (not in DOCK_HIDDEN_PAGES) and, at z-50, sits directly in this
        // card's old [80px, ~130px+] range with a lower z-index — meaning
        // this card (z-90) was rendering on top of / through the dock rather
        // than clearing it. Same --dock-reserve token every other fixed
        // dock-adjacent surface in the app now uses.
        style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + var(--dock-reserve) + 6px)" }}
        className="fixed inset-x-4 z-[90] bg-card rounded-3xl border border-border/60 shadow-xl overflow-hidden"
      >
        <div className="p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold">Daily Mood Check</p>
            <button onClick={handleClose} aria-label="Close" className="h-6 w-6 rounded-full bg-muted flex items-center justify-center">
              <X className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
            </button>
          </div>

          {cameraIssue ? (
            <div className="text-center py-3 space-y-3">
              <div className="mx-auto h-11 w-11 rounded-full bg-destructive/10 flex items-center justify-center">
                <CameraOff className="h-5 w-5 text-destructive" aria-hidden="true" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {cameraIssue.code === "denied" ? "Camera access needed" : "Camera unavailable"}
                </p>
                <p className="text-[11px] text-muted-foreground leading-relaxed px-2">{cameraIssue.message}</p>
              </div>
              <div className="flex items-center justify-center gap-2 pt-1">
                <button
                  onClick={() => { setCameraIssue(null); startDetection(); }}
                  className="flex items-center gap-1.5 rounded-xl bg-primary text-primary-foreground px-3.5 py-2 text-xs font-medium active:scale-95"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Try again
                </button>
                {Capacitor.isNativePlatform() && cameraIssue.code === "denied" && (
                  <button
                    onClick={() => openAppSettings()}
                    className="flex items-center gap-1.5 rounded-xl bg-muted px-3.5 py-2 text-xs font-medium active:scale-95"
                  >
                    <Settings2 className="h-3.5 w-3.5" /> Settings
                  </button>
                )}
              </div>
              <p className="text-[10px] text-muted-foreground/70 pt-1">or pick a mood manually below</p>
              <div className="flex justify-center gap-3 pt-1">
                {moods.map(m => (
                  <button key={m.label} onClick={() => selectManualMood(m.label)}
                    className="flex flex-col items-center gap-1 active:scale-90 transition-transform">
                    <span className="text-2xl">{m.emoji}</span>
                    <span className="text-[9px] text-muted-foreground">{m.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : detectedMood ? (
            <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="text-center py-3">
              <p className="text-4xl mb-2">{moods.find(m => m.label === detectedMood)?.emoji}</p>

              {readIssue ? (
                <>
                  <p className="text-sm font-medium">{READ_ISSUE_COPY[readIssue].title}</p>
                  <p className="text-[11px] text-muted-foreground mt-1">{READ_ISSUE_COPY[readIssue].hint}</p>
                </>
              ) : (
                <>
                  {/* Detected vs. confirmed is never left ambiguous: a camera
                      read always says "Detected" with its confidence until
                      the person confirms it; a manual pick or a 👍 is
                      "Confirmed" immediately. Never phrased as certainty. */}
                  <div className="flex items-center justify-center gap-1.5 mb-1">
                    {moodSource === "confirmed" ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary text-[9px] font-medium px-2 py-0.5 uppercase tracking-wide">
                        <CheckCircle2 className="h-2.5 w-2.5" aria-hidden="true" /> Confirmed
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-muted text-muted-foreground text-[9px] font-medium px-2 py-0.5 uppercase tracking-wide">
                        Detected{confidencePct != null ? ` · ~${confidencePct}%` : ""}
                      </span>
                    )}
                  </div>
                  <p className="text-sm font-medium">
                    {lowConfidence ? `Looks like you might be feeling a little ${detectedMood.toLowerCase()}` : `Looks like you're feeling ${detectedMood.toLowerCase()}`}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {moodSource === "confirmed"
                      ? "Saved to your mood log"
                      : "Estimated from your expression, not a diagnosis — let us know if it's off"}
                  </p>
                </>
              )}

              {!feedbackGiven && !readIssue && moodSource !== "confirmed" && (
                <div className="flex items-center justify-center gap-3 mt-3">
                  <p className="text-[10px] text-muted-foreground">Was this accurate?</p>
                  <button onClick={() => giveFeedback(true)} aria-label="Mood detection was accurate" className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center">
                    <ThumbsUp className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                  </button>
                  <button onClick={() => giveFeedback(false)} aria-label="Mood detection was inaccurate" className="h-7 w-7 rounded-full bg-destructive/10 flex items-center justify-center">
                    <ThumbsDown className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
                  </button>
                </div>
              )}
              {readIssue && (
                <div className="flex justify-center gap-3 mt-3">
                  {moods.map(m => (
                    <button key={m.label} onClick={() => selectManualMood(m.label)}
                      className="flex flex-col items-center gap-1 active:scale-90 transition-transform">
                      <span className="text-xl">{m.emoji}</span>
                      <span className="text-[9px] text-muted-foreground">{m.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </motion.div>
          ) : detecting ? (
            <div className="relative">
              <video ref={videoRef} muted playsInline
                className="w-full max-h-[46vh] rounded-2xl aspect-[3/4] object-cover scale-x-[-1]" />

              {/* Face-scan frame — four corner brackets, a subtle breathing
                  pulse, and a sweeping scan line. All framer-motion, so
                  MotionConfig's reducedMotion="user" (set app-wide in
                  App.tsx) automatically disables this for anyone with
                  prefers-reduced-motion set — no extra handling needed here. */}
              <motion.div
                className="absolute inset-6 rounded-xl pointer-events-none"
                animate={{ scale: [1, 1.015, 1] }}
                transition={{ repeat: Infinity, duration: 2.4, ease: "easeInOut" }}
              >
                {([
                  ["top-0 left-0 border-t-2 border-l-2 rounded-tl-lg"],
                  ["top-0 right-0 border-t-2 border-r-2 rounded-tr-lg"],
                  ["bottom-0 left-0 border-b-2 border-l-2 rounded-bl-lg"],
                  ["bottom-0 right-0 border-b-2 border-r-2 rounded-br-lg"],
                ] as const).map(([cls], i) => (
                  <div key={i} className={`absolute h-6 w-6 border-white/70 ${cls}`} />
                ))}
                <motion.div
                  className="absolute left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/80 to-transparent"
                  style={{ boxShadow: "0 0 8px 1px rgba(255,255,255,0.6)" }}
                  animate={{ top: ["4%", "96%", "4%"] }}
                  transition={{ repeat: Infinity, duration: 2.6, ease: "easeInOut" }}
                />
              </motion.div>

              <div className="absolute inset-0 flex items-center justify-center">
                <motion.div
                  animate={{ scale: [1, 1.08, 1] }}
                  transition={{ repeat: Infinity, duration: 1 }}
                  className="h-16 w-16 rounded-full bg-foreground/20 backdrop-blur-md border border-white/20 flex items-center justify-center"
                >
                  <span className="text-2xl font-bold text-foreground">{countdown}</span>
                </motion.div>
              </div>
              <p className="text-center text-[11px] text-muted-foreground mt-2">
                {liveHint ?? "Analyzing your expression..."}
              </p>
            </div>
          ) : (
            <>
              <p className="text-xs text-muted-foreground mb-1">How are you feeling? Use camera or pick manually.</p>
              <p className="text-[10px] text-muted-foreground/70 mb-3">
                Your camera is only used to read your expression for a few seconds, right on your device — the photo itself is never saved or sent anywhere, only the mood.
              </p>
              <button onClick={startDetection}
                className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground rounded-xl py-2.5 text-sm font-medium mb-3 active:scale-[0.98] transition-transform">
                <Camera className="h-4 w-4" /> Detect with Camera
              </button>
              <div className="flex justify-center gap-3">
                {moods.map(m => (
                  <button key={m.label} onClick={() => selectManualMood(m.label)}
                    className="flex flex-col items-center gap-1 active:scale-90 transition-transform">
                    <span className="text-2xl">{m.emoji}</span>
                    <span className="text-[9px] text-muted-foreground">{m.label}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
};

export default MoodDetector;
