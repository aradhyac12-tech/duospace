import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import { isNativePlatform, getAuthPlatform } from "@/lib/auth-redirect";
import { completeAuthCallback, getPostAuthPath, hasAuthCallback, parseAuthCallbackUrl } from "@/lib/auth-callback";
import { logInfo, logError, logWarn, newTraceId } from "@/lib/telemetry";
import { closeExternalBrowser } from "@/lib/nativeBrowser";
import { getAuthErrorMessage } from "@/lib/authErrors";

const supaErr = (e: unknown) => {
  if (!e || typeof e !== "object") return { message: String(e) };
  const err = e as { message?: string; status?: number; code?: string; name?: string };
  return { message: err.message, status: err.status, code: err.code, name: err.name };
};

/**
 * BUG FIX ("Nothing listens for the deep link that returns from the
 * browser"): this whole appUrlOpen/getLaunchUrl handler used to live
 * entirely inside Auth.tsx's own useEffect — meaning it was ONLY active
 * while Auth.tsx happened to be the currently-mounted route. That's a real
 * gap, not a hypothetical one: `/reset-password` is its own top-level
 * sibling route (see App.tsx's <Routes>), and `/auth` itself redirects an
 * already-signed-in user straight to `/chat` (AuthRoute) — so any of these
 * common cases landed with literally no listener registered:
 *   - App is currently open on /chat (or anywhere else) when the OS
 *     delivers the duospace://auth/reset-password callback.
 *   - App was fully killed and gets COLD-STARTED by that same deep link
 *     while the person is already signed in on this device (e.g. testing
 *     the reset flow, or resetting as a precaution while still logged in)
 *     — AuthRoute redirects to /chat before Auth.tsx's own
 *     getLaunchUrl() check ever runs, since Auth.tsx never mounts at all.
 * In both cases the callback URL — and the single-use PKCE code inside it —
 * was silently dropped with no error, no toast, nothing.
 *
 * Fixed by moving this to a listener mounted ONCE at the app root (see
 * App.tsx), inside the Router but outside any specific route, so it's
 * always active regardless of what screen is currently showing or whether
 * the person is signed in. Auth.tsx no longer registers its own copy of
 * this (its *web*-platform callback effect, driven by window.location
 * rather than appUrlOpen, is untouched — that one doesn't have this bug:
 * a browser tab navigating to /auth/callback or /reset-password naturally
 * lands on the right route on its own, no JS-side re-routing needed).
 *
 * Returns `processing` so the app root can show a lightweight blocking
 * overlay while a deep link is being handled, regardless of which screen
 * it interrupted.
 */
export function useNativeAuthDeepLink() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    if (!isNativePlatform()) return;
    let cancelled = false;
    let sub: { remove: () => void } | undefined;
    // Same dedupe guards as before: Android can redeliver the same
    // appUrlOpen event, and a cold start can hand the same callback URL to
    // both getLaunchUrl() and the first appUrlOpen event. A PKCE code is
    // single-use, so a second exchange attempt for the same code must be
    // short-circuited rather than surfacing a spurious failure.
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
        } else {
          // Not an auth callback at all (some other duospace:// path, or a
          // URL this listener doesn't recognize) — nothing to do, and
          // deliberately not touching `processing`/toasts for a URL that
          // was never ours to handle.
          return;
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

        setProcessing(true);
        const t0 = performance.now();
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
            setProcessing(false);
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
            logInfo("auth.deeplink", "navigation executed", {
              request_id: traceId, destination,
            }, traceId);
          } else {
            logError("auth.deeplink", "callback finalized with no session", {
              request_id: traceId, duration_ms,
            }, traceId);
            toast({ title: "Sign in failed", description: "No session was returned. Please try again.", variant: "destructive" });
          }
          setProcessing(false);
        }
      } catch (err) {
        logError("auth.deeplink", "deep link handler threw", { request_id: traceId, source, err: supaErr(err) }, traceId);
        if (!cancelled) {
          toast({ title: "Sign in failed", description: getAuthErrorMessage(err), variant: "destructive" });
          setProcessing(false);
        }
      } finally {
        inFlight = false;
      }
      await closeInAppBrowser();
    };

    // Two delivery paths, both required:
    //  1) appUrlOpen — fires while the app is alive (foreground/background)
    //     when the OS hands it the duospace:// callback.
    //  2) getLaunchUrl — covers the case where the app was cold-started BY
    //     the duospace:// callback itself. That launch can complete —
    //     Capacitor bridge ready, event dispatched — before this listener
    //     subscribes, so appUrlOpen alone can silently miss it.
    const setup = async () => {
      const { App } = await import("@capacitor/app");
      logInfo("auth.deeplink", "global appUrlOpen listener registered", {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate, toast]);

  return { processing };
}
