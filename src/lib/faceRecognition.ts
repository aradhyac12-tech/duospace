/**
 * Owner face recognition using MediaPipe FaceLandmarker.
 *
 * Why landmarks (and not a CNN embedder)?
 * ────────────────────────────────────────
 * MediaPipe's FaceLandmarker returns 478 3D points per face. After centering
 * on the nose and scaling by inter-ocular distance, the resulting flat vector
 * is a stable, identity-discriminative descriptor that we can compare with
 * cosine similarity. This avoids shipping a multi-MB CNN model and keeps the
 * whole pipeline in one model file (~3MB) loaded once and reused.
 *
 * Storage: enrolled embeddings live in IndexedDB ("duo-assets" / "blobs" store,
 * key "owner-face-embeddings") as JSON. We never persist raw photos.
 */

import { FilesetResolver, FaceLandmarker, type FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import { faceFromLandmarks } from "@/lib/faceMath";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";

const IDB_DB    = "duo-assets";
const IDB_STORE = "blobs";
const KEY       = "owner-face-embeddings";

let landmarkerSingleton: FaceLandmarker | null = null;
let loading: Promise<FaceLandmarker> | null = null;

export const getLandmarker = async (maxFaces = 5): Promise<FaceLandmarker> => {
  if (landmarkerSingleton) return landmarkerSingleton;
  if (loading) return loading;
  loading = (async () => {
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    const lm = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numFaces: maxFaces,
      minFaceDetectionConfidence: 0.6,
      minFacePresenceConfidence: 0.6,
      minTrackingConfidence: 0.5,
    });
    landmarkerSingleton = lm;
    return lm;
  })();
  return loading;
};

// ── Blendshape-enabled landmarker (lip reading) ────────────────────────────
// A second, separate FaceLandmarker instance rather than reusing
// getLandmarker() above: this one turns on outputFaceBlendshapes, which the
// peek-guard/mood-detector instance deliberately doesn't need (52 extra
// classification outputs per frame it would just discard) and only tracks
// one face (the remote call partner) instead of up to 5. Both instances
// still share the same underlying WASM binary and model file at the HTTP
// cache layer — FilesetResolver.forVisionTasks(WASM_URL) / MODEL_URL are the
// same constants — so this doesn't cost a second download, just a second
// lightweight graph instance.
let lipLandmarkerSingleton: FaceLandmarker | null = null;
let lipLoading: Promise<FaceLandmarker> | null = null;

export const getLipLandmarker = async (): Promise<FaceLandmarker> => {
  if (lipLandmarkerSingleton) return lipLandmarkerSingleton;
  if (lipLoading) return lipLoading;
  lipLoading = (async () => {
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    const lm = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
      // Lower than getLandmarker()'s 0.6 — this runs against a compressed,
      // often small/off-angle WebRTC video tile instead of a clean local
      // camera feed, so the bar for "still worth tracking" is lower;
      // classification quality is judged from blendshape confidence
      // downstream, not gated here.
      minFaceDetectionConfidence: 0.4,
      minFacePresenceConfidence: 0.4,
      minTrackingConfidence: 0.4,
    });
    lipLandmarkerSingleton = lm;
    return lm;
  })();
  return lipLoading;
};

export const closeLipLandmarker = (): void => {
  if (lipLandmarkerSingleton) {
    try { lipLandmarkerSingleton.close(); } catch { /* ignore */ }
    lipLandmarkerSingleton = null;
  }
  lipLoading = null;
};

/** One frame's blendshape scores, keyed by MediaPipe's category name
 *  (e.g. "jawOpen", "mouthPucker") — see face_blendshapes_graph.cc for the
 *  canonical 52-name list this comes from. */
export type BlendshapeScores = Record<string, number>;

export const detectBlendshapes = (
  landmarker: FaceLandmarker,
  video: HTMLVideoElement,
  ts: number,
): BlendshapeScores | null => {
  const result = landmarker.detectForVideo(video, ts);
  const cats = result.faceBlendshapes?.[0]?.categories;
  if (!cats || cats.length === 0) return null;
  const out: BlendshapeScores = {};
  for (const c of cats) out[c.categoryName] = c.score;
  return out;
};

