import { useEffect, useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/appClient";
import {
  generateKeyPair, saveKeyPair, loadKeyPair,
  encryptMessage, decryptMessage, isEncrypted,
} from "@/lib/crypto";
import { logWarn } from "@/lib/telemetry";
import { isOnlineNow } from "@/lib/connectivity";
import storage from "@/lib/storage";

// OFFLINE-FIRST (2026-09-21): the partner's PUBLIC key is not a secret (it is
// readable by the partner's own profile row), so it is cached in plain
// storage per (me, partner). Together with this device's own keypair (already
// kept in IndexedDB by saveKeyPair) that is everything needed to decrypt the
// local message store and to encrypt an outgoing message with no network.
const partnerKeyCacheKey = (userId: string, partnerId: string) => `duo-e2e-partner-pub-${userId}-${partnerId}`;

type StoredKeyPair = { privateKeyJwk: JsonWebKey; publicKey: string };

/**
 * Resolves THE single account-wide identity keypair — never generates a
 * throwaway per-device one if the account already has a canonical key.
 *
 * FIX (2026-09-20, "messages unable to decrypt on different platform"):
 * previously this device would generate a brand-new keypair any time its
 * own local IndexedDB was empty (i.e. every single new platform/browser
 * profile the same account was opened on), then unconditionally
 * overwrite `profiles.public_key` — silently breaking every other
 * already-signed-in device's ability to decrypt anything encrypted
 * before or after that overwrite. See
 * supabase/migrations/20260920100000_e2e_account_wide_identity_key.sql's
 * own header for the full root-cause writeup and the security trade-off
 * this fix accepts (private key now syncs via Supabase, RLS'd to the
 * owning user only, but readable by service_role — stated plainly, not
 * hidden).
 *
 * Flow:
 *   1. Does `user_e2e_identity_keys` already have a row for this
 *      account? Use it — this is what makes a *second* device correctly
 *      adopt the *first* device's key instead of minting its own.
 *   2. No canonical row yet. Use this device's own existing local key if
 *      it has one (preserves continuity for whichever pre-existing
 *      device runs this fixed code first, rather than discarding
 *      perfectly good key material for no reason), otherwise generate a
 *      fresh one.
 *   3. Try to register that candidate as the account's canonical key via
 *      an ignore-on-conflict upsert (first writer wins — enforced by the
 *      table's own PRIMARY KEY, not just app logic). Always re-fetch
 *      afterward to find out which key actually won, even if it wasn't
 *      this device's candidate — handles both a genuine simultaneous
 *      first-run race AND the one-time migration case where two
 *      *pre-existing* devices both had their own different local keys
 *      before this fix shipped (only one can become canonical; the
 *      other device will adopt it on its own next load via step 1,
 *      losing the ability to decrypt whatever only its own old key could
 *      — an unavoidable, one-time cost of unifying to one account-wide
 *      key after the fact, not a bug in this fix).
 */
export async function resolveAccountIdentityKey(userId: string): Promise<StoredKeyPair> {
  const { data: existing, error: selectError } = await supabase
    .from("user_e2e_identity_keys")
    .select("public_key, private_key_jwk")
    .eq("user_id", userId)
    .maybeSingle();
  if (selectError) throw selectError;
  if (existing?.private_key_jwk) {
    return { privateKeyJwk: existing.private_key_jwk as unknown as JsonWebKey, publicKey: existing.public_key as string };
  }

  const local = await loadKeyPair(userId);
  const candidate: StoredKeyPair = local ?? await (async () => {
    const { publicKey, privateKeyJwk } = await generateKeyPair();
    return { privateKeyJwk, publicKey };
  })();

  const { error: upsertError } = await supabase
    .from("user_e2e_identity_keys")
    .upsert(
      { user_id: userId, public_key: candidate.publicKey, private_key_jwk: candidate.privateKeyJwk },
      { onConflict: "user_id", ignoreDuplicates: true },
    );
  if (upsertError) throw upsertError;

  const { data: winner, error: refetchError } = await supabase
    .from("user_e2e_identity_keys")
    .select("public_key, private_key_jwk")
    .eq("user_id", userId)
    .single();
  if (refetchError) throw refetchError;
  return { privateKeyJwk: winner.private_key_jwk as unknown as JsonWebKey, publicKey: winner.public_key as string };
}

/**
 * True when the error means the account-key sync TABLE itself is unusable
 * (migration 20260920100000 never applied to this Supabase project, or the
 * table isn't exposed/granted) — as opposed to a transient failure such as
 * a dropped connection. The two need opposite handling: a transient error
 * is worth retrying, a missing table will never fix itself by retrying.
 */
export function isSyncTableUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown; status?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  return (
    code === "PGRST205" || // table not found in PostgREST's schema cache
    code === "42P01" ||    // undefined_table
    code === "42501" ||    // insufficient_privilege (no GRANT / RLS refusal)
    msg.includes("schema cache") ||
    msg.includes("could not find the table") ||
    (msg.includes("relation") && msg.includes("does not exist")) ||
    msg.includes("permission denied for table")
  );
}

