/// <reference lib="webworker" />
/**
 * faceDetection.worker — runs MediaPipe FaceLandmarker off the main thread.
 *
 * Why: previously usePeekDetection ran `detectForVideo` on a `setInterval`
 * on the main thread — a ~15-30ms WASM/GPU inference call every tick,
 * competing with React's render loop and any UI animation. Moving it here
 * means detection never drops a frame or janks the lock/blur transition.
 *
 * Also computes a lightweight pixel-texture score (see
 * textureScoreFromCrop() below) for the largest face only, using the raw
 * ImageBitmap before closing it — this is the "not just landmarks"
 * anti-spoof supplement. Read faceMath.ts's textureScoreFromGrayscale()
 * doc comment for its honest limits before trusting it for anything.
 *
 * Protocol (structured-clone / transferable messages):
 *   → { type: "detect", id, bitmap: ImageBitmap, enhance?: boolean }
 *   ← { type: "result", id, faces: SerializedFace[], meta: DetectionMeta }
 *   ← { type: "error",  id, message }
 *   ← { type: "ready" }               (sent once the model finishes loading)
 *
 * Each face's Float32Array embedding is sent back as a Transferable so the
 * ~5.7KB buffer (478*3 floats) is moved, not copied.
 */

import { FilesetResolver, FaceLandmarker } from "@mediapipe/tasks-vision";
import { faceFromLandmarks, textureScoreFromGrayscale, type DetectedFaceRaw } from "@/lib/faceMath";
import {
  lumaStatsFromRgba, planEnhancement, buildEnhanceLut, applyLut, type DetectionMeta,
} from "@/lib/lowLight";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";

interface SerializedFace {
  embedding: Float32Array;
  bbox: { x: number; y: number; w: number; h: number };
  area: number;
  ear: number;
  pose: { yaw: number; pitch: number };
  textureScore?: { laplacianVar: number; lumaStdDev: number } | null;
}

let landmarker: FaceLandmarker | null = null;
let loading: Promise<FaceLandmarker> | null = null;

const getLandmarker = async (): Promise<FaceLandmarker> => {
  if (landmarker) return landmarker;
  if (loading) return loading;
  loading = (async () => {
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    // Try GPU first (OffscreenCanvas-backed WebGL is available in most
    // module workers on modern Chromium/WebView); fall back to CPU if the
    // delegate isn't supported in this worker context.
    try {
      landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
        runningMode: "VIDEO",
        numFaces: 5,
        minFaceDetectionConfidence: 0.6,
        minFacePresenceConfidence: 0.6,
        minTrackingConfidence: 0.5,
      });
    } catch {
      landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
        runningMode: "VIDEO",
        numFaces: 5,
        minFaceDetectionConfidence: 0.6,
        minFacePresenceConfidence: 0.6,
        minTrackingConfidence: 0.5,
      });
    }
    postMessage({ type: "ready" });
    return landmarker;
  })();
  return loading;
};

// Warm the model as soon as the worker spins up so the first real detect()
// call doesn't pay the ~1s model-load cost.
getLandmarker().catch(() => { /* surfaced on first real detect() instead */ });

let tsCounter = 0;

// Lazily-created small OffscreenCanvas, reused across ticks, for the
// texture-score crop. Feature-detected — if OffscreenCanvas isn't
// available in this worker context, textureScore is just always null and
// everything else in the pipeline works exactly as before.
const CROP_SIZE = 48;
let cropCanvas: OffscreenCanvas | null = null;
let cropCtx: OffscreenCanvasRenderingContext2D | null = null;
if (typeof OffscreenCanvas !== "undefined") {
  cropCanvas = new OffscreenCanvas(CROP_SIZE, CROP_SIZE);
  cropCtx = cropCanvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
}

/** Crop `bitmap` to `bbox` (normalized 0-1 coords) and downsample to a
 *  CROP_SIZE×CROP_SIZE grayscale patch. Returns null if OffscreenCanvas isn't
 *  available or the crop would be degenerate (bbox at the very edge of frame,
 *  zero-size, etc). */
const cropGray = (
  bitmap: ImageBitmap,
  bbox: { x: number; y: number; w: number; h: number },
): Float32Array | null => {
  if (!cropCanvas || !cropCtx) return null;
  const sx = Math.max(0, Math.round(bbox.x * bitmap.width));
  const sy = Math.max(0, Math.round(bbox.y * bitmap.height));
  const sw = Math.min(bitmap.width - sx, Math.round(bbox.w * bitmap.width));
  const sh = Math.min(bitmap.height - sy, Math.round(bbox.h * bitmap.height));
  if (sw < 8 || sh < 8) return null;
  try {
    cropCtx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, CROP_SIZE, CROP_SIZE);
    const { data } = cropCtx.getImageData(0, 0, CROP_SIZE, CROP_SIZE);
    const gray = new Float32Array(CROP_SIZE * CROP_SIZE);
    for (let i = 0; i < gray.length; i++) {
      const p = i * 4;
      // Standard luma weights.
      gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    }
    return gray;
  } catch {
    return null; // e.g. a transient decode failure — never worth failing the whole tick over
  }
};

