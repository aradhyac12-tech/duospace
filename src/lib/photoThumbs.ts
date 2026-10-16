import { isOnlineNow } from "@/lib/connectivity";
/**
 * Photo thumbnails for chat bubbles.
 *
 * WHY: photos are sent at ORIGINAL quality on purpose (see Chat.tsx
 * attemptSendMedia), so a bubble used to hand the WebView the full 12 MP –
 * 200 MP original just to paint a ~250 px box. Every visible/lazy photo kept a
 * fully decoded bitmap alive (tens of MB each), which is what made long chats
 * with many photos stutter and the whole phone feel heavy afterwards.
 *
 * WHAT: a bubble now shows a small (≤ THUMB_WIDTH px wide, WebP) copy made
 * on-device. The original is untouched: tapping the photo opens the full
 * original in PhotoViewer, and saving/downloading uses the original file.
 * `createImageBitmap(blob, { resizeWidth })` lets the browser decode straight
 * to the small size instead of decoding the whole image first.
 *
 * BOUNDS: at most MAX_ACTIVE thumbnails are generated at once, results are
 * kept in a small LRU (blob: URLs revoked a while after eviction so an <img>
 * that is still mounted never goes blank), and anything that can't be
 * thumbnailed (GIF/SVG, tiny files, decode errors) just falls back to the
 * original exactly like before.
 */
const THUMB_WIDTH = 720;
const SMALL_ENOUGH_BYTES = 180 * 1024; // already light — use the original
const MAX_ACTIVE = 2;
const MAX_ENTRIES = 160;
const REVOKE_DELAY_MS = 60_000;

const ready = new Map<string, string>();               // key -> thumb blob: URL (insertion order = LRU)
const inFlight = new Map<string, Promise<string | null>>();
const noThumb = new Set<string>();                      // key -> use the original
let active = 0;
const waiting: Array<() => void> = [];

const acquire = (): Promise<void> =>
  active < MAX_ACTIVE ? (active++, Promise.resolve()) : new Promise((res) => waiting.push(() => { active++; res(); }));
const release = () => { active--; waiting.shift()?.(); };

/** Synchronous lookup (marks the entry as recently used). */
export function peekThumb(key: string): string | null {
  const url = ready.get(key);
  if (!url) return null;
  ready.delete(key); ready.set(key, url);
  return url;
}

export const hasNoThumb = (key: string) => noThumb.has(key);

const remember = (key: string, url: string) => {
  ready.set(key, url);
  while (ready.size > MAX_ENTRIES) {
    const oldest = ready.keys().next().value as string | undefined;
    if (!oldest) break;
    const old = ready.get(oldest);
    ready.delete(oldest);
    if (old) setTimeout(() => { try { URL.revokeObjectURL(old); } catch { /* ignore */ } }, REVOKE_DELAY_MS);
  }
};

const toWebp = async (bmp: ImageBitmap): Promise<Blob | null> => {
  if (typeof OffscreenCanvas !== "undefined") {
    try {
      const oc = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = oc.getContext("2d");
      if (ctx) {
        ctx.drawImage(bmp, 0, 0);
        return await oc.convertToBlob({ type: "image/webp", quality: 0.8 });
      }
    } catch { /* fall through to the DOM canvas */ }
  }
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width; canvas.height = bmp.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bmp, 0, 0);
  const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/webp", 0.8));
  canvas.width = 0; canvas.height = 0; // release the backing store right away
  return out;
};

const idle = (): Promise<void> =>
  new Promise((res) => {
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(() => res(), { timeout: 400 }); else setTimeout(res, 16);
  });

/**
 * Resolve a thumbnail for `key` (use the message id) built from `src`.
 * Resolves null when the original should be used instead.
 */
export function getThumb(key: string, src: string): Promise<string | null> {
  const hit = peekThumb(key);
  if (hit) return Promise.resolve(hit);
  if (noThumb.has(key)) return Promise.resolve(null);
  const running = inFlight.get(key);
  if (running) return running;
  // OFFLINE: a network URL can't be fetched — settle immediately (NOT marked
  // permanent, so the thumbnail is built once the connection is back) instead
  // of leaving the placeholder pulsing until the OS gives up on the socket.
  if (/^https?:/i.test(src) && !isOnlineNow()) return Promise.resolve(null);

  const job = (async () => {
    await acquire();
    try {
      await idle();
      if (typeof createImageBitmap !== "function") { noThumb.add(key); return null; }
      // Bounded: a dead connection must end in "use the original", not hang.
      const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), 12_000) : null;
      let res: Response;
      try { res = await fetch(src, ctl ? { signal: ctl.signal } : undefined); }
      finally { if (timer) clearTimeout(timer); }
      if (!res.ok) return null; // transient — don't mark permanent
      const blob = await res.blob();
      if (!blob.type.startsWith("image/") || blob.type === "image/gif" || blob.type === "image/svg+xml" || blob.size < SMALL_ENOUGH_BYTES) {
        noThumb.add(key);
        return null;
      }
      const bmp = await createImageBitmap(blob, { resizeWidth: THUMB_WIDTH, resizeQuality: "medium" });
      try {
        const out = await toWebp(bmp);
        if (!out || out.size >= blob.size) { noThumb.add(key); return null; }
        const url = URL.createObjectURL(out);
        remember(key, url);
        return url;
      } finally {
        bmp.close?.();
      }
    } catch {
      noThumb.add(key); // undecodable here — original it is
      return null;
    } finally {
      release();
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, job);
  return job;
}

/** Drop everything (sign-out / Vanish cleanup). */
export function clearPhotoThumbs(): void {
  ready.forEach((u) => { try { URL.revokeObjectURL(u); } catch { /* ignore */ } });
  ready.clear(); noThumb.clear();
}
