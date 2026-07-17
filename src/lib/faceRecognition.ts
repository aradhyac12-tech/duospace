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

/** Detected face wrapper used throughout the peek pipeline. */
export interface DetectedFace {
  embedding: Float32Array;     // 478*3 normalized landmarks
  /** Bounding box in *normalized* coords [0..1] from min/max landmarks. */
  bbox: { x: number; y: number; w: number; h: number };
  /** Approximate area in normalized units — used to ignore tiny far-away faces. */
  area: number;
  /** Average Eye-Aspect-Ratio (EAR) — used for blink-based liveness. */
  ear: number;
  /** Yaw / pitch proxy from nose-vs-eye-center delta — used for movement liveness. */
  pose: { yaw: number; pitch: number };
}

/**
 * Extract a normalized embedding from one face's landmark list.
 * Centering on landmark 1 (nose tip) + scaling by distance(left-eye, right-eye)
 * makes the vector translation/scale invariant. Identity-stable across
 * head poses within ~30°.
 */
const buildEmbedding = (landmarks: { x: number; y: number; z: number }[]): Float32Array => {
  // Landmark indices for canonical FaceMesh:
  // 1 = nose tip, 33 = left eye outer, 263 = right eye outer
  const nose = landmarks[1];
  const le   = landmarks[33];
  const re   = landmarks[263];
  const dx   = re.x - le.x;
  const dy   = re.y - le.y;
  const dz   = re.z - le.z;
  const scale = Math.hypot(dx, dy, dz) || 1;

  const out = new Float32Array(landmarks.length * 3);
  for (let i = 0; i < landmarks.length; i++) {
    out[i * 3]     = (landmarks[i].x - nose.x) / scale;
    out[i * 3 + 1] = (landmarks[i].y - nose.y) / scale;
    out[i * 3 + 2] = (landmarks[i].z - nose.z) / scale;
  }
  return out;
};

const bboxFromLandmarks = (landmarks: { x: number; y: number }[]) => {
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of landmarks) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  return { x: minX, y: minY, w, h, area: w * h };
};

// Eye landmark indices (FaceMesh canonical):
// Left eye:  outer 33, inner 133, top 159, bottom 145
// Right eye: outer 263, inner 362, top 386, bottom 374
const computeEAR = (lm: { x: number; y: number }[]): number => {
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);
  const leftEAR  = dist(lm[159], lm[145]) / (dist(lm[33], lm[133])  || 1);
  const rightEAR = dist(lm[386], lm[374]) / (dist(lm[263], lm[362]) || 1);
  return (leftEAR + rightEAR) / 2;
};

// Coarse pose proxy — yaw from nose vs midpoint of outer eyes; pitch from
// nose vs midpoint of (forehead 10) and (chin 152). Good enough for
// "did the head move at all" liveness, no full PnP needed.
const computePose = (lm: { x: number; y: number }[]): { yaw: number; pitch: number } => {
  const nose = lm[1];
  const eyeMidX = (lm[33].x + lm[263].x) / 2;
  const yaw = nose.x - eyeMidX;
  const vertMidY = (lm[10].y + lm[152].y) / 2;
  const pitch = nose.y - vertMidY;
  return { yaw, pitch };
};

/** Run FaceLandmarker on a video/image frame and return per-face embeddings. */
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
    if (!lmList || lmList.length < 400) continue; // need enough points for EAR/pose
    const bb = bboxFromLandmarks(lmList);
    faces.push({
      embedding: buildEmbedding(lmList as any),
      bbox: { x: bb.x, y: bb.y, w: bb.w, h: bb.h },
      area: bb.area,
      ear: computeEAR(lmList as any),
      pose: computePose(lmList as any),
    });
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
}

export const saveOwnerProfile = async (embeddings: Float32Array[]): Promise<void> => {
  const profile: OwnerProfile = {
    embeddings: embeddings.map((e) => Array.from(e)),
    enrolledAt: Date.now(),
    count: embeddings.length,
  };
  await idbSet(KEY, JSON.stringify(profile));
};

export const loadOwnerProfile = async (): Promise<OwnerProfile | null> => {
  const raw = await idbGet(KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as OwnerProfile; } catch { return null; }
};

export const clearOwnerProfile = async (): Promise<void> => idbDelete(KEY);

/** Best similarity between candidate and any enrolled owner embedding. */
export const matchAgainstOwner = (candidate: Float32Array, owner: OwnerProfile): number => {
  let best = 0;
  for (const arr of owner.embeddings) {
    const ref = arr instanceof Float32Array ? arr : new Float32Array(arr);
    const s = cosineSim(candidate, ref);
    if (s > best) best = s;
  }
  return best;
};
