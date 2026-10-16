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
import { isVaultValue } from "@/lib/privacy/deviceVault";
import { faceSeal, faceUnseal, isHardwareSealed, hardwareKeyAvailable, destroyHardwareKey } from "@/lib/privacy/secureKey";
import { Capacitor } from "@capacitor/core";
import { dropExpiredAdaptive } from "@/lib/templateLifecycle";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";

const IDB_DB    = "duo-assets";
const IDB_STORE = "blobs";
const KEY       = "owner-face-embeddings";
// Second copy in the same store. A single IDB record can end up truncated or
// unreadable (crash mid-write, storage pressure on a WebView); a sealed
// duplicate lets load() self-heal instead of silently reporting "not enrolled".
const KEY_BACKUP = "owner-face-embeddings.bak";
// Third copy, native only: SharedPreferences/UserDefaults live outside the
// WebView's IndexedDB, so they survive the WebView evicting site storage.
const NATIVE_MIRROR_KEY = "duo-owner-face-v2";

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

// ── Blendshape-enabled landmarker (mood detection) ─────────────────────────
// A third singleton (same shared-download reasoning as getLipLandmarker()
// above). Mood detection needs BOTH the raw landmarks — for the existing
// quality gate and multi-face counting (area/pose/faces.length, see
// moodFrameIssue in lib/moodScoring.ts and the callers' noFace/multiFace
// tracking) — AND blendshapes, from a single inference pass. It can't just
// reuse getLandmarker() (no blendshapes) or getLipLandmarker() (numFaces:1,
// so a second face in frame would silently vanish instead of tripping the
// "multiple faces" hint; also tuned with lower confidence thresholds for a
// compressed remote call feed, and used concurrently by an active call's
// lip reading — sharing that singleton risks two independent ts sequences
// interleaving against one landmarker's monotonic-timestamp requirement).
// numFaces matches getLandmarker() (not getLipLandmarker()'s 1) so
// multi-face detection keeps working exactly as before.
let moodLandmarkerSingleton: FaceLandmarker | null = null;
let moodLoading: Promise<FaceLandmarker> | null = null;

export const getMoodLandmarker = async (maxFaces = 5): Promise<FaceLandmarker> => {
  if (moodLandmarkerSingleton) return moodLandmarkerSingleton;
  if (moodLoading) return moodLoading;
  moodLoading = (async () => {
    const { FilesetResolver, FaceLandmarker } = await import("@mediapipe/tasks-vision");
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    const lm = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numFaces: maxFaces,
      outputFaceBlendshapes: true,
      minFaceDetectionConfidence: 0.6,
      minFacePresenceConfidence: 0.6,
      minTrackingConfidence: 0.5,
    });
    moodLandmarkerSingleton = lm;
    return lm;
  })();
  return moodLoading;
};

export const closeMoodLandmarker = (): void => {
  if (moodLandmarkerSingleton) {
    try { moodLandmarkerSingleton.close(); } catch { /* ignore */ }
    moodLandmarkerSingleton = null;
  }
  moodLoading = null;
};

/** One frame's combined mood-detection read: the same DetectedFace[] shape
 *  detectFaces() below already produces (so the existing quality gate and
 *  face-count tracking need zero changes) PLUS trained blendshape scores
 *  for the first detected face — both derived from a SINGLE
 *  detectForVideo() call so mood detection doesn't pay for two inference
 *  passes per sample tick. `blendshapes` is the accuracy upgrade: it's the
 *  output of MediaPipe's own trained face-blendshape model (52 ARKit-
 *  compatible per-muscle activation scores, each ~0 at genuine rest and
 *  calibrated across many real faces) rather than raw landmark geometry —
 *  see scoreMoodsFromBlendshapes in lib/moodScoring.ts. Null when the
 *  blendshape sub-graph didn't populate for this frame (rare) or no face
 *  was found at all; callers fall back to the geometry pipeline in that
 *  case, same as if this function didn't exist. */