/** Detected face wrapper used throughout the peek pipeline. Same shape the
 *  detection worker produces — see lib/faceMath.ts for the shared math. */
export type DetectedFace = import("@/lib/faceMath").DetectedFaceRaw;

/** Run FaceLandmarker on a video/image frame and return per-face embeddings.
 *  Main-thread path — used by enrollment (still image sources) and as the
 *  fallback when the peek-guard Web Worker pipeline isn't available. The
 *  hot path (usePeekDetection) normally runs this same math off-thread via
 *  faceDetection.worker.ts / faceWorkerClient.ts instead of calling this. */
export const detectFaces = async (
  source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement,
  ts = performance.now(),
): Promise<DetectedFace[]> => {
  const lm = await getLandmarker();
  const result: FaceLandmarkerResult =
    source instanceof HTMLVideoElement
      ? lm.detectForVideo(source, ts)
      : lm.detect(source);
  const faces: DetectedFace[] = [];
  for (const lmList of result.faceLandmarks ?? []) {
    const face = faceFromLandmarks(lmList as any);
    if (face) faces.push(face);
  }
  return faces;
};

export const cosineSim = (a: Float32Array, b: Float32Array): number => {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
};

// ── IndexedDB persistence ────────────────────────────────────────────────────
const idbOpen = (): Promise<IDBDatabase> =>
  new Promise((res, rej) => {
    const req = indexedDB.open(IDB_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });

const idbGet = async (key: string): Promise<string | null> => {
  try {
    const db = await idbOpen();
    return await new Promise((res) => {
      const req = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key);
      req.onsuccess = () => res((req.result as string) ?? null);
      req.onerror   = () => res(null);
    });
  } catch { return null; }
};

const idbSet = async (key: string, value: string): Promise<void> => {
  try {
    const db = await idbOpen();
    db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).put(value, key);
  } catch { /* noop */ }
};

const idbDelete = async (key: string): Promise<void> => {
  try {
    const db = await idbOpen();
    db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).delete(key);
  } catch { /* noop */ }
};

export interface OwnerProfile {
  embeddings: number[][]; // each = 478*3 floats
  enrolledAt: number;
  count: number;
  /**
   * Worst-case (minimum) pairwise cosine similarity between the owner's own
   * enrolled samples. Enrollment now requires real yaw diversity, so this is
   * a genuine measure of "how much does MY face's match score naturally
   * drop across realistic angles" — not a guess. Used to personalize the
   * peek-guard match threshold instead of applying one static number to
   * every face shape/lighting condition. Undefined for profiles saved
   * before this field existed (falls back to the configured threshold).
   */
  selfSimFloor?: number;
}

// FIX (peek guard "owner not detected" even after enrolling): usePeekDetection
// only loaded the owner profile once, when Peek Guard was switched on (effect
// keyed off `enabled`). Enrolling a face *while Peek Guard was already
// running* — the normal flow, since enrollment lives in Settings — never
// re-ran that effect, so the in-memory owner reference stayed null/stale
// until the user toggled Peek Guard off and on again or restarted the app.
// Dispatching this event lets an already-mounted usePeekDetection instance
// reload the profile immediately after save/clear.
const OWNER_PROFILE_EVENT = "duospace:owner-profile-changed";
const notifyOwnerProfileChanged = () => {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(OWNER_PROFILE_EVENT));
};

export const saveOwnerProfile = async (embeddings: Float32Array[]): Promise<void> => {
  let selfSimFloor: number | undefined;
  if (embeddings.length >= 2) {
    let min = 1;
    for (let i = 0; i < embeddings.length; i++) {
      for (let j = i + 1; j < embeddings.length; j++) {
        const s = cosineSim(embeddings[i], embeddings[j]);
        if (s < min) min = s;
      }
    }
    selfSimFloor = min;
  }
  const profile: OwnerProfile = {
    embeddings: embeddings.map((e) => Array.from(e)),
    enrolledAt: Date.now(),
    count: embeddings.length,
    selfSimFloor,
  };
  await idbSet(KEY, JSON.stringify(profile));
  notifyOwnerProfileChanged();
};

