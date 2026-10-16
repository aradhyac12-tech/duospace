import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { useReauth } from "@/hooks/useReauth";

/**
 * Rendered by ConfirmActionDialog only when `authRequired` is true. It owns
 * the secret and hands the dialog a `verify()` to run on confirm, via
 * `registerVerify`, so the action never fires unless this resolves true.
 */
const ReauthField = ({
  registerVerify, onReadyChange, disabled,
}: {
  registerVerify: (fn: (() => Promise<boolean>) | null) => void;
  onReadyChange: (ready: boolean) => void;
  disabled?: boolean;
}) => {
  const { method, email, sendCode, verify } = useReauth();
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [codeSent, setCodeSent] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    registerVerify(async () => {
      const res = await verify(secret);
      setError(res.ok ? null : res.error ?? "Couldn't confirm it's you.");
      return res.ok;
    });
    return () => registerVerify(null);
  }, [registerVerify, verify, secret]);

  useEffect(() => {
    onReadyChange(method === "password" ? secret.length > 0 : codeSent && secret.length > 0);
  }, [method, secret, codeSent, onReadyChange]);

  const send = async () => {
    setSending(true);
    setError(null);
    const res = await sendCode();
    setSending(false);
    if (res.ok) setCodeSent(true); else setError(res.error ?? "Couldn't send the code.");
  };

  return (
    <div className="space-y-2 rounded-xl border border-border/60 p-3">
      {method === "password" ? (
        <>
          <label htmlFor="reauth-secret" className="text-[11px] font-medium text-muted-foreground">
            Enter your password to confirm
          </label>
          <Input
            id="reauth-secret" type="password" autoComplete="current-password" value={secret}
            onChange={(e) => { setSecret(e.target.value); setError(null); }} disabled={disabled}
          />
        </>
      ) : (
        <>
          <p className="text-[11px] text-muted-foreground">
            We'll email a 6-digit code to {email ?? "your email"} to confirm it's you.
          </p>
          {!codeSent ? (
            <Button type="button" variant="outline" size="sm" className="rounded-xl" disabled={sending || disabled} onClick={send}>
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Email me a code"}
            </Button>
          ) : (
            <Input
              id="reauth-secret" inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" value={secret}
              onChange={(e) => { setSecret(e.target.value); setError(null); }} disabled={disabled}
            />
          )}
        </>
      )}
      {error && <p role="alert" className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
};

export default ReauthField;
