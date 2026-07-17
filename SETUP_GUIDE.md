# DuoSpace — Complete Setup & Build Guide

## Overview

DuoSpace is a private couples app built with React + Vite + Capacitor. This guide covers everything needed to build and deploy the APK/IPA.

## Email Integration (Resend)

The app uses Resend for sending password reset and verification emails.
- Backend function: `send-email` edge function
- Secret: `RESEND_API_KEY` (configured in backend secrets)
- Sends from: `noreply@resend.dev` (update to your domain in `send-email/index.ts`)

## Password Reset Flow

1. User taps "Forgot password?" on the login screen
2. Enters their email → receives a reset link via Supabase Auth
3. Link redirects to `/reset-password` where they set a new password
4. Password updated via `supabase.auth.updateUser()`

---

## Prerequisites

- **Node.js** ≥ 18
- **npm** or **bun**
- **Android Studio** (for Android APK)
- **Xcode** ≥ 15 (for iOS, macOS only)
- **Java JDK 17** (for Android)

---

## 1. Project Setup

```bash
# Clone from GitHub (export via Lovable → Settings → Export to GitHub)
git clone <your-repo-url>
cd duospace

# Install dependencies
npm install
```

---

## 2. Capacitor Configuration

The `capacitor.config.ts` is pre-configured. For production builds, update the server URL:

```ts
// capacitor.config.ts — For production, remove the server.url to use local assets:
server: {
  // Remove or comment out for production APK
  // url: 'https://...',
  cleartext: true,
},
```

---

## 3. Add Native Platforms

```bash
# Add Android
npx cap add android

# Add iOS (macOS only)
npx cap add ios
```

---

## 4. Build & Sync

```bash
# Build the web app
npm run build

# Sync web assets + plugins to native projects
npx cap sync
```

> **Important**: Run `npx cap sync` after every `git pull` or dependency change.

---

## 5. Capacitor Plugins Used

All plugins are already installed in `package.json`. Here's what each does:

| Plugin | Purpose |
|--------|---------|
| `@capacitor/core` | Core Capacitor runtime |
| `@capacitor/android` | Android platform support |
| `@capacitor/haptics` | Haptic feedback (vibrations) |
| `@capacitor/push-notifications` | Push notification support |
| `@capacitor/geolocation` | GPS location for map feature |
| `@capacitor-community/privacy-screen` | Hide app content in task switcher |
| `@capawesome/capacitor-screen-orientation` | Lock/control screen orientation |
| `capacitor-native-biometric` | FaceID / Fingerprint authentication |

### Android Permissions

Add to `android/app/src/main/AndroidManifest.xml`:

```xml
<!-- Camera for Peek Guard & Photo/Video capture -->
<uses-permission android:name="android.permission.CAMERA" />
<uses-feature android:name="android.hardware.camera" android:required="false" />
<uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />

<!-- Biometrics -->
<uses-permission android:name="android.permission.USE_BIOMETRIC" />
<uses-permission android:name="android.permission.USE_FINGERPRINT" />

<!-- Location for Map (foreground + background) -->
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />

<!-- Push Notifications -->
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

<!-- Microphone for calls & voice messages -->
<uses-permission android:name="android.permission.RECORD_AUDIO" />

<!-- Haptics -->
<uses-permission android:name="android.permission.VIBRATE" />

<!-- Internet & Network -->
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />

<!-- Storage for gallery imports -->
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />
<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" />
<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />
<uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />

<!-- Foreground service for music & location -->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />

<!-- Wake lock for background music -->
<uses-permission android:name="android.permission.WAKE_LOCK" />
```

### iOS Permissions

Add to `ios/App/App/Info.plist`:

