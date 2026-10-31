// SoundCloud HLS pass-through proxy.
//
// WHY: some networks (confirmed on a Kyrgyzstan connection) cannot reach SoundCloud's stream hosts
// (playback.media-streaming.soundcloud.cloud and the segment CDN): ExoPlayer starts the playlist request and it
// never completes, no error. Supabase can reach them, and the phone can reach Supabase, so the phone fetches
// the playlist + segments THROUGH this function. Nothing is stored or rehosted: bytes are streamed straight through.
//
// AUTH: ExoPlayer cannot send a Supabase JWT, so verify_jwt is OFF and every URL carries an HMAC signature that only
// soundcloud-search (same secret) can mint, plus a host allow-list, so this is not an open proxy.
const ALLOWED_HOST = /(^|\.)(soundcloud\.cloud|sndcdn\.com|soundcloud\.com)$/i;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SELF = `${Deno.env.get("SUPABASE_URL")}/functions/v1/sc-hls-proxy`;

const enc = new TextEncoder();
let keyPromise: Promise<CryptoKey> | null = null;
const hmacKey = () => (keyPromise ??= crypto.subtle.importKey("raw", enc.encode(KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]));
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sign = async (u: string) => hex(await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(u)));
const b64u = (s: string) => btoa(String.fromCharCode(...enc.encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

async function wrap(upstream: string): Promise<string> {
  return `${SELF}?u=${b64u(upstream)}&s=${await sign(upstream)}`;
}

async function rewritePlaylist(text: string, base: string): Promise<string> {
  const lines = text.split(/\r?\n/);
  const out = await Promise.all(lines.map(async (line) => {
    const t = line.trim();
    if (!t) return line;
    const resolve = (u: string) => new URL(u, base).toString();
    if (t.startsWith("#")) {
      const uris = [...t.matchAll(/URI="([^"]+)"/g)];
      let res = line;
      for (const m of uris) res = res.replace(m[0], `URI="${await wrap(resolve(m[1]))}"`);
      return res;
    }
    return await wrap(resolve(t));
  }));
  return out.join("\n");
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const u = url.searchParams.get("u"), s = url.searchParams.get("s");
    if (!u || !s) return new Response("bad request", { status: 400 });
    const upstream = unb64u(u);
    if ((await sign(upstream)) !== s) return new Response("forbidden", { status: 403 });
    const target = new URL(upstream);
    if (target.protocol !== "https:" || !ALLOWED_HOST.test(target.hostname)) return new Response("forbidden", { status: 403 });

    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    };
    const range = req.headers.get("range");
    if (range) headers["Range"] = range;
    const res = await fetch(upstream, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok && res.status !== 206) return new Response(`upstream ${res.status}`, { status: res.status === 404 ? 404 : 502 });

    const ct = res.headers.get("content-type") ?? "";
    if (target.pathname.includes(".m3u8") || /mpegurl/i.test(ct)) {
      const body = await rewritePlaylist(await res.text(), upstream);
      return new Response(body, { status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store" } });
    }
    const h = new Headers();
    for (const k of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const v = res.headers.get(k);
      if (v) h.set(k, v);
    }
    h.set("Cache-Control", "private, max-age=300");
    return new Response(res.body, { status: res.status, headers: h });
  } catch (e) {
    console.warn("[sc-hls-proxy]", e instanceof Error ? e.message : e);
    return new Response("proxy error", { status: 502 });
  }
});
