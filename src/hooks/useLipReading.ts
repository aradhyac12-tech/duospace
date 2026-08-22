/**
 * useLipReading — Visual Speech Recognition
 * LR-02: Multi-CDN fallback for MediaPipe loading
 * LR-03: Proper MediaStream liveness check (videoWidth instead of paused)
 * LR-05: FaceMesh.close() on stop/unmount to free WASM module
 * LR-06: Full transcript reset on language change and restart
 */
import { useCallback, useEffect, useRef, useState } from "react";

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
  "VELAR":          { en: "k",  hi: "क",  mr: "क"  },
};

// LR-02 FIX: Multiple CDN mirrors. loadMediaPipe() tries each in order.
const MP_VER  = "0.4.1633559619";
const MP_CDNS = [
  `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@${MP_VER}`,
  `https://unpkg.com/@mediapipe/face_mesh@${MP_VER}`,
];

async function loadMediaPipe(): Promise<any> {
  if ((window as any).FaceMesh) return (window as any).FaceMesh;
  let lastErr: Error | null = null;
  for (const cdn of MP_CDNS) {
    try {
      await new Promise<void>((res, rej) => {
        if (document.querySelector(`script[data-mp="${cdn}"]`)) { res(); return; }
        const s = document.createElement("script");
        s.src = `${cdn}/face_mesh.js`;
        s.crossOrigin = "anonymous";
        s.dataset.mp  = cdn;
        s.onload  = () => res();
        s.onerror = () => rej(new Error(`CDN blocked: ${cdn}`));
        document.head.appendChild(s);
      });
      if ((window as any).FaceMesh) return (window as any).FaceMesh;
    } catch (e: any) { lastErr = e; }
  }
  throw new Error(lastErr?.message ?? "MediaPipe unavailable. Check connection or CSP settings.");
}

function extractGeo(landmarks: Array<{ x: number; y: number; z: number }>) {
  if (!landmarks || landmarks.length < 468) return null;
  const g = (i: number) => landmarks[i];
  const left = g(61), right = g(291), top = g(13), bottom = g(14);
  const width      = Math.abs(right.x - left.x) || 0.001;
  const height     = Math.abs(bottom.y - top.y);
  const openRatio  = Math.min(height / width, 1);
  const avgZ       = (left.z + right.z + top.z + bottom.z) / 4;
  const roundRatio = Math.max(0, -avgZ * 2);
  return { openRatio, roundRatio, width };
}

function classifyViseme(geo: ReturnType<typeof extractGeo>): string {
  if (!geo) return "SILENCE";
  const { openRatio, roundRatio } = geo;
  if (openRatio < 0.04) return "BILABIAL_CLOSE";
  if (openRatio < 0.09) return roundRatio > 0.18 ? "O_ROUND" : "DENTAL";
  if (openRatio < 0.20) return roundRatio > 0.12 ? "O_ROUND" : "E_MID";
  return "A_OPEN";
}

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

export const useLipReading = ({ language, onResult, videoRef }: UseLipReadingOptions) => {
  const [isActive,  setIsActive]  = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  const faceMeshRef   = useRef<any>(null);
  const intervalRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const sequenceRef   = useRef<string[]>([]);
  const silenceRef    = useRef<number>(0);
  const transcriptRef = useRef<string>("");
  const languageRef   = useRef<LipReadLanguage>(language);
  const onResultRef   = useRef(onResult);

  useEffect(() => { languageRef.current = language; }, [language]);
  useEffect(() => { onResultRef.current = onResult;  }, [onResult]);

  const FRAME_MS   = 80;
  const WINDOW     = 16;
  const SILENCE_MS = 700;

  interface FaceMeshResults {
  multiFaceLandmarks?: Array<Array<{ x: number; y: number; z: number }>>;
}
const onFaceMeshResults = useCallback((results: FaceMeshResults) => {
    const lang = languageRef.current;
    const now  = Date.now();
    if (!results.multiFaceLandmarks?.[0]) {
      if (now - silenceRef.current > SILENCE_MS && sequenceRef.current.length >= 3) {
        const word = sequenceToWord(sequenceRef.current, lang);
        if (word) {
          const next = (transcriptRef.current + " " + word).trim();
          transcriptRef.current = next;
          onResultRef.current({ transcript: next, confidence: 0.5, isFinal: false, language: lang });
        }
        sequenceRef.current = [];
      }
      silenceRef.current = now;
      return;
    }
    const geo    = extractGeo(results.multiFaceLandmarks[0]);
    const viseme = classifyViseme(geo);
    if (viseme === "SILENCE") return;
    sequenceRef.current.push(viseme);
    if (sequenceRef.current.length > WINDOW) sequenceRef.current = sequenceRef.current.slice(-WINDOW);
    if (sequenceRef.current.length % 6 === 0) {
      const word = sequenceToWord(sequenceRef.current.slice(-6), lang);
      if (word) {
        const conf = geo ? 0.35 + geo.openRatio * 0.5 : 0.35;
        onResultRef.current({ transcript: word, confidence: Math.min(conf, 0.95), isFinal: false, language: lang });
      }
    }
  }, []);

  // LR-03 FIX: video.paused is always false for MediaStream elements.
  // Use readyState + videoWidth as the real liveness check.
  const processFrame = useCallback(async () => {
    const video = videoRef.current;
    const fm    = faceMeshRef.current;
    if (!video || !fm)            return;
    if (video.readyState < 2)     return; // HAVE_CURRENT_DATA minimum
    if (video.videoWidth === 0)   return; // video track off or not decoded
    try { await fm.send({ image: video }); } catch { /* transient, ignore */ }
  }, [videoRef]);

  const stop = useCallback(() => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    sequenceRef.current = [];
    // LR-05 FIX: close FaceMesh to release WASM memory; previously only clearInterval was called.
    if (faceMeshRef.current) {
      try { faceMeshRef.current.close(); } catch { /* ignore */ }
      faceMeshRef.current = null;
    }
    setIsActive(false);
    setIsLoading(false);
  }, []);

  const start = useCallback(async () => {
    if (isActive || isLoading) return;
    setIsLoading(true);
    setError(null);
    // LR-06 FIX: always reset transcript on (re)start so language switches don't
    // prepend stale transcript from a previous language session.
    transcriptRef.current = "";
    sequenceRef.current   = [];
    try {
      const FaceMesh = await loadMediaPipe();
      if (!FaceMesh) throw new Error("FaceMesh class not found after load");
      const fm = new FaceMesh({ locateFile: (f: string) => `${MP_CDNS[0]}/${f}` });
      fm.setOptions({ maxNumFaces: 1, refineLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
      fm.onResults(onFaceMeshResults);
      await fm.initialize();
      faceMeshRef.current = fm;
      intervalRef.current = setInterval(processFrame, FRAME_MS);
      setIsActive(true);
    } catch (err: unknown) {
      setError((err instanceof Error ? err.message : String(err)) || "Lip reading unavailable on this device");
    } finally {
      setIsLoading(false);
    }
  }, [isActive, isLoading, onFaceMeshResults, processFrame]);

  const clearTranscript = useCallback(() => {
    transcriptRef.current = "";
    sequenceRef.current   = [];
  }, []);

  // LR-06 FIX: reset full context (sequence + transcript) on language change.
  useEffect(() => {
    sequenceRef.current   = [];
    transcriptRef.current = "";
  }, [language]);

  // LR-05 FIX: stop() now closes FaceMesh on unmount too.
  useEffect(() => () => stop(), [stop]);

  return { isActive, isLoading, error, start, stop, clearTranscript };
};