export const detectMoodFrame = (
  landmarker: FaceLandmarker,
  video: HTMLVideoElement,
  ts: number,
): { faces: DetectedFace[]; blendshapes: BlendshapeScores | null } => {
  const result = landmarker.detectForVideo(video, ts);
  const faces: DetectedFace[] = [];
  for (const lmList of result.faceLandmarks ?? []) {
    const face = faceFromLandmarks(lmList as any);
    if (face) faces.push(face);
  }
  const cats = result.faceBlendshapes?.[0]?.categories;
  const blendshapes: BlendshapeScores | null =
    cats && cats.length > 0 ? Object.fromEntries(cats.map((c) => [c.categoryName, c.score])) : null;
  return { faces, blendshapes };
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

// Norm cache: enrolled vectors are long-lived (profile cache), so their norms
// are computed once instead of on every frame × every sample.
const normCache = new WeakMap<Float32Array, number>();
const normOf = (v: Float32Array): number => {
  let n = normCache.get(v);
  if (n === undefined) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * v[i];
    n = Math.sqrt(s);
    normCache.set(v, n);
  }
  return n;
};
const cosineSimNorm = (a: Float32Array, an: number, b: Float32Array, bn: number): number => {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  const den = an * bn;
  return den === 0 ? 0 : dot / den;
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
  /** Each = 478*3 floats. Stored as Float32Array in memory after load (so the
   *  per-frame matcher never re-allocates); plain arrays are still accepted
   *  for profiles built by older code/tests. */
  embeddings: Array<number[] | Float32Array>;
  /**
   * How many of the FIRST `embeddings` are anchors: the guided-enrollment
   * samples. Anchors are never evicted by passive adaptation and are the only
   * samples used for `selfSimFloor`, so background learning can't loosen the
   * match threshold over time. Undefined on older profiles (treated as all
   * samples being anchors).
   */
  anchorCount?: number;
  /** Creation time (ms) per sample, index-aligned with `embeddings`. Lets
   *  passively-learned samples expire (lib/templateLifecycle.ts). */
  addedAt?: number[];
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

// ── Profile codec (v2) ───────────────────────────────────────────────────────
// v1 stored `embeddings` as number[][] JSON (~11 chars per float, ~1MB for a
// full profile) and had no integrity check. v2 packs the vectors as base64
// Float32 (~4x smaller, no float→text→float rounding) with an FNV-1a checksum
// so a truncated/corrupt record is DETECTED and recovered from the backup copy
// rather than silently parsed into garbage. v1 is still readable.
const PROFILE_VERSION = 2;

const fnv1a = (bytes: Uint8Array): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
};
const f32ToB64 = (arr: Float32Array): string => {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const b64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};
const toF32 = (e: number[] | Float32Array): Float32Array => (e instanceof Float32Array ? e : new Float32Array(e));

const normalizeProfile = (p: OwnerProfile): OwnerProfile => ({
  ...p,
  embeddings: p.embeddings.map(toF32),
  count: p.embeddings.length,
  anchorCount: Math.min(p.anchorCount ?? p.embeddings.length, p.embeddings.length),
});

const encodeProfile = (p: OwnerProfile): string => {
  const embs = p.embeddings.map(toF32);
  const dim = embs[0]?.length ?? 0;
  if (dim === 0 || embs.some((e) => e.length !== dim)) {
    // Ragged/empty input can't be packed — keep the legacy shape rather than lose data.
    return JSON.stringify({ ...p, embeddings: embs.map((e) => Array.from(e)) });
  }
  const flat = new Float32Array(embs.length * dim);
  embs.forEach((e, i) => flat.set(e, i * dim));
  const sum = fnv1a(new Uint8Array(flat.buffer));
  return JSON.stringify({
    v: PROFILE_VERSION, enrolledAt: p.enrolledAt, count: embs.length, dim,
    selfSimFloor: p.selfSimFloor, poses: p.poses, anchorCount: p.anchorCount ?? embs.length,
    addedAt: p.addedAt,
    data: f32ToB64(flat), sum,
  });
};

/** Returns the profile plus whether it was in the legacy (v1) shape. */
const decodeProfile = (raw: string): { profile: OwnerProfile; legacy: boolean } | null => {
  let o: any;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  if (o.v === PROFILE_VERSION && typeof o.data === "string" && o.dim > 0 && o.count > 0) {
    try {
      const bytes = b64ToBytes(o.data);
      if (fnv1a(bytes) !== o.sum) return null; // corrupt → caller tries the backup
      const flat = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      if (flat.length !== o.count * o.dim) return null;
      const embeddings: Float32Array[] = [];
      for (let i = 0; i < o.count; i++) embeddings.push(flat.slice(i * o.dim, (i + 1) * o.dim));
      return {
        legacy: false,
        profile: normalizeProfile({
          embeddings, enrolledAt: o.enrolledAt, count: o.count,
          selfSimFloor: o.selfSimFloor, poses: o.poses, anchorCount: o.anchorCount,
          addedAt: Array.isArray(o.addedAt) && o.addedAt.length === o.count ? o.addedAt : undefined,
        }),
      };
    } catch { return null; }
  }
  if (Array.isArray(o.embeddings) && o.embeddings.length > 0) {
    return { legacy: true, profile: normalizeProfile(o as OwnerProfile) };
  }
  return null;
};

