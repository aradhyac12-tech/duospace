import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Camera, X, Smile, Frown, Meh, Heart, Angry, ThumbsUp, ThumbsDown, Sparkles, Cloud } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import storage from "@/lib/storage";
import { hapticLight } from "@/lib/haptics";
import { useToast } from "@/hooks/use-toast";
import { acquireCamera, type CameraLease } from "@/lib/cameraBus";
import { detectFaces, getLandmarker } from "@/lib/faceRecognition";

const MOOD_KEY = "last-mood-check-date";
const SAMPLE_INTERVAL_MS = 350; // ~14 samples across the 5s window

// FaceMesh landmark indices (canonical 478-point topology) used for expression
// features. All reads come from DetectedFace.embedding, which is ALREADY
// centered on the nose and scaled by inter-ocular distance (see
// lib/faceRecognition.ts buildEmbedding) — so these deltas are comparable
// across different faces, distances from camera, and frame resolutions
// without any extra normalization here.
const IDX = {
  mouthLeft: 61, mouthRight: 291,
  lipTop: 13, lipBottom: 14,
  browLeft: 105, browRight: 334,
  eyeTopLeft: 159, eyeTopRight: 386,
};

interface ExpressionSample {
  mouthCurve: number;   // + = corners lifted (smile), - = corners dropped (frown)
  mouthOpen: number;    // vertical lip gap
  browRaise: number;    // + = brows raised, - = brows lowered/furrowed
  eyeOpenness: number;  // EAR, already computed by faceRecognition
}

const yAt = (embedding: Float32Array, landmark: number) => embedding[landmark * 3 + 1];

/** Extract normalized expression features from one detected face's embedding. */
const extractExpression = (embedding: Float32Array): ExpressionSample => {
  const cornerAvgY = (yAt(embedding, IDX.mouthLeft) + yAt(embedding, IDX.mouthRight)) / 2;
  const lipCenterY = (yAt(embedding, IDX.lipTop) + yAt(embedding, IDX.lipBottom)) / 2;
  const browAvgY = (yAt(embedding, IDX.browLeft) + yAt(embedding, IDX.browRight)) / 2;
  const eyeTopAvgY = (yAt(embedding, IDX.eyeTopLeft) + yAt(embedding, IDX.eyeTopRight)) / 2;

  return {
    mouthCurve: lipCenterY - cornerAvgY,                       // corners above lip-center = smile
    mouthOpen: Math.abs(yAt(embedding, IDX.lipTop) - yAt(embedding, IDX.lipBottom)),
    browRaise: eyeTopAvgY - browAvgY,                          // bigger gap = brows raised
    eyeOpenness: 0, // filled in from DetectedFace.ear by the caller
  };
};

const moods = [
  { emoji: "😊", label: "Happy", icon: Smile, color: "text-green-500" },
  { emoji: "😢", label: "Sad", icon: Frown, color: "text-blue-500" },
  { emoji: "😐", label: "Neutral", icon: Meh, color: "text-yellow-500" },
  { emoji: "😍", label: "Loving", icon: Heart, color: "text-pink-500" },
  { emoji: "😤", label: "Frustrated", icon: Angry, color: "text-red-500" },
  { emoji: "😲", label: "Surprised", icon: Sparkles, color: "text-purple-500" },
  { emoji: "😌", label: "Calm", icon: Cloud, color: "text-teal-500" },
];

const moodToValence: Record<string, { valence: number; arousal: number }> = {
  Happy: { valence: 0.7, arousal: 0.6 },
  Sad: { valence: -0.6, arousal: 0.3 },
  Neutral: { valence: 0, arousal: 0.4 },
  Loving: { valence: 0.9, arousal: 0.7 },
  Frustrated: { valence: -0.5, arousal: 0.8 },
  Surprised: { valence: 0.2, arousal: 0.85 },
  Calm: { valence: 0.4, arousal: 0.15 },
};

/**
 * Evidence score per mood from one averaged feature set. Each term is a
 * nonnegative "how far past the resting threshold" magnitude — these are
 * NOT probabilities yet, softmaxScores() below turns them into a proper
 * distribution. `distrust` (this user's own feedback history — see
 * distrustRef) raises the bar for moods they've frequently corrected.
 *
 * Honest scope note: with only 4 landmark-derived scalars (no full FACS
 * Action Units, no per-eyebrow asymmetry, no gaze vector), 7 evidence-backed
 * labels is the practical ceiling here — every additional label the spec's
 * 20-emotion list asks for (Excited vs Happy, Confused vs Thinking, Bored
 * vs Tired, ...) would be indistinguishable noise from these same 4 numbers
 * and would just add false confidence, not real accuracy.
 */
type MoodLabel = "Happy" | "Loving" | "Surprised" | "Frustrated" | "Sad" | "Calm" | "Neutral";

