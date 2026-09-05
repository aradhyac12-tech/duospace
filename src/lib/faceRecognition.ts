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

// PERF FIX (Phase 1 #4): this used to be a static value import of
// @mediapipe/tasks-vision (several hundred KB of vision-model wrapper JS),
// which pulls the whole package into whatever chunk this file lands in.
// Since this file is imported (directly or via usePeekDetection.ts) from
// PeekGuard.tsx — mounted unconditionally at the App root for every user,
// whether or not Peek Guard is even enabled — that meant MediaPipe loaded
// on every app startup. Now it's a type-only import (erased at build time,
// zero runtime cost) plus a dynamic `import()` inside getLandmarker() /
// getLipLandmarker() below, so the actual package is only fetched the
// first time a landmarker is actually requested — i.e. only once Peek
// Guard or lip reading is enabled and actually running. Every exported
// function's signature here is unchanged, so no caller (PeekGuard.tsx,
// usePeekDetection.ts, useLipReading.ts) needs to change.
import type { FaceLandmarker, FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import { faceFromLandmarks, computePose } from "@/lib/faceMath";

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
    const { FilesetResolver, FaceLandmarker } = await import("@mediapipe/tasks-vision");
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
    const { FilesetResolver, FaceLandmarker } = await import("@mediapipe/tasks-vision");
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

/** A single frame's blendshapes plus the same coarse yaw/pitch pose proxy
 *  used elsewhere in this file (faceRecognition's own match-threshold
 *  relaxation) — reusing computePose() rather than deriving pose from the
 *  facial transformation matrix keeps this consistent with the rest of the
 *  codebase's "|yaw| beyond ~0.04 is meaningfully off-angle" convention and
 *  avoids a second, differently-scaled pose representation. `pose` is null
 *  when this frame's landmarks weren't returned (shouldn't normally happen
 *  alongside a successful blendshape read, but MediaPipe's two outputs are
 *  populated by separate sub-graphs so it isn't strictly guaranteed). */
export interface BlendshapeFrame {
  scores: BlendshapeScores;
  pose: { yaw: number; pitch: number } | null;
}

export const detectBlendshapes = (
  landmarker: FaceLandmarker,
  video: HTMLVideoElement,
  ts: number,
): BlendshapeFrame | null => {
  const result = landmarker.detectForVideo(video, ts);
  const cats = result.faceBlendshapes?.[0]?.categories;
  if (!cats || cats.length === 0) return null;
  const scores: BlendshapeScores = {};
  for (const c of cats) scores[c.categoryName] = c.score;
  const lm = result.faceLandmarks?.[0];
  const pose = lm ? computePose(lm) : null;
  return { scores, pose };
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
// RELIABILITY FIX: idbSet/idbDelete previously resolved as soon as
// `.put()`/`.delete()` was *called*, not once the underlying transaction
// actually committed — IDBObjectStore.put() only queues the write; the
// browser can still fail it (quota exceeded, another tab's version-change
// blocking it, disk error) after the call returns. Both also swallowed every
// error silently ("noop"), so saveOwnerProfile() could resolve — and
// FaceEnrollmentDialog would show "Owner face enrolled" — even when nothing
// was actually persisted. Now every write/delete awaits the transaction's
// own oncomplete/onerror/onabort, and failures propagate instead of being
// eaten, so callers (saveOwnerProfile) can tell the user the truth and
// retry rather than silently losing their enrollment.
let idbSingleton: Promise<IDBDatabase> | null = null;
const idbOpen = (): Promise<IDBDatabase> => {
  if (idbSingleton) return idbSingleton;
  idbSingleton = new Promise((res, rej) => {
    const req = indexedDB.open(IDB_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      // If another tab/version upgrades the DB later, drop our cached handle
      // so the next call reopens cleanly instead of using a stale connection.
      db.onversionchange = () => { try { db.close(); } catch { /* ignore */ } idbSingleton = null; };
      res(db);
    };
    req.onerror = () => { idbSingleton = null; rej(req.error); };
    req.onblocked = () => { idbSingleton = null; };
  });
  return idbSingleton;
};

/** Runs one op against the store and waits for the *transaction* (not just
 *  the request) to finish, with a single retry on a transient failure —
 *  covers the common "DB was mid-upgrade/blocked on first call" case
 *  without making every caller implement its own retry loop. */
const idbRun = async <T,>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
  attempt = 0,
): Promise<T> => {
  try {
    const db = await idbOpen();
    return await new Promise<T>((res, rej) => {
      const tx = db.transaction(IDB_STORE, mode);
      const req = fn(tx.objectStore(IDB_STORE));
      let result: T;
      req.onsuccess = () => { result = req.result; };
      req.onerror = () => rej(req.error);
      tx.oncomplete = () => res(result);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  } catch (err) {
    if (attempt === 0) {
      idbSingleton = null; // force a fresh connection before the retry
      return idbRun(mode, fn, 1);
    }
    throw err;
  }
};

const idbGet = async (key: string): Promise<string | null> => {
  try {
    const v = await idbRun<string | undefined>("readonly", (s) => s.get(key));
    return v ?? null;
  } catch { return null; } // reads stay best-effort: worst case, treat as "no owner enrolled"
};

const idbSet = (key: string, value: string): Promise<void> =>
  idbRun<IDBValidKey>("readwrite", (s) => s.put(value, key)).then(() => undefined);

const idbDelete = (key: string): Promise<void> =>
  idbRun<undefined>("readwrite", (s) => s.delete(key)).then(() => undefined);

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
  /**
   * Per-embedding head pose captured at enrollment time (same index as
   * `embeddings`), populated once the guided directional enrollment
   * (center/left/right/up/down) shipped. Lets matching weight an enrolled
   * sample more heavily when it was captured at an angle close to the
   * *candidate's* current angle — a "looking down at the phone" owner frame
   * should be compared mainly against the owner's own "down" enrollment
   * samples, not diluted by center-only ones. Undefined for profiles saved
   * before this field existed; matching falls back to the plain top-N
   * average in that case.
   */
  poses?: { yaw: number; pitch: number }[];
}

/** One captured enrollment sample: an embedding plus the head pose it was
 *  captured at. Enrollment (FaceEnrollmentDialog) now guides the owner
 *  through center/left/right/up/down so real pose coverage — not just yaw —
 *  ends up in the stored profile. */
export interface EnrollmentSample {
  embedding: Float32Array;
  pose: { yaw: number; pitch: number };
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

/**
 * Persists the owner profile. Accepts either plain embeddings (legacy call
 * shape — pose data omitted, matching falls back to the non-pose-aware
 * path) or full `EnrollmentSample`s (embedding + the pose it was captured
 * at), which is what the guided directional enrollment flow now produces.
 */
export const saveOwnerProfile = async (
  samples: Float32Array[] | EnrollmentSample[],
): Promise<void> => {
  const hasPose = samples.length > 0 && "pose" in (samples[0] as EnrollmentSample);
  const embeddings = hasPose
    ? (samples as EnrollmentSample[]).map((s) => s.embedding)
    : (samples as Float32Array[]);
  const poses = hasPose ? (samples as EnrollmentSample[]).map((s) => s.pose) : undefined;

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
    poses,
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
 * average of the top-N similarities (rather than a single best-of-N) so one
 * unusually generic or unusually noisy enrolled sample can't single-handedly
 * decide the match — the candidate has to genuinely resemble multiple
 * captured angles. N scales gently with how many samples are enrolled
 * (min 3, ~20% of the set beyond that) — a profile with 30-40 samples from
 * the guided center/left/right/up/down flow shouldn't still be judged by
 * only 3 of them, or most of that pose coverage never actually influences
 * the score.
 */
export const matchAgainstOwner = (candidate: Float32Array, owner: OwnerProfile): number => {
  const sims: number[] = [];
  for (const arr of owner.embeddings) {
    const ref = arr instanceof Float32Array ? arr : new Float32Array(arr);
    sims.push(cosineSim(candidate, ref));
  }
  if (sims.length === 0) return 0;
  sims.sort((a, b) => b - a);
  const topN = Math.max(3, Math.min(sims.length, Math.round(sims.length * 0.2)));
  const top = sims.slice(0, topN);
  return top.reduce((a, b) => a + b, 0) / top.length;
};

/**
 * Pose-weighted variant of matchAgainstOwner: when the profile has per-
 * sample pose data (see OwnerProfile.poses — populated by the guided
 * directional enrollment), similarities are weighted toward whichever
 * enrolled samples were captured at an angle close to the *candidate's*
 * current pose. A frame of the owner looking down at their phone should be
 * judged mainly against the owner's own "look down" enrollment samples, not
 * averaged in with center-only ones that a plain top-N never distinguishes
 * from off-angle ones. Falls back to the plain top-N average when the
 * profile predates pose storage.
 *
 * The weighting is a soft Gaussian kernel over pose distance (not a hard
 * nearest-neighbor cutoff) so it degrades gracefully for in-between angles
 * instead of snapping between buckets.
 */
const poseWeightedSims = (
  candidate: Float32Array,
  owner: OwnerProfile,
  candidateYaw: number,
  candidatePitch: number,
): number[] => {
  const poses = owner.poses;
  const sims: number[] = [];
  for (let i = 0; i < owner.embeddings.length; i++) {
    const arr = owner.embeddings[i];
    const ref = arr instanceof Float32Array ? arr : new Float32Array(arr);
    const sim = cosineSim(candidate, ref);
    if (!poses?.[i]) { sims.push(sim); continue; }
    const dYaw = candidateYaw - poses[i].yaw;
    const dPitch = candidatePitch - poses[i].pitch;
    const poseDistSq = dYaw * dYaw + dPitch * dPitch;
    // sigma ~0.08 in this yaw/pitch unit space (roughly a 30° window) — wide
    // enough that a same-side sample still counts a lot, narrow enough that
    // an opposite-angle sample is meaningfully down-weighted rather than
    // treated as equally relevant.
    const weight = Math.exp(-poseDistSq / (2 * 0.08 * 0.08));
    // Blend rather than hard-multiply: a weight floor of 0.35 keeps every
    // sample contributing something, so a candidate at a totally novel
    // angle (nothing close was enrolled) still gets compared against the
    // owner's whole profile instead of effectively zeroing it out.
    sims.push(sim * (0.35 + 0.65 * weight));
  }
  return sims;
};

const averageTopN = (sims: number[]): number => {
  if (sims.length === 0) return 0;
  const sorted = [...sims].sort((a, b) => b - a);
  const topN = Math.max(3, Math.min(sorted.length, Math.round(sorted.length * 0.2)));
  const top = sorted.slice(0, topN);
  return top.reduce((a, b) => a + b, 0) / top.length;
};

/**
 * Pose-aware matching: when the candidate face is at an extreme angle,
 * landmarks are less reliable and match scores naturally drop. This
 * function (a) scores the candidate using pose-weighted similarities when
 * the profile has pose data, and (b) applies a small, bounded relaxation to
 * the threshold based on how far the face is from frontal — capped so it
 * can never loosen the threshold by more than 0.05, preventing a
 * side-profile stranger from matching.
 */
export const matchAgainstOwnerPoseAware = (
  candidate: Float32Array,
  owner: OwnerProfile,
  configuredThreshold: number,
  candidateYaw: number,
  candidatePitch = 0,
): { score: number; threshold: number; matched: boolean } => {
  const score = owner.poses?.length
    ? averageTopN(poseWeightedSims(candidate, owner, candidateYaw, candidatePitch))
    : matchAgainstOwner(candidate, owner);
  let threshold = getAdaptiveMatchThreshold(owner, configuredThreshold);
  // Relax threshold for non-frontal faces: yaw/pitch beyond ~0.04 (roughly
  // 15-20° off-center) means landmarks are less precise, so allow a small
  // tolerance. Bounded at +0.05 so it can never fully override the
  // configured security level. Using whichever axis is further off-center
  // (not just yaw) matters once pitch is also guided during enrollment —
  // "looking down" breaches were previously never relaxed for pitch at all.
  const offCenter = Math.max(Math.abs(candidateYaw), Math.abs(candidatePitch));
  if (offCenter > 0.04) {
    const relaxation = Math.min(0.05, (offCenter - 0.04) * 0.8);
    threshold = Math.max(ABSOLUTE_MIN_MATCH_THRESHOLD, threshold - relaxation);
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
