# DuoSpace — Build & Release

## Local

```bash
npm ci
npm run dev          # http://localhost:8080
npm run lint
npx tsc -b --noEmit
npm test
npm run check:rls
npm run build
```

CI (`.github/workflows/ci.yml`) runs exactly these. **No step is allowed to end
in `|| true`** — the typecheck previously did, which kept CI green over real
type errors. That mask has been removed; a type error now fails the build.

Package manager is npm, exclusively — `npm ci` needs `package-lock.json` to
match `package.json` exactly. Do not run `bun install`/`bun add` in this repo;
a stray `bun.lock` was previously found alongside `package-lock.json` and is
exactly the kind of drift that causes "works locally, plugin missing in CI"
failures. `android-build.yml` fails fast if it finds one again.

## Android APK

`.github/workflows/android-build.yml` — separate from `ci.yml`, headless,
produces a signed APK. See `BUILD.md` for the required secrets and trigger
conditions.

## Native

```bash
npm run build
npm run cap:sync     # verify deps -> cap sync -> patch permissions -> verify native
npx cap run android  # or: npx cap run ios
```

`scripts/patch-native-permissions.mjs` runs as part of `cap:sync` and is
responsible for:
- injecting the `duospace://` URL scheme into `Info.plist` and
  `AndroidManifest.xml` (required for OAuth to return to the app),
- injecting media/camera/mic/location permission entries (incl. Android 13+
  granular media permissions),
- pinning `PRODUCT_BUNDLE_IDENTIFIER` (iOS) and `applicationId`/`namespace`
  (Android) to `com.duospace.app`.

Never hand-edit the generated `ios/` or `android/` projects for anything this
script handles; `cap sync` will overwrite it.

## Supabase deployment (manual — external project)

```bash
npx supabase link --project-ref jzlpelxwzjjpddqcrtpu
npx supabase functions deploy <name>
```

SQL in `scripts/sql/` is applied by hand in the Supabase SQL editor.
Outstanding: `scripts/sql/harden_partner_daily_key.sql` (P0 — run this).

## Web hosting

`netlify.toml`, `vercel.json`, `wrangler.toml`, and `public/_headers` /
`public/_redirects` provide SPA routing + security headers on Netlify, Vercel,
and Cloudflare Pages. Build command `npm run build`, output `dist`.
