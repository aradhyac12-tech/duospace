/**
 * server — DuoSpace Call Gateway entry point. A thin adapter that binds
 * the `ws` library to gateway.ts, which holds ALL routing/authorization
 * logic (and is unit-tested without a socket).
 *
 * NOT RUNTIME-VERIFIED — see auth.ts's own note. This process was never
 * started against a real Supabase project or real clients from the
 * environment it was written in.
 *
 * Required environment:
 *   SIGNALING_TICKET_SECRET     verifies the short-lived signaling ticket (same value as the
 *                               signaling-ticket function's secret; SUPABASE_JWT_SECRET = legacy fallback)
 *   SUPABASE_URL                https://<project>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY   SERVER-SIDE ONLY. Used exclusively for the
 *                               single `signaling_get_call_facts` RPC
 *                               (authorizer.ts). Never sent to a client.
 * Optional:
 *   PORT (8787) · SIGNALING_RING_TTL_MS (40000) · SIGNALING_ALLOWED_ORIGINS
 *   (comma-separated Origin allowlist; unset = no Origin check, which is
 *   only appropriate for local development)
 *
 * The process refuses to start without the three required variables —
 * running without call authorization would silently reintroduce "relay to
 * whoever the message names".
 */
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { verifyClientToken, SignalingAuthError } from "./auth.js";
import { SupabaseRpcCallAuthorizer } from "./authorizer.js";
import { SignalingGateway } from "./gateway.js";
import type { GatewayConnection } from "./session.js";
import { RateLimiter } from "./rateLimit.js";
import { parseOriginPolicy, isOriginAllowed, originPolicyWarnings, OriginConfigError, type OriginPolicy } from "./origin.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) {
    // eslint-disable-next-line no-console
    console.error(`FATAL: ${name} is not set — refusing to start the signaling gateway without it.`);
    process.exit(1);
  }
  return v.trim();
}

if (!process.env.SIGNALING_TICKET_SECRET && !process.env.SUPABASE_JWT_SECRET) requireEnv("SIGNALING_TICKET_SECRET");
const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

const PORT = Number(process.env.PORT ?? "8787");
const RING_TTL_MS = Number(process.env.SIGNALING_RING_TTL_MS ?? "40000");
let ORIGIN_POLICY: OriginPolicy;
try {
  ORIGIN_POLICY = parseOriginPolicy(process.env.SIGNALING_ALLOWED_ORIGINS, process.env.NODE_ENV);
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(`FATAL: ${err instanceof OriginConfigError ? err.message : String(err)}`);
  process.exit(1);
}
for (const w of originPolicyWarnings(ORIGIN_POLICY)) {
  // eslint-disable-next-line no-console
  console.warn(`WARN: ${w}`);
}

// SINGLE INSTANCE BY DESIGN: sessions (one socket per user), the call
// registry, ring timers, idempotency cache and rate limits are all held in
// this process's memory. Running more than one instance would split users
// across processes (offers/accepts silently undeliverable). Do not scale
// horizontally without shared session state or sticky routing by user id.

// REMEDIATION P1-10: bounded in-memory, single-instance-only — see
// rateLimit.ts. Connection attempts per remote IP; messages per user.
const connectionAttemptLimiter = new RateLimiter(20, 60_000);
const messageLimiter = new RateLimiter(60, 10_000);

function logLine(event: string, data: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));
}

const gateway = new SignalingGateway({
  authorizer: new SupabaseRpcCallAuthorizer({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY }),
  messageLimiter,
  ringTtlMs: RING_TTL_MS,
  log: (event, data) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));
  },
});

const httpServer = createServer((req, res) => {
  // Healthcheck for docker-compose / load balancer probes. Reveals only
  // aggregate counts — no ids, no per-user information.
  if (req.url === "/healthz") {
    const s = gateway.stats();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, sessions: s.sessions, calls: s.calls }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok");
});

// maxPayload: the library closes the socket (1009) on anything larger,
// BEFORE it is buffered in full — bounds memory per malicious client.
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

httpServer.on("upgrade", async (req, socket, head) => {
  const remoteAddr = req.socket.remoteAddress ?? "unknown";
  if (!connectionAttemptLimiter.check(remoteAddr)) {
    socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
    socket.destroy();
    return;
  }
  {
    const origin = req.headers.origin ?? "";
    if (!isOriginAllowed(ORIGIN_POLICY, origin)) {
      // The #1 device-only failure: a WebView origin missing from
      // SIGNALING_ALLOWED_ORIGINS. Log the origin (not user data) so it's visible.
      logLine("upgrade_rejected_origin", { origin: origin || "(none)" });
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
  }
  try {
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);
    const token = url.searchParams.get("token") ?? "";
    const identity = await verifyClientToken(token);
    wss.handleUpgrade(req, socket, head, (ws) => {
      attach(ws, identity.userId);
    });
  } catch (err) {
    const status = err instanceof SignalingAuthError ? 401 : 500;
    // Reason class only — never the token. "token verification failed" here
    // usually means SIGNALING_TICKET_SECRET differs from the Edge Function's.
    logLine("upgrade_rejected_auth", { status, reason: err instanceof SignalingAuthError ? err.message.replace(/:.*$/, "") : "internal" });
    socket.write(`HTTP/1.1 ${status} Unauthorized\r\n\r\n`);
    socket.destroy();
  }
});

// Protocol-level liveness (dead TCP peers): a socket that hasn't answered
// the previous ping by the next probe is terminated.
const alive = new WeakMap<WebSocket, boolean>();

function attach(ws: WebSocket, userId: string): void {
  const conn: GatewayConnection = {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    isOpen: () => ws.readyState === ws.OPEN,
  };
  alive.set(ws, true);
  ws.on("pong", () => alive.set(ws, true));

  gateway.connect(userId, conn);
  ws.on("message", (raw, isBinary) => {
    if (isBinary) return; // the protocol is JSON text only
    const text = Buffer.isBuffer(raw)
      ? raw.toString("utf8")
      : Array.isArray(raw) ? Buffer.concat(raw).toString("utf8") : Buffer.from(raw).toString("utf8");
    void gateway.handleRaw(userId, conn, text).catch(() => { /* one bad message must never crash the process */ });
  });
  logLine("socket_connected", { user: userId.slice(0, 8) });
  ws.on("close", (code) => { logLine("socket_closed", { user: userId.slice(0, 8), code }); gateway.disconnect(userId, conn); });
  ws.on("error", () => { /* close follows */ });
}

// Ring timeouts + eviction every 5s; app-level ping every 15s; protocol
// ping/terminate for dead TCP peers every 30s.
setInterval(() => gateway.sweep(), 5_000).unref();
setInterval(() => gateway.heartbeat(), 15_000).unref();
setInterval(() => {
  for (const ws of wss.clients) {
    if (alive.get(ws) === false) { ws.terminate(); continue; }
    alive.set(ws, false);
    try { ws.ping(); } catch { /* socket already closing */ }
  }
}, 30_000).unref();

httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`duospace-signaling listening on :${PORT}`);
});
