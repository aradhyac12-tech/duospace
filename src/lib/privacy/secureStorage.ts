/**
 * Secure local storage abstraction for sensitive, device-scoped data
 * (future local AI intermediate results, cached insights pending sync,
 * anything classified DEVICE_ONLY or HIGHLY_SENSITIVE that needs to sit
 * on disk between app launches). See .ai/SECURITY_MODEL.md's Key
 * Management section for the full picture.
 *
 * HONEST LIMITATION, stated plainly rather than implied away: this is
 * software AES-256-GCM (Web Crypto API — an established primitive, not
 * invented cryptography) with the master key held in IndexedDB
 * (duo-keystore, the same store src/lib/crypto.ts already trusts for E2E
 * private keys) and durable values written through prefs.ts
 * (@capacitor/preferences, native SharedPreferences/UserDefaults under
 * the hood). This is NOT Android Keystore- or iOS Keychain-backed
 * hardware encryption. A genuinely hardware-backed implementation needs
 * either a native Capacitor plugin (e.g. capacitor-secure-storage-plugin)
 * or custom native code in native-plugins/ — real native development that
 * needs an Android/iOS toolchain and a real device to build and verify,
 * neither of which exist in this environment. Building that blind, with
 * no way to test it, would be worse than being honest about not having
 * it yet: see .ai/KNOWN_ISSUES.md for this tracked as an open item.
 *
 * What this DOES give you over plain prefs.ts/storage.ts: values are
 * encrypted at rest (not plaintext in SharedPreferences/UserDefaults/
 * localStorage), scoped per-user (a second account on the same device
 * can't read the first user's values even though both go through the
 * same native storage), and the key never touches Supabase, analytics,
 * or logs.
 */

import prefs from "@/lib/prefs";
import { idbGetStrict, idbSet, idbDelete } from "@/lib/keystore";
import { logError, logWarn } from "@/lib/telemetry";

const MASTER_KEY_PREFIX = "duo_secure_storage_master_key_";
const VALUE_PREFIX = "duo_secure_v1_";

/**
 * Exported (offline-first pass, 2026-09-21) so the local message store can
 * encrypt each stored message with THIS SAME per-user key instead of
 * inventing a second key hierarchy. Wiping the key (secureWipeAll below)
 * therefore also makes every locally stored message permanently unreadable.
 *
 * Memoised per user: the local message store and secureStorage callers now
 * all ask for this key at launch, concurrently. Without sharing the
 * in-flight promise, two callers on the very first run could each find "no
 * key yet", each generate one, and the later write would silently orphan
 * whatever the earlier caller had already encrypted.
 */
const masterKeyPromises = new Map<string, Promise<CryptoKey>>();

export function getOrCreateMasterKey(userId: string): Promise<CryptoKey> {
  const existing = masterKeyPromises.get(userId);
  if (existing) return existing;
  const pending = loadOrCreateMasterKey(userId);
  masterKeyPromises.set(userId, pending);
  pending.catch(() => {
    // Never cache a failure — the next caller should try again.
    if (masterKeyPromises.get(userId) === pending) masterKeyPromises.delete(userId);
  });
  return pending;
}

/**
 * ROOT-CAUSE FIX (chat/gallery/us/shayari looking "never cached on this
 * device" on every launch despite a stable install/signing setup): reading
 * the existing master key used to swallow every IndexedDB failure (timeout,
 * blocked connection, a slow read racing other stores opening at boot) into
 * a plain `null`, which read identically to "no key was ever created" — so
 * a single transient hiccup on any given launch would generate a brand-new
 * key and `put` it over the old one's slot. Every message ever encrypted
 * under the old key then fails to decrypt forever after (messageStore.ts
 * treats an undecryptable row as absent, by design, since it can't tell a
 * rotated key from real corruption) — which is exactly "empty cache, every
 * time," independent of anything at the install/APK layer.
 *
 * Fix: a failed READ (not a confirmed absence) is retried with backoff
 * before ever falling through to key generation, so only a genuine "this
 * key store has never held a key for this user" reaches generateKey().
 */
