// ─── Chat constants ─────────────────────────────────────────────────────────
// Extracted from pages/Chat.tsx (Phase 3 UI/state decomposition) so both
// Chat.tsx and the decomposed presentational components in components/chat/
// share one definition instead of duplicating it.

// Vanish Mode redesign: there is deliberately no duration/TTL concept left
// here anymore. A message sent while Vanish Mode is on carries
// disappear_at = "vanish" (see Chat.tsx) and stays visible for as long as
// the mode itself stays on — it's removed, for both people, the instant
// either side turns the mode off (see endVanishMode in Chat.tsx), not on
// any timer. DISAPPEAR_OPTIONS / DEFAULT_DISAPPEAR_MS previously lived
// here and have been removed along with the per-message countdown UI.
export const VANISH_SENTINEL = "vanish" as const;

// Vanish Mode — "unseen messages survive" fix.
//
// Turning Vanish Mode off used to hard-delete EVERY vanish message in the
// conversation, in both directions, no matter whether the other person had
// opened it yet. A message you sent and your partner never got to see was
// erased from their side (and from the database) the moment you switched
// the mode off.
//
// Now the two states are distinct:
//   "vanish"            — sent while a Vanish session is running. Stays
//                         until that session ends.
//   "vanish_after_seen" — the session that sent it has ENDED, but the
//                         recipient hasn't opened it yet. It is kept so they
//                         actually get to see it, and is deleted (row +
//                         media files) once they have read it and left the
//                         chat.
// Both values are non-timestamps, so every sweep that parses disappear_at
// as a timestamptz must skip them — see migration
// 20260921120000_vanish_after_seen.sql.
export const VANISH_AFTER_SEEN_SENTINEL = "vanish_after_seen" as const;

/** True for either vanish state ("vanish" or "vanish_after_seen"). */
export const isVanishValue = (v: string | null | undefined): boolean =>
  v === VANISH_SENTINEL || v === VANISH_AFTER_SEEN_SENTINEL;
