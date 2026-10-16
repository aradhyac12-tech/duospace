/**
 * Client-side request envelope for a FUTURE E2E cloud inference path.
 *
 * Same algorithm family as DuoSpace's existing chat E2E (src/lib/crypto.ts:
 * ECDH P-256 + AES-GCM-256, WebCrypto only — no invented cryptography), used
 * as an ECIES-style one-shot envelope:
 *   ephemeral ECDH P-256 ⊕ recipient public key → HKDF-SHA-256 → AES-GCM-256
 *   AAD = version | purpose | requestId | issuedAt | ephemeral public key
 * The AAD binds every field, so tampering or re-labelling fails decryption;
 * `openEnvelope` also rejects replays (seen requestId) and stale requests.
 *
 * IMPORTANT — what this does NOT provide by itself: the recipient key must
 * belong to an ATTESTED confidential-computing enclave (TEE) whose
 * attestation the client verifies before encrypting. Encrypting to an
 * ordinary server key only gives encrypted transport to a server that can
 * read the plaintext — NOT end-to-end. No attested endpoint exists, so the
 * E2E_CLOUD provider is BLOCKED and this module is never called in production.
 */
const CURVE = { name: "ECDH", namedCurve: "P-256" } as const;
const te = new TextEncoder();
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))));
const unb64 = (s: string): BufferSource => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) as unknown as BufferSource;

export interface Envelope { v: 1; purpose: string; requestId: string; issuedAt: number; epk: string; iv: string; ct: string }

function aad(e: Pick<Envelope, "v" | "purpose" | "requestId" | "issuedAt" | "epk">): BufferSource {
  return te.encode(`${e.v}|${e.purpose}|${e.requestId}|${e.issuedAt}|${e.epk}`);
}

async function aesKey(priv: CryptoKey, pub: CryptoKey, requestId: string): Promise<CryptoKey> {
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256);
  const hk = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: te.encode(requestId) as BufferSource, info: te.encode("duospace-ai-envelope-v1") as BufferSource },
    hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

export async function sealEnvelope(recipientPublicRawB64: string, plaintext: string, meta: { purpose: string; requestId: string; issuedAt: number }): Promise<Envelope> {
  const recipient = await crypto.subtle.importKey("raw", unb64(recipientPublicRawB64), CURVE, false, []);
  const eph = await crypto.subtle.generateKey(CURVE, false, ["deriveBits"]);
  const epk = b64(await crypto.subtle.exportKey("raw", eph.publicKey));
  const key = await aesKey(eph.privateKey, recipient, meta.requestId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const head = { v: 1 as const, ...meta, epk };
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: aad(head) }, key, te.encode(plaintext) as BufferSource);
  return { ...head, iv: b64(iv), ct: b64(ct) };
}

export class EnvelopeError extends Error {
  constructor(public reason: "REPLAY" | "STALE" | "DECRYPT" | "PURPOSE") { super(`envelope rejected: ${reason}`); this.name = "EnvelopeError"; }
}

/** Recipient side (would run INSIDE the attested enclave). */
export async function openEnvelope(recipientPrivate: CryptoKey, e: Envelope, opts: { purpose: string; seen: Set<string>; now: number; maxAgeMs: number }): Promise<string> {
  if (e.purpose !== opts.purpose) throw new EnvelopeError("PURPOSE");
  if (opts.seen.has(e.requestId)) throw new EnvelopeError("REPLAY");
  if (Math.abs(opts.now - e.issuedAt) > opts.maxAgeMs) throw new EnvelopeError("STALE");
  try {
    const epk = await crypto.subtle.importKey("raw", unb64(e.epk), CURVE, false, []);
    const key = await aesKey(recipientPrivate, epk, e.requestId);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(e.iv), additionalData: aad(e) }, key, unb64(e.ct));
    opts.seen.add(e.requestId);
    return new TextDecoder().decode(pt);
  } catch {
    throw new EnvelopeError("DECRYPT");
  }
}
