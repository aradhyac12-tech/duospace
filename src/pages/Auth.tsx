import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdgeFunction } from "@/lib/edgeFunction";
import { buildAuthRedirectUri, getAuthPlatform, isNativePlatform } from "@/lib/auth-redirect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import storage from "@/lib/storage";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2, QrCode } from "lucide-react";
import { useNavigate } from "react-router-dom";
import QRSignInScanner from "@/components/auth/QRSignInScanner";
import QRSignInDisplay from "@/components/auth/QRSignInDisplay";
import PasskeyLogin from "@/components/auth/PasskeyLogin";
import { logInfo, logWarn, logError, newTraceId } from "@/lib/telemetry";
import { cleanAuthCallbackUrl, completeAuthCallback, getPostAuthPath, hasAuthCallback, parseAuthCallbackUrl } from "@/lib/auth-callback";
import { hapticLight, hapticMedium } from "@/lib/haptics";
import { openExternalUrl, closeExternalBrowser } from "@/lib/nativeBrowser";


// Structured-logging helpers for the auth surface.
// We deliberately log: request_id (traceId), origin, redirect_uri, status (ok|error|redirected),
// provider, and the supabase error.status / error.code / error.name when present.
// Email is NEVER logged in plaintext — only a sha-style hash prefix for correlation.
const hashEmail = async (email: string): Promise<string> => {
  try {
    const buf = new TextEncoder().encode(email.trim().toLowerCase());
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest)).slice(0, 6)
      .map(b => b.toString(16).padStart(2, "0")).join("");
  } catch { return "unknown"; }
};
const supaErr = (e: unknown) => {
  if (!e || typeof e !== "object") return { message: String(e) };
  const err = e as { message?: string; status?: number; code?: string; name?: string };
  return { message: err.message, status: err.status, code: err.code, name: err.name };
};
const readableError = (e: unknown) => {
  if (!e) return "Something went wrong";
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && "message" in e) return String((e as { message?: unknown }).message ?? e);
  return String(e);
};

// Soft ambient glow behind the auth screens — theme-aware (uses the
// primary/accent CSS vars so it matches whichever preset/mode is active),
// purely decorative, shared across the main form, OAuth-loading, and
// forgot-password states so they feel like one consistent screen rather
// than three differently-flat ones.
const AmbientGlow = () => (
  <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
    <div className="absolute -top-24 -left-16 h-72 w-72 rounded-full blur-3xl opacity-25" style={{ background: "hsl(var(--primary))" }} />
    <div className="absolute -bottom-32 -right-20 h-80 w-80 rounded-full blur-3xl opacity-20" style={{ background: "hsl(var(--accent))" }} />
  </div>
);

