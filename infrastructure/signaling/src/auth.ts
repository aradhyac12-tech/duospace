/**
 * auth — verifies the short-lived signaling TICKET a client presents
 * when opening the signaling WebSocket, and derives the real user id
 * from it (migration brief STEP 6: "Never trust the client-provided
 * user ID. Derive identity from authenticated credentials.").
 *
 * REMEDIATION (P1-7, signaling security audit): this used to verify the
 * client's actual Supabase access token directly, passed as a `?token=`
 * query param — a long-lived session credential ending up in a URL
 * (browser history, proxy/server access logs) rather than a header. The
 * client now instead fetches a short-lived, purpose-scoped ticket from
 * the `signaling-ticket` edge function first (see that function's own
 * doc comment) and passes THAT in the URL. Ticket verification below is
 * the same HS256-against-SUPABASE_JWT_SECRET mechanism as before, plus
 * one added check: `purpose` must be exactly `"duospace-signaling"`,
 * which a real Supabase-issued session token never has (Supabase's own
 * tokens carry `aud: "authenticated"` and no `purpose` claim at all) —
 * so this also closes off a real Supabase token being replayed here
 * even if one leaked.
 *
 * NOT RUNTIME-VERIFIED: no live Supabase project's JWT secret is
 * available in this sandbox to test against. The verification itself
 * (HS256 JWT signature check against SUPABASE_JWT_SECRET) is standard
 * and small enough to hand-roll with `jose` rather than pull in the full
 * supabase-js client just to verify a token server-side — but has not
 * been exercised against a real ticket here.
 *
 * The client attaches the ticket as a `token` query param on the WSS URL
 * (see WebSocketSignalingEngineOptions.url on the frontend) — not a
 * header, since browser WebSocket clients cannot set arbitrary headers
 * on the handshake request. This is exactly why the ticket has to be
 * short-lived and single-purpose rather than just "the token, but in a
 * header instead" — there is no header option for a browser WebSocket
 * handshake, so whatever's used here is unavoidably URL-visible, and
 * the mitigation is making that thing cheap to leak instead of avoiding
 * the URL entirely.
 */
import { jwtVerify } from "jose";

export interface AuthenticatedIdentity {
  userId: string;
}

export class SignalingAuthError extends Error {}

const REQUIRED_PURPOSE = "duospace-signaling";

let cachedSecretKey: Uint8Array | null = null;
function secretKey(): Uint8Array {
  if (!cachedSecretKey) {
    // Must be the SAME value as the signaling-ticket function's
    // SIGNALING_TICKET_SECRET (see that function for why it isn't
    // SUPABASE_JWT_SECRET any more; that name stays as a legacy fallback).
    const secret = process.env.SIGNALING_TICKET_SECRET ?? process.env.SUPABASE_JWT_SECRET;
    if (!secret) throw new SignalingAuthError("SIGNALING_TICKET_SECRET is not configured");
    cachedSecretKey = new TextEncoder().encode(secret);
  }
  return cachedSecretKey;
}

/** Verify a signaling ticket and return the authenticated user id (the
 *  ticket's `sub` claim). Throws SignalingAuthError on any failure —
 *  expired, malformed, wrong signature, missing `sub`, or wrong/missing
 *  `purpose`. Callers must reject the WebSocket upgrade on any thrown
 *  error rather than proceeding with an unauthenticated connection. */
export async function verifyClientToken(token: string): Promise<AuthenticatedIdentity> {
  if (!token) throw new SignalingAuthError("missing token");
  try {
    // No `audience` check here — a signaling-ticket carries no `aud`
    // claim at all (see signaling-ticket/index.ts's payload shape); the
    // `purpose` check below is what actually distinguishes a real
    // ticket from anything else, including a real Supabase session
    // token (which DOES carry `aud: "authenticated"` but never `purpose`).
    const { payload } = await jwtVerify(token, secretKey());
    if (payload.purpose !== REQUIRED_PURPOSE) {
      throw new SignalingAuthError("token is not a valid signaling ticket");
    }
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new SignalingAuthError("token missing sub claim");
    }
    return { userId: payload.sub };
  } catch (err) {
    if (err instanceof SignalingAuthError) throw err;
    throw new SignalingAuthError(`token verification failed: ${(err as Error).message}`);
  }
}
