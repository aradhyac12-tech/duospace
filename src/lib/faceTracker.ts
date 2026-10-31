/**
 * faceTracker — frame-to-frame face tracking with sticky identity.
 *
 * Before this, every detection tick classified every face from scratch:
 * owner vs stranger was decided from a single frame's match score. One noisy
 * frame (motion blur, a dark room, half-turned head) flipped the owner to
 * "stranger" and locked the screen; one lucky frame flipped a stranger to
 * "owner". And because faces had no identity across frames, a stranger who
 * ducked out of view for a single frame looked exactly like a stranger who
 * had left, so the lock could clear the instant they leaned away.
 *
 * The tracker fixes both:
 *   - Detections are associated to tracks (IoU first, centroid distance as a
 *     fallback), so a face keeps one identity while it moves.
 *   - Each track smooths its match *margin* (score - threshold) with an EMA and
 *     applies hysteresis: it takes real evidence to change a track's verdict,
 *     not one frame.
 *   - Tracks that disappear linger as "ghosts" for a short window so callers
 *     can tell "stranger just left frame" from "no stranger was ever here".
 *
 * Pure and DOM-free: no timers, no globals, `now` is always passed in.
 */

export interface BBox { x: number; y: number; w: number; h: number }

export type Verdict = "owner" | "stranger";

export interface TrackObservation {
  bbox: BBox;
  /** matchScore - effectiveThreshold. >= 0 means "looks like the owner". */
  margin: number;
}

export interface Track {
  id: number;
  bbox: BBox;
  verdict: Verdict;
  /** EMA of margin: the smoothed evidence the verdict is based on. */
  marginEma: number;
  hits: number;
  firstSeen: number;
  lastSeen: number;
  /** True when this track was matched in the latest update() call. */
  visible: boolean;
}

export interface FaceTrackerOptions {
  /** Drop a track after it hasn't been seen for this long (ms). */
  maxMissMs?: number;
  /** EMA weight of the newest margin (0..1). */
  alpha?: number;
  /** Margin the EMA must reach to flip stranger -> owner. */
  ownerEnter?: number;
  /** Margin the EMA must fall below (negated) to flip owner -> stranger. */
  ownerExit?: number;
  /** Minimum IoU for an IoU association. */
  minIou?: number;
}

const DEFAULTS: Required<FaceTrackerOptions> = {
  maxMissMs: 900,
  alpha: 0.45,
  ownerEnter: 0.03,
  ownerExit: 0.05,
  minIou: 0.15,
};

export const iou = (a: BBox, b: BBox): number => {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
};

const centerDist = (a: BBox, b: BBox): number =>
  Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.h / 2 - (b.y + b.h / 2));

export class FaceTracker {
  private opts: Required<FaceTrackerOptions>;
  private tracks: Track[] = [];
  private nextId = 1;

  constructor(opts: FaceTrackerOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  reset(): void {
    this.tracks = [];
  }

  /**
   * Feed one frame of observations. Returns the track for each observation,
   * in the same order as `observations`.
   */
  update(observations: TrackObservation[], now: number): Track[] {
    const { alpha, ownerEnter, ownerExit, minIou, maxMissMs } = this.opts;
    const assigned: (Track | null)[] = observations.map(() => null);
    const used = new Set<number>();

    // Greedy association by descending IoU. Face counts are tiny (<= 5), so
    // the O(n*m) pair list is irrelevant next to the detection itself.
    const pairs: { oi: number; ti: number; score: number }[] = [];
    observations.forEach((o, oi) => {
      this.tracks.forEach((t, ti) => {
        const score = iou(o.bbox, t.bbox);
        if (score >= minIou) pairs.push({ oi, ti, score });
      });
    });
    pairs.sort((a, b) => b.score - a.score);
    for (const p of pairs) {
      if (assigned[p.oi] || used.has(p.ti)) continue;
      assigned[p.oi] = this.tracks[p.ti];
      used.add(p.ti);
    }

    // Fallback for fast movement (low IoU between consecutive frames): nearest
    // unused track whose center is within ~1 face-width.
    observations.forEach((o, oi) => {
      if (assigned[oi]) return;
      let best = -1;
      let bestD = Infinity;
      this.tracks.forEach((t, ti) => {
        if (used.has(ti)) return;
        const d = centerDist(o.bbox, t.bbox);
        if (d < Math.max(o.bbox.w, t.bbox.w) && d < bestD) { bestD = d; best = ti; }
      });
      if (best >= 0) { assigned[oi] = this.tracks[best]; used.add(best); }
    });

    for (const t of this.tracks) t.visible = false;

    const out = observations.map((o, oi) => {
      let t = assigned[oi];
      if (!t) {
        // New track: verdict follows the raw sign so a clear stranger still
        // locks on frame one (instant lock is a product requirement).
        t = {
          id: this.nextId++,
          bbox: o.bbox,
          verdict: o.margin >= 0 ? "owner" : "stranger",
          marginEma: o.margin,
          hits: 1,
          firstSeen: now,
          lastSeen: now,
          visible: true,
        };
        this.tracks.push(t);
        return t;
      }
      t.bbox = o.bbox;
      t.hits += 1;
      t.lastSeen = now;
      t.visible = true;
      t.marginEma = t.marginEma * (1 - alpha) + o.margin * alpha;
      // Hysteresis: asymmetric bars so verdicts don't chatter around 0.
      if (t.verdict === "owner" && t.marginEma < -ownerExit) t.verdict = "stranger";
      else if (t.verdict === "stranger" && t.marginEma > ownerEnter) t.verdict = "owner";
      return t;
    });

    this.tracks = this.tracks.filter((t) => now - t.lastSeen <= maxMissMs);
    return out;
  }

  /** Tracks not seen in the latest update but still within the ghost window. */
  ghosts(): Track[] {
    return this.tracks.filter((t) => !t.visible);
  }

  /** True if a stranger track is visible now OR vanished within `withinMs`. */
  strangerRecently(now: number, withinMs: number): boolean {
    return this.tracks.some((t) => t.verdict === "stranger" && now - t.lastSeen <= withinMs);
  }

  snapshot(): readonly Track[] {
    return this.tracks;
  }
}
