// Shared helper: derive the effective WebAuthn RP ID and expected origins
// from a request. Falls back to WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN env vars,
// then to the request's Origin header. This lets the same edge function
// work across preview URLs, published URLs, and custom domains without
// having to redeploy every time the host changes.

export function getWebauthnConfig(req: Request): {
  rpID: string;
  origins: string[];
} {
  const envRpId = Deno.env.get("WEBAUTHN_RP_ID")?.trim();
  const envOrigins = (Deno.env.get("WEBAUTHN_ORIGIN") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  const originHeader = req.headers.get("origin") ?? req.headers.get("referer") ?? "";
  let hostFromReq: string | null = null;
  let originFromReq: string | null = null;
  try {
    if (originHeader) {
      const u = new URL(originHeader);
      hostFromReq = u.hostname; // no port, no protocol — WebAuthn RP ID
      originFromReq = `${u.protocol}//${u.host}`;
    }
  } catch { /* ignore */ }

  // Build origin allow-list. Always accept whatever env says, plus the
  // request origin so preview iframes and popped-out tabs both work.
  const origins = Array.from(new Set([
    ...envOrigins,
    ...(originFromReq ? [originFromReq] : []),
    "http://localhost:8080",
  ]));

  // Pick RP ID: env wins; else the request host; else localhost.
  const rpID = envRpId || hostFromReq || "localhost";

  return { rpID, origins };
}
