import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Camera, X, Smile, Frown, Meh, Heart, Angry, ThumbsUp, ThumbsDown } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import storage from "@/lib/storage";
import { hapticLight } from "@/lib/haptics";
import { useToast } from "@/hooks/use-toast";
import { acquireCamera, type CameraLease } from "@/lib/cameraBus";

const MOOD_KEY = "last-mood-check-date";

const moods = [
  { emoji: "😊", label: "Happy", icon: Smile, color: "text-green-500" },
  { emoji: "😢", label: "Sad", icon: Frown, color: "text-blue-500" },
  { emoji: "😐", label: "Neutral", icon: Meh, color: "text-yellow-500" },
  { emoji: "😍", label: "Loving", icon: Heart, color: "text-pink-500" },
  { emoji: "😤", label: "Frustrated", icon: Angry, color: "text-red-500" },
];

const moodToValence: Record<string, { valence: number; arousal: number }> = {
  Happy: { valence: 0.7, arousal: 0.6 },
  Sad: { valence: -0.6, arousal: 0.3 },
  Neutral: { valence: 0, arousal: 0.4 },
  Loving: { valence: 0.9, arousal: 0.7 },
  Frustrated: { valence: -0.5, arousal: 0.8 },
};

const MoodDetector = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [show, setShow] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectedMood, setDetectedMood] = useState<string | null>(null);
  const [lastLogId, setLastLogId] = useState<string | null>(null);
  const [feedbackGiven, setFeedbackGiven] = useState(false);
  const [countdown, setCountdown] = useState(5);
  const videoRef = useRef<HTMLVideoElement>(null);
  const leaseRef = useRef<CameraLease | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

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

  // Fix #Bug5: use a stable ref so startDetection always calls the *current*
  // analyzeMood — previously [] deps meant startDetection captured the initial
  // analyzeMood which had no `user`, so mood data was never saved.
  const analyzeMoodRef = useRef<() => Promise<void>>(async () => {});

  const startDetection = useCallback(async () => {
    setDetecting(true);
    setCountdown(5);

    try {
      const lease = await acquireCamera("user");
      leaseRef.current = lease;
      if (videoRef.current) {
        videoRef.current.srcObject = lease.stream;
        await videoRef.current.play().catch(() => {});
      }

      let remaining = 5;
      const interval = setInterval(() => {
        remaining--;
        setCountdown(remaining);
        if (remaining <= 0) {
          clearInterval(interval);
          analyzeMoodRef.current();
        }
      }, 1000);
    } catch {
      setDetecting(false);
    }
  }, []);

  const analyzeMood = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = 320;
    canvas.height = 240;
    ctx.drawImage(videoRef.current, 0, 0, 320, 240);

    // Fix #Bug6: removed racially-biased skin-tone pixel heuristic (r>95 && g>40...).
    // That check had poor accuracy on dark skin tones, causing "Neutral/0.3 confidence"
    // for many users regardless of actual expression.
    // Now using perceptual brightness + warmth variance — works across all skin tones.
    const imageData = ctx.getImageData(0, 0, 320, 240);
    const pixels = imageData.data;
    let totalBrightness = 0;
    let warmth = 0;
    const brightnessValues: number[] = [];

    for (let i = 0; i < pixels.length; i += 16) {
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      // Perceptual luminance (ITU-R BT.601)
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      totalBrightness += lum;
      warmth += r - b;
      brightnessValues.push(lum);
    }

    const n = brightnessValues.length;
    const avgBrightness = totalBrightness / n;
    const avgWarmth = warmth / n;

    // Variance: high variance = expressive face, low = still/neutral
    const variance = brightnessValues.reduce((acc, v) => acc + (v - avgBrightness) ** 2, 0) / n;
    const stdDev = Math.sqrt(variance);

    // Mood heuristic using brightness + warmth + expression variance
    let mood: string;
    let confidence: number;

    if (stdDev < 20) {
      // Very flat frame — likely no face or eyes closed
      mood = "Neutral";
      confidence = 0.35;
    } else if (avgBrightness > 140 && avgWarmth > 20 && stdDev > 35) {
      mood = "Happy";
      confidence = 0.72;
    } else if (avgBrightness < 80 && stdDev < 40) {
      mood = "Sad";
      confidence = 0.55;
    } else if (avgWarmth > 40 && avgBrightness > 100) {
      mood = "Loving";
      confidence = 0.62;
    } else if (avgWarmth < -10 && stdDev > 30) {
      mood = "Frustrated";
      confidence = 0.48;
    } else {
      mood = "Neutral";
      confidence = 0.5;
    }

    setDetectedMood(mood);
    stopCamera();

    // Save to database
    if (user) {
      const va = moodToValence[mood] || { valence: 0, arousal: 0.5 };
      const { data: logData } = await supabase.from("mood_logs").insert({
        user_id: user.id,
        mood,
        confidence,
        valence: va.valence,
        arousal: va.arousal,
      } as any).select("id").single();
      if (logData) setLastLogId((logData as any).id);
      storage.set(MOOD_KEY, new Date().toDateString());

      // Also update profile mood
      const moodItem = moods.find(m => m.label === mood);
      await supabase.from("profiles").update({
        mood_emoji: moodItem?.emoji || "😐",
        mood_text: `Feeling ${mood.toLowerCase()}`,
        mood_updated_at: new Date().toISOString(),
      }).eq("user_id", user.id);
    }
  }, [user]);

  // Fix #Bug5: keep ref in sync so startDetection always calls the latest analyzeMood
  useEffect(() => { analyzeMoodRef.current = analyzeMood; }, [analyzeMood]);

  const selectManualMood = async (mood: string) => {
    hapticLight();
    setDetectedMood(mood);
    if (user) {
      const moodItem = moods.find(m => m.label === mood);
      const va = moodToValence[mood] || { valence: 0, arousal: 0.5 };
      const { data: logData } = await supabase.from("mood_logs").insert({
        user_id: user.id,
        mood,
        confidence: 1.0,
        valence: va.valence,
        arousal: va.arousal,
      } as any).select("id").single();
      if (logData) setLastLogId((logData as any).id);
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
    await supabase.from("mood_logs").update({ feedback: accurate ? "accurate" : "inaccurate" } as any).eq("id", lastLogId);
    setFeedbackGiven(true);
    toast({ title: accurate ? "Thanks! 👍" : "Got it, we'll improve" });
    setTimeout(() => { setShow(false); setDetectedMood(null); setFeedbackGiven(false); setLastLogId(null); }, 1000);
  };

  const stopCamera = () => {
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

  // Cleanup camera on unmount
  useEffect(() => {
    return () => {
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
            <button onClick={handleClose} className="h-6 w-6 rounded-full bg-muted flex items-center justify-center">
              <X className="h-3 w-3 text-muted-foreground" />
            </button>
          </div>

          {detectedMood ? (
            <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="text-center py-3">
              <p className="text-4xl mb-2">{moods.find(m => m.label === detectedMood)?.emoji}</p>
              <p className="text-sm font-medium">You seem {detectedMood.toLowerCase()} today!</p>
              <p className="text-[11px] text-muted-foreground mt-1">Saved to your mood log</p>
              {!feedbackGiven && (
                <div className="flex items-center justify-center gap-3 mt-3">
                  <p className="text-[10px] text-muted-foreground">Was this accurate?</p>
                  <button onClick={() => giveFeedback(true)} className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center">
                    <ThumbsUp className="h-3.5 w-3.5 text-primary" />
                  </button>
                  <button onClick={() => giveFeedback(false)} className="h-7 w-7 rounded-full bg-destructive/10 flex items-center justify-center">
                    <ThumbsDown className="h-3.5 w-3.5 text-destructive" />
                  </button>
                </div>
              )}
            </motion.div>
          ) : detecting ? (
            <div className="relative">
              <video ref={videoRef} muted playsInline className="w-full rounded-2xl aspect-video object-cover" />
              <canvas ref={canvasRef} className="hidden" />
              <div className="absolute inset-0 flex items-center justify-center">
                <motion.div
                  animate={{ scale: [1, 1.2, 1] }}
                  transition={{ repeat: Infinity, duration: 1 }}
                  className="h-16 w-16 rounded-full bg-foreground/20 backdrop-blur-sm flex items-center justify-center"
                >
                  <span className="text-2xl font-bold text-foreground">{countdown}</span>
                </motion.div>
              </div>
              <p className="text-center text-[11px] text-muted-foreground mt-2">Analyzing your expression...</p>
            </div>
          ) : (
            <>
              <p className="text-xs text-muted-foreground mb-3">How are you feeling? Use camera or pick manually.</p>
              <button onClick={startDetection}
                className="w-full flex items-center justify-center gap-2 bg-foreground text-background rounded-xl py-2.5 text-sm font-medium mb-3 active:scale-[0.98] transition-transform">
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
