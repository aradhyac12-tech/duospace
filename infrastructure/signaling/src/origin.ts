/**
 * origin — WebSocket upgrade Origin policy for the signaling gateway.
 *
 * The signaling ticket is the real authentication; the Origin allowlist is
 * defence in depth against other websites opening sockets from a signed-in
 * browser. Previously an EMPTY SIGNALING_ALLOWED_ORIGINS silently allowed
 * every origin, in production too. Now:
 *
 *   - production (NODE_ENV=production) with an empty list → refuse to start;
 *   - "*" is an explicit, deliberate "allow any origin" (logged as a warning);
 *   - development with an empty list → allow any (local testing), warned.
 *
 * Capacitor WebView origins must be listed explicitly:
 *   Android (Capacitor 6+, androidScheme https)  → https://localhost
 *   iOS                                          → capacitor://localhost
 * Matching is exact after normalization (lower-case, no trailing slash).
 */
export const CAPACITOR_ANDROID_ORIGIN = "https://localhost";
export const CAPACITOR_IOS_ORIGIN = "capacitor://localhost";

export type OriginPolicy =
  | { mode: "any"; reason: "explicit_wildcard" | "development_default" }
  | { mode: "list"; origins: ReadonlySet<string> };

export class OriginConfigError extends Error {}

export function normalizeOrigin(o: string): string {
  return o.trim().toLowerCase().replace(/\/+$/, "");
}

export function parseOriginPolicy(raw: string | undefined, nodeEnv: string | undefined): OriginPolicy {
  const entries = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (entries.includes("*")) {
    if (entries.length > 1) throw new OriginConfigError('SIGNALING_ALLOWED_ORIGINS: "*" cannot be combined with other origins');
    return { mode: "any", reason: "explicit_wildcard" };
  }
  if (entries.length === 0) {
    if (nodeEnv === "production") {
      throw new OriginConfigError(
        `SIGNALING_ALLOWED_ORIGINS is empty in production. Set it (e.g. "https://your-web-app,${CAPACITOR_ANDROID_ORIGIN},${CAPACITOR_IOS_ORIGIN}") or set "*" to deliberately allow any origin.`,
      );
    }
    return { mode: "any", reason: "development_default" };
  }
  for (const e of entries) {
    if (!/^[a-z][a-z0-9+.-]*:\/\/[^/\s]+\/?$/i.test(e)) throw new OriginConfigError(`SIGNALING_ALLOWED_ORIGINS: not an origin: ${e}`);
  }
  return { mode: "list", origins: new Set(entries.map(normalizeOrigin)) };
}

export function isOriginAllowed(policy: OriginPolicy, origin: string | undefined): boolean {
  if (policy.mode === "any") return true;
  if (!origin) return false;
  return policy.origins.has(normalizeOrigin(origin));
}

/** Non-fatal hints for startup logs. */
export function originPolicyWarnings(policy: OriginPolicy): string[] {
  if (policy.mode === "any") {
    return [policy.reason === "explicit_wildcard"
      ? 'SIGNALING_ALLOWED_ORIGINS="*": any website origin may open a signaling socket (tickets are still required).'
      : "SIGNALING_ALLOWED_ORIGINS is empty (development): any origin is accepted."];
  }
  const w: string[] = [];
  if (!policy.origins.has(CAPACITOR_ANDROID_ORIGIN)) w.push(`${CAPACITOR_ANDROID_ORIGIN} (Capacitor Android WebView) is not allowed — the Android app will get 403 on connect.`);
  if (!policy.origins.has(CAPACITOR_IOS_ORIGIN)) w.push(`${CAPACITOR_IOS_ORIGIN} (Capacitor iOS WebView) is not allowed — the iOS app will get 403 on connect.`);
  return w;
}