async function loadOrCreateMasterKey(userId: string): Promise<CryptoKey> {
  const idbKey = `${MASTER_KEY_PREFIX}${userId}`;

  const existingJwk = await readExistingKeyWithRetry(idbKey);
  if (existingJwk) {
    return crypto.subtle.importKey("jwk", existingJwk, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
  }

  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  await idbSet(idbKey, jwk);
  return key;
}

const KEY_READ_RETRIES = 3;
const KEY_READ_RETRY_DELAY_MS = 300;

/** Returns the stored key, or null ONLY once a read has actually succeeded
 * and found nothing there. Throws (never silently returns null) if every
 * retry failed to even complete the read — the caller must not treat "I
 * couldn't check" as "there's nothing to find". */
async function readExistingKeyWithRetry(idbKey: string): Promise<JsonWebKey | null> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < KEY_READ_RETRIES; attempt++) {
    try {
      return await idbGetStrict<JsonWebKey>(idbKey);
    } catch (err) {
      lastErr = err;
      logWarn("secureStorage", `master key read attempt ${attempt + 1} failed — retrying`, err);
      if (attempt < KEY_READ_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, KEY_READ_RETRY_DELAY_MS * (attempt + 1)));
      }
    }
  }
  // Every attempt failed to even complete — do NOT fall through to
  // generating a replacement key; that would be the exact bug this fixes,
  // just with more retries first. Surface the failure instead.
  logError("secureStorage", "master key read failed after retries — refusing to risk generating a replacement", lastErr);
  throw lastErr instanceof Error ? lastErr : new Error("master key read failed");
}

function ab2b64(buf: ArrayBuffer): string {
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

/** Encrypt-then-store a JSON-serializable value under `key`, scoped to `userId`. */
export async function secureSet(userId: string, key: string, value: unknown): Promise<void> {
  try {
    const cryptoKey = await getOrCreateMasterKey(userId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(value));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, plaintext);
    const payload = JSON.stringify({ iv: ab2b64(iv.buffer), ct: ab2b64(ciphertext) });
    await prefs.set(`${VALUE_PREFIX}${userId}_${key}`, payload);
    await addToIndex(userId, key);
  } catch (err) {
    logError("secureStorage", `secureSet failed for key "${key}"`, err);
    throw err;
  }
}

/** Decrypt and return a value previously written with secureSet, or null if absent/undecryptable. */
export async function secureGet<T = unknown>(userId: string, key: string): Promise<T | null> {
  try {
    const raw = await prefs.get(`${VALUE_PREFIX}${userId}_${key}`);
    if (!raw) return null;
    const { iv, ct } = JSON.parse(raw) as { iv: string; ct: string };
    const cryptoKey = await getOrCreateMasterKey(userId);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b642ab(iv) }, cryptoKey, b642ab(ct));
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch (err) {
    // Decrypt failure (corrupt value, key rotated/lost) is not re-thrown —
    // callers should treat a missing/undecryptable value the same as
    // "never set", not crash the feature reading it.
    logError("secureStorage", `secureGet failed for key "${key}" — treating as absent`, err);
    return null;
  }
}

export async function secureRemove(userId: string, key: string): Promise<void> {
  await prefs.remove(`${VALUE_PREFIX}${userId}_${key}`);
  await removeFromIndex(userId, key);
}

/**
 * prefs.ts (the shared @capacitor/preferences wrapper) doesn't expose a
 * `keys()`/prefix-scan method, and this module deliberately doesn't add
 * one there — that's shared, load-bearing code for auth/device-id/other
 * features, and widening its surface for this one caller isn't worth the
 * risk. Instead this module keeps its own small index of the key names
 * it has written per user, so secureWipeAll() knows what to delete
 * without needing a native prefix scan.
 */
const INDEX_KEY_PREFIX = "duo_secure_v1_index_";

async function readIndex(userId: string): Promise<string[]> {
  const raw = await prefs.get(`${INDEX_KEY_PREFIX}${userId}`);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function addToIndex(userId: string, key: string): Promise<void> {
  const current = await readIndex(userId);
  if (!current.includes(key)) {
    await prefs.set(`${INDEX_KEY_PREFIX}${userId}`, JSON.stringify([...current, key]));
  }
}

async function removeFromIndex(userId: string, key: string): Promise<void> {
  const current = await readIndex(userId);
  const next = current.filter((k) => k !== key);
  if (next.length !== current.length) {
    await prefs.set(`${INDEX_KEY_PREFIX}${userId}`, JSON.stringify(next));
  }
}

/**
 * Full wipe for this user: deletes the master key (making any remaining
 * ciphertext permanently unrecoverable, which is the correct behavior —
 * see .ai/SECURITY_MODEL.md's Key Management: LOGOUT/ACCOUNT DELETION)
 * and every value this module has written for them, per its own index.
 * Call on logout and on account deletion.
 */
export async function secureWipeAll(userId: string): Promise<void> {
  masterKeyPromises.delete(userId);
  await idbDelete(`${MASTER_KEY_PREFIX}${userId}`);
  const keys = await readIndex(userId);
  await Promise.all(keys.map((k) => prefs.remove(`${VALUE_PREFIX}${userId}_${k}`)));
  await prefs.remove(`${INDEX_KEY_PREFIX}${userId}`);
}
