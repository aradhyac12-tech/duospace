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
