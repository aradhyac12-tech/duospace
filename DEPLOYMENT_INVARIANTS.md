# Deployment Invariants — Vercel, Lovable Publish, Cloudflare, Netlify

This file is the permanent contract for anything that touches build or deploy
config in DuoSpace. **Every rule below has already broken a deploy at least
once.** Do not "clean up" any of them without reading the reason.

Agents (Lovable, Codex, Copilot, etc.): read this file before editing
`package.json`, `package-lock.json`, `vite.config.ts`, `vercel.json`,
`netlify.toml`, `wrangler.toml`, or anything in `native-plugins/`.

---

## 1. The lockfile must always be in sync with package.json

**Failure it caused:** Vercel and Lovable Publish both run `npm ci`. `npm ci`
refuses to install when `package.json` and `package-lock.json` disagree:

```
npm error `npm ci` can only install packages when your package.json and
npm error package-lock.json ... are in sync.
npm error Missing: @vitejs/plugin-react-swc@3.7.2 from lock file
npm error Missing: @swc/core@1.16.1 from lock file
...
```

The build dies during *install*, before Vite ever runs, so the log shows no
application error — which is why this looked like "Lovable/Vercel is broken".

**Rule:** after ANY dependency change, run `npm install` locally and commit the
updated `package-lock.json` in the same commit. Never hand-edit the lockfile.

**Guard:** `npm run verify:lock` (runs `npm ci --dry-run`). It exits non-zero
if the lockfile drifted. Run it before every push.

## 2. Vite must import `@vitejs/plugin-react-swc`, never `@vitejs/plugin-react`

Only the SWC plugin is in `package.json`. Importing the Babel one works on a
machine with stale `node_modules` and fails with `ERR_MODULE_NOT_FOUND` on
every clean CI install. `vite.config.ts` must keep:

```ts
import react from "@vitejs/plugin-react-swc";
```

## 3. All five local Capacitor plugins must be aliased to their TS sources

`native-plugins/*` ship no built `dist/`, and `dist/` is gitignored, so a clean
clone cannot resolve their `package.json` `main`. Symptom on Cloudflare/Vercel:

```
[commonjs--resolver] Failed to resolve entry for package
"duospace-background-geolocation".
```

`vite.config.ts` `resolve.alias` **and** `tsconfig.app.json` `paths` must both
list all five: `audio-route`, `device-status`, `callkit-bridge`,
`background-geolocation`, `audio-engine` → `native-plugins/<name>/src/index.ts`.
Adding a sixth plugin means adding it to both files.

## 4. Node 22 everywhere

`@capacitor/cli` and `@supabase/*` require Node >= 22; Vercel/Cloudflare default
lower and emit `EBADENGINE`, then fail unpredictably. Keep all four in sync:
`.nvmrc` = `22`, `.node-version` = `22`, `netlify.toml` `NODE_VERSION = "22"`,
`package.json` `engines.node = ">=22.0.0"`. On Vercel, set the project's Node
version to 22.x in Project Settings → General.

## 5. No stray package-manager config

`.yarnrc.yml` was present with no `yarn.lock`. Corepack/Vercel package-manager
detection can then pick yarn and install a different (or empty) tree. This repo
is **npm only** (`packageManager: npm@10.9.2`). Never add `.yarnrc.yml`,
`yarn.lock`, `pnpm-lock.yaml`, or `pnpm-workspace.yaml`.

## 6. SPA fallback must exist on every host

Client routes (`/auth`, `/chat`, ...) 404 on hard refresh without it.
- `vercel.json` → `rewrites: [{ "source": "/(.*)", "destination": "/index.html" }]`
- `netlify.toml` → `/*` → `/index.html` status 200
- Cloudflare Pages → `pages_build_output_dir = "dist"` (SPA fallback automatic)

## 7. Env vars are build-time, and must be set in each dashboard

`VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` are inlined by Vite at
build time. They must be set in Vercel / Cloudflare / Netlify project settings
**for both Production and Preview environments**, otherwise the deployed app
builds fine and then fails at runtime with an unauthenticated Supabase client.
Locally they come from `.env.local` (see `.env.example`). Never hardcode them
and never rename the prefix — non-`VITE_` vars are not exposed to the client.

## 8. `npm run build` must never depend on `tsc`

The build script is `vite build` only. The repo still has known *type-only*
errors (Supabase generated types vs. `playlist_songs.position`, a few
`PromiseLike.catch` narrowings). They do not affect the bundle. Do not add
`tsc -b &&` to the `build` script — it would turn type debt into a deploy
outage. Fix types in `npm run lint` / typecheck passes instead.

## 9. Never commit `dist/`, `node_modules/`, `.env*`, or native build output

`.gitignore` covers these. Committing `dist/` is what previously masked rule 3
locally while CI kept failing.

---

## Pre-push checklist

```sh
npm run verify:lock   # lockfile in sync -> npm ci will succeed on CI
npm run build         # production build, same command every host runs
```

Both green = Vercel, Lovable Publish, Cloudflare Pages and Netlify will all
build. If either fails, do not push.