const Auth = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotLoading, setForgotLoading] = useState(false);
  const [oauthProcessing, setOauthProcessing] = useState(false);
  const [showQrScanner, setShowQrScanner] = useState(false);
  const [qrPanel, setQrPanel] = useState<"scan" | "display">("scan");
  const [authTab, setAuthTab] = useState<"login" | "signup">("login");
  const { toast } = useToast();
  const navigate = useNavigate();

  // Handle OAuth callback - check for hash fragments or query params indicating a callback
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const inviteCode = params.get("invite");

    if (inviteCode) {
      sessionStorage.setItem("duo-pending-invite", inviteCode.toUpperCase());
    }

    if (hasAuthCallback()) {
      const traceId = newTraceId("oauth_cb");
      let cancelled = false;
      setOauthProcessing(true);
      const parsed = parseAuthCallbackUrl();

      logInfo("auth.oauth", "callback received", {
        request_id: traceId,
        origin: window.location.origin,
        has_access_token: Boolean(parsed.get("access_token")),
        has_code: Boolean(parsed.get("code")),
        has_error: Boolean(parsed.get("error") || parsed.get("error_description")),
      }, traceId);

      const finalizeOAuth = async () => {
        try {
          const result = await completeAuthCallback();
          if (cancelled) return;
          if (result.session) {
            logInfo("auth.oauth", "session established via callback finalizer", {
              request_id: traceId, status: "ok", user_id: result.session.user.id,
              callback_type: result.type,
            }, traceId);
            const next = result.type === "recovery" ? "/reset-password" : getPostAuthPath();
            cleanAuthCallbackUrl(window.location.pathname);
            setOauthProcessing(false);
            navigate(next, { replace: true });
            return;
          }
          logError("auth.oauth", "callback finalizer returned no session", {
            request_id: traceId, origin: window.location.origin, status: "no_session",
          }, traceId);
          toast({ title: "Sign in failed", description: "No session was returned. Please try again.", variant: "destructive" });
        } catch (error) {
          if (cancelled) return;
          logError("auth.oauth", "callback finalizer failed", {
            request_id: traceId, origin: window.location.origin, status: "error", error: supaErr(error),
          }, traceId);
          toast({ title: "Sign in failed", description: readableError(error), variant: "destructive" });
        } finally {
          if (!cancelled) {
            cleanAuthCallbackUrl(window.location.pathname);
            setOauthProcessing(false);
          }
        }
      };

      finalizeOAuth();

      return () => {
        cancelled = true;
      };
    }
  }, [navigate, toast]);

  // Native deep link OAuth callback (Android/iOS): the system browser redirects
  // back into the app via the "duospace://auth" custom URL scheme. Capacitor's
  // App plugin delivers the full callback URL directly — it never touches
  // window.location/history, so the web callback effect above cannot see it.
  useEffect(() => {
    if (!isNativePlatform()) return;
    let cancelled = false;
    let sub: { remove: () => void } | undefined;
    // Guards against duplicate exchangeCodeForSession() calls: Android can
    // redeliver the same appUrlOpen event (e.g. onNewIntent firing more than
    // once), and a cold start can hand the same callback URL to BOTH
    // getLaunchUrl() and the very first appUrlOpen event. A PKCE code is
    // single-use — a second exchange attempt for the same code fails and
    // would surface a spurious "Sign in failed" error even though the first
    // attempt already succeeded. Track which codes we've started exchanging
    // (module scope isn't needed since this ref only needs to survive this
    // component instance) and short-circuit any repeat.
    const processedCodes = new Set<string>();
    let inFlight = false;

    const closeInAppBrowser = async () => {
      await closeExternalBrowser();
    };


    const handleDeepLinkUrl = async (url: string, source: "appUrlOpen" | "getLaunchUrl") => {
        const traceId = newTraceId("oauth_cb_native");
        const receivedAt = Date.now();
        try {
          const parsed = parseAuthCallbackUrl(url);
          const code = parsed.get("code");
          const errorDesc = parsed.get("error_description") || parsed.get("error");
          const isPasswordRecovery = parsed.get("type") === "recovery" || url.includes("reset-password");

          logInfo("auth.deeplink", "deep link received", {
            request_id: traceId,
            source,
            received_at: receivedAt,
            platform: getAuthPlatform(),
            raw_scheme: parsed.url.protocol.replace(":", ""),
            raw_host: parsed.url.host,
            raw_pathname: parsed.url.pathname,
            has_code: Boolean(code),
            has_access_token: Boolean(parsed.get("access_token")),
            has_refresh_token: Boolean(parsed.get("refresh_token")),
            callback_type: parsed.get("type"),
            is_password_recovery: isPasswordRecovery,
            has_error: Boolean(errorDesc),
          }, traceId);

          if (code || errorDesc || parsed.get("access_token")) {
            logInfo("auth.deeplink", "callback detected", {
              request_id: traceId, source, kind: code ? "code" : errorDesc ? "error" : "implicit_tokens",
            }, traceId);
          }

          if (errorDesc) {
            logError("auth.deeplink", "provider returned error in deep link", {
              request_id: traceId, error: errorDesc,
            }, traceId);
            toast({ title: "Sign in failed", description: errorDesc, variant: "destructive" });
            await closeInAppBrowser();
            return;
          }

          const dedupeKey = code ?? url;
          if (processedCodes.has(dedupeKey)) {
            logWarn("auth.deeplink", "duplicate callback ignored (already processed)", {
              request_id: traceId, source, has_code: Boolean(code),
            }, traceId);
            await closeInAppBrowser();
            return;
          }
          if (inFlight) {
            logWarn("auth.deeplink", "duplicate callback ignored (exchange already in flight)", {
              request_id: traceId, source,
            }, traceId);
            return;
          }
          processedCodes.add(dedupeKey);
          inFlight = true;

          setOauthProcessing(true);
          const t0 = performance.now();
          // Timeout so a stalled network request (e.g. right after the
          // browser->app handoff on flaky mobile connections) can never
          // leave the user stuck on "Completing sign in" forever.
          const timeoutMs = 20000;
          const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs));
          const outcome = await Promise.race([completeAuthCallback(url, traceId), timeout]);
          const duration_ms = Math.round(performance.now() - t0);
          if (outcome === "timeout") {
            logError("auth.deeplink", "exchangeCodeForSession timed out", {
              request_id: traceId, duration_ms, timeout_ms: timeoutMs,
            }, traceId);
            if (!cancelled) {
              toast({ title: "Sign in timed out", description: "Please check your connection and try again.", variant: "destructive" });
              setOauthProcessing(false);
            }
            await closeInAppBrowser();
            return;
          }
          const result = outcome;
          if (!cancelled) {
            if (result.session) {
              logInfo("auth.deeplink", "native session established", {
                request_id: traceId, status: "ok", duration_ms,
                user_id: result.session.user.id,
                callback_type: result.type,
                expires_at: result.session.expires_at,
              }, traceId);
              const destination = isPasswordRecovery ? "/reset-password" : getPostAuthPath(url);
              logInfo("auth.deeplink", "navigating after session creation", {
                request_id: traceId, destination, user_id: result.session.user.id,
              }, traceId);
              navigate(destination, { replace: true });
            } else {
              logError("auth.deeplink", "callback finalized with no session", {
                request_id: traceId, duration_ms,
              }, traceId);
              toast({ title: "Sign in failed", description: "No session was returned. Please try again.", variant: "destructive" });
            }
            setOauthProcessing(false);
          }
        } catch (err) {
          logError("auth.deeplink", "deep link handler threw", { request_id: traceId, source, err: supaErr(err) }, traceId);
          if (!cancelled) {
            toast({ title: "Sign in failed", description: readableError(err), variant: "destructive" });
            setOauthProcessing(false);
          }
        } finally {
          inFlight = false;
        }
        await closeInAppBrowser();
    };

    // Two delivery paths, both required:
    //  1) appUrlOpen — fires while the app is alive (foreground/background)
    //     when the OS hands it the duospace:// callback.
    //  2) getLaunchUrl — covers the case where the OS killed the app while
    //     the user was on Google's consent screen (common under memory
    //     pressure). The app is then cold-launched BY the duospace://
    //     callback itself, and that launch can complete — Capacitor bridge
    //     ready, event dispatched — before this component mounts and
    //     subscribes, so appUrlOpen alone can silently miss it. Checking
    //     getLaunchUrl() once on mount catches that case.
    const setup = async () => {
      const { App } = await import("@capacitor/app");
      logInfo("auth.deeplink", "appUrlOpen listener registered", {
        platform: getAuthPlatform(),
      });
      sub = await App.addListener("appUrlOpen", ({ url }) => {
        void handleDeepLinkUrl(url, "appUrlOpen");
      });

      try {
        const launch = await App.getLaunchUrl();
        if (!cancelled && launch?.url && hasAuthCallback(launch.url)) {
          logInfo("auth.deeplink", "cold-start launch URL contains auth callback", {
            platform: getAuthPlatform(),
          });
          await handleDeepLinkUrl(launch.url, "getLaunchUrl");
        }
      } catch {
        /* getLaunchUrl not supported on this platform/version — appUrlOpen still covers the live case */
      }
    };

    setup();

    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [navigate, toast]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) return;
    const traceId = newTraceId("signin");
    const emailHash = await hashEmail(email);
    setLoading(true);
    logInfo("auth.signin", "token exchange start", {
      request_id: traceId, origin: window.location.origin, email_hash: emailHash,
    }, traceId);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) {
        logError("auth.signin", "token exchange failed", {
          request_id: traceId, email_hash: emailHash, status: "error", supabase_error: supaErr(error),
        }, traceId);
        toast({ title: "Couldn't sign in", description: error.message, variant: "destructive" });
      } else {
        logInfo("auth.signin", "token exchange ok", {
          request_id: traceId, email_hash: emailHash, status: "ok", user_id: data.user?.id,
        }, traceId);
      }
    } catch (err: unknown) {
      logError("auth.signin", "token exchange threw", {
        request_id: traceId, email_hash: emailHash, status: "exception", err: supaErr(err),
      }, traceId);
      toast({ title: "Sign in error", description: (err instanceof Error ? err.message : String(err)), variant: "destructive" });
    }
    setLoading(false);
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim() || !displayName.trim()) return;
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      toast({
        title: "Weak password",
        description: "Use at least 8 characters with letters and numbers.",
        variant: "destructive",
      });
      return;
    }
    const traceId = newTraceId("signup");
    const emailHash = await hashEmail(email);
    let redirectUri = "";
    setLoading(true);
    try {
      redirectUri = buildAuthRedirectUri("email_confirm");
      logInfo("auth.signup", "token exchange start", {
        request_id: traceId, origin: window.location.origin,
        platform: getAuthPlatform(),
        redirect_uri: redirectUri, email_hash: emailHash,
      }, traceId);
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: {
            full_name: displayName.trim(),
            qr_inviter_id: sessionStorage.getItem("duo-pending-qr-inviter") ?? undefined,
          },
          emailRedirectTo: redirectUri,
        },
      });
      if (error) {
        logError("auth.signup", "token exchange failed", {
          request_id: traceId, email_hash: emailHash, redirect_uri: redirectUri,
          status: "error", supabase_error: supaErr(error),
        }, traceId);
        toast({ title: "Couldn't sign up", description: error.message, variant: "destructive" });
      } else {
        logInfo("auth.signup", "token exchange ok", {
          request_id: traceId, email_hash: emailHash, status: "ok",
          user_id: data.user?.id, needs_confirmation: !data.session,
        }, traceId);
        // If we just completed signup from an anon QR flow (issuer side) or
        // a signup_invite QR (scanner side), auto-link the pending partner.
        if (data.user?.id) {
          try {
            await supabase.rpc("complete_qr_pending_link", { _user_id: data.user.id });
            const inviter = sessionStorage.getItem("duo-pending-qr-inviter");
            if (inviter) {
              await supabase.rpc("link_partners", { _a: data.user.id, _b: inviter });
              sessionStorage.removeItem("duo-pending-qr-inviter");
            }
          } catch (e) { logWarn("auth.signup", "auto-link skipped", { err: supaErr(e) }, traceId); }
        }

        // AUTH-EMAIL FIX: this project has no SMTP/email provider configured,
        // so Supabase's own confirmation email never arrives and accounts
        // used to get stuck forever waiting on it. When signUp() comes back
        // needing confirmation (no session yet), immediately finish it
        // server-side instead of waiting on that email.
        if (!data.session && data.user?.id) {
          try {
            const tokens = await invokeEdgeFunction<{
              access_token: string; refresh_token: string;
            }>("complete-signup", { body: { user_id: data.user.id, email: email.trim() } });
            const { error: sessErr } = await supabase.auth.setSession(tokens);
            if (sessErr) throw sessErr;
            toast({ title: "Account created", description: "Welcome to DuoSpace." });
          } catch (completeErr) {
            logError("auth.signup", "complete-signup failed", {
              request_id: traceId, email_hash: emailHash, err: supaErr(completeErr),
            }, traceId);
            toast({ title: "Check your email", description: "We sent you a confirmation link." });
          }
        } else {
          toast({ title: "Account created", description: "Welcome to DuoSpace." });
        }
      }

    } catch (err: unknown) {
      logError("auth.signup", "token exchange threw", {
        request_id: traceId, email_hash: emailHash, redirect_uri: redirectUri,
        status: "exception", err: supaErr(err),
      }, traceId);
      toast({ title: "Sign up error", description: (err instanceof Error ? err.message : String(err)), variant: "destructive" });
    }
    setLoading(false);
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!forgotEmail.trim()) return;
    const traceId = newTraceId("pwreset");
    const emailHash = await hashEmail(forgotEmail);
    let redirectTo = "";
    setForgotLoading(true);
    try {
      redirectTo = buildAuthRedirectUri("password_reset");
      logInfo("auth.pwreset", "request start", {
        request_id: traceId, origin: window.location.origin,
        platform: getAuthPlatform(),
        redirect_uri: redirectTo, email_hash: emailHash,
      }, traceId);
      const { error } = await supabase.auth.resetPasswordForEmail(forgotEmail.trim(), { redirectTo });
      if (error) {
        logError("auth.pwreset", "request failed", {
          request_id: traceId, email_hash: emailHash, redirect_uri: redirectTo,
          status: "error", supabase_error: supaErr(error),
        }, traceId);
        toast({ title: "Failed", description: error.message, variant: "destructive" });
      } else {
        logInfo("auth.pwreset", "request ok", {
          request_id: traceId, email_hash: emailHash, status: "ok",
        }, traceId);
        toast({ title: "Reset link sent", description: "Check your email for the reset link." });
        setShowForgot(false);
      }
    } catch (err: unknown) {
      logError("auth.pwreset", "request threw", {
        request_id: traceId, email_hash: emailHash, redirect_uri: redirectTo,
        status: "exception", err: supaErr(err),
      }, traceId);
      toast({ title: "Error", description: (err instanceof Error ? err.message : String(err)), variant: "destructive" });
    }
    setForgotLoading(false);
  };

  // Root cause of the Google/Apple "404 Page Not Found": this app previously
  // initiated OAuth through `@lovable.dev/cloud-auth-js`'s hosted proxy
  // (`lovable.auth.signInWithOAuth`), which sends the browser to a Lovable
  // Cloud endpoint rather than Supabase's own `/auth/v1/authorize` endpoint.
  // For a project that isn't actively served through the Lovable Cloud proxy,
  // that endpoint 404s immediately on click — before the provider's consent
  // screen ever loads. Supabase Auth already has Google and Apple configured
  // as providers (those credentials are untouched); the fix is to initiate
  // the flow with Supabase's own, correctly-routed `signInWithOAuth`.
  const startOAuth = async (provider: "google", extraQueryParams?: Record<string, string>) => {
    const traceId = newTraceId(`oauth_${provider}`);
    try {
      const redirectUri = buildAuthRedirectUri("oauth");
      logInfo("auth.oauth", "initiate", {
        request_id: traceId, provider,
        platform: getAuthPlatform(),
        origin: window.location.origin, redirect_uri: redirectUri,
      }, traceId);
      // Native (Capacitor): don't let supabase-js redirect the in-app
      // WebView (that's what produced the earlier "redirect_uri is not
      // allowed" / dead-end 404 on native, since the WebView origin is
      // https://localhost). Instead, fetch the provider URL without
      // redirecting, then hand it to the system browser. The existing
      // `appUrlOpen` listener (native deep-link effect above) picks up the
      // `duospace://auth` callback once the provider redirects back.
      if (isNativePlatform()) {
        const { data, error } = await supabase.auth.signInWithOAuth({
          provider,
          options: {
            redirectTo: redirectUri,
            skipBrowserRedirect: true,
            queryParams: extraQueryParams,
          },
        });
        if (error) throw error;
        if (!data?.url) throw new Error("No authorization URL returned");
        // Log the exact URL we're about to hand to the system browser — this
        // is what actually gets sent to Supabase's /authorize endpoint (and
        // from there to Google), so the real redirect_to param can be
        // confirmed from logs instead of assumed from source code. Redact
        // anything that looks like a secret/token, keep everything else
        // (including redirect_to) intact for debugging.
        try {
          const outgoing = new URL(data.url);
          const redacted = new URL(data.url);
          for (const k of Array.from(redacted.searchParams.keys())) {
            if (/token|secret|key|code/i.test(k)) redacted.searchParams.set(k, "<redacted>");
          }
          logInfo("auth.oauth", "authorization URL received from supabase", {
            request_id: traceId, provider,
            host: outgoing.host,
            path: outgoing.pathname,
            redirect_to_param: outgoing.searchParams.get("redirect_to"),
            full_url_redacted: redacted.toString(),
          }, traceId);
        } catch {
          /* URL parsing failed — non-fatal, proceed to open browser regardless */
        }
        // openExternalUrl() falls back to a top-level navigation when the
        // native @capacitor/browser plugin isn't registered in the APK
        // ("Browser" plugin is not implemented on android) — the OAuth flow
        // must never die just because the in-app browser is unavailable.
        const how = await openExternalUrl(data.url);
        logInfo("auth.oauth", "opened system browser", { request_id: traceId, provider, status: "redirected", via: how }, traceId);

        return;
      }

      // Web: let supabase-js perform the standard top-level redirect to
      // Supabase's /auth/v1/authorize endpoint, which forwards to the
      // provider's real consent screen and back to redirectUri.
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: redirectUri,
          queryParams: extraQueryParams,
        },
      });
      if (error) throw error;
      logInfo("auth.oauth", "redirected to provider", {
        request_id: traceId, provider, status: "redirected", redirect_uri: redirectUri,
      }, traceId);
    } catch (err: unknown) {
      logError("auth.oauth", "initiate failed", {
        request_id: traceId, provider,
        status: "error", err: supaErr(err),
      }, traceId);
      const label = "Google";
      toast({
        title: `${label} sign-in failed`,
        description: readableError(err) || "Unable to start sign-in. Please check your internet connection or try again later.",
        variant: "destructive",
      });
      throw err;
    }
  };

  const handleGoogleLogin = async () => {
    if (googleLoading) return;
    setGoogleLoading(true);
    try {
      await startOAuth("google", { prompt: "select_account" });
    } catch {
      /* toast already shown in startOAuth */
    }
    setGoogleLoading(false);
  };


  // OAuth processing state
  if (oauthProcessing) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-6 relative overflow-hidden">
        <AmbientGlow />
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className="text-center space-y-5 max-w-xs relative z-10"
        >
          <div className="relative mx-auto h-16 w-16">
            <motion.div
              className="absolute inset-0 rounded-full border-2 border-primary/20"
              animate={{ scale: [1, 1.15, 1], opacity: [0.6, 0, 0.6] }}
              transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }}
            />
            <motion.div
              className="absolute inset-0 rounded-full border-2 border-primary/10"
              animate={{ scale: [1, 1.35, 1], opacity: [0.4, 0, 0.4] }}
              transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut", delay: 0.4 }}
            />
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="h-7 w-7 animate-spin text-primary" />
            </div>
          </div>
          <div className="space-y-1.5">
            <p className="text-base font-medium text-foreground">Completing sign in</p>
            <p className="text-xs text-muted-foreground">Verifying your credentials, one moment…</p>
          </div>
          <div className="flex justify-center gap-1.5">
            {[0, 1, 2].map(i => (
              <motion.div
                key={i}
                className="h-1.5 w-1.5 rounded-full bg-primary/50"
                animate={{ opacity: [0.3, 1, 0.3], scale: [0.8, 1.1, 0.8] }}
                transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.15 }}
              />
            ))}
          </div>
        </motion.div>
      </div>
    );
  }


  // Forgot password overlay
  if (showForgot) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-6 relative overflow-hidden">
        <AmbientGlow />
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-sm space-y-6 relative z-10">
          <div className="text-center space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Reset Password</h1>
            <p className="text-sm text-muted-foreground">Enter your email to receive a reset link</p>
          </div>
          <form onSubmit={handleForgotPassword} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="forgot-email" className="text-[11px] text-muted-foreground uppercase tracking-wider">Email</Label>
              <Input id="forgot-email" type="email" value={forgotEmail} onChange={(e) => setForgotEmail(e.target.value)}
                placeholder="you@example.com" className="h-11 rounded-xl bg-card border-border" required autoFocus />
            </div>
            <Button type="submit" disabled={forgotLoading}
              className="w-full h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-medium">
              {forgotLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send Reset Link"}
            </Button>
          </form>
          <button onClick={() => { hapticLight(); setShowForgot(false); }} className="block mx-auto text-sm text-muted-foreground hover:text-foreground transition-colors">
            Back to Sign In
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-6 relative overflow-hidden">
      <AmbientGlow />
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-sm space-y-6 relative z-10"
      >
        <div className="text-center space-y-1">
          {/* Show custom app icon if set */}
          {(() => {
            const icon = storage.get("duo-app-icon");
            const name = storage.get("duo-app-name") || "DuoSpace";
            return icon ? (
              <div className="flex flex-col items-center gap-3 mb-2">
                <img src={icon} alt={name} className="h-16 w-16 rounded-2xl object-cover shadow-[0_8px_30px_rgba(0,0,0,0.12)] ring-1 ring-border/40 mx-auto" />
                <h1 className="text-3xl font-semibold tracking-tight">{name}</h1>
              </div>
            ) : (
              <h1 className="text-3xl font-semibold tracking-tight">{name}</h1>
            );
          })()}
          <p className="text-sm text-muted-foreground">A private space for two</p>
        </div>

        {/* Social login */}
        <div className="space-y-2">
          <Button
            onClick={() => { hapticMedium(); handleGoogleLogin(); }}
            disabled={googleLoading || oauthProcessing}
            variant="outline"
            className="w-full h-12 rounded-xl gap-3 text-sm font-medium"
          >
            {googleLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <svg className="h-5 w-5" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              </svg>
            )}
            Continue with Google
          </Button>
          <Button
            onClick={() => { hapticMedium(); setQrPanel("scan"); setShowQrScanner(true); }}
            variant="outline"
            className="w-full h-12 rounded-xl gap-3 text-sm font-medium"
          >
            <QrCode className="h-5 w-5" />
            Sign in with QR
          </Button>
          <PasskeyLogin email={email} />
        </div>

        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-border" />
          <span className="text-[11px] text-muted-foreground">or use email</span>
          <div className="flex-1 h-px bg-border" />
        </div>

        <Tabs value={authTab} onValueChange={(v) => setAuthTab(v as "login" | "signup")} className="w-full">
          <TabsList className="w-full bg-muted/50 rounded-xl h-10">
            <TabsTrigger value="login" className="flex-1 rounded-lg text-xs">Sign In</TabsTrigger>
            <TabsTrigger value="signup" className="flex-1 rounded-lg text-xs">Sign Up</TabsTrigger>
          </TabsList>

          <TabsContent value="login">
            <form onSubmit={handleLogin} className="space-y-3 mt-4">
              <div className="space-y-1.5">
                <Label htmlFor="login-email" className="text-[11px] text-muted-foreground uppercase tracking-wider">Email</Label>
                <Input id="login-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com" className="h-11 rounded-xl bg-card border-border" required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="login-password" className="text-[11px] text-muted-foreground uppercase tracking-wider">Password</Label>
                <Input id="login-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••" className="h-11 rounded-xl bg-card border-border" required />
              </div>
              <Button type="submit" disabled={loading}
                className="w-full h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-medium">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Sign In"}
              </Button>
              <button type="button" onClick={() => { hapticLight(); setShowForgot(true); }}
                className="block mx-auto text-xs text-muted-foreground hover:text-foreground transition-colors">
                Forgot password?
              </button>
            </form>
          </TabsContent>

          <TabsContent value="signup">
            <form onSubmit={handleSignUp} className="space-y-3 mt-4">
              <div className="space-y-1.5">
                <Label htmlFor="name" className="text-[11px] text-muted-foreground uppercase tracking-wider">Your Name</Label>
                <Input id="name" type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Your name" className="h-11 rounded-xl bg-card border-border" required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="signup-email" className="text-[11px] text-muted-foreground uppercase tracking-wider">Email</Label>
                <Input id="signup-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com" className="h-11 rounded-xl bg-card border-border" required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="signup-password" className="text-[11px] text-muted-foreground uppercase tracking-wider">Password</Label>
                <Input id="signup-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder="Min 8 chars, letters + numbers" className="h-11 rounded-xl bg-card border-border" required minLength={8} />
              </div>
              <Button type="submit" disabled={loading}
                className="w-full h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-medium">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create Account"}
              </Button>
            </form>
          </TabsContent>
        </Tabs>

        <p className="text-center text-[10px] text-muted-foreground">
          End-to-end encrypted • Your data stays yours
        </p>
      </motion.div>

      <Dialog open={showQrScanner} onOpenChange={setShowQrScanner}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Sign in with QR</DialogTitle>
          </DialogHeader>
          {showQrScanner && (
            <Tabs value={qrPanel} onValueChange={(v) => setQrPanel(v as "scan" | "display")} className="w-full">
              <TabsList className="grid w-full grid-cols-2 rounded-xl bg-muted/50">
                <TabsTrigger value="scan" className="rounded-lg text-xs">Scan a QR</TabsTrigger>
                <TabsTrigger value="display" className="rounded-lg text-xs">Show my QR</TabsTrigger>
              </TabsList>
              <TabsContent value="scan" className="mt-4">
                <QRSignInScanner
                  onClose={() => setShowQrScanner(false)}
                  onSuccess={() => setShowQrScanner(false)}
                  onSignupInvite={(inviterId) => {
                    if (inviterId) {
                      sessionStorage.setItem("duo-pending-qr-inviter", inviterId);
                    }
                    setAuthTab("signup");
                    setShowQrScanner(false);
                    toast({
                      title: "Create your account",
                      description: "Fill in your details to finish signup.",
                    });
                  }}
                />
              </TabsContent>
              <TabsContent value="display" className="mt-4">
                <QRSignInDisplay mode="signup_invite" onClose={() => setShowQrScanner(false)} />
              </TabsContent>
            </Tabs>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Auth;
