/**
 * livekitAuthz — the pure authorization decision behind `livekit-token`,
 * extracted so it is unit-testable (src/test/livekitTokenAuthz.test.ts)
 * without a Deno runtime, a Supabase project, or a LiveKit server. It
 * touches no Deno globals and does no I/O.
 *
 * CALLING PHASE 4. What this fixes versus the previous inline checks:
 *
 *  1. ROOM IS DERIVED, NEVER STORED-AS-TRUSTED. The old code minted a
 *     token for `call_history.room_name`, a value the CALLER chooses at
 *     INSERT (frozen afterwards, but arbitrary). A caller could therefore
 *     insert a row whose room_name was any string — including the room of
 *     someone else's live call — and be handed a token for it. The room
 *     is now `duo-call-<callId>`, computed here from the call's own id;
 *     the stored room_name is ignored entirely. This is the same
 *     derivation the signaling gateway puts in CALL_OFFER (gateway.ts
 *     roomNameForCall) and the client uses (src/lib/callEngine/roomName.ts);
 *     src/test/signalingProtocolParity.test.ts fails if the three drift.
 *  2. PROVIDER. Only provider='self_hosted' calls get a LiveKit token — a
 *     the call engine call's row must never open a LiveKit room.
 *  3. CLAIM. The RECEIVER gets a token only after winning claim_call()
 *     (claimed_by = them). Before that they are merely being rung; a
 *     token then would let a device join (and listen to) a call the user
 *     never accepted. The CALLER may join while the call is still
 *     ringing (they pre-join the room so audio is ready the moment the
 *     callee arrives), but not once the ring window has lapsed.
 *  4. ACTIVE ONLY. status must be in_progress (unchanged from REMEDIATION
 *     P1-11) — no historical tokens.
 *
 * Authentication (who `userId` is) stays in the edge function: it comes
 * from the verified Supabase JWT, never from the request body.
 */

export const LIVEKIT_ROOM_PREFIX = "duo-call-";

export function livekitRoomNameForCall(callId: string): string {
  return `${LIVEKIT_ROOM_PREFIX}${callId}`;
}

export interface LiveKitCallRow {
  id: string;
  caller_id: string;
  receiver_id: string;
  provider?: string | null;
  status: string;
  claimed_by?: string | null;
  /** ISO timestamp of the ring-window end (call_history.expires_at). */
  expires_at?: string | null;
  /** From signaling_get_call_facts: the receiver declined (declined_at set). */
  declined?: boolean | null;
  /** From signaling_get_call_facts: caller and receiver are CURRENTLY mutual
   *  partners (profiles.partner_id both ways). Missing = NOT partners
   *  (fail closed). */
  are_partners?: boolean | null;
}

export type LiveKitAuthzResult =
  | { ok: true; role: "caller" | "receiver"; roomName: string }
  | { ok: false; httpStatus: 403 | 404 | 409; code: string; error: string };

const deny = (httpStatus: 403 | 404 | 409, code: string, error: string): LiveKitAuthzResult =>
  ({ ok: false, httpStatus, code, error });

export function authorizeLiveKitToken(input: {
  userId: string;
  call: LiveKitCallRow | null | undefined;
  /** ms epoch; injectable for tests. */
  now?: number;
}): LiveKitAuthzResult {
  const { userId, call } = input;
  const now = input.now ?? Date.now();

  if (!call) return deny(404, "room_unavailable", "Call not found");

  const role = call.caller_id === userId ? "caller" : call.receiver_id === userId ? "receiver" : null;
  if (!role) return deny(403, "not_a_participant", "Not authorized for this call");

  if (call.provider !== "self_hosted") {
    return deny(409, "wrong_provider", "This call does not use self-hosted calling");
  }
  // A relationship that ended after the call row was created must not get
  // media access (fail closed when unknown).
  if (call.are_partners !== true) {
    return deny(403, "not_partners", "You can only call your current partner");
  }
  if (call.status !== "in_progress" || call.declined === true) {
    return deny(409, "room_unavailable", "This call is no longer active");
  }

  if (role === "receiver" && call.claimed_by !== userId) {
    return deny(403, "not_claimed", "Accept the call before joining it");
  }
  if (role === "caller" && !call.claimed_by && call.expires_at) {
    const expires = Date.parse(call.expires_at);
    if (Number.isFinite(expires) && expires <= now) {
      return deny(409, "ring_expired", "This call is no longer ringing");
    }
  }

  return { ok: true, role, roomName: livekitRoomNameForCall(call.id) };
}
