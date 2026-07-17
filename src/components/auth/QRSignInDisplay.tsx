import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Loader2, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { invokeEdgeFunction } from "@/lib/edgeFunction";

// Device A (already signed in) shows this: renders a rotating QR that encodes a
// short-lived pairing token issued by the issue-qr-token edge function.
// Device B scans and posts the token to redeem-qr-token to sign in.
// The QR payload is JSON:
//   { v: 1, kind: "duospace-qr-signin", token: "<pairing-token>", exp: "<iso>" }

interface QRSignInDisplayProps {
  onClose?: () => void;
  /**
   * device_pairing — the default. QR mints a session for the authed user on the
   *                  scanning device.
   * signup_invite  — QR routes the scanning (unauthed) device into the Sign Up
   *                  tab of the Auth screen. The scanning user creates their
   *                  own account via the normal supabase.auth.signUp flow.
   */
  mode?: "device_pairing" | "signup_invite";
}

const QRSignInDisplay = ({ onClose, mode = "device_pairing" }: QRSignInDisplayProps) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [now, setNow] = useState<number>(Date.now());
  const [issuedMode, setIssuedMode] = useState<"device_pairing" | "signup_invite" | "anon_signup">(mode);

  const mintAndRender = async () => {
    setLoading(true);
    setError(null);
    try {
      // Check auth. If signed in, use the authed issuer (device_pairing or
      // signup_invite). If not, fall back to the anonymous signup issuer so a
      // brand-new user can still show a QR to a partner who already has an
      // account. The anon path never mints a session — it only enables
      // partner auto-link once the issuing device finishes signup.
      const { data: sessionData } = await supabase.auth.getSession();
      const isAuthed = !!sessionData?.session;
      const effectiveMode: "device_pairing" | "signup_invite" | "anon_signup" =
        isAuthed ? mode : "anon_signup";
      setIssuedMode(effectiveMode);

      const fnName = isAuthed ? "issue-qr-token" : "qr-anon-issue";
      const body = isAuthed ? { token_type: mode } : {};
      const data = await invokeEdgeFunction<{ token?: string; expires_at?: string }>(fnName, { body });
      if (!data?.token) throw new Error("No sign-in token was returned. Please try again.");


      const payload = JSON.stringify({
        v: 1,
        kind: "duospace-qr-signin",
        token: data.token as string,
        exp: data.expires_at as string,
      });

      if (canvasRef.current) {
        await QRCode.toCanvas(canvasRef.current, payload, {
          errorCorrectionLevel: "M",
          margin: 1,
          width: 240,
          color: { dark: "#0F0F0F", light: "#FFFFFF" },
        });
      }
      setExpiresAt(new Date(data.expires_at as string).getTime());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load QR");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    mintAndRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-refresh 3s before expiry. Skip while the tab is hidden so a
  // backgrounded QR screen doesn't burn through the per-user rate limit.
  useEffect(() => {
    if (!expiresAt) return;
    if (typeof document !== "undefined" && document.hidden) return;
    const msLeft = expiresAt - Date.now() - 3000;
    if (msLeft <= 0) {
      mintAndRender();
      return;
    }
    const t = setTimeout(() => mintAndRender(), msLeft);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt]);

  // Re-mint immediately when the tab becomes visible again if the current
  // token has already expired while we were paused.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVis = () => {
      if (!document.hidden && expiresAt && expiresAt - Date.now() < 3000) {
        mintAndRender();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt]);

  // 1Hz tick for countdown display.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const secondsLeft = expiresAt
    ? Math.max(0, Math.round((expiresAt - now) / 1000))
    : null;

  return (
    <div className="flex flex-col items-center gap-4 py-4">
      <div className="relative rounded-2xl bg-white p-4 shadow-sm border border-border">
        <canvas
          ref={canvasRef}
          width={240}
          height={240}
          aria-label="Sign-in QR code"
          className={loading && !expiresAt ? "opacity-0" : "opacity-100"}
        />
        {loading && !expiresAt && (
          <div className="absolute inset-4 flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>
      {error ? (
        <p className="text-xs text-destructive text-center max-w-[280px]">
          {error}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground text-center max-w-[280px]">
          Scan with the DuoSpace sign-in scanner on your other device.
          {secondsLeft !== null && (
            <> Refreshes in <span className="font-medium">{secondsLeft}s</span>.</>
          )}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={mintAndRender}
          disabled={loading}
          className="gap-2"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Regenerate
        </Button>
        {onClose && (
          <Button size="sm" variant="ghost" onClick={onClose}>
            Done
          </Button>
        )}
      </div>
    </div>
  );
};

export default QRSignInDisplay;
