/**
 * secureKey — hardware-backed sealing for the face template.
 *
 * Phones (Face ID / Samsung face unlock) never keep a face template in app
 * storage that the app's own web layer can read: it lives in the Secure
 * Enclave / Keystore-backed TEE. We can't reach a Secure Enclave from a
 * Capacitor web view, but we CAN get the same key-custody property:
 *
 *   - a random 256-bit AES key is generated once and stored through
 *     capacitor-native-biometric's credential store, which is backed by the
 *     Android Keystore (encrypted prefs) / iOS Keychain,
 *   - the face template is sealed with that key (AES-GCM), so the IndexedDB /
 *     SharedPreferences copies are useless without the OS keystore,
 *   - the key never touches IndexedDB or localStorage, and the imported
 *     CryptoKey is non-extractable.
 *
 * FIXED 2026-10-11: this path never actually ran before — it called
 * `isCredentialsSaved`, which capacitor-native-biometric 4.2.2 does not have,
 * so every device silently used the software vault. See resolveHardwareKeyBytes.
 *
 * On web, or if the keystore is unavailable, we fall back to the existing
 * deviceVault (non-extractable WebCrypto key in IndexedDB) — never plaintext.
 */
import { Capacitor } from "@capacitor/core";
import { vaultEncrypt, vaultDecrypt } from "@/lib/privacy/deviceVault";
import prefs from "@/lib/prefs";

const HW_PREFIX = "duo-hw1:";
const SERVER = "com.duospace.face-template-key";

let hwKeyPromise: Promise<CryptoKey | null> | null = null;

const toB64 = (b: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** Storage the key bytes live in (OS keystore on the phone; a fake in tests). */
export interface HwCredentialStore {
  /** Base64 key material, or null when absent OR unreadable (the plugin cannot tell the two apart). */
  get(): Promise<string | null>;
  set(b64: string): Promise<void>;
}
/** Durable "a hardware key was created on this install" flag (Preferences, not the keystore). */
export interface HwMarker { isSet(): Promise<boolean>; set(): Promise<void> }

/**
 * Find or create the 32-byte hardware-held key.
 *
 * WHY THIS IS SHAPED SO CAREFULLY: capacitor-native-biometric 4.2.2 has NO
 * `isCredentialsSaved` (the code used to call it, threw, and silently fell back
 * to the software vault on every device), and getCredentials rejects both when
 * nothing is saved AND when a read fails. "Absent" and "couldn't read" are
 * therefore indistinguishable — and treating the second as the first would mint
 * a new key over the old one and orphan every sealed template. So:
 *   1. a readable, well-formed key is used (and the marker is healed if missing);
 *   2. unreadable + marker set  → a key DID exist: return null (callers fall
 *      back to the vault) and NEVER regenerate;
 *   3. unreadable + no marker   → first use: create, READ BACK to verify the
 *      keystore really holds it, and only then set the marker.
 * Residual risk (stated, not hidden): marker lost AND the keystore read failing
 * at the same moment AND a key existing. The marker lives in Preferences,
 * which is not wiped independently of the keystore on Android, and an iOS
 * reinstall (Preferences gone, Keychain kept) reads the old key fine.
 */
export async function resolveHardwareKeyBytes(
  store: HwCredentialStore,
  marker: HwMarker,
  randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n))),
): Promise<Uint8Array<ArrayBuffer> | null> {
  const existing = await store.get().catch(() => null);
  if (existing) {
    let raw: Uint8Array<ArrayBuffer> | null = null;
    try { raw = fromB64(existing); } catch { raw = null; }
    if (raw && raw.length === 32) {
      if (!(await marker.isSet().catch(() => true))) await marker.set().catch(() => {});
      return raw;
    }
    // Something is stored but it is not our key: never overwrite it.
    return null;
  }
  if (await marker.isSet().catch(() => true)) return null;

  const generated = randomBytes(32);
  const raw = new Uint8Array(new ArrayBuffer(32));
  raw.set(generated);
  const b64 = toB64(raw);
  await store.set(b64);
  const back = await store.get().catch(() => null);
  if (back !== b64) return null; // keystore did not keep it → vault fallback, no marker
  await marker.set().catch(() => {});
  return raw;
}

const MARKER_KEY = "duo-hw-key-created-v1";

const nativeHwStore: HwCredentialStore = {
  async get() {
    try {
      const { NativeBiometric } = await import("capacitor-native-biometric");
      const cred = await NativeBiometric.getCredentials({ server: SERVER });
      return cred?.password || null;
    } catch { return null; }
  },
  async set(b64) {
    const { NativeBiometric } = await import("capacitor-native-biometric");
    await NativeBiometric.setCredentials({ username: "face-template", password: b64, server: SERVER });
  },
};

const prefsMarker: HwMarker = {
  async isSet() { return (await prefs.get(MARKER_KEY)) === "1"; },
  async set() { await prefs.set(MARKER_KEY, "1"); },
};

const loadHardwareKey = async (): Promise<CryptoKey | null> => {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const raw = await resolveHardwareKeyBytes(nativeHwStore, prefsMarker);
    if (!raw) return null;
    return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  } catch {
    return null;
  }
};

const getHardwareKey = (): Promise<CryptoKey | null> => {
  if (!hwKeyPromise) hwKeyPromise = loadHardwareKey().then((k) => { if (!k) hwKeyPromise = null; return k; });
  return hwKeyPromise;
};

export const isHardwareSealed = (v: string | null | undefined): v is string => !!v && v.startsWith(HW_PREFIX);
export const hardwareKeyAvailable = async (): Promise<boolean> => !!(await getHardwareKey());

/** Seal with the hardware-backed key when present, else the device vault. */
export async function faceSeal(plain: string): Promise<string> {
  const key = await getHardwareKey();
  if (!key) return vaultEncrypt(plain);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)));
  return `${HW_PREFIX}${toB64(iv)}:${toB64(ct)}`;
}

/** Opens either format. Returns null when it can't (treated as "absent"). */
export async function faceUnseal(stored: string | null): Promise<string | null> {
  if (stored == null) return null;
  if (!isHardwareSealed(stored)) return vaultDecrypt(stored);
  try {
    const key = await getHardwareKey();
    if (!key) return null;
    const [iv, ct] = stored.slice(HW_PREFIX.length).split(":");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, key, fromB64(ct));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

/** Removes the keystore entry (used when the face profile is deleted). */
export async function destroyHardwareKey(): Promise<void> {
  hwKeyPromise = null;
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { NativeBiometric } = await import("capacitor-native-biometric");
    await NativeBiometric.deleteCredentials({ server: SERVER });
  } catch { /* nothing stored */ }
  // The key is gone on purpose, so a future enrolment may create a fresh one.
  await prefs.remove(MARKER_KEY).catch(() => {});
}