/** Worst-case pairwise similarity across the given samples (anchors only —
 *  see OwnerProfile.anchorCount for why adaptive samples are excluded). */
const computeSelfSimFloor = (embs: Array<number[] | Float32Array>): number | undefined => {
  if (embs.length < 2) return undefined;
  const f = embs.map(toF32);
  let min = 1;
  for (let i = 0; i < f.length; i++) {
    for (let j = i + 1; j < f.length; j++) {
      const s = cosineSim(f[i], f[j]);
      if (s < min) min = s;
    }
  }
  return min;
};

// ── Cache + persistence ──────────────────────────────────────────────────────
// loadOwnerProfile() used to hit IndexedDB, decrypt and JSON-parse on every
// call (including every manual verify). One in-memory copy, invalidated on any
// write/clear through this module, makes it effectively free.
let profileCache: OwnerProfile | null | undefined; // undefined = not loaded yet
let profileLoading: Promise<OwnerProfile | null> | null = null;
export type ProfileSource = "primary" | "backup" | "native-backup" | "none";
let lastSource: ProfileSource = "none";

const requestPersistentStorage = async (): Promise<boolean | null> => {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.persist) return null;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch { return null; }
};

const mirrorToNative = async (sealed: string | null): Promise<void> => {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { Preferences } = await import("@capacitor/preferences");
    if (sealed == null) await Preferences.remove({ key: NATIVE_MIRROR_KEY });
    else await Preferences.set({ key: NATIVE_MIRROR_KEY, value: sealed });
  } catch { /* plugin missing — IDB copies still stand */ }
};

const persistProfile = async (profile: OwnerProfile, opts: { notify?: boolean } = {}): Promise<void> => {
  const normalized = normalizeProfile(profile);
  const sealed = await faceSeal(encodeProfile(normalized));
  // The primary write must succeed (and propagates failure — see the
  // RELIABILITY FIX note on idbRun); the redundant copies are best-effort.
  await idbSet(KEY, sealed);
  profileCache = normalized;
  lastSource = "primary";
  void idbSet(KEY_BACKUP, sealed).catch(() => { /* best effort */ });
  void mirrorToNative(sealed);
  void requestPersistentStorage();
  if (opts.notify !== false) notifyOwnerProfileChanged();
};

/**
 * Persists the owner profile. Accepts either plain embeddings (legacy call
 * shape — pose data omitted, matching falls back to the non-pose-aware
 * path) or full `EnrollmentSample`s (embedding + the pose it was captured
 * at), which is what the guided directional enrollment flow now produces.
 * Everything saved here is an ANCHOR (see OwnerProfile.anchorCount).
 */
export const saveOwnerProfile = async (
  samples: Float32Array[] | EnrollmentSample[],
): Promise<void> => {
  const hasPose = samples.length > 0 && "pose" in (samples[0] as EnrollmentSample);
  const embeddings = hasPose
    ? (samples as EnrollmentSample[]).map((s) => s.embedding)
    : (samples as Float32Array[]);
  const poses = hasPose ? (samples as EnrollmentSample[]).map((s) => s.pose) : undefined;

  // Keep adaptive headroom: a full 60-anchor enrollment would leave passive
  // learning nowhere to go, so cap anchors (oldest dropped).
  let kept = embeddings;
  let keptPoses = poses;
  if (kept.length > MAX_ANCHORS) {
    kept = kept.slice(kept.length - MAX_ANCHORS);
    keptPoses = poses?.slice(poses.length - MAX_ANCHORS);
  }
  await persistProfile({
    embeddings: kept,
    enrolledAt: Date.now(),
    count: kept.length,
    anchorCount: kept.length,
    selfSimFloor: computeSelfSimFloor(kept),
    poses: keptPoses,
    addedAt: kept.map(() => Date.now()),
  });
};

/**
 * Adds a freshly-captured batch of samples to the EXISTING owner profile
 * instead of replacing it — the "add more photos" / "improve recognition"
 * flow in FaceEnrollmentDialog. New guided samples become anchors (inserted
 * after the existing anchors, ahead of any passively-learned samples).
 */
