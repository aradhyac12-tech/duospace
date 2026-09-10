import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Loader2, RefreshCw, CheckCircle2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/appClient";
import { Button } from "@/components/ui/button";
import { invokeEdgeFunction } from "@/lib/edgeFunction";

// Device A (already signed in) shows this: renders a rotating QR that encodes a
// short-lived pairing token issued by the issue-qr-token edge function.
// Device B scans and posts the token to redeem-qr-token to sign in.
// The QR payload is JSON:
//   { v: 1, kind: "duospace-qr-signin", token: "<pairing-token>", exp: "<iso>" }
//
// BUG FIX (this device never knew the QR had been scanned — "the display QR
// changes nothing"): there was no mechanism here at all for Device A to find
// out Device B had redeemed the token. It just kept showing/refreshing a QR
// forever, even after a successful scan on the other device, with nothing
// telling the person on THIS device to do anything next. Fixed by polling
// the new check-qr-token-status function (see that file for why this has to
// be a poll rather than a realtime table subscription — qr_pairing_tokens
// denies all client SELECT access, even to the row's own owner) every 2s
// while a token is showing, and surfacing a clear "Scanned ✓" state plus a
// new onRedeemed callback once it has been, so callers (Auth.tsx,
// DevicesSettings.tsx) can close the dialog / advance / refresh whatever
// list needs it, instead of leaving the person staring at a QR that already
// did its job.

interface QRSignInDisplayProps {
  onClose?: () => void;
  /**
   * Fired once the currently-displayed token has been scanned/redeemed by
   * the other device. `kind` distinguishes what actually happened:
   *  - "session" (device_pairing): the other device is now signed in.
   *  - "signup_invite": the other device was routed into signup — not
   *    actually linked as a partner yet (that happens when THEY finish
   *    creating their account), so don't imply completion here.
   *  - "anon_signup": someone (possibly unauthenticated themselves) scanned
   *    this device's pending-signup invite.
   */
  onRedeemed?: (kind: "session" | "signup_invite" | "anon_signup") => void;
  /**
   * device_pairing — the default. QR mints a session for the authed user on the
   *                  scanning device.
   * signup_invite  — QR routes the scanning (unauthed) device into the Sign Up
   *                  tab of the Auth screen. The scanning user creates their
   *                  own account via the normal supabase.auth.signUp flow.
   */
  mode?: "device_pairing" | "signup_invite";
}

const QRSignInDisplay = ({ onClose, onRedeemed, mode = "device_pairing" }: QRSignInDisplayProps) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [now, setNow] = useState<number>(Date.now());
  const [issuedMode, setIssuedMode] = useState<"device_pairing" | "signup_invite" | "anon_signup">(mode);
  const [redeemed, setRedeemed] = useState<{ kind: "session" | "signup_invite" | "anon_signup" } | null>(null);
  // The raw token currently on screen — kept in a ref (not state) purely so
  // the polling interval below always reads the latest value without
  // needing to be torn down/recreated every time mintAndRender() rotates it.
  const currentTokenRef = useRef<string | null>(null);

  const mintAndRender = async () => {
    setLoading(true);
    setError(null);
    setRedeemed(null);
    currentTokenRef.current = null;
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
      currentTokenRef.current = data.token as string;
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
  // Also skip once redeemed — nothing left to scan, no reason to keep
  // rotating tokens.
  useEffect(() => {
    if (!expiresAt || redeemed) return;
    if (typeof document !== "undefined" && document.hidden) return;
    const msLeft = expiresAt - Date.now() - 3000;
    if (msLeft <= 0) {
      mintAndRender();
      return;
    }
    const t = setTimeout(() => mintAndRender(), msLeft);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt, redeemed]);

  // Poll for redemption every 2s while a token is on screen — see the BUG
  // FIX comment at the top of this file for why this has to be a poll
  // rather than a realtime subscription. Stops polling (and stops
  // refreshing/expiring the QR) once redeemed, since there's nothing left
  // to scan. Skips while the tab is hidden, same rationale as the
  // auto-refresh effect above: a backgrounded screen shouldn't burn
  // through the rate limit.
  useEffect(() => {
    if (!expiresAt || redeemed) return;
    let cancelled = false;
    const poll = async () => {
      const token = currentTokenRef.current;
      if (!token) return;
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const res = await invokeEdgeFunction<{ redeemed: boolean; kind?: string }>(
          "check-qr-token-status",
          { body: { token }, retry: false, timeoutMs: 8000 },
        );
        if (cancelled) return;
        // Guard against a stale response landing after mintAndRender()
        // already rotated to a new token (e.g. the poll was in flight when
        // the 90s device_pairing token expired and refreshed).
        if (res.redeemed && currentTokenRef.current === token) {
          const kind = (res.kind as "session" | "signup_invite" | "anon_signup" | undefined) ?? "session";
          setRedeemed({ kind });
          onRedeemed?.(kind);
        }
      } catch {
        // Best-effort — a missed poll just means the next 2s tick tries
        // again; never surface a status-check failure as if the QR itself
        // broke.
      }
    };
    const t = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt, redeemed]);

  // Re-mint immediately when the tab becomes visible again if the current
  // token has already expired while we were paused.
  useEffect(() => {
    if (typeof document === "undefined" || redeemed) return;
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

  // Copy per token kind — "redeemed" means genuinely different things
  // depending on what this QR was for (see the onRedeemed prop doc above),
  // so this doesn't claim more than what actually just happened.
  const redeemedCopy = redeemed && {
    session: { title: "New device signed in ✓", body: "Your other device is now signed in to this account." },
    signup_invite: { title: "Scanned ✓", body: "They're creating their account on the other device now." },
    anon_signup: { title: "Linked ✓", body: "They'll be your partner as soon as they finish signing up." },
  }[redeemed.kind];

  if (redeemed && redeemedCopy) {
    return (
      <div className="flex flex-col items-center gap-4 py-4">
        <div className="relative rounded-2xl bg-white p-4 shadow-sm border border-border h-[272px] w-[272px] flex items-center justify-center">
          <CheckCircle2 className="h-16 w-16 text-primary" aria-hidden="true" />
        </div>
        <div className="text-center max-w-[280px] space-y-1">
          <p className="text-sm font-medium">{redeemedCopy.title}</p>
          <p className="text-xs text-muted-foreground">{redeemedCopy.body}</p>
        </div>
        {onClose && (
          <Button size="sm" onClick={onClose} className="rounded-full">
            Done
          </Button>
        )}
      </div>
    );
  }

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