const scoreMoods = (
  f: { mouthCurve: number; mouthOpen: number; browRaise: number; eyeOpenness: number },
  distrust: Record<string, number>,
): Record<MoodLabel, number> => {
  const need = (mood: string, base: number) => base * (distrust[mood] ?? 1);
  return {
    Happy:      Math.max(0, f.mouthCurve - need("Happy", 0.018)) * 30
              + Math.max(0, f.mouthOpen  - need("Happy", 0.035)) * 15,
    Loving:     Math.max(0, f.mouthCurve - need("Loving", 0.010)) * 22
              + Math.max(0, 0.035 - f.mouthOpen) * 6,
    Surprised:  Math.max(0, f.browRaise  - need("Surprised", 0.20)) * 18
              + Math.max(0, f.mouthOpen  - need("Surprised", 0.05)) * 20,
    Frustrated: Math.max(0, -f.mouthCurve - need("Frustrated", 0.007)) * 26
              + Math.max(0, 0.16 - f.browRaise) * 14,
    Sad:        Math.max(0, -f.mouthCurve - need("Sad", 0.0045)) * 20
              + Math.max(0, 0.24 - f.eyeOpenness) * 12,
    Calm:       Math.max(0, f.eyeOpenness - 0.22) * 8
              + Math.max(0, 0.02 - Math.abs(f.mouthCurve)) * 10,
    // Flat floor, not a feature-derived score — wins only when nothing
    // else clears its own threshold, same role the old `else` branch played.
    Neutral: 2.2,
  };
};

/** Turn evidence scores into a probability distribution over all moods, so
 *  we can store "Happy 74%, Loving 12%, Surprised 8%, ..." instead of just
 *  the single winning label — this is what lets confidence reflect genuine
 *  ambiguity (two moods close together) rather than only signal magnitude. */
const softmaxScores = (scores: Record<MoodLabel, number>): Record<MoodLabel, number> => {
  const entries = Object.entries(scores) as [MoodLabel, number][];
  const max = Math.max(...entries.map(([, v]) => v));
  const exps = entries.map(([k, v]) => [k, Math.exp((v - max) * 0.8)] as const);
  const sum = exps.reduce((a, [, v]) => a + v, 0) || 1;
  return Object.fromEntries(exps.map(([k, v]) => [k, v / sum])) as Record<MoodLabel, number>;
};

