import { useEffect, useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  generateKeyPair, saveKeyPair, loadKeyPair,
  encryptMessage, decryptMessage, isEncrypted,
} from "@/lib/crypto";

export const useE2E = (userId: string | undefined, partnerId: string | null) => {
  const [ready, setReady] = useState(false);
  const [partnerPublicKey, setPartnerPublicKey] = useState<string | null>(null);
  const [myKeys, setMyKeys] = useState<{ privateKeyJwk: JsonWebKey; publicKey: string } | null>(null);
  // FIX: track interval so we can clear it once key found
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Init or load own keys
  useEffect(() => {
    if (!userId) return;
    const init = async () => {
      let keys = await loadKeyPair(userId);
      if (!keys) {
        const { publicKey, privateKeyJwk } = await generateKeyPair();
        keys = { privateKeyJwk, publicKey };
        await saveKeyPair(userId, privateKeyJwk, publicKey);
      }
      await supabase.from("profiles").update({ public_key: keys.publicKey } as any).eq("user_id", userId);
      setMyKeys(keys);
    };
    init();
  }, [userId]);

  // Fetch partner public key; stop polling once found
  useEffect(() => {
    if (!partnerId) return;
    let cancelled = false;

    const fetchKey = async () => {
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
