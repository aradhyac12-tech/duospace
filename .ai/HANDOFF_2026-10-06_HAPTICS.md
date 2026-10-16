# Handoff — premium haptics (2026-10-06)

Built on duospace-v3_22_9-new-logo. See CHANGELOG entry of the same date.

## Next steps for the owner
1. Build a new APK/IPA (native plugin added). Bump version first (rule 12).
2. On device: Settings -> Security -> "Feel the haptics". Engine label should read "Premium"; "Basic" means the old app is installed.
3. If Android Gradle or Xcode fails, the suspects are `native-plugins/haptics/android/.../DuospaceHapticsPlugin.kt` and `ios/Plugin/DuospaceHapticsPlugin.swift` (written without a compiler).
4. Tuning lives in one place: PATTERNS in `src/lib/hapticEngine.ts` (JS-only, no native rebuild). Android named-effect table: `compositionFor` in the Kotlin file.

## Invariants
- UI components import from hapticEngine, never haptics.ts (tests mock haptics.ts partially).
- Class is `DuospaceHapticsPlugin` (not `HapticsPlugin`) to avoid an iOS collision with @capacitor/haptics.
