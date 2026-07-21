import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.duospace.app',
  appName: 'DuoSpace',
  webDir: 'dist',
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    SplashScreen: {
      launchAutoHide: true,
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      backgroundColor: '#F5F0EB',
      splashFullScreen: true,
      splashImmersive: true,
      launchShowDuration: 1500,
    },
    Keyboard: {
      resize: 'body',
      resizeOnFullScreen: true,
    },
    PrivacyScreen: {
      enable: false,
    },
    // Preferences plugin - no extra config needed, uses native storage
    // Filesystem plugin - no extra config needed, uses app's Documents directory
  },
  ios: {
    contentInset: 'automatic',
    preferredContentMode: 'mobile',
    scheme: 'DuoSpace',
    backgroundColor: '#F5F0EB',
    // OAuth deep link scheme: "duospace" (must match NATIVE_OAUTH_REDIRECT_URI
    // in src/lib/auth-redirect.ts). This is separate from `scheme` above,
    // which only controls the webview's internal load scheme. Capacitor has
    // no config field for external URL scheme registration — it can only be
    // set in native project files. Run `npm run cap:patch-permissions`
    // after `cap add ios` / `cap sync` to add it automatically (also adds
    // camera/mic/photo usage descriptions); see scripts/patch-native-permissions.mjs.
  },
  android: {
    backgroundColor: '#F5F0EB',
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
    // AndroidManifest.xml permissions added automatically by Capacitor plugins:
    // CAMERA, RECORD_AUDIO, READ_EXTERNAL_STORAGE, WRITE_EXTERNAL_STORAGE,
    // ACCESS_FINE_LOCATION, INTERNET, POST_NOTIFICATIONS (Android 13+)
    //
    // OAuth deep link scheme "duospace" (must match NATIVE_OAUTH_REDIRECT_URI
    // in src/lib/auth-redirect.ts): run `npm run cap:patch-permissions`
    // after `cap add android` / `cap sync` to add the intent-filter to the
    // launcher Activity automatically; see scripts/patch-native-permissions.mjs.
  },
};

export default config;
