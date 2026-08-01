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
};

export const loadOwnerProfile = async (): Promise<OwnerProfile | null> => {
  const raw = await idbGet(KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as OwnerProfile; } catch { return null; }
};

export const clearOwnerProfile = async (): Promise<void> => idbDelete(KEY);

/**
 * Match score for a candidate face against the enrolled owner. Uses the
 * average of the top-2 similarities (rather than a single best-of-N) so one
 * unusually generic or unusually noisy enrolled sample can't single-handedly
 * decide the match — the candidate has to genuinely resemble more than one
 * captured angle.
 */
export const matchAgainstOwner = (candidate: Float32Array, owner: OwnerProfile): number => {
  const sims: number[] = [];
  for (const arr of owner.embeddings) {
    const ref = arr instanceof Float32Array ? arr : new Float32Array(arr);
    sims.push(cosineSim(candidate, ref));
  }
  if (sims.length === 0) return 0;
  sims.sort((a, b) => b - a);
  const top = sims.slice(0, Math.min(2, sims.length));
  return top.reduce((a, b) => a + b, 0) / top.length;
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
