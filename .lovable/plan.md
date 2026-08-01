# Sync `duospace-redesign-final.zip` + full media permissions

## 1. Pull the zip in as-is

Sync all 564 files from the archive into the project, overwriting existing files. Verified: the archive contains no `.git` metadata, so nothing can corrupt the repo.

- Copy everything except the vendored `native-plugins/*/node_modules` folders (144 entries — reinstalled by the package manager instead).
- The archive brings a newer app version (3.2.0) with new pieces: `IconStudio`, `SecurityDashboard`, `GroicInviteBanner`, `useDeviceStatus`, `useAudioRoute`, two local Capacitor plugins (`duospace-audio-route`, `duospace-device-status`), `docs/` and a much larger `scripts/patch-native-permissions.mjs`.
- Run install so the new local file-linked plugins and any new deps resolve, then typecheck and confirm the preview renders.

## 2. Full media permissions (camera, photo library, files)

A single permission layer used by every media entry point (chat photo/video attach, camera with filters, gallery upload, Peek Guard face enrollment, QR scanner, backup export/import).

- **Permission service** — one module that, per platform, checks and requests: camera, microphone, photo library read, photo library add/save, and file/document access. Native uses the Capacitor Camera + Filesystem permission APIs; web maps to `getUserMedia` / file input with graceful capability detection.
- **Request at point of use, not just launch** — every media action asks first, and only opens the picker/camera once granted. Launch-time batch request stays as a convenience.
- **Fallback UI when denied** — a shared sheet explaining exactly what is blocked, why the feature needs it, and a button that deep-links to the OS app settings (native) or shows browser-specific re-enable steps (web). Permanently-denied ("don't ask again") is detected and shown differently from a first-time denial.
- **Camera-in-use fallback** — keeps the existing busy-camera recovery path and routes it through the same UI so a `NotReadableError` shows "close the other app/tab, then retry" instead of a generic failure.
- **Degraded modes** — if the photo library is denied, media flows fall back to camera capture; if camera is denied, they fall back to file picker; if all are denied, the attach action is disabled with a visible reason rather than silently failing.

## 3. Native (Capacitor / APK / iOS) declarations

Extend `scripts/patch-native-permissions.mjs` (already idempotent and wired to `npm run cap:sync`) so a fresh `cap add` produces a build that can actually be granted these permissions:

- **iOS Info.plist**: `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`, `NSPhotoLibraryUsageDescription`, `NSPhotoLibraryAddUsageDescription`, plus `NSFaceIDUsageDescription` and the existing `duospace://auth` URL scheme.
- **AndroidManifest.xml**: `CAMERA`, `RECORD_AUDIO`, `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO`, `READ_MEDIA_VISUAL_USER_SELECTED` (Android 14 partial access), legacy `READ_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE` with `maxSdkVersion` guards, `POST_NOTIFICATIONS`, and the OAuth intent-filter.
- Android 13+ granular media permissions are handled in the request logic so the app doesn't ask for the deprecated storage permission on new devices.

## Technical notes

Files expected to change: everything in the archive (bulk sync), plus `scripts/patch-native-permissions.mjs`, a new `src/lib/mediaPermissions.ts`, a new `src/components/PermissionDeniedSheet.tsx`, and the call sites in `Chat.tsx`, `CameraWithFilters.tsx`, `Gallery.tsx`, `FaceEnrollmentDialog.tsx`, `QRSignInScanner.tsx`, `useLaunchPermissions.ts`, and `cameraBus.ts`.

Verification in-sandbox: typecheck + preview render. Device-level permission prompts can only be confirmed after you run `npx cap sync` and build in Xcode / Android Studio — the patch script output will list exactly which keys and permissions it injected.
