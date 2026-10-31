// Deno-native tests (run: `deno test supabase/functions/_shared/tests/googlePlay.test.ts`).
// No network: Google is faked through __setTestHooks. Also runnable under
// Node 22 with a tiny Deno.test shim (this is how it was verified in the
// authoring sandbox — see docs/MONETIZATION_ARCHITECTURE.md).
import {
  __setTestHooks,
  acknowledgeWithGooglePlay,
  mapSubscriptionPurchaseV2,
  verifyPubSubJwt,
  verifyWithGooglePlay,
} from "../googlePlay.ts";

function eq(a: unknown, b: unknown, msg = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
}
const NOW = Date.parse("2026-09-30T00:00:00Z");
const future = "2026-10-30T00:00:00Z";
const past = "2026-09-01T00:00:00Z";
const P = "duospace_plus_individual_monthly";
const sub = (state: string, expiry = future, extra: Record<string, unknown> = {}) => ({
  subscriptionState: state,
  latestOrderId: "GPA.1",
  acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
  lineItems: [{ productId: P, expiryTime: expiry }],
  externalAccountIdentifiers: { obfuscatedExternalAccountId: "abc" },
  ...extra,
});

Deno.test("mapper: ACTIVE / GRACE / CANCELED-in-period grant; others don't", () => {
  eq(mapSubscriptionPurchaseV2(P, sub("SUBSCRIPTION_STATE_ACTIVE"), NOW).valid, true);
  eq(mapSubscriptionPurchaseV2(P, sub("SUBSCRIPTION_STATE_IN_GRACE_PERIOD"), NOW).valid, true);
  eq(mapSubscriptionPurchaseV2(P, sub("SUBSCRIPTION_STATE_CANCELED"), NOW).valid, true);
  eq(mapSubscriptionPurchaseV2(P, sub("SUBSCRIPTION_STATE_CANCELED", past), NOW).valid, false);
  for (const s of ["ON_HOLD", "PAUSED", "EXPIRED", "PENDING", "PENDING_PURCHASE_CANCELED"]) {
    eq(mapSubscriptionPurchaseV2(P, sub(`SUBSCRIPTION_STATE_${s}`), NOW).valid, false, s);
  }
  eq(mapSubscriptionPurchaseV2(P, sub("SOMETHING_NEW"), NOW).valid, false, "unknown state fails closed");
});

Deno.test("mapper: token for a different product is rejected", () => {
  eq(mapSubscriptionPurchaseV2("duospace_pro_couple_monthly", sub("SUBSCRIPTION_STATE_ACTIVE"), NOW).valid, false);
});

