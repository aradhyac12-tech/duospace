/**
 * faceMath — pure landmark math with zero DOM dependencies.
 *
 * Extracted out of faceRecognition.ts so the exact same embedding / EAR /
 * pose computation can run both on the main thread (enrollment, which reads
 * an <img>/<canvas>) and inside faceDetection.worker.ts (peek-guard's hot
 * path, which only ever sees an ImageBitmap). Keeping one implementation
 * guarantees the two pipelines produce numerically identical embeddings —
 * an owner enrolled via the main thread must match against candidates
 * scored in the worker.
 */

export interface RawLandmark { x: number; y: number; z: number }

export interface DetectedFaceRaw {
  embedding: Float32Array;
  bbox: { x: number; y: number; w: number; h: number };
  area: number;
  ear: number;
  pose: { yaw: number; pitch: number };
  /**
   * Pixel-level texture stats from the face crop — a weak, unvalidated
   * anti-spoof supplement, not a real spoof detector. null when not
   * computed (main-thread fallback path never computes this — see
   * faceDetection.worker.ts's textureScoreFromCrop() for the only place
   * it's actually populated, and its doc comment for the honest limits).
   */
  textureScore?: { laplacianVar: number; lumaStdDev: number } | null;
}

/**
 * Centering on landmark 1 (nose tip) + scaling by distance(left-eye, right-eye)
 * makes the vector translation/scale invariant. Identity-stable across
 * head poses within ~30°.
 */
export const buildEmbedding = (landmarks: RawLandmark[]): Float32Array => {
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

export const bboxFromLandmarks = (landmarks: { x: number; y: number }[]) => {
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

// Left eye:  outer 33, inner 133, top 159, bottom 145
// Right eye: outer 263, inner 362, top 386, bottom 374
export const computeEAR = (lm: { x: number; y: number }[]): number => {
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);
  const leftEAR  = dist(lm[159], lm[145]) / (dist(lm[33], lm[133])  || 1);
  const rightEAR = dist(lm[386], lm[374]) / (dist(lm[263], lm[362]) || 1);
  return (leftEAR + rightEAR) / 2;
};

// Coarse pose proxy — yaw from nose vs midpoint of outer eyes; pitch from
// nose vs midpoint of (forehead 10) and (chin 152). Good enough for
// "did the head move at all" liveness, no full PnP needed.
export const computePose = (lm: { x: number; y: number }[]): { yaw: number; pitch: number } => {
  const nose = lm[1];
  const eyeMidX = (lm[33].x + lm[263].x) / 2;
  const yaw = nose.x - eyeMidX;
  const vertMidY = (lm[10].y + lm[152].y) / 2;
  const pitch = nose.y - vertMidY;
  return { yaw, pitch };
};

/**
 * Laplacian-variance + luminance-std-dev texture stats from a small
 * grayscale patch. Both are classic, cheap "is this a flat/blurry image"
 * signals — commonly used for blur detection, repurposed here as a very
 * rough anti-spoof supplement: a printed photo (especially a lower-
 * quality print) or a photo-of-a-photo often reads flatter/smoother than
 * real skin under ambient light, which has natural micro-texture (pores,
 * sensor noise) and shading variation from actual 3D structure (nose
 * bridge, cheekbones).
 *
 * HONEST LIMITS — this is not real anti-spoofing:
 *  - It does NOT catch screen/tablet replay attacks well. A screen
 *    showing a sharp photo can have just as much (or more, via moiré)
 *    high-frequency texture as real skin — moiré is a genuine frequency-
 *    domain artifact that needs an FFT-based check to detect properly,
 *    which this is not.
 *  - It does NOT catch a good-quality, well-lit printed photo — only
 *    catches the flat/blurry/low-quality end of that spectrum.
 *  - Thresholds for "suspiciously flat" are NOT calibrated against real
 *    devices/lighting in this codebase — see the caller in
 *    faceDetection.worker.ts for the current placeholder values and why
 *    they're deliberately given low weight until real-device tuning
 *    happens.
 *
 * @param gray grayscale pixel values, row-major, length === width*height
 */
export const textureScoreFromGrayscale = (
  gray: Uint8ClampedArray | Float32Array,
  width: number,
  height: number,
): { laplacianVar: number; lumaStdDev: number } => {
  // Luminance std-dev over the whole patch.
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  const mean = sum / gray.length;
  let variance = 0;
  for (let i = 0; i < gray.length; i++) { const d = gray[i] - mean; variance += d * d; }
  const lumaStdDev = Math.sqrt(variance / gray.length);

  // Laplacian (edge-response) variance — high variance means lots of
  // real local contrast changes (texture/edges); low variance means a
  // smooth/flat patch.
  const lap: number[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const val =
        -4 * gray[i] + gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width];
      lap.push(val);
    }
  }
  let lapMean = 0;
  for (const v of lap) lapMean += v;
  lapMean /= Math.max(1, lap.length);
  let lapVar = 0;
  for (const v of lap) { const d = v - lapMean; lapVar += d * d; }
  lapVar /= Math.max(1, lap.length);

  return { laplacianVar: lapVar, lumaStdDev };
};

/** Build a full DetectedFaceRaw from one face's raw landmark list. Shared by
 *  both the main-thread and worker detection paths so results are identical. */
export const faceFromLandmarks = (lmList: RawLandmark[]): DetectedFaceRaw | null => {
  if (!lmList || lmList.length < 400) return null; // need enough points for EAR/pose
  const bb = bboxFromLandmarks(lmList);
  return {
    embedding: buildEmbedding(lmList),
    bbox: { x: bb.x, y: bb.y, w: bb.w, h: bb.h },
    area: bb.area,
    ear: computeEAR(lmList),
    pose: computePose(lmList),
  };
};
