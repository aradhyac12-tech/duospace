/**
 * Hardware-backed backup of the per-user master key.
 *
 * WHY: every locally stored message / screen snapshot is AES-GCM encrypted
 * under the master key, and that key lived ONLY in IndexedDB (duo-keystore).
 * When the OS reclaims the WebView's storage, the key goes together with the
 * data — so a copy of the ciphertext in app files (the native mirror) would be
 * unreadable. A copy of the key in the Android Keystore / iOS Keychain (via
 * capacitor-native-biometric's credential store, already used by secureKey.ts
 * for the face template) is not subject to that.
 *
 * RULES THAT KEEP THIS SAFE:
 *  - restore is only attempted when IndexedDB was READ successfully and held no
 *    key (secureStorage.ts keeps its retry-before-generate logic); a failed
 *    read still throws and never reaches here;
 *  - every function swallows its own errors: backup trouble = today's behaviour;
 *  - sign-out / account deletion remove the backup (secureWipeAll), so wiping a
 *    user still makes their stored data permanently unreadable;
 *  - web builds have no store → all no-ops.
 */
import { Capacitor } from "@capacitor/core";
import { logWarn } from "@/lib/telemetry";

export interface KeyBackupStore {
  get(userId: string): Promise<string | null>;
  set(userId: string, jwkJson: string): Promise<void>;
  remove(userId: string): Promise<void>;
}

const serverFor = (userId: string) => `com.duospace.master-key.${userId}`;

/**
 * NOTE: capacitor-native-biometric 4.2.2 has NO `isCredentialsSaved` (types or
 * native code) — only getCredentials / setCredentials / deleteCredentials — so
 * "not saved" is signalled by getCredentials rejecting. Any failure to read is
 * therefore treated as "no backup"; that is safe because restore() is only ever
 * reached after IndexedDB was read successfully and held no key.
 */
export const nativeCredentialStore: KeyBackupStore = {
  async get(userId) {
    const { NativeBiometric } = await import("capacitor-native-biometric");
    try {
      const cred = await NativeBiometric.getCredentials({ server: serverFor(userId) });
      return cred?.password || null;
    } catch {
      return null;
    }
  },
  async set(userId, jwkJson) {
    const { NativeBiometric } = await import("capacitor-native-biometric");
    await NativeBiometric.setCredentials({ username: "master-key", password: jwkJson, server: serverFor(userId) });
  },
  async remove(userId) {
    const { NativeBiometric } = await import("capacitor-native-biometric");
    await NativeBiometric.deleteCredentials({ server: serverFor(userId) });
  },
};

export function createMasterKeyBackup(store: KeyBackupStore | null) {
  const backedUp = new Set<string>();
  return {
    /** Make sure the OS keystore holds this exact key. Once per session per user. Never throws. */
    async backup(userId: string, jwk: JsonWebKey): Promise<void> {
      if (!store || backedUp.has(userId)) return;
      backedUp.add(userId);
      try {
        const json = JSON.stringify(jwk);
        if ((await store.get(userId)) === json) return;
        await store.set(userId, json);
      } catch (err) {
        backedUp.delete(userId);
        logWarn("masterKeyBackup", "could not back up the master key to the OS keystore", err);
      }
    },
    /** The key saved earlier, or null. Never throws. */
    async restore(userId: string): Promise<JsonWebKey | null> {
      if (!store) return null;
      try {
        const json = await store.get(userId);
        if (!json) return null;
        const jwk = JSON.parse(json) as JsonWebKey;
        return jwk && jwk.kty === "oct" && typeof jwk.k === "string" ? jwk : null;
      } catch (err) {
        logWarn("masterKeyBackup", "could not read the master key backup", err);
        return null;
      }
    },
    async remove(userId: string): Promise<void> {
      backedUp.delete(userId);
      if (!store) return;
      try { await store.remove(userId); } catch { /* nothing saved */ }
    },
  };
}

export const masterKeyBackup = createMasterKeyBackup(Capacitor.isNativePlatform() ? nativeCredentialStore : null);