/**
 * resolveAccountIdentityKey() with a safety net.
 *
 * FIX (2026-09-19, "Securing connection… Please wait a moment" on every
 * text send): resolveAccountIdentityKey() throws when the
 * `user_e2e_identity_keys` table can't be read. init() below retries on
 * every throw, so if that migration hadn't been applied the retry loop
 * ran forever, `myKeys` never got set, `ready` stayed false, and Chat's
 * send path could only ever show the "Securing connection…" toast. A
 * missing table is a deployment gap, not something a retry can cure — so
 * for that specific class of error we fall back to this device's own
 * local key (or mint one), which is exactly what the app did before the
 * account-wide-key change. Cross-device decryption stays limited to what
 * the old behaviour gave until the migration is applied; once it is, the
 * next launch adopts/registers the canonical key through the normal path
 * (the local key this fallback saved becomes the candidate that gets
 * registered, so nothing is thrown away).
 *
 * Transient errors (network etc.) are still rethrown so the caller keeps
 * retrying — falling back on those could pick a key that differs from the
 * account's canonical one.
 */
export async function resolveIdentityKeyWithFallback(
  userId: string,
): Promise<StoredKeyPair & { synced: boolean }> {
  try {
    const keys = await resolveAccountIdentityKey(userId);
    return { ...keys, synced: true };
  } catch (error) {
    if (!isSyncTableUnavailable(error)) throw error;
    logWarn(
      "useE2E",
      "user_e2e_identity_keys unavailable (migration not applied?) — falling back to this device's local key",
      { error },
    );
    const local = await loadKeyPair(userId);
    if (local) return { ...local, synced: false };
    const { publicKey, privateKeyJwk } = await generateKeyPair();
    return { privateKeyJwk, publicKey, synced: false };
  }
}

