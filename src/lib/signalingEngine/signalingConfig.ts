/**
 * signalingConfig — resolves whether/where a signaling gateway
 * (infrastructure/signaling) is actually reachable.
 *
 * Returns null unless VITE_SIGNALING_URL is explicitly set at build
 * time. This is deliberately NOT auto-derived from anything else (e.g.
 * the Supabase project URL) — no default is safe here.
 *
 * PHASE 4: null now means "self-hosted signaling is not available on this
 * build": the bridge reports NOT_CONFIGURED, a self-hosted call refuses to
 * start with a clear message, and NOTHING falls back to Realtime or the call engine
 * implicitly. It is also what keeps the call engine completely unaffected — with the
 * default provider (or this variable unset) no transport is created, no
 * ticket is fetched and no socket is opened. See
 * docs/CALLING_PHASE_4_AUTHORITATIVE_SIGNALING.md.
 */
const RUNTIME_KEY = "duo_signaling_url_v1";
/** Standard Vite form so it is statically inlined at build time (and stubbable in tests). */
function buildTimeUrl(): string | null {
  const raw = import.meta.env.VITE_SIGNALING_URL as string | undefined;
  return raw && raw.trim().length > 0 ? raw.trim() : null;
}
const isWss = (u: string | null | undefined): u is string => !!u && /^wss:\/\/[a-z0-9.-]+(:\d+)?(\/\S*)?$/i.test(u.trim());
let runtimeUrl: string | null = (() => { try { const v = localStorage.getItem(RUNTIME_KEY); return isWss(v) ? v : null; } catch { return null; } })();

/** Build-time VITE_SIGNALING_URL wins; otherwise the URL delivered at
 *  runtime by the signaling-ticket function (SIGNALING_PUBLIC_URL secret),
 *  cached so later launches don't wait. Fixes "Self-hosted calling isn't set
 *  up on this build" for Vercel/APK builds made without the env var. */
export function resolveSignalingUrl(): string | null {
  const raw = buildTimeUrl();
  if (raw) return raw;
  return runtimeUrl;
}

export function setRuntimeSignalingUrl(url: string | null | undefined): void {
  if (!isWss(url)) return;
  runtimeUrl = url.trim();
  try { localStorage.setItem(RUNTIME_KEY, runtimeUrl); } catch { /* private mode */ }
}

let inflight: Promise<string | null> | null = null;
/** Ask the backend once (authenticated) for the signaling URL if this build has none. */
export function loadRuntimeSignalingUrl(fetchConfig: () => Promise<{ signalingUrl?: string | null }>): Promise<string | null> {
  const current = resolveSignalingUrl();
  const fromBuild = !!buildTimeUrl();
  if (fromBuild) return Promise.resolve(current);
  if (!inflight) {
    inflight = fetchConfig()
      .then((r) => { setRuntimeSignalingUrl(r?.signalingUrl ?? null); return resolveSignalingUrl(); })
      .catch(() => resolveSignalingUrl())
      .finally(() => { inflight = null; });
  }
  return inflight;
}
