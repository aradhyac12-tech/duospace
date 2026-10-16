/**
 * Deferred QR partner linking.
 *
 * Two QR flows can't link two people on the spot because one of them has no
 * account yet when the QR is scanned:
 *
 *   - "anon_signup":   this device showed a QR while signed OUT, and a signed-in
 *                      partner scanned it.
 *   - "signup_invite": this device scanned a signed-in partner's invite QR while
 *                      signed OUT (it was sent to the Sign Up tab).
 *
 * In both, the raw QR token is the proof that "this device is the one that took
 * part in that scan". The device remembers it here, and as soon as it has a
 * session it hands the token to the `claim_qr_partner_link` RPC, which links the
 * caller to whoever the scan recorded.
 *
 * (Before this existed, Auth.tsx called `complete_qr_pending_link` /
 * `link_partners` right after signUp() — with "Confirm email" on there is no
 * session yet, so both calls ran as `anon` and were silently refused, and the
 * first one looked the row up by the wrong column anyway. Nobody was ever linked
 * although the screens said "Linked ✓".)
 */
import storage from "@/lib/storage";
import { supabase } from "@/integrations/supabase/appClient";
import { setCachedPartner } from "@/lib/partnerCache";

const KEY = "duo-pending-qr-claim";
/** Matches the server's 48h window in claim_qr_partner_link(). */
export const CLAIM_MAX_AGE_MS = 48 * 60 * 60 * 1000;

interface StoredClaim {
  token: string;
  at: number;
}

export function rememberQrClaim(token: string, now: number = Date.now()): void {
  if (!token) return;
  storage.setJSON(KEY, { token, at: now } satisfies StoredClaim);
}

export function readQrClaim(now: number = Date.now()): StoredClaim | null {
  const c = storage.getJSON<StoredClaim | null>(KEY, null);
  if (!c || typeof c.token !== "string" || typeof c.at !== "number") return null;
  if (now - c.at > CLAIM_MAX_AGE_MS) {
    storage.remove(KEY);
    return null;
  }
  return c;
}

export function clearQrClaim(): void {
  storage.remove(KEY);
}

export type ClaimOutcome =
  | { status: "none" }
  | { status: "linked"; partnerId: string }
  | { status: "failed"; reason: string }   // definitive: don't retry, claim discarded
  | { status: "retry" };                   // transient: keep the claim, try again later

/** Server error codes after which retrying can never succeed. */
const DEFINITIVE = new Set([
  "NOTHING_TO_LINK", "EXPIRED", "NO_PARTNER_SCANNED", "SELF",
  "ALREADY_CLAIMED", "ALREADY_LINKED", "PROFILE_MISSING", "INVALID_TOKEN",
]);

const REASONS: Record<string, string> = {
  NOTHING_TO_LINK: "That QR code can't be used to link any more.",
  EXPIRED: "That QR code expired before the link could finish. Scan again.",
  NO_PARTNER_SCANNED: "Nobody signed in scanned that QR code. Ask your partner to scan it again after they sign in.",
  SELF: "That QR code was scanned from your own account.",
  ALREADY_CLAIMED: "That QR code was already used.",
  ALREADY_LINKED: "One of you is already linked with someone else. Unlink first, then try again.",
  PROFILE_MISSING: "Your profile isn't ready yet. Finish setup, then link from Settings.",
  INVALID_TOKEN: "That QR code isn't valid.",
};

/** Pure: turn the RPC's `{ data, error }` into an outcome. Exported for tests. */
export function interpretClaimResponse(
  data: unknown,
  error: { message?: string } | null,
): ClaimOutcome {
  if (error) return { status: "retry" }; // network / server hiccup — keep the claim
  const d = (data ?? {}) as { success?: boolean; partner_id?: string; error?: string };
  if (d.success && d.partner_id) return { status: "linked", partnerId: d.partner_id };
  const code = d.error ?? "";
  if (code === "NOT_SIGNED_IN") return { status: "retry" };
  if (DEFINITIVE.has(code)) return { status: "failed", reason: REASONS[code] ?? "Couldn't link." };
  return { status: "retry" };
}

let inFlight: Promise<ClaimOutcome> | null = null;

/**
 * If this device is holding a remembered QR token, try to turn it into a real
 * partner link. Safe to call on every launch / sign-in: a no-op when there is
 * nothing pending, and de-duplicated while a claim is running.
 */
export function claimPendingQrPartnerLink(userId: string): Promise<ClaimOutcome> {
  if (inFlight) return inFlight;
  const claim = readQrClaim();
  if (!claim) return Promise.resolve({ status: "none" });

  inFlight = (async (): Promise<ClaimOutcome> => {
    try {
      const { data, error } = await supabase.rpc("claim_qr_partner_link", { _token: claim.token });
      const outcome = interpretClaimResponse(data, error as { message?: string } | null);
      if (outcome.status === "linked") {
        clearQrClaim();
        // A previous "no partner" answer may be cached; refresh what Chat pre-fills from.
        try {
          const { data: prof } = await supabase
            .from("profiles")
            .select("display_name, avatar_url")
            .eq("user_id", outcome.partnerId)
            .maybeSingle();
          setCachedPartner(userId, {
            partnerId: outcome.partnerId,
            partnerName: (prof as { display_name?: string | null } | null)?.display_name || "Partner",
            partnerAvatar: (prof as { avatar_url?: string | null } | null)?.avatar_url ?? null,
          });
        } catch { /* cosmetic — Chat re-fetches the real values anyway */ }
      } else if (outcome.status === "failed") {
        clearQrClaim();
      }
      return outcome;
    } catch {
      return { status: "retry" };
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
