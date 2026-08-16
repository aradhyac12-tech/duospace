import { Capacitor } from "@capacitor/core";
import { logInfo } from "@/lib/telemetry";

/**
 * Custom URL scheme used for OAuth / magic-link / password-reset callbacks
 * on native (Capacitor) builds. Must be registered natively:
 *
 *   Android (android/app/src/main/AndroidManifest.xml), launcher activity:
 *     <intent-filter>
 *       <action android:name="android.intent.action.VIEW" />
 *       <category android:name="android.intent.category.DEFAULT" />
 *       <category android:name="android.intent.category.BROWSABLE" />
 *       <data android:scheme="duospace" android:host="auth" />
 *     </intent-filter>
 *
 *   iOS (ios/App/App/Info.plist):
 *     <key>CFBundleURLTypes</key>
 *     <array><dict>
 *       <key>CFBundleURLSchemes</key>
 *       <array><string>duospace</string></array>
 *     </dict></array>
 *
 * The `scripts/patch-native-permissions.mjs` script wires both automatically
 * on `npx cap sync`.
 */
export const NATIVE_SCHEME = "duospace";
export const NATIVE_OAUTH_REDIRECT_URI = `${NATIVE_SCHEME}://auth`;
export const NATIVE_RESET_REDIRECT_URI = `${NATIVE_SCHEME}://auth/reset-password`;

export type AuthRedirectPurpose =
  | "oauth"          // Google (and any other) OAuth provider callback
  | "email_confirm"  // Sign-up confirmation link
  | "magic_link"     // Passwordless magic link
  | "password_reset" // Forgot-password recovery link
  | "email_change";  // Email change confirmation

export type AuthPlatform = "web" | "ios" | "android";

/** Detect the current runtime platform. */
export function getAuthPlatform(): AuthPlatform {
  if (Capacitor.isNativePlatform()) {
    const p = Capacitor.getPlatform();
    if (p === "ios" || p === "android") return p;
  }
  return "web";
}

/** True when running inside the native Capacitor shell (Android/iOS), not web/PWA. */
export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * The canonical, publicly-reachable web origin for this deployment.
 *
 * We deliberately IGNORE `window.location.origin` when it looks like a local
 * dev origin (localhost / 127.0.0.1 / capacitor's internal `https://localhost`
 * WebView origin) because Supabase will reject unregistered redirect URIs and
 * providers like Google reject non-https, non-registered origins outright.
 *
 * Priority order:
 *   1. `VITE_PUBLIC_SITE_URL` build-time env (if set)
 *   2. `window.location.origin` when it is a real https origin
 *   3. Hard-coded production origin (fallback of last resort — never localhost)
 */
const PRODUCTION_WEB_ORIGIN = "https://web-duospace.lovable.app";

function isLocalOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return (
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1" ||
      u.hostname === "0.0.0.0" ||
      u.hostname.endsWith(".local")
    );
  } catch {
    return true;
  }
}

export function getPublicWebOrigin(): string {
  const envOrigin = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_PUBLIC_SITE_URL;
  if (envOrigin && /^https?:\/\//.test(envOrigin) && !isLocalOrigin(envOrigin)) {
    return envOrigin.replace(/\/+$/, "");
  }
  if (typeof window !== "undefined") {
    const origin = window.location.origin;
    if (origin && /^https?:\/\//.test(origin) && !isLocalOrigin(origin)) {
      return origin.replace(/\/+$/, "");
    }
  }
  return PRODUCTION_WEB_ORIGIN;
}

/**
 * Platform-aware redirect URI builder. Always returns a URL that is
 * registered with Supabase and the relevant OAuth provider:
 *   - Native (iOS/Android)  → `duospace://auth[...]` custom scheme
 *   - Web (prod / preview)  → `https://<origin>/<path>`
 *   - Web (localhost dev)   → falls back to the production origin so
 *     Supabase / Google don't reject the redirect (we NEVER emit
 *     `http://localhost` as a redirect_uri).
 *
 * Both native and web variants are logged so the flow can be traced end-to-end.
 */
export function buildAuthRedirectUri(purpose: AuthRedirectPurpose = "oauth"): string {
  const platform = getAuthPlatform();

  let uri: string;
  if (platform !== "web") {
    uri = purpose === "password_reset" ? NATIVE_RESET_REDIRECT_URI : NATIVE_OAUTH_REDIRECT_URI;
  } else {
    const origin = getPublicWebOrigin();
    const path =
      purpose === "password_reset" ? "/reset-password" : "/auth/callback";
    uri = `${origin}${path}`;
  }

  logInfo("auth.redirect", "resolved redirect_uri", {
    platform,
    purpose,
    redirect_uri: uri,
    window_origin: typeof window !== "undefined" ? window.location.origin : null,
  });

  return uri;
}

/** Back-compat: previous callers used `getAuthRedirectUri()` for OAuth. */
export function getAuthRedirectUri(purpose: AuthRedirectPurpose = "oauth"): string {
  return buildAuthRedirectUri(purpose);
}