export const loadOwnerProfile = async (): Promise<OwnerProfile | null> => {
  const raw = await idbGet(KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as OwnerProfile; } catch { return null; }
};

export const clearOwnerProfile = async (): Promise<void> => {
  await idbDelete(KEY);
  notifyOwnerProfileChanged();
};

/**
 * Match score for a candidate face against the enrolled owner. Uses the
 * average of the top-3 similarities (rather than a single best-of-N) so one
 * unusually generic or unusually noisy enrolled sample can't single-handedly
 * decide the match — the candidate has to genuinely resemble multiple
 * captured angles. Top-3 (vs top-2) adds robustness against a single
 * outlier enrolled sample while still ignoring truly mismatched angles.
 */
export const matchAgainstOwner = (candidate: Float32Array, owner: OwnerProfile): number => {
  const sims: number[] = [];
  for (const arr of owner.embeddings) {
    const ref = arr instanceof Float32Array ? arr : new Float32Array(arr);
    sims.push(cosineSim(candidate, ref));
  }
  if (sims.length === 0) return 0;
  sims.sort((a, b) => b - a);
  const topN = Math.min(3, sims.length);
  const top = sims.slice(0, topN);
  return top.reduce((a, b) => a + b, 0) / top.length;
};

/**
 * Pose-aware matching: when the candidate face is at an extreme angle,
 * landmarks are less reliable and match scores naturally drop. This
 * function applies a small, bounded relaxation to the threshold based
 * on how far the face is from frontal — capped so it can never loosen
 * the threshold by more than 0.05, preventing a side-profile stranger
 * from matching.
 */
export const matchAgainstOwnerPoseAware = (
  candidate: Float32Array,
  owner: OwnerProfile,
  configuredThreshold: number,
  candidateYaw: number,
): { score: number; threshold: number; matched: boolean } => {
  const score = matchAgainstOwner(candidate, owner);
  let threshold = getAdaptiveMatchThreshold(owner, configuredThreshold);
  // Relax threshold for non-frontal faces: yaw beyond ~0.04 (roughly
  // 15-20° off-center) means landmarks are less precise, so allow a
  // small tolerance. Bounded at +0.05 so it can never fully override
  // the configured security level.
  const absYaw = Math.abs(candidateYaw);
  if (absYaw > 0.04) {
    const yawRelaxation = Math.min(0.05, (absYaw - 0.04) * 0.8);
    threshold = Math.max(ABSOLUTE_MIN_MATCH_THRESHOLD, threshold - yawRelaxation);
  }
  return { score, threshold, matched: score >= threshold };
};

/** Absolute floor — never treat anything below this as "possibly the owner",
 *  regardless of how variable the owner's own enrollment turned out to be. */
const ABSOLUTE_MIN_MATCH_THRESHOLD = 0.55;
const SELF_SIM_MARGIN = 0.06;

/**
 * Personalizes the match threshold using real enrollment data instead of one
 * static number for everyone: never looser than ABSOLUTE_MIN_MATCH_THRESHOLD,
 * never stricter than the user's configured threshold (that stays a hard
 * ceiling — this only ever relaxes toward the owner's own measured
 * variability, it never overrides the user's chosen security level upward).
 */
export const getAdaptiveMatchThreshold = (owner: OwnerProfile | null, configuredThreshold: number): number => {
  if (!owner?.selfSimFloor) return configuredThreshold;
  const personalized = owner.selfSimFloor - SELF_SIM_MARGIN;
  return Math.min(configuredThreshold, Math.max(ABSOLUTE_MIN_MATCH_THRESHOLD, personalized));
};
