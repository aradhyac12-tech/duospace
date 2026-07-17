# DuoSpace — Production Build Guide

## Prerequisites
- Node.js 20+
- Android Studio (for Android APK)
- Xcode 15+ (for iOS IPA, macOS only)
- Supabase project with migrations applied

## 1. Environment Setup
Create `.env` file in project root:
```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your_anon_key
```

## 2. Database Migration
Run in Supabase SQL Editor:
```sql
-- Run the migration file:
supabase/migrations/20260412000001_bugfixes.sql
```

## 3. Install & Build
```bash
npm install
npm run build
npx cap sync
```

## 4. Android
```bash
npx cap open android
# In Android Studio:
# Build → Generate Signed Bundle/APK → APK
# Select your keystore, build release APK
```

### Required AndroidManifest.xml permissions (auto-added by plugins):
- `CAMERA` — photos + video calls
- `RECORD_AUDIO` — voice/video calls  
- `READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO` (Android 13+)
- `POST_NOTIFICATIONS` (Android 13+)
- `USE_BIOMETRIC` / `USE_FINGERPRINT`
- `ACCESS_FINE_LOCATION` — map feature

## 5. iOS
```bash
npx cap open ios
# In Xcode:
# Select your team under Signing & Capabilities
# Product → Archive → Distribute App
```

### Required Info.plist keys (set in Xcode → Info tab):
- `NSCameraUsageDescription`: "DuoSpace uses your camera for photos and video calls"
- `NSMicrophoneUsageDescription`: "DuoSpace uses your microphone for voice and video calls"
- `NSPhotoLibraryUsageDescription`: "DuoSpace accesses your photos to share them"
- `NSPhotoLibraryAddUsageDescription`: "DuoSpace saves photos to your library"
- `NSFaceIDUsageDescription`: "DuoSpace uses Face ID to keep your conversations private"
- `NSLocationWhenInUseUsageDescription`: "DuoSpace shows your location on the couple map"

## 6. Supabase Edge Functions
Deploy the scheduled messages delivery function:
```bash
supabase functions deploy deliver-scheduled-messages
```

## 7. Features Summary
- E2E encrypted chat (ECDH + AES-GCM)
- Voice & video calls (Daily.co)
- Lip reading overlay (English / हिंदी / मराठी)
- Gallery (original quality, no compression)
- 12 colour themes incl. Wine Red, Cherry Blossom, Deep Space
- App lock (Face ID / Fingerprint + 6-digit PIN fallback)
- Custom app name + icon
- Chat wallpapers
- Offline detection + Android back button
- Media visibility toggle
- Memory wall, Shayari, Playlist blend, Couple map, Anniversary countdown

## Notes
- Auth session uses @capacitor/preferences on native (not localStorage)
- All uploads are original quality — no compression anywhere
- PIN stored in localStorage (device-local, not synced to server)
