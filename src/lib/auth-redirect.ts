import { Capacitor } from "@capacitor/core";

/**
 * Custom URL scheme used to receive OAuth / magic-link callbacks on native
 * platforms. This is NOT the Capacitor `ios.scheme` / `androidScheme` config
 * (which only affects how the webview loads local app pages) — it is a
 * separate deep link that must be registered natively:
 *
 *   Android (android/app/src/main/AndroidManifest.xml), inside the launcher
 *   activity's <intent-filter>:
 *     <action android:name="android.intent.action.VIEW" />
 *     <category android:name="android.intent.category.DEFAULT" />
 *     <category android:name="android.intent.category.BROWSABLE" />
 *     <data android:scheme="duospace" android:host="auth" />
 *
 *   iOS (ios/App/App/Info.plist):
 *     <key>CFBundleURLTypes</key>
 *     <array><dict>
 *       <key>CFBundleURLSchemes</key>
 *       <array><string>duospace</string></array>
 *     </dict></array>
 *
 * Register this exact value in the Lovable/Supabase auth provider config
 * ("Additional Redirect URLs") alongside the web origin(s).
 */
export const NATIVE_OAUTH_REDIRECT_URI = "duospace://auth";

/**
 * Returns the correct redirect_uri for OAuth sign-in and email links
 * (signup confirmation, password reset) for the current platform.
 *
 * On native Android/iOS builds, `window.location.origin` resolves to
 * `https://localhost` (the webview's internal origin) — that is not a
 * real, publicly routable address, so Google/Apple/the auth provider
 * reject it with "redirect_uri is not allowed". Native builds must use
 * a registered custom URL scheme deep link instead.
 */
export function getAuthRedirectUri(): string {
  if (Capacitor.isNativePlatform()) {
    return NATIVE_OAUTH_REDIRECT_URI;
  }
  if (window.location.origin === "null" || window.location.origin === "http://localhost:3000") {
    throw new Error("This OAuth redirect origin is invalid. Open DuoSpace from the Lovable preview/published URL and make sure that URL is allow-listed in Auth redirect URLs.");
  }
  // Point at the dedicated callback route (registered in App.tsx) rather
  // than the bare origin. Functionally the Auth page already parses the
  // OAuth hash/query params regardless of which path it lands on, but an
  // explicit /auth/callback avoids relying on that fallback and matches
  // what should be registered as the redirect URL in the Google/Apple/
  // Supabase provider configuration.
  return `${window.location.origin}/auth/callback`;
}

/** True when running inside the native Capacitor shell (Android/iOS), not web/PWA. */
export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}