export const addOwnerSamples = async (samples: EnrollmentSample[]): Promise<void> => {
  const existing = await loadOwnerProfile();
  if (!existing) return saveOwnerProfile(samples);

  const embeddings = existing.embeddings.map(toF32);
  const poses = existing.poses ? [...existing.poses] : embeddings.map(() => ({ yaw: 0, pitch: 0 }));
  const addedAt = existing.addedAt?.length === embeddings.length
    ? [...existing.addedAt] : embeddings.map(() => existing.enrolledAt);
  let anchorCount = existing.anchorCount ?? embeddings.length;
  for (const s of samples) {
    embeddings.splice(anchorCount, 0, new Float32Array(s.embedding));
    poses.splice(anchorCount, 0, s.pose);
    addedAt.splice(anchorCount, 0, Date.now());
    anchorCount++;
  }
  anchorCount = evictToCap(embeddings, poses, anchorCount, addedAt);

  await persistProfile({
    embeddings,
    enrolledAt: existing.enrolledAt, // top-up, not a re-enrollment — keep the original date
    count: embeddings.length,
    anchorCount,
    selfSimFloor: computeSelfSimFloor(embeddings.slice(0, anchorCount)) ?? existing.selfSimFloor,
    poses,
    addedAt,
  });
};

/** Trims to MAX_ADAPTIVE_EMBEDDINGS in place. Passive samples go first
 *  (oldest first); anchors are only touched if they alone exceed the cap.
 *  Returns the new anchorCount. */
const evictToCap = (
  embeddings: Float32Array[],
  poses: { yaw: number; pitch: number }[],
  anchorCount: number,
  addedAt?: number[],
): number => {
  while (embeddings.length > MAX_ADAPTIVE_EMBEDDINGS) {
    if (anchorCount < embeddings.length) {
      embeddings.splice(anchorCount, 1); // oldest passive sample
      poses.splice(anchorCount, 1);
      addedAt?.splice(anchorCount, 1);
    } else {
      embeddings.shift();
      poses.shift();
      addedAt?.shift();
      anchorCount--;
    }
  }
  return anchorCount;
};

const readSealed = async (key: string): Promise<{ stored: string; profile: OwnerProfile; legacy: boolean } | null> => {
  const stored = await idbGet(key);
  if (!stored) return null;
  const raw = await faceUnseal(stored);
  if (!raw) return null;
  const decoded = decodeProfile(raw);
  if (!decoded) return null;
  return { stored, ...decoded };
};

const loadFromStorage = async (): Promise<OwnerProfile | null> => {
  // 1. Primary record.
  const primary = await readSealed(KEY);
  if (primary) {
    lastSource = "primary";
    // KI-22: encrypted at rest (deviceVault). Legacy plaintext / v1 shape is
    // migrated to the encrypted v2 form on first load (best effort).
    // Also upgrades vault-sealed profiles to the hardware-backed key once it's available.
    const needsHwUpgrade = !isHardwareSealed(primary.stored) && (await hardwareKeyAvailable());
    if (primary.legacy || !isVaultValue(primary.stored) && !isHardwareSealed(primary.stored) || needsHwUpgrade) {
      try { await persistProfile(primary.profile, { notify: false }); } catch { /* keep legacy copy */ }
    } else {
      // Refresh the redundant copies for installs that predate them.
      void idbSet(KEY_BACKUP, primary.stored).catch(() => { /* best effort */ });
      void mirrorToNative(primary.stored);
    }
    return primary.profile;
  }
  // 2. Backup IDB record — primary missing or failed its checksum.
  const backup = await readSealed(KEY_BACKUP);
  if (backup) {
    try { await persistProfile(backup.profile, { notify: false }); } catch { /* still usable in memory */ }
    lastSource = "backup";
    return backup.profile;
  }
  // 3. Native mirror — IDB wiped entirely (WebView storage eviction).
  if (Capacitor.isNativePlatform()) {
    try {
      const { Preferences } = await import("@capacitor/preferences");
      const { value } = await Preferences.get({ key: NATIVE_MIRROR_KEY });
      if (value) {
        const raw = await faceUnseal(value);
        const decoded = raw ? decodeProfile(raw) : null;
        if (decoded) {
          try { await persistProfile(decoded.profile, { notify: false }); } catch { /* in-memory still fine */ }
          lastSource = "native-backup";
          return decoded.profile;
        }
      }
    } catch { /* ignore */ }
  }
  lastSource = "none";
  return null;
};

