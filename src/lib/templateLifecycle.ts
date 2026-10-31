/**
 * templateLifecycle — expiry for passively-learned face samples.
 *
 * Apple's Face ID security guide: samples learned during normal use are used
 * "for a finite number of additional matches before that data is discarded",
 * and a learned sample is dropped if the user stops matching against it. That
 * keeps the template tracking gradual change (beard, glasses, makeup) without
 * a one-off lookalike frame living in it forever.
 *
 * We approximate "finite number of matches" with an age limit: anything
 * learned passively and older than ADAPT_TTL_MS is dropped. Anchors (guided
 * enrollment samples, the first `anchorCount` entries) never expire.
 * Samples that keep being re-learned stay young, so a persistent change
 * (a beard you keep) sticks; a transient one fades out.
 */

export const ADAPT_TTL_MS = 45 * 24 * 60 * 60 * 1000;

export interface LifecycleProfile {
  embeddings: unknown[];
  poses?: { yaw: number; pitch: number }[];
  /** Per-sample creation time (ms), index-aligned with embeddings. */
  addedAt?: number[];
  anchorCount?: number;
  count: number;
}

export function dropExpiredAdaptive<T extends LifecycleProfile>(p: T, now = Date.now(), ttl = ADAPT_TTL_MS): T {
  const n = p.embeddings.length;
  const added = p.addedAt;
  if (!added || added.length !== n) return p; // legacy profile: no timestamps, nothing to expire
  const anchors = p.anchorCount ?? n;
  const keep: number[] = [];
  for (let i = 0; i < n; i++) if (i < anchors || now - added[i] <= ttl) keep.push(i);
  if (keep.length === n) return p;
  return {
    ...p,
    embeddings: keep.map((i) => p.embeddings[i]),
    poses: p.poses ? keep.map((i) => p.poses![i]) : undefined,
    addedAt: keep.map((i) => added[i]),
    count: keep.length,
    anchorCount: anchors,
  };
}