export const useE2E = (userId: string | undefined, partnerId: string | null) => {
  const [ready, setReady] = useState(false);
  const [partnerPublicKey, setPartnerPublicKey] = useState<string | null>(null);
  const [myKeys, setMyKeys] = useState<{ privateKeyJwk: JsonWebKey; publicKey: string } | null>(null);
  // FIX: track interval so we can clear it once key found
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Init or load own keys
  // RELIABILITY FIX: this async init() used to be invoked bare (`init()`,
  // no .catch()) right after a fresh sign-up/sign-in — exactly the moment
  // there's no existing keypair yet, so generateKeyPair()/saveKeyPair()
  // (IndexedDB via idbSet, see lib/keystore.ts) run for the first time on
  // this device. Any failure there (IndexedDB unavailable/blocked/quota,
  // a transient WebView storage error right after a cold native launch)
  // became an unhandled promise rejection with no recovery: `myKeys` never
  // got set, `ready` stayed false forever, and — because nothing ever
  // retried — E2E silently never worked for the rest of the session with
  // no user-visible signal beyond messages staying "[Encrypted]".
  //
  // ROOT-CAUSE FIX (this pass): the try/catch above was necessary but not
  // sufficient — it stopped the unhandled-rejection crash, but the comment
  // that used to sit here claimed the failure was "left in a state the
  // effect can retry from" when nothing in this file actually retried it.
  // `init()` ran exactly once per `userId`, so any single failure (a
  // one-off IndexedDB error, a transient network blip on the
  // `profiles.update` call) left `myKeys` — and therefore `ready` — false
  // for the rest of the session, with no path back to true short of a full
  // reload. Since Chat.tsx gates EVERY text send (`handleSend`) AND its
  // very first `fetchMessages()` call on `ready`, this alone was enough to
  // make the whole conversation look "stuck"/unsendable with only a
  // "Securing connection…" toast and no way to recover. Now retries with
  // capped exponential backoff, the same pattern already used a few lines
  // down for polling the partner's public key.
  //
  // ACCOUNT-WIDE KEY FIX (2026-09-20): init() now calls
  // resolveAccountIdentityKey() instead of the old "load local, else
  // generate fresh" logic — see that function's own doc comment.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const MAX_RETRY_DELAY_MS = 5000;

    // Best-effort: make this account's public key visible to the partner.
    // Kept OUT of the try/catch that gates `myKeys` — a failed profile
    // update must not stop this device from being able to encrypt/decrypt,
    // and it used to be silently ignored (the `{ error }` result of a
    // supabase update is never thrown), which left the partner stuck on
    // "Securing connection…" with nothing logged anywhere.
    const publishPublicKey = async (publicKey: string) => {
      for (let i = 0; i < 4 && !cancelled; i++) {
        try {
          const { error } = await supabase
            .from("profiles").update({ public_key: publicKey } as any).eq("user_id", userId);
          if (!error) return;
          logWarn("useE2E", "publishing public key failed — retrying", { error, i });
        } catch (error) {
          logWarn("useE2E", "publishing public key threw — retrying", { error, i });
        }
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
      }
    };

    // LOCAL-FIRST (2026-09-21): this used to ask Supabase for the account's
    // canonical key on EVERY launch and refuse to become `ready` until that
    // answered — so with no network the keys never loaded, nothing could be
    // decrypted or sent, and even online every launch paid a round trip before
    // the first message could be read. Now the copy this device already saved
    // is applied immediately (from IndexedDB, no network) and the server
    // lookup below only RECONCILES it: if the account's canonical key turns
    // out to differ (the multi-device case the account-wide-key fix handles),
    // the canonical one replaces it and `keyVersion` bumps so callers re-decrypt.
    const applyLocal = async () => {
      try {
        const local = await loadKeyPair(userId);
        if (local && !cancelled) setMyKeys((prev) => prev ?? { privateKeyJwk: local.privateKeyJwk, publicKey: local.publicKey });
      } catch { /* fall through to the network path */ }
    };

    const init = async () => {
      try {
        const keys = await resolveIdentityKeyWithFallback(userId);
        // Cache locally so the next app open on this same device takes
        // the fast IndexedDB-only path instead of round-tripping to
        // Supabase every time. Idempotent — a no-op if already cached.
        await saveKeyPair(userId, keys.privateKeyJwk, keys.publicKey);
        if (!cancelled) {
          // Keep the SAME object when nothing changed so encrypt/decrypt keep
          // a stable identity (Chat.tsx re-subscribes realtime on decrypt change).
          setMyKeys((prev) => (prev && prev.publicKey === keys.publicKey
            ? prev
            : { privateKeyJwk: keys.privateKeyJwk, publicKey: keys.publicKey }));
        }
        void publishPublicKey(keys.publicKey);
      } catch (error) {
        if (cancelled) return;
        logWarn("useE2E", "key init failed — retrying", { error, attempt });
        attempt += 1;
        // Offline there is nothing to retry against; poll gently instead of
        // burning the backoff schedule. Local keys (if any) already work.
        const delay = isOnlineNow() ? Math.min(1000 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS) : 15_000;
        retryTimer = setTimeout(init, delay);
      }
    };
    void applyLocal();
    init();
    return () => { cancelled = true; if (retryTimer) clearTimeout(retryTimer); };
  }, [userId]);

  // Partner public key: apply the cached copy at once (offline-first), then
  // confirm it with the server and keep polling ONLY until the first successful
  // server answer — same "stop once found" behaviour as before, just no longer
  // a precondition for being ready.
  useEffect(() => {
    if (!partnerId || !userId) return;
    let cancelled = false;
    let partnerKeyErrorLogged = false;
    const cacheKey = partnerKeyCacheKey(userId, partnerId);

    const cached = storage.get(cacheKey);
    // No cached key for THIS partner → clear whatever an earlier partner left in
    // state, so nothing is ever encrypted to (or decrypted with) the wrong key.
    setPartnerPublicKey(cached ?? null);

    const fetchKey = async () => {
      if (!isOnlineNow()) return; // next tick / reconnect will try again
      try {
        const { data, error: fetchError } = await supabase
          .from("profiles").select("public_key" as any).eq("user_id", partnerId).single();
        if (cancelled) return;
        if (fetchError && !partnerKeyErrorLogged) {
          // Logged once per mount so a permanent RLS/schema problem is
          // visible without spamming the log every 5s poll tick.
          partnerKeyErrorLogged = true;
          logWarn("useE2E", "partner public key query returned an error", { error: fetchError });
        }
        const fresh = (data as any)?.public_key as string | undefined;
        if (fresh) {
          // Server is authoritative: a changed key replaces the cached one.
          setPartnerPublicKey((prev) => (prev === fresh ? prev : fresh));
          storage.set(cacheKey, fresh);
          // FIX: stop polling once we have a server-confirmed key
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
        }
      } catch (error) {
        // Same reliability fix as the init() effect above — a bare await
        // here (e.g. a genuine network failure, not just a Postgrest
        // error) was an unhandled rejection on every 5s poll tick until
        // the partner's key was found. The next interval tick retries.
        if (!cancelled) logWarn("useE2E", "partner key fetch failed", { error });
      }
    };

    fetchKey();
    pollIntervalRef.current = setInterval(fetchKey, 5000);

    return () => {
      cancelled = true;
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [partnerId, userId]);

  // Bumps when the key material CHANGES after having been set (a reconcile
  // replaced a stale local/cached key). Callers that already decrypted with the
  // old key use it to decrypt again. Not bumped for the first load.
  const [keyVersion, setKeyVersion] = useState(0);
  const lastKeySigRef = useRef<string | null>(null);
  useEffect(() => {
    if (!myKeys || !partnerPublicKey) return;
    const sig = `${myKeys.publicKey}|${partnerPublicKey}`;
    if (lastKeySigRef.current !== null && lastKeySigRef.current !== sig) setKeyVersion((v) => v + 1);
    lastKeySigRef.current = sig;
  }, [myKeys, partnerPublicKey]);

  useEffect(() => {
    setReady(!!myKeys && !!partnerPublicKey);
  }, [myKeys, partnerPublicKey]);

  const encrypt = useCallback(async (text: string): Promise<string> => {
    if (!myKeys || !partnerPublicKey) return text;
    return encryptMessage(text, myKeys.privateKeyJwk, partnerPublicKey);
  }, [myKeys, partnerPublicKey]);

  // Latest-value refs so decrypt() can wait out a brief "keys not ready yet"
  // window without the polling loop below capturing stale closed-over
  // myKeys/partnerPublicKey from the render it was created on.
  const myKeysRef = useRef(myKeys);
  const partnerPublicKeyRef = useRef(partnerPublicKey);
  myKeysRef.current = myKeys;
  partnerPublicKeyRef.current = partnerPublicKey;

  // BUG FIX ("messages show [Encrypted] until app is closed and reopened"):
  // this used to bail to the placeholder the INSTANT either key was missing.
  // On reconnect (airplane mode off, app resume) fetchMessages() re-runs
  // immediately, but the E2E key exchange (an async Supabase round trip —
  // resolveAccountIdentityKey + the partner-key poll above) hasn't finished
  // yet at that exact moment, so every message in the page decrypted to the
  // placeholder — and because that decrypted text is exactly what gets
  // written into the on-device cache, the placeholder could even persist.
  // Closing/reopening "fixed" it only because by the next cold mount the
  // keys had finished syncing. Now: if the keys aren't ready yet, wait a
  // bounded amount of time for the in-flight exchange to finish (it usually
  // takes well under a second on a real reconnect) before actually giving up
  // and showing the placeholder.
  const DECRYPT_KEY_WAIT_MS = 5000;
  const decrypt = useCallback(async (text: string | null): Promise<string> => {
    if (!text) return "";
    if (!isEncrypted(text)) return text;
    if (!myKeysRef.current || !partnerPublicKeyRef.current) {
      const startedAt = Date.now();
      while (
        (!myKeysRef.current || !partnerPublicKeyRef.current) &&
        Date.now() - startedAt < DECRYPT_KEY_WAIT_MS
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
      }
    }
    const keys = myKeysRef.current;
    const partnerKey = partnerPublicKeyRef.current;
    if (!keys || !partnerKey) return "[🔒 Encrypted]";
    return decryptMessage(text, keys.privateKeyJwk, partnerKey);
  }, []);

  return {
    ready: ready && !!myKeys && !!partnerPublicKey,
    // Which half of the key exchange is still missing — lets the UI say
    // something more useful than a generic "please wait".
    hasOwnKeys: !!myKeys,
    hasPartnerKey: !!partnerPublicKey,
    keyVersion,
    encrypt,
    decrypt,
  };
};
