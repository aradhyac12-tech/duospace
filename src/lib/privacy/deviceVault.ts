/**
 * deviceVault — AES-256-GCM at-rest encryption for DEVICE-ONLY sensitive blobs (KI-22):
 * the Peek Guard owner face template and breach snapshots (JPEG data URLs).
 *
 * Why not secureStorage: that module is user-scoped and wiped on sign-out. These blobs must
 * survive sign-out (the owner should not have to re-enrol Peek Guard every time), so this vault
 * has its OWN device-scoped key that is NOT removed by secureWipeAll(). Use clearDeviceVault()
 * to destroy it (makes every vault ciphertext permanently unreadable).
 *
 * HONEST SCOPE (see KI-25): software key storage. The CryptoKey is generated NON-EXTRACTABLE and
 * persisted as a CryptoKey object in its own IndexedDB database, so JS cannot export the key
 * bytes — but code running in this origin can still call decrypt, and it is not Keystore/Keychain
 * backed. It protects against copied/backed-up data files and casual inspection, not a compromised
 * runtime. Hardware-backed storage needs a native plugin + device (KI-25).
 *
 * Format: "dv1:<ivB64>:<ctB64>". Anything not starting with "dv1:" is treated as LEGACY plaintext
 * and passed through by vaultDecrypt so existing installs keep working; callers re-save to
 * migrate. Encrypt failures THROW (fail closed): never silently store plaintext.
 */
const DB_NAME = "duo-vault";
const STORE = "keys";
const KEY_ID = "master-v1";
export const VAULT_PREFIX = "dv1:";

let keyPromise: Promise<CryptoKey> | null = null;

const openDb = (): Promise<IDBDatabase> =>
  new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

const readKey = (db: IDBDatabase): Promise<CryptoKey | null> =>
  new Promise((res, rej) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY_ID);
    req.onsuccess = () => res((req.result as CryptoKey | undefined) ?? null);
    req.onerror = () => rej(req.error); // a failed READ must never lead to generating a replacement key
  });

const writeKey = (db: IDBDatabase, key: CryptoKey): Promise<void> =>
  new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(key, KEY_ID);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });

const getKey = (): Promise<CryptoKey> => {
  if (keyPromise) return keyPromise;
  keyPromise = (async () => {
    const db = await openDb();
    try {
      const existing = await readKey(db);
      if (existing) return existing;
      const fresh = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      await writeKey(db, fresh);
      return fresh;
    } finally {
      db.close();
    }
  })().catch((err) => { keyPromise = null; throw err; });
  return keyPromise;
};

const toB64 = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const fromB64 = (b64: string): ArrayBuffer => {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return buf;
};

/** Encrypt a string. Throws if the vault is unavailable (never falls back to plaintext). */
export async function vaultEncrypt(plain: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  return `${VAULT_PREFIX}${toB64(iv)}:${toB64(ct)}`;
}

export const isVaultValue = (v: string | null | undefined): v is string => !!v && v.startsWith(VAULT_PREFIX);

/**
 * Decrypt a vault value. Legacy plaintext (no prefix) is returned unchanged so existing data keeps
 * working. A vault value that cannot be decrypted (key lost/rotated, corrupt) returns null — treat
 * as "absent", never as an error the feature must survive.
 */
export async function vaultDecrypt(stored: string | null): Promise<string | null> {
  if (stored == null) return null;
  if (!isVaultValue(stored)) return stored;
  try {
    const [ivB64, ctB64] = stored.slice(VAULT_PREFIX.length).split(":");
    const key = await getKey();
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(ivB64) }, key, fromB64(ctB64));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

/** Destroys the vault key: every existing vault ciphertext becomes permanently unreadable. */
export async function clearDeviceVault(): Promise<void> {
  keyPromise = null;
  await new Promise<void>((res) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => res();
    req.onerror = () => res();
    req.onblocked = () => res();
  });
}