```xml
<!-- Camera for Peek Guard & capture -->
<key>NSCameraUsageDescription</key>
<string>DuoSpace uses the camera to detect if someone is looking over your shoulder and for capturing photos</string>

<!-- Microphone for calls & voice messages -->
<key>NSMicrophoneUsageDescription</key>
<string>DuoSpace needs microphone access for voice and video calls</string>

<!-- Location (foreground) -->
<key>NSLocationWhenInUseUsageDescription</key>
<string>DuoSpace shows your location on the shared map</string>

<!-- Location (background - persistent mode) -->
<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
<string>DuoSpace can share your location with your partner even when the app is in the background</string>
<key>NSLocationAlwaysUsageDescription</key>
<string>DuoSpace shares your location continuously with your partner</string>

<!-- Background modes -->
<key>UIBackgroundModes</key>
<array>
    <string>audio</string>
    <string>location</string>
    <string>fetch</string>
    <string>remote-notification</string>
</array>

<!-- FaceID -->
<key>NSFaceIDUsageDescription</key>
<string>DuoSpace uses Face ID to secure your private conversations</string>

<!-- Photo Library -->
<key>NSPhotoLibraryUsageDescription</key>
<string>DuoSpace needs access to save and share photos</string>

<!-- Photo Library Add -->
<key>NSPhotoLibraryAddUsageDescription</key>
<string>DuoSpace saves photos to your camera roll</string>
```

---

## 6. Running on Device/Emulator

```bash
# Android — open in Android Studio
npx cap open android
# Or run directly (device must be connected)
npx cap run android

# iOS — open in Xcode
npx cap open ios
# Or run directly
npx cap run ios
```

---

## 7. Building APK (Android)

### Debug APK
```bash
cd android
./gradlew assembleDebug
# APK at: android/app/build/outputs/apk/debug/app-debug.apk
```

### Signed Release APK
```bash
# Generate keystore (first time only)
keytool -genkey -v -keystore duospace-release.keystore -alias duospace -keyalg RSA -keysize 2048 -validity 10000

# Build release
cd android
./gradlew assembleRelease
# APK at: android/app/build/outputs/apk/release/app-release.apk
```

---

## 8. Building IPA (iOS)

1. Open `ios/App/App.xcworkspace` in Xcode
2. Select your device or "Any iOS Device"
3. Product → Archive
4. Distribute via App Store Connect or export Ad Hoc

---

## 9. Feature Details

### Peek Guard (Face Detection)
- **Android**: Uses the native `FaceDetector` API in Chrome WebView — works perfectly
- **iOS**: Uses a canvas-based skin-tone heuristic as fallback since `FaceDetector` API is not available in WKWebView
- Camera runs at 320×240 @ 5fps to minimize battery impact
- Configurable: face threshold (2–5), detection delay (0.5–5s), scan frequency (300–2000ms)

### Biometric Lock
- Uses `capacitor-native-biometric` for FaceID (iOS) and Fingerprint (Android)
- Falls back to WebAuthn on web browsers
- Triggers when app is backgrounded and reopened

### Privacy Screen
- Uses `@capacitor-community/privacy-screen` to show a blank screen in the task switcher
- Automatically enabled when Peek Guard or Privacy Mode is on

### Video/Voice Calls
- Powered by Daily.co via edge functions
- Supports HD video, screen sharing, adaptive bitrate
- Unlimited call duration (7-day room expiry, auto-renewed)
- Draggable PiP (picture-in-picture) for local video

### Haptic Feedback
- Light haptics on navigation and toggles
- Medium haptics on important actions (send, connect)
- Heavy haptics on privacy alerts (peek detected)
- Controlled by the Haptics toggle in Settings

---

## 10. Troubleshooting

### Camera permission denied on Android
Make sure the `CAMERA` permission is in `AndroidManifest.xml` and the app has been granted permission in device settings.

### FaceDetector not working on iOS
This is expected — iOS WKWebView doesn't support the `FaceDetector` API. The app automatically falls back to canvas-based detection.

### Biometric not prompting
Ensure the device has biometrics set up (at least one fingerprint or Face ID enrolled).

### Build fails after sync
```bash
# Clean and rebuild
cd android && ./gradlew clean && cd ..
npx cap sync android
```

### Hot reload not working on device
Ensure the `server.url` in `capacitor.config.ts` points to your development machine's IP or the Lovable preview URL.

---

## 11. Production Checklist

- [ ] Remove `server.url` from `capacitor.config.ts` (use bundled assets)
- [ ] Set `webContentsDebuggingEnabled: false` in capacitor config
- [ ] Generate and configure signing keystore (Android)
- [ ] Configure App Store Connect provisioning (iOS)
- [ ] Test all permissions on fresh install
- [ ] Test biometric lock flow
- [ ] Test Peek Guard with multiple people
- [ ] Verify call quality on cellular network
- [ ] Test push notifications end-to-end