Deno.test("mapper: carries account binding, linked token, ack state", () => {
  const r = mapSubscriptionPurchaseV2(
    P,
    sub("SUBSCRIPTION_STATE_ACTIVE", future, { linkedPurchaseToken: "old", acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" }),
    NOW,
  );
  eq(r.obfuscatedExternalAccountId, "abc");
  eq(r.linkedPurchaseToken, "old");
  eq(r.acknowledgementState, "acknowledged");
  eq(r.orderId, "GPA.1");
});

async function makeSa() {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  let s = ""; for (const b of der) s += String.fromCharCode(b);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(s).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
  return JSON.stringify({ client_email: "sa@x.iam.gserviceaccount.com", private_key: pem });
}

Deno.test("verifyWithGooglePlay: mints token, calls v2 endpoint, maps result; 404 => invalid; 500 => throws", async () => {
  const calls: string[] = [];
  let status = 200;
  __setTestHooks({
    now: () => NOW,
    env: (k) => ({ GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: saJson }[k as "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"]),
    fetch: (async (url: string, init: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("oauth2.googleapis.com")) {
        const body = String(init.body);
        if (!body.includes("assertion=")) throw new Error("no assertion");
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      if (String((init.headers as Record<string, string>).Authorization) !== "Bearer tok") throw new Error("bad auth");
      return new Response(JSON.stringify(sub("SUBSCRIPTION_STATE_ACTIVE")), { status });
    }) as typeof fetch,
  });
  const ok = await verifyWithGooglePlay(P, "TOKEN/1");
  eq(ok.valid, true);
  eq(calls.some((c) => c.includes("/com.duospace.app/purchases/subscriptionsv2/tokens/TOKEN%2F1")), true);
  status = 404;
  eq((await verifyWithGooglePlay(P, "x")).valid, false);
  status = 500;
  let threw = false;
  try { await verifyWithGooglePlay(P, "x"); } catch { threw = true; }
  eq(threw, true, "5xx must throw");
  eq(calls.filter((c) => c.includes("oauth2")).length, 1, "access token cached");
});

Deno.test("verifyWithGooglePlay: fails closed without secret", async () => {
  __setTestHooks({ env: () => undefined });
  let threw = false;
  try { await verifyWithGooglePlay(P, "x"); } catch { threw = true; }
  eq(threw, true);
});

Deno.test("acknowledge: posts to :acknowledge, throws on failure", async () => {
  let last = "";
  let ok = true;
  __setTestHooks({
    now: () => NOW,
    env: (k) => ({ GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: saJson }[k as "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"]),
    fetch: (async (url: string, init: RequestInit) => {
      if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      last = `${init.method} ${url}`;
      return new Response("{}", { status: ok ? 200 : 403 });
    }) as typeof fetch,
  });
  await acknowledgeWithGooglePlay(P, "T");
  eq(last.startsWith("POST ") && last.endsWith(`/subscriptions/${P}/tokens/T:acknowledge`), true, last);
  ok = false;
  let threw = false;
  try { await acknowledgeWithGooglePlay(P, "T"); } catch { threw = true; }
  eq(threw, true);
});

Deno.test("verifyPubSubJwt: accepts a correctly signed token; rejects tamper/aud/email/expiry/unconfigured", async () => {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const sign = async (claims: Record<string, unknown>, kid = "k1") => {
    const h = enc({ alg: "RS256", kid, typ: "JWT" }), p = enc(claims);
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(`${h}.${p}`)));
    let s = ""; for (const b of sig) s += String.fromCharCode(b);
    return `${h}.${p}.${btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
  };
  const good = { iss: "https://accounts.google.com", aud: "aud1", email: "push@x.iam.gserviceaccount.com", email_verified: true, exp: NOW / 1000 + 600 };
  const env = { PUBSUB_PUSH_AUDIENCE: "aud1", PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL: "push@x.iam.gserviceaccount.com" } as Record<string, string>;
  __setTestHooks({
    now: () => NOW,
    env: (k) => env[k],
    fetch: (async () => new Response(JSON.stringify({ keys: [jwk] }))) as typeof fetch,
  });
  const t = await sign(good);
  eq(await verifyPubSubJwt(`Bearer ${t}`), true, "good");
  eq(await verifyPubSubJwt(null), false, "no header");
  eq(await verifyPubSubJwt(`Bearer ${t.slice(0, -4)}AAAA`), false, "tampered sig");
  eq(await verifyPubSubJwt(`Bearer ${await sign({ ...good, aud: "other" })}`), false, "aud");
  eq(await verifyPubSubJwt(`Bearer ${await sign({ ...good, email: "evil@x.iam.gserviceaccount.com" })}`), false, "email");
  eq(await verifyPubSubJwt(`Bearer ${await sign({ ...good, exp: NOW / 1000 - 5 })}`), false, "expired");
  eq(await verifyPubSubJwt(`Bearer ${await sign({ ...good, email_verified: false })}`), false, "unverified email");
  eq(await verifyPubSubJwt(`Bearer ${await sign(good, "unknown")}`), false, "unknown kid");
  delete env.PUBSUB_PUSH_AUDIENCE;
  eq(await verifyPubSubJwt(`Bearer ${t}`), false, "unconfigured fails closed");
});

let saJson = "";
Deno.test("setup", async () => { saJson = await makeSa(); });