// ── Low-light repair ────────────────────────────────────────────────────────
// A tiny sample canvas measures the frame; only when it's actually dim do we
// pay for a full-frame LUT pass (see lib/lowLight.ts). Capped to ENH_MAX_W so
// the pass stays ~2-4ms even on a 1080p front camera.
const SAMPLE_W = 32;
const SAMPLE_H = 24;
const ENH_MAX_W = 640;
let sampleCanvas: OffscreenCanvas | null = null;
let sampleCtx: OffscreenCanvasRenderingContext2D | null = null;
let enhCanvas: OffscreenCanvas | null = null;
let enhCtx: OffscreenCanvasRenderingContext2D | null = null;
if (typeof OffscreenCanvas !== "undefined") {
  sampleCanvas = new OffscreenCanvas(SAMPLE_W, SAMPLE_H);
  sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
}

/** Returns the bitmap to run detection on (the original, or a brightened copy
 *  the caller must close) plus what we learned about the frame's lighting. */
const prepareFrame = (
  bitmap: ImageBitmap,
  allowEnhance: boolean,
): { image: ImageBitmap; owned: boolean; meanLuma: number; enhanced: boolean; gamma: number } => {
  let meanLuma = 128;
  try {
    if (sampleCtx) {
      sampleCtx.drawImage(bitmap, 0, 0, SAMPLE_W, SAMPLE_H);
      const stats = lumaStatsFromRgba(sampleCtx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data);
      meanLuma = stats.mean;
      const plan = planEnhancement(stats);
      // A near-black frame is a covered lens, not a dark room: amplifying it
      // only produces noise, so leave it alone and let the hook's cover check
      // deal with it.
      if (allowEnhance && plan.enhance && stats.mean >= 4 && typeof OffscreenCanvas !== "undefined") {
        const scale = Math.min(1, ENH_MAX_W / bitmap.width);
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        if (!enhCanvas || enhCanvas.width !== w || enhCanvas.height !== h) {
          enhCanvas = new OffscreenCanvas(w, h);
          enhCtx = enhCanvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
        }
        if (enhCtx && enhCanvas) {
          enhCtx.drawImage(bitmap, 0, 0, w, h);
          const img = enhCtx.getImageData(0, 0, w, h);
          applyLut(img.data, buildEnhanceLut(plan));
          enhCtx.putImageData(img, 0, 0);
          const out = enhCanvas.transferToImageBitmap();
          return { image: out, owned: true, meanLuma, enhanced: true, gamma: plan.gamma };
        }
      }
    }
  } catch {
    /* enhancement is best-effort: fall through to the untouched frame */
  }
  return { image: bitmap, owned: false, meanLuma, enhanced: false, gamma: 1 };
};

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (!msg || msg.type !== "detect") return;
  const { id, bitmap, enhance } = msg as { id: number; bitmap: ImageBitmap; enhance?: boolean };
  let prepared: ReturnType<typeof prepareFrame> | null = null;

  try {
    const lm = await getLandmarker();
    // Monotonic timestamp required by detectForVideo, independent of the
    // main thread's own clock (frames arrive from a postMessage queue).
    tsCounter = Math.max(tsCounter + 1, Math.floor(performance.now()));
    prepared = prepareFrame(bitmap, enhance !== false);
    const result = lm.detectForVideo(prepared.image, tsCounter);

    const faces: SerializedFace[] = [];
    for (const lmList of result.faceLandmarks ?? []) {
      const face: DetectedFaceRaw | null = faceFromLandmarks(lmList as any);
      if (face) faces.push(face);
    }

    // Texture score only for the single largest face, and only while the
    // bitmap is still open — this is the one thing in this file that
    // still needs raw pixels rather than just landmarks. Bounded to one
    // face so a multi-face frame doesn't multiply the crop/convolution cost.
    // Texture + face-brightness read the ORIGINAL bitmap on purpose: the
    // anti-spoof texture heuristic must not see the amplified noise from
    // enhancement, and "how dark is the face really" is a pre-repair fact.
    let faceLuma: number | null = null;
    if (faces.length > 0) {
      const primary = faces.reduce((a, b) => (a.area > b.area ? a : b));
      const gray = cropGray(bitmap, primary.bbox);
      if (gray) {
        primary.textureScore = textureScoreFromGrayscale(gray, CROP_SIZE, CROP_SIZE);
        let sum = 0;
        for (let i = 0; i < gray.length; i++) sum += gray[i];
        faceLuma = sum / gray.length;
      } else {
        primary.textureScore = null;
      }
    }
    const meta: DetectionMeta = {
      meanLuma: prepared.meanLuma, faceLuma, enhanced: prepared.enhanced, gamma: prepared.gamma,
    };
    if (prepared.owned) { try { prepared.image.close(); } catch { /* already closed */ } }
    bitmap.close(); // free GPU/CPU backing memory now that we're done reading it

    const transfer = faces.map((f) => f.embedding.buffer);
    postMessage({ type: "result", id, faces, meta }, transfer as any);
  } catch (err) {
    if (prepared?.owned) { try { prepared.image.close(); } catch { /* already closed */ } }
    try { bitmap.close(); } catch { /* already closed */ }
    postMessage({
      type: "error",
      id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
