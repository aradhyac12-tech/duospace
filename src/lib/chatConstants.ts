// ─── Chat constants ─────────────────────────────────────────────────────────
// Extracted from pages/Chat.tsx (Phase 3 UI/state decomposition) so both
// Chat.tsx and the decomposed presentational components in components/chat/
// share one definition instead of duplicating it.

// FIX: disappear delay is now configurable (default 30s)
export const DISAPPEAR_OPTIONS = [
  { label: "10 seconds",  value: 10_000 },
  { label: "30 seconds",  value: 30_000 },
  { label: "5 minutes",   value: 5 * 60_000 },
  { label: "1 hour",      value: 60 * 60_000 },
  { label: "1 day",       value: 24 * 60 * 60_000 },
];
export const DEFAULT_DISAPPEAR_MS = 30_000;
