/**
 * faceWorkerClient — main-thread side of faceDetection.worker.ts.
 *
 * Owns a single lazily-created worker, matches responses back to callers by
 * message id, and exposes one async function: detectFacesOffThread(). If
 * Worker or createImageBitmap aren't available (older WebViews),
 * `isWorkerSupported()` returns false and callers should fall back to
 * lib/faceRecognition.ts's main-thread detectFaces().
 */

import type { DetectedFaceRaw } from "@/lib/faceMath";

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (f: DetectedFaceRaw[]) => void; reject: (e: Error) => void }>();

export const isWorkerSupported = (): boolean =>
  typeof Worker !== "undefined" && typeof createImageBitmap === "function";

const getWorker = (): Worker => {
  if (worker) return worker;
  worker = new Worker(new URL("../workers/faceDetection.worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (e: MessageEvent) => {
    const msg = e.data;
    if (!msg || (msg.type !== "result" && msg.type !== "error")) return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.type === "error") p.reject(new Error(msg.message));
    else p.resolve(msg.faces as DetectedFaceRaw[]);
  };
  worker.onerror = (e) => {
    // Fail every in-flight request rather than hanging the peek loop.
    for (const [, p] of pending) p.reject(new Error(e.message || "face worker error"));
    pending.clear();
  };
  return worker;
};

/**
 * Detect faces in a video frame off the main thread. Captures the frame as
 * an ImageBitmap (cheap, GPU-backed where available) and transfers it to
 * the worker — the worker closes the bitmap once it's done with it, so no
 * frame data is ever copied twice.
 */
export const detectFacesOffThread = async (
  video: HTMLVideoElement,
): Promise<DetectedFaceRaw[]> => {
  const bitmap = await createImageBitmap(video);
  const id = nextId++;
  const w = getWorker();
  return new Promise<DetectedFaceRaw[]>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ type: "detect", id, bitmap }, [bitmap]);
  });
};

/** Terminate the worker (e.g. peek guard fully disabled / app backgrounded
 *  for a long time). A new call to detectFacesOffThread() re-spawns it. */
export const teardownFaceWorker = () => {
  if (!worker) return;
  for (const [, p] of pending) p.reject(new Error("face worker torn down"));
  pending.clear();
  worker.terminate();
  worker = null;
};
