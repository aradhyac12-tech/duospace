/**
 * authorizer — how the signaling gateway learns the REAL facts about a
 * call, instead of trusting whatever a client's message claims.
 *
 * The gateway never believes client-supplied senderId / recipientId /
 * roomName / provider / call state. It asks a CallAuthorizer for the
 * authoritative CallFacts (who the caller and receiver actually are,
 * which provider owns the call, whether the two are currently partners,
 * the call's persisted status/claim, and its authoritative sessionId) and
 * checks every message against them.
 *
 * The production implementation (SupabaseRpcCallAuthorizer) calls ONE
 * narrow SECURITY DEFINER RPC, `signaling_get_call_facts`, created by
 * supabase/migrations/20260920130000_signaling_call_facts_and_session_id.sql.
 * That RPC is executable by service_role only, returns only the handful of
 * columns needed for routing, and computes the partner check itself from
 * the existing `profiles.partner_id` model — there is deliberately no
 * second, parallel relationship system here (brief STEP 11: "Do not
 * create a second incompatible relationship system").
 *
 * Secrets: the service-role key lives ONLY in this server's environment
 * (SUPABASE_SERVICE_ROLE_KEY). It is never sent to a client, and this
 * process never exposes a way to make it run arbitrary queries — only
 * that one RPC by id.
 *
 * NOT RUNTIME-VERIFIED against a live Supabase project (none reachable
 * from the environment this was written in) — the request/response shape
 * below is the contract the migration's function was written to, and
 * parseCallFacts() is unit-tested against it.
 */
import { UUID_RE, type ServerCallState } from "./types.js";

export interface CallFacts {
  callId: string;
  callerId: string;
  receiverId: string;
  /** call_history.provider — only "self_hosted" calls may use this gateway. */
  provider: string;
  /** call_history.status (in_progress | completed | cancelled | missed | failed | seen). */
  status: string;
  /** call_history.claimed_by — set atomically by claim_call() on accept. */
  claimedBy: string | null;
  /** call_history.session_id — DB-generated, frozen at insert. */
  sessionId: string;
  /** ms epoch of call_history.expires_at (the 40s ring window), or null. */
  expiresAt: number | null;
  callType: "voice" | "video";
  /** call_history.declined_at IS NOT NULL. */
  declined: boolean;
  /** Both directions of profiles.partner_id agree, right now. */
  arePartners: boolean;
}

export class AuthorizerUnavailableError extends Error {}

export interface CallAuthorizer {
  /** Resolve authoritative facts for a call. `null` = no such call.
   *  Throws AuthorizerUnavailableError when the backing store can't be
   *  reached — the gateway then fails CLOSED with a retryable reason. */
  getCallFacts(callId: string): Promise<CallFacts | null>;
}

/** Defensive parse of the RPC's JSON. Returns null for `found:false` or a
 *  shape that doesn't satisfy the contract (treated as unknown call). */
export function parseCallFacts(raw: unknown): CallFacts | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.found === false) return null;
  const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  if (!str(r.id) || !UUID_RE.test(r.id)) return null;
  if (!str(r.caller_id) || !UUID_RE.test(r.caller_id)) return null;
  if (!str(r.receiver_id) || !UUID_RE.test(r.receiver_id)) return null;
  if (!str(r.provider) || !str(r.status) || !str(r.session_id)) return null;
  const claimedBy = str(r.claimed_by) ? r.claimed_by : null;
  const expires = typeof r.expires_at === "string" ? Date.parse(r.expires_at) : NaN;
  return {
    callId: r.id,
    callerId: r.caller_id,
    receiverId: r.receiver_id,
    provider: r.provider,
    status: r.status,
    claimedBy,
    sessionId: r.session_id,
    expiresAt: Number.isFinite(expires) ? expires : null,
    callType: r.call_type === "voice" ? "voice" : "video",
    declined: r.declined === true,
    arePartners: r.are_partners === true,
  };
}

/** Map persisted facts to the server's ephemeral state vocabulary. */
export function initialStateFromFacts(f: CallFacts, now: number): ServerCallState {
  switch (f.status) {
    case "in_progress":
      if (f.claimedBy) return "ACCEPTED";
      if (f.expiresAt !== null && f.expiresAt <= now) return "TIMED_OUT";
      return "RINGING";
    case "completed":
    case "failed":
      return "ENDED";
    case "cancelled":
      return "CANCELLED";
    case "missed":
    case "seen":
      return f.declined ? "REJECTED" : "TIMED_OUT";
    default:
      // Unknown persisted status: refuse to treat the call as live.
      return "ENDED";
  }
}

export interface SupabaseRpcCallAuthorizerOptions {
  /** https://<project>.supabase.co */
  supabaseUrl: string;
  /** SERVICE ROLE key — server-side only. */
  serviceRoleKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class SupabaseRpcCallAuthorizer implements CallAuthorizer {
  private readonly url: string;
  private readonly key: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SupabaseRpcCallAuthorizerOptions) {
    this.url = `${opts.supabaseUrl.replace(/\/+$/, "")}/rest/v1/rpc/signaling_get_call_facts`;
    this.key = opts.serviceRoleKey;
    this.timeoutMs = opts.timeoutMs ?? 3_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async getCallFacts(callId: string): Promise<CallFacts | null> {
    if (!UUID_RE.test(callId)) return null; // never interpolate/forward a non-uuid
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: this.key,
          Authorization: `Bearer ${this.key}`,
        },
        body: JSON.stringify({ _call_id: callId }),
        signal: controller.signal,
      });
      if (!res.ok) throw new AuthorizerUnavailableError(`facts rpc http ${res.status}`);
      return parseCallFacts(await res.json());
    } catch (err) {
      if (err instanceof AuthorizerUnavailableError) throw err;
      throw new AuthorizerUnavailableError(`facts rpc failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
