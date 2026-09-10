import { useEffect, useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/appClient";
import {
  generateKeyPair, saveKeyPair, loadKeyPair,
  encryptMessage, decryptMessage, isEncrypted,
} from "@/lib/crypto";
import { logWarn } from "@/lib/telemetry";

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
  // no user-visible signal beyond messages staying "[Encrypted]". Wrapped
  // in try/catch so a failure is caught, logged, and left in a state the
  // effect can retry from (not swallowed into a state no one observes).
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const init = async () => {
      try {
        let keys = await loadKeyPair(userId);
        if (!keys) {
          const { publicKey, privateKeyJwk } = await generateKeyPair();
          keys = { privateKeyJwk, publicKey };
          await saveKeyPair(userId, privateKeyJwk, publicKey);
        }
        await supabase.from("profiles").update({ public_key: keys.publicKey } as any).eq("user_id", userId);
        if (!cancelled) setMyKeys(keys);
      } catch (error) {
        if (!cancelled) logWarn("useE2E", "key init failed", { error });
      }
    };
    init();
    return () => { cancelled = true; };
  }, [userId]);

  // Fetch partner public key; stop polling once found
  useEffect(() => {
    if (!partnerId) return;
    let cancelled = false;

    const fetchKey = async () => {
      try {
        const { data } = await supabase
          .from("profiles").select("public_key" as any).eq("user_id", partnerId).single();
        if (cancelled) return;
        if ((data as any)?.public_key) {
          setPartnerPublicKey((data as any).public_key);
          // FIX: stop polling once we have the key
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
    // Only start interval if we don't already have the key
    pollIntervalRef.current = setInterval(fetchKey, 5000);

    return () => {
      cancelled = true;
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [partnerId]);

  useEffect(() => {
    setReady(!!myKeys && !!partnerPublicKey);
  }, [myKeys, partnerPublicKey]);

  const encrypt = useCallback(async (text: string): Promise<string> => {
    if (!myKeys || !partnerPublicKey) return text;
    return encryptMessage(text, myKeys.privateKeyJwk, partnerPublicKey);
  }, [myKeys, partnerPublicKey]);

  const decrypt = useCallback(async (text: string | null): Promise<string> => {
    if (!text) return "";
    if (!isEncrypted(text)) return text;
    if (!myKeys || !partnerPublicKey) return "[🔒 Encrypted]";
    return decryptMessage(text, myKeys.privateKeyJwk, partnerPublicKey);
  }, [myKeys, partnerPublicKey]);

  return { ready: ready && !!myKeys && !!partnerPublicKey, encrypt, decrypt };
};
