/**
 * Build-time guard for `vite build --mode staging` (npm run build:staging).
 *
 * The app deliberately falls back to the PRODUCTION Supabase project when
 * VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY are unset (so production
 * hosts need no configuration). That default is unchanged. But a "staging"
 * test build that forgot its env vars would silently talk to production.
 * In staging mode only, both vars are therefore REQUIRED and must not point
 * at production; otherwise the build fails loudly. Every other mode is
 * untouched.
 */
export const PRODUCTION_REF = "jzlpelxwzjjpddqcrtpu";
export const PRODUCTION_KEY = "sb_publishable_1ZGx52jJok6cITi8Ky3ifQ_TtOErEac";

/** Returns an error message, or null when the build may proceed. */
export function checkStagingEnv(mode, env) {
  if (mode !== "staging") return null;
  const url = env.VITE_SUPABASE_URL ?? "";
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
  if (!url || !key) return "Staging build: set BOTH VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (e.g. in .env.staging). Refusing to fall back to production.";
  if (url.includes(PRODUCTION_REF) || key === PRODUCTION_KEY) return "Staging build: VITE_SUPABASE_URL / key point at PRODUCTION. Refusing.";
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(url)) return `Staging build: VITE_SUPABASE_URL "${url}" is not a Supabase project URL.`;
  return null;
}