export const loadOwnerProfile = async (): Promise<OwnerProfile | null> => {
  if (profileCache !== undefined) return profileCache;
  if (profileLoading) return profileLoading;
  profileLoading = loadFromStorage()
    .then((p) => { profileCache = p ? dropExpiredAdaptive(p) : p; return profileCache; })
    .finally(() => { profileLoading = null; });
  return profileLoading;
};

export const clearOwnerProfile = async (): Promise<void> => {
  await idbDelete(KEY);
  await idbDelete(KEY_BACKUP).catch(() => { /* may not exist */ });
  await mirrorToNative(null);
  await destroyHardwareKey();
  profileCache = null;
  lastSource = "none";
  notifyOwnerProfileChanged();
};

/** Where the profile was last loaded from + whether the OS has promised not to
 *  evict storage. Surfaced in the Peek Guard settings so "my face vanished"
 *  stops being a mystery. */
export const getOwnerProfileHealth = async (): Promise<{
  enrolled: boolean; count: number; anchors: number; source: ProfileSource; persisted: boolean | null; hardwareBacked: boolean;
}> => {
  const p = await loadOwnerProfile();
  let persisted: boolean | null = null;
  try { persisted = (await navigator.storage?.persisted?.()) ?? null; } catch { /* ignore */ }
  return {
    enrolled: !!p && p.count > 0,
    count: p?.count ?? 0,
    anchors: p?.anchorCount ?? p?.count ?? 0,
    source: lastSource,
    persisted,
    hardwareBacked: await hardwareKeyAvailable(),
  };
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
  const cn = normOf(candidate);
  for (const arr of owner.embeddings) {
    const ref = toF32(arr);
    sims.push(cosineSimNorm(candidate, cn, ref, normOf(ref)));
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
  const cn = normOf(candidate);
  for (let i = 0; i < owner.embeddings.length; i++) {
    const ref = toF32(owner.embeddings[i]);
    const sim = cosineSimNorm(candidate, cn, ref, normOf(ref));
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

// ── Face-ID-style "Require Attention" + continuous template adaptation ─────
// Researched from how Face ID actually works: the TrueDepth pipeline (a)
// requires the eyes to be open and directed at the screen before it'll
// unlock at all ("Require Attention"), and (b) quietly folds new high-
// confidence captures into the stored face data after a successful unlock,
// so the template keeps up with gradual appearance change (haircut,
// glasses, weight change) without ever needing the person to re-enroll —
// only falling back to a passcode-confirmed re-enrollment for an abrupt
// change (shaving a beard, say). Landmark-based EAR/pose was already being
// computed for every detected face in this codebase (faceMath.ts,
// usePeekDetection.ts's own separate blink/micro-movement liveness tracker
// for the passive detection loop) — the two functions below are the
// missing piece: a single-frame "attention" gate for the deliberate
// owner-verify moment, and a bounded, conservative version of the
// template-adaptation idea.

// usePeekDetection.ts's own blink tracker observes this codebase's EAR
// scale running open ~0.32 → closed ~0.18 (see its earHistoryRef comment).
// 0.20 sits close to "closed" so a slightly narrowed/relaxed eye during
// ordinary use still passes — this only rejects genuinely shut eyes.
const EYES_OPEN_EAR_THRESHOLD = 0.20;
// ~40° off-center — generous. This only rejects "looking away", not
// "not perfectly centered"; matchAgainstOwnerPoseAware's own off-angle
// relaxation (±0.04) is a much tighter frontal bound used for a different
// purpose (matching, not attention).
const ATTENTION_MAX_OFF_CENTER = 0.12;

export interface AttentionResult { attentive: boolean; eyesOpen: boolean; facingCamera: boolean }

/** Single-frame "is this person actually looking at the phone with their
 *  eyes open" check — Face ID's "Require Attention" toggle, applied to the
 *  one frame captured for a manual owner-verify dismiss. */
export const isAttentive = (face: DetectedFace): AttentionResult => {
  const eyesOpen = face.ear >= EYES_OPEN_EAR_THRESHOLD;
  const facingCamera = Math.max(Math.abs(face.pose.yaw), Math.abs(face.pose.pitch)) <= ATTENTION_MAX_OFF_CENTER;
  return { attentive: eyesOpen && facingCamera, eyesOpen, facingCamera };
};

// Enrollment's guided flow already produces 30-40 samples; this leaves
// headroom before FIFO pruning kicks in so adaptation has real room to work
// with before it starts trading away old samples for new ones.
const MAX_ADAPTIVE_EMBEDDINGS = 60;
// Guided enrollment/top-ups may fill at most this many slots; the rest is
// reserved for passive learning so it always has room to work.
const MAX_ANCHORS = 48;
// Passive learning writes the whole sealed profile, so don't do it on every
// single auto-unlock, and don't store near-duplicates of what we already hold.
const ADAPT_MIN_INTERVAL_MS = 30_000;
const ADAPT_DUPLICATE_SIM = 0.985;
let lastAdaptAt = 0;
// Near-miss + stronger-factor learning (Face ID parity): how far below the
// threshold a rejected frame may be and still be learned from.
const STRONG_AUTH_MIN_MARGIN = -0.10;
// How far above the matching threshold a sample must score to be trusted as
// a clean update — a borderline pass is exactly the kind of ambiguous frame
// that must NOT get folded into the reference data, or the profile could
// drift toward whatever borderline face keeps almost-matching.
const ADAPTIVE_MATCH_CONFIDENCE_MARGIN = 0.08;
// Frontal-only for adaptation — tighter than ATTENTION_MAX_OFF_CENTER above,
// matching matchAgainstOwnerPoseAware's own off-angle relaxation bound, so
// only a genuinely centered capture (the most reliable landmarks) ever
// becomes new reference data.
const ADAPTIVE_MAX_OFF_CENTER = 0.04;

/**
 * Face-ID-style continuous template adaptation. Call ONLY after a real
 * owner-verified event (a successful camera-based dismiss) — never from the
 * passive detection loop — so a spoofed or ambiguous frame can never poison
 * the profile. Requires attentive (eyes open, facing camera), frontal, and
 * comfortably-above-threshold in the same frame before accepting it; any
 * one of those failing is a silent no-op, not an error — this is meant to
 * happen unnoticed in the background the way Face ID's own does.
 *
 * Bounded at MAX_ADAPTIVE_EMBEDDINGS: the oldest PASSIVE sample is evicted
 * first and enrollment anchors are protected (`poses` stays index-aligned
 * with `embeddings`). Rate-limited and de-duplicated so storage isn't
 * rewritten on every unlock.
 */
export const maybeAdaptOwnerProfile = async (
  face: DetectedFace,
  owner: OwnerProfile,
  matchScore: number,
  threshold: number,
  opts: { strongAuth?: boolean } = {},
): Promise<void> => {
  const { attentive } = isAttentive(face);
  const offCenter = Math.max(Math.abs(face.pose.yaw), Math.abs(face.pose.pitch));
  // Face ID's second learning path: a near-miss that the user immediately
  // confirms with their passcode/biometric is trusted a little further down.
  // The stronger factor vouches for identity; the attention/pose gates still apply.
  const margin = matchScore - threshold;
  const confidentMargin = opts.strongAuth
    ? margin >= STRONG_AUTH_MIN_MARGIN
    : margin >= ADAPTIVE_MATCH_CONFIDENCE_MARGIN;
  if (!attentive || offCenter > ADAPTIVE_MAX_OFF_CENTER || !confidentMargin) return;

  const nowMs = Date.now();
  if (nowMs - lastAdaptAt < ADAPT_MIN_INTERVAL_MS) return;

  const embeddings = owner.embeddings.map(toF32);
  // Near-duplicate of something already stored → no new information.
  for (const e of embeddings) if (cosineSim(face.embedding, e) > ADAPT_DUPLICATE_SIM) return;

  const poses = owner.poses ? [...owner.poses] : embeddings.map(() => ({ yaw: 0, pitch: 0 }));
  const addedAt = owner.addedAt?.length === embeddings.length
    ? [...owner.addedAt] : embeddings.map(() => owner.enrolledAt);
  let anchorCount = owner.anchorCount ?? embeddings.length;
  embeddings.push(new Float32Array(face.embedding)); // passive samples live after the anchors
  poses.push(face.pose);
  addedAt.push(nowMs);
  anchorCount = evictToCap(embeddings, poses, anchorCount, addedAt);
  lastAdaptAt = nowMs;

  // selfSimFloor is measured on ANCHORS only: letting passive samples lower it
  // would quietly loosen the personalised threshold every time the owner
  // unlocks, a slow security drift.
  const updated: OwnerProfile = {
    embeddings,
    enrolledAt: owner.enrolledAt,
    count: embeddings.length,
    anchorCount,
    selfSimFloor: computeSelfSimFloor(embeddings.slice(0, anchorCount)) ?? owner.selfSimFloor,
    poses,
    addedAt,
  };
  await persistProfile(dropExpiredAdaptive(updated, nowMs));
};

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
