# White-label apps

Each entry here is one buildable app/project — its own name, Android
`applicationId`, iOS bundle id, and (via Icon Studio) its own icon. Icon
Studio (Settings → Appearance → Icon Studio, in the running app) is where you
design each app's icon; this folder plus `scripts/apply-whitelabel.mjs` is
how that config reaches the actual native build.

## Files

- `apps.json` — the registry of apps: id, name, packageId, bundleId. This is
  the same shape Icon Studio keeps in the browser (`src/lib/whitelabelApps.ts`).
  Icon Studio's app picker can export its copy to this exact format — replace
  this seed file with that export, or hand-edit it.
- `<appId>/resources/` — the exported icon PNGs for that app
  (`icon.png`, `icon-foreground.png`, `icon-background.png`,
  `icon-monochrome.png`). Not committed by default — see below for how to
  populate it.

## Workflow

1. In the running app: Settings → Appearance → Icon Studio → pick/create the
   app in the app picker → design its icon → **Export Android + iOS icon
   set**. This downloads `<packageId>-icon-assets.zip`.
2. Unzip it, and copy just its `resources/` folder to
   `whitelabel/<appId>/resources/` in this repo.
3. Run:
   ```
   node scripts/apply-whitelabel.mjs <appId>
   ```
   This patches `capacitor.config.ts`, and — if `android/`/`ios/` already
   exist (`npx cap add android` / `npx cap add ios`) — the Android
   `applicationId`/`app_name` and iOS `CFBundleDisplayName`/bundle id too,
   then tries to regenerate every native icon size via
   `npx @capacitor/assets generate`.
4. If step 3's `@capacitor/assets generate` couldn't run (no network, or the
   package isn't installed), the zip from step 1 already contains every
   Android/iOS size pre-rendered under its own `android/` and `ios/`
   folders — copy those in directly instead.

Run `node scripts/apply-whitelabel.mjs --list` to see registered apps.

## Known limitation

The OAuth deep link scheme (`duospace://auth`, wired through
`src/lib/auth-redirect.ts` and `scripts/patch-native-permissions.mjs`) is
shared across every app built from this repo — it is not split per white-label
app by this tooling. Giving each app its own OAuth redirect would need its
own registered provider redirect URI and is a separate change.
