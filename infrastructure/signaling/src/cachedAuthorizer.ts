/**
 * CachedCallAuthorizer — an optional Redis-backed layer in front of the
 * Supabase `signaling_get_call_facts` RPC.
 *
 * WHAT IS (AND IS NOT) CACHED — deliberately narrow, because this sits on the
 * call-authorization path:
 *
 *   • ONLY facts for calls that have reached a FINAL status
 *     (completed / failed / cancelled). A call never leaves those states, so the
 *     cached answer can never be stale in a way that matters: the gateway refuses
 *     every control message for them (CALL_TERMINAL) whether the facts came from
 *     Redis or Postgres. Late stragglers (duplicate hang-ups, ICE after end,
 *     reconnecting clients re-resolving a finished call) are the repeated lookups
 *     this removes from the database.
 *   • NOTHING for a live call (in_progress): CALL_ACCEPTED must see the CURRENT
 *     `claimed_by` (the atomic claim is the source of truth), so live-call facts
 *     always come from the database.
 *   • Nothing for "unknown call" (null) — a call row can appear a moment after a
 *     message that references it; a negative cache entry would turn that race
 *     into a permanent UNKNOWN_CALL.
 *   • `missed` / `seen` are NOT cached either (`seen` follows `missed`, and the
 *     `declined` flag can differ) — only states with no further transitions.
 *
 * Fail-open: any cache error (down, slow, corrupt entry) falls straight through
 * to the inner authorizer. The cache can only ever save a query, never change an
 * authorization decision.
 */
import { UUID_RE } from "./types.js";
import type { CallAuthorizer, CallFacts } from "./authorizer.js";
import type { CacheStore } from "./redisCache.js";

/** Statuses with no further transitions. Everything else is always read live. */
export const FINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

export interface CachedAuthorizerOptions {
  /** TTL for final-call facts. Default 1 hour (calls this old are never touched again). */
  ttlSeconds?: number;
  /** Key namespace — bump the version if CallFacts' shape ever changes. */
  prefix?: string;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface AuthorizerCacheStats { hits: number; misses: number; stores: number; errors: number }

/** Strict shape check for a cached entry; anything unexpected is treated as a miss. */
export function parseCachedFacts(raw: string, callId: string): CallFacts | null {
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  const s = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  if (r.callId !== callId) return null;
  if (!s(r.callerId) || !UUID_RE.test(r.callerId) || !s(r.receiverId) || !UUID_RE.test(r.receiverId)) return null;
  if (!s(r.provider) || !s(r.status) || !FINAL_STATUSES.has(r.status) || !s(r.sessionId)) return null;
  if (r.claimedBy !== null && !s(r.claimedBy)) return null;
  if (r.expiresAt !== null && typeof r.expiresAt !== "number") return null;
  if (r.callType !== "voice" && r.callType !== "video") return null;
  if (typeof r.declined !== "boolean" || typeof r.arePartners !== "boolean") return null;
  return {
    callId, callerId: r.callerId, receiverId: r.receiverId, provider: r.provider, status: r.status,
    claimedBy: (r.claimedBy as string | null), sessionId: r.sessionId, expiresAt: (r.expiresAt as number | null),
    callType: r.callType, declined: r.declined, arePartners: r.arePartners,
  };
}

export class CachedCallAuthorizer implements CallAuthorizer {
  private readonly ttl: number;
  private readonly prefix: string;
  private readonly log: (event: string, data: Record<string, unknown>) => void;
  readonly stats: AuthorizerCacheStats = { hits: 0, misses: 0, stores: 0, errors: 0 };

  constructor(
    private readonly inner: CallAuthorizer,
    private readonly store: CacheStore,
    opts: CachedAuthorizerOptions = {},
  ) {
    this.ttl = opts.ttlSeconds ?? 3600;
    this.prefix = opts.prefix ?? "duo:sig:facts:v1:";
    this.log = opts.log ?? (() => {});
  }

  async getCallFacts(callId: string): Promise<CallFacts | null> {
    // Never build a cache key from anything that isn't a UUID.
    if (!UUID_RE.test(callId)) return this.inner.getCallFacts(callId);
    const key = this.prefix + callId;

    try {
      const raw = await this.store.get(key);
      if (raw) {
        const cached = parseCachedFacts(raw, callId);
        if (cached) { this.stats.hits += 1; return cached; }
        void this.store.del(key).catch(() => {}); // corrupt entry: drop it, fall through
      }
    } catch { this.stats.errors += 1; }
    this.stats.misses += 1;

    const facts = await this.inner.getCallFacts(callId); // AuthorizerUnavailableError propagates unchanged
    if (facts && FINAL_STATUSES.has(facts.status)) {
      this.stats.stores += 1;
      void this.store.set(key, JSON.stringify(facts), this.ttl).catch(() => { this.stats.errors += 1; });
    }
    return facts;
  }
}