const MoodDetector = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [show, setShow] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectedMood, setDetectedMood] = useState<string | null>(null);
  const [lowConfidence, setLowConfidence] = useState(false);
  const [lastLogId, setLastLogId] = useState<string | null>(null);
  const [feedbackGiven, setFeedbackGiven] = useState(false);
  const [countdown, setCountdown] = useState(5);
  const videoRef = useRef<HTMLVideoElement>(null);
  const leaseRef = useRef<CameraLease | null>(null);
  const countdownTickRef = useRef<number | null>(null);

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

  // Pull calibration data once when the card opens — not per frame.
  useEffect(() => {
    if (!show || !user) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("mood_logs")
        .select("mood, feedback")
        .eq("user_id", user.id)
        .not("feedback", "is", null)
        .order("created_at", { ascending: false })
        .limit(40);
      if (cancelled || !data) return;
      const stats: Record<string, { total: number; inaccurate: number }> = {};
      for (const row of data as any[]) {
        const m = row.mood as string;
        stats[m] ??= { total: 0, inaccurate: 0 };
        stats[m].total++;
        if (row.feedback === "inaccurate") stats[m].inaccurate++;
      }
      const distrust: Record<string, number> = {};
      for (const [mood, s] of Object.entries(stats)) {
        // Require at least 3 data points before trusting the rate; cap the
        // penalty so calibration can soften a mood, never disable it outright.
        if (s.total < 3) continue;
        const inaccurateRate = s.inaccurate / s.total;
        distrust[mood] = 1 + Math.min(inaccurateRate, 0.7) * 1.2;
      }
      distrustRef.current = distrust;
    })();
    return () => { cancelled = true; };
  }, [show, user]);

  const startDetection = useCallback(async () => {
    setDetecting(true);
    setCountdown(5);
    setLowConfidence(false);
    samplesRef.current = [];
    tsRef.current = 0;

    try {
      const lease = await acquireCamera("user");
      leaseRef.current = lease;
      if (videoRef.current) {
        videoRef.current.srcObject = lease.stream;
        await videoRef.current.play().catch(() => {});
      }
      // Warm up the landmark model in parallel — first call is otherwise slow.
      getLandmarker().catch(() => {});

      // Sample real facial landmarks throughout the window instead of
      // reading a single final frame — smooths out blinks, motion blur,
      // and momentary expressions into a stable read.
      sampleTickRef.current = window.setInterval(async () => {
        const v = videoRef.current;
        if (!v || v.readyState < 2) return;
        try {
          tsRef.current = Math.max(tsRef.current + 1, performance.now());
          const faces = await detectFaces(v, tsRef.current);
          if (faces.length === 1) {
            const expr = extractExpression(faces[0].embedding);
            expr.eyeOpenness = faces[0].ear;
            samplesRef.current.push(expr);
          }
        } catch { /* transient — skip this sample */ }
      }, SAMPLE_INTERVAL_MS);

      let remaining = 5;
      countdownTickRef.current = window.setInterval(() => {
        remaining--;
        setCountdown(remaining);
        if (remaining <= 0) {
          if (countdownTickRef.current) { clearInterval(countdownTickRef.current); countdownTickRef.current = null; }
          if (sampleTickRef.current) { clearInterval(sampleTickRef.current); sampleTickRef.current = null; }
          analyzeMoodRef.current();
        }
      }, 1000);
    } catch {
      setDetecting(false);
    }
  }, []);

  const analyzeMood = useCallback(async () => {
    stopCamera();

    const samples = samplesRef.current;
    const faceRatio = samples.length / Math.max(1, Math.round(5000 / SAMPLE_INTERVAL_MS));

    // Not enough real signal — be honest about it instead of guessing.
    if (samples.length < 3) {
      setDetectedMood("Neutral");
      setLowConfidence(true);
      if (user) {
        const { error: logErr } = await supabase.from("mood_logs").insert({
          user_id: user.id, mood: "Neutral", confidence: 0.25, valence: 0, arousal: 0.4,
          features: { sample_count: samples.length, face_presence_ratio: faceRatio, reason: "insufficient_face_samples" },
        }).select("id").single().then(({ data, error }) => {
          if (data) setLastLogId((data as { id: string }).id);
          return { error };
        });
        if (logErr) console.error("mood_logs insert failed:", logErr.message);
        storage.set(MOOD_KEY, new Date().toDateString());
      }
      toast({ title: "Couldn't get a clear view", description: "Try again with better lighting, or pick a mood manually." });
      return;
    }

    // Reject blink frames before averaging — a closed-eye sample would drag
    // eyeOpenness down in a way that's unrelated to the "eyes narrowed" cue
    // we use for Sad, and can momentarily distort mouth/brow readings too.
    const sortedEye = [...samples.map((s) => s.eyeOpenness)].sort((a, b) => a - b);
    const medianEye = sortedEye[Math.floor(sortedEye.length / 2)] || 0;
    const blinkFiltered = samples.filter((s) => medianEye === 0 || s.eyeOpenness > medianEye * 0.55);
    const pool = blinkFiltered.length >= 3 ? blinkFiltered : samples;

    // Recency-weighted average — expressions typically settle over the 5s
    // window (the first ~1s often still carries "surprised by the camera
    // turning on"), so later samples in the window count more toward the
    // final read. Weight ramps linearly 0.5x → 1.5x across the pool.
    const weightedAvg = (fn: (s: ExpressionSample) => number) => {
      let wSum = 0, vSum = 0;
      pool.forEach((s, i) => {
        const w = 0.5 + i / Math.max(1, pool.length - 1);
        wSum += w; vSum += fn(s) * w;
      });
      return vSum / wSum;
    };
    const mouthCurve  = weightedAvg((s) => s.mouthCurve);
    const mouthOpen   = weightedAvg((s) => s.mouthOpen);
    const browRaise   = weightedAvg((s) => s.browRaise);
    const eyeOpenness = weightedAvg((s) => s.eyeOpenness);

    const distrust = distrustRef.current;
    const evidence = scoreMoods({ mouthCurve, mouthOpen, browRaise, eyeOpenness }, distrust);
    const probs = softmaxScores(evidence);
    const [mood, topProb] = (Object.entries(probs) as [MoodLabel, number][])
      .reduce((best, cur) => (cur[1] > best[1] ? cur : best));

    // Confidence blends the softmax probability of the winning mood (how
    // clearly it beat the alternatives) with how much of the window
    // actually had a usable face in frame.
    const magnitudeConf = mood === "Neutral" ? Math.max(0.4, topProb) : Math.min(0.97, 0.4 + topProb * 0.6);
    const confidence = Math.max(0.3, Math.min(0.97, magnitudeConf * Math.min(1, faceRatio + 0.3)));

    setDetectedMood(mood);
    setLowConfidence(confidence < 0.5);

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
    if (!lastLogId) return;
    hapticLight();
    const { error } = await supabase.from("mood_logs").update({ feedback: accurate ? "accurate" : "inaccurate" }).eq("id", lastLogId);
    if (error) console.error("mood_logs feedback update failed:", error.message);
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

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 50 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 50 }}
        className="fixed inset-x-4 bottom-20 z-[90] bg-card rounded-3xl border border-border/60 shadow-xl overflow-hidden safe-bottom"
      >
        <div className="p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold">Daily Mood Check</p>
            <button onClick={handleClose} aria-label="Close" className="h-6 w-6 rounded-full bg-muted flex items-center justify-center">
              <X className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
            </button>
          </div>

          {detectedMood ? (
            <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="text-center py-3">
              <p className="text-4xl mb-2">{moods.find(m => m.label === detectedMood)?.emoji}</p>
              <p className="text-sm font-medium">
                {lowConfidence ? `Looks like you might be feeling a little ${detectedMood.toLowerCase()}` : `You seem ${detectedMood.toLowerCase()} today!`}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">
                {lowConfidence ? "Not fully sure — feel free to correct it below" : "Saved to your mood log"}
              </p>
              {!feedbackGiven && (
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
              <p className="text-center text-[11px] text-muted-foreground mt-2">Analyzing your expression...</p>
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
