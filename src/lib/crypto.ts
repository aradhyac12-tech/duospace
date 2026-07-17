import storage from "@/lib/storage";
import { idbGet, idbSet, idbDelete } from "@/lib/keystore";

// E2E Encryption using ECDH key exchange + AES-GCM
const ALGO = { name: "ECDH", namedCurve: "P-256" };
const AES  = { name: "AES-GCM", length: 256 };
const DB_KEY   = "duo_e2e_keypair";
const E2E_PREFIX = "E2E::";

type StoredKeyPair = { privateKeyJwk: JsonWebKey; publicKey: string };

function ab2b64(buf: ArrayBuffer): string {
  // FIX AUDIT #3: chunked encoder avoids "Maximum call stack size exceeded"
  // on large buffers (spread operator blows up past ~100KB on some engines).
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}
function b642ab(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

export async function generateKeyPair(): Promise<{ publicKey: string; privateKeyJwk: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey(ALGO, true, ["deriveKey"]);
  const pubRaw  = await crypto.subtle.exportKey("raw", pair.publicKey);
  const privJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: ab2b64(pubRaw), privateKeyJwk: privJwk };
}

// FIX AUDIT #4: Private keys live in IndexedDB; localStorage is read-once
// for backward compatibility, then migrated and purged.
export async function saveKeyPair(userId: string, privateKeyJwk: JsonWebKey, publicKey: string): Promise<void> {
  await idbSet(`${DB_KEY}_${userId}`, { privateKeyJwk, publicKey } satisfies StoredKeyPair);
  // Legacy: clean up any old localStorage copy.
  storage.remove(`${DB_KEY}_${userId}`);
}
export async function loadKeyPair(userId: string): Promise<StoredKeyPair | null> {
  const fromIdb = await idbGet<StoredKeyPair>(`${DB_KEY}_${userId}`);
  if (fromIdb) return fromIdb;
  // Backward-compat: migrate from localStorage on first read.
  const legacy = storage.getJSON<StoredKeyPair | null>(`${DB_KEY}_${userId}`, null);
  if (legacy) {
    await idbSet(`${DB_KEY}_${userId}`, legacy);
    storage.remove(`${DB_KEY}_${userId}`);
    return legacy;
  }
  return null;
}
export async function clearKeyPair(userId: string): Promise<void> {
  await idbDelete(`${DB_KEY}_${userId}`);
  storage.remove(`${DB_KEY}_${userId}`);
}

async function deriveKey(myPrivateKeyJwk: JsonWebKey, peerPublicKeyB64: string): Promise<CryptoKey> {
  const privateKey  = await crypto.subtle.importKey("jwk", myPrivateKeyJwk, ALGO, false, ["deriveKey"]);
  const peerPublicKey = await crypto.subtle.importKey("raw", b642ab(peerPublicKeyB64), ALGO, false, []);
  return crypto.subtle.deriveKey(
    { name: "ECDH", public: peerPublicKey },
    privateKey, AES, false, ["encrypt", "decrypt"]
  );
}

export async function encryptMessage(text: string, myPrivateKeyJwk: JsonWebKey, peerPublicKeyB64: string): Promise<string> {
  const key = await deriveKey(myPrivateKeyJwk, peerPublicKeyB64);
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text));
  return `${E2E_PREFIX}${ab2b64(iv.buffer)}:${ab2b64(ciphertext)}`;
}

export async function decryptMessage(encrypted: string, myPrivateKeyJwk: JsonWebKey, peerPublicKeyB64: string): Promise<string> {
  try {
    const payload = encrypted.startsWith(E2E_PREFIX) ? encrypted.slice(E2E_PREFIX.length) : encrypted;
    const [ivB64, ctB64] = payload.split(":");
    if (!ivB64 || !ctB64) return encrypted;
    const key       = await deriveKey(myPrivateKeyJwk, peerPublicKeyB64);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(b642ab(ivB64)) }, key, b642ab(ctB64));
    return new TextDecoder().decode(decrypted);
  } catch { return "[🔒 Cannot decrypt]"; }
}

export function isEncrypted(content: string | null): boolean {
  return !!content && content.startsWith(E2E_PREFIX);
}

// ─── Secure PIN hashing via PBKDF2 ──────────────────────────────────────────
const PIN_ITERS = 100_000;

export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const km   = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, hash: "SHA-256", iterations: PIN_ITERS }, km, 256
  );
  return `${ab2b64(salt.buffer)}:${ab2b64(bits)}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  try {
    const [saltB64, hashB64] = stored.split(":");
    if (!saltB64 || !hashB64) return false;
    const km   = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: new Uint8Array(b642ab(saltB64)), hash: "SHA-256", iterations: PIN_ITERS }, km, 256
    );
    return ab2b64(bits) === hashB64;
  } catch { return false; }
}

/** One-time migration: plaintext PIN → hashed PIN */
export async function migratePinIfNeeded(key: string): Promise<void> {
  const raw = storage.get(key);
  if (!raw) return;
  if (!raw.includes(":")) {
    storage.set(key, await hashPin(raw));
  }
}
