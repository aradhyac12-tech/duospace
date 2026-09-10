/**
 * Partner-identity cache — perf pass (WhatsApp-latency brief, §5).
 *
 * On a cold app start, Chat.tsx's very first useEffect fetches this
 * user's `profiles.partner_id`, then — only once THAT resolves — fetches
 * the partner's display_name/avatar_url. Nothing else in Chat (messages,
 * E2E key exchange, typing, presence, call history) can start until
 * `partnerId` is known, so that round trip sat in front of every other
 * request as a hard sequential dependency.
 *
 * DuoSpace is a fixed-pairing couples app — a signed-in user's partner
 * essentially never changes between one app open and the next (re-pairing
 * is a rare, explicit, user-initiated action). That makes partnerId an
 * ideal candidate for a small persisted cache: correct almost always,
 * cheap to reconcile against the server, and safe to be wrong for the
 * one render before the real fetch resolves, since every consumer here
 * already re-derives its own state from the fresh partnerId once the
 * network call lands (this cache is a head start, not a source of truth).
 *
 * Scoped and validated by userId (localStorage key embeds it, and every
 * read is a straight lookup by the current user's id) so it can never
 * leak one account's partner into a different signed-in account on a
 * shared device — same isolation guarantee messageCache already gives.
 * Not written to at logout because it holds no message content or
 * secrets, only which account this account is paired with, and the
 * next successful fetch after any account switch overwrites it with
 * the correct value before it's ever displayed as fact (it only ever
 * pre-fills state that the real fetch immediately reconciles).
 */
import storage from "@/lib/storage";

export interface CachedPartner {
  partnerId: string;
  partnerName: string;
  partnerAvatar: string | null;
}

const keyFor = (userId: string) => `duo-partner-cache-${userId}`;

export function getCachedPartner(userId: string): CachedPartner | null {
  const cached = storage.getJSON<CachedPartner | null>(keyFor(userId), null);
  if (!cached || !cached.partnerId) return null;
  return cached;
}

export function setCachedPartner(userId: string, data: CachedPartner): void {
  storage.setJSON(keyFor(userId), data);
}
