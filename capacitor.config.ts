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
    // Info.plist usage descriptions must be set in Xcode:
    // NSCameraUsageDescription: "DuoSpace needs camera for photos and video calls"
    // NSMicrophoneUsageDescription: "DuoSpace needs microphone for voice and video calls"
    // NSPhotoLibraryUsageDescription: "DuoSpace needs access to save and share photos"
    // NSFaceIDUsageDescription: "DuoSpace uses Face ID to keep your conversations private"
    //
    // OAuth deep link (must also be added manually — Capacitor does not
    // generate this): add to ios/App/App/Info.plist
    //   <key>CFBundleURLTypes</key>
    //   <array><dict>
    //     <key>CFBundleURLSchemes</key>
    //     <array><string>duospace</string></array>
    //   </dict></array>
    // This is separate from `scheme` above (which only controls the
    // webview's internal load scheme, not external deep links).
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
    // OAuth deep link (must also be added manually to the launcher
    // Activity in android/app/src/main/AndroidManifest.xml):
    //   <intent-filter>
    //     <action android:name="android.intent.action.VIEW" />
    //     <category android:name="android.intent.category.DEFAULT" />
    //     <category android:name="android.intent.category.BROWSABLE" />
    //     <data android:scheme="duospace" android:host="auth" />
    //   </intent-filter>
  },
};

export default config;
