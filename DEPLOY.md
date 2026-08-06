# Deploying DuoSpace (web)

DuoSpace is a static Vite + React SPA. Any static host works — build once,
serve `dist/`, and make sure unknown paths fall back to `index.html`.

## Build settings

| Host                | Build command     | Output dir | Notes |
| ------------------- | ----------------- | ---------- | ----- |
| Netlify             | `npm run build`   | `dist`     | `netlify.toml` + `public/_redirects` already configured |
| Cloudflare Pages    | `npm run build`   | `dist`     | `wrangler.toml` + `public/_redirects` |
| Vercel              | `npm run build`   | `dist`     | `vercel.json` rewrites all routes to `index.html` |
| Any static host     | `npm run build`   | `dist`     | Add your own SPA fallback rule |

Node version is pinned to 20 via `.nvmrc` and `netlify.toml`.

## Environment variables

Set these in the host's dashboard (they are public, client-side values):

- `VITE_SUPABASE_URL` — `https://jzlpelxwzjjpddqcrtpu.supabase.co`
- `VITE_SUPABASE_PUBLISHABLE_KEY` — the Supabase **anon / publishable** key
  (never the `service_role` key)
- `VITE_PUBLIC_SITE_URL` *(optional)* — pin the OAuth/email redirect origin to
  your production domain, e.g. `https://duospace.app`. If unset, the app uses
  the browser's own origin.

See `.env.example` for the same list.

## After adding a new domain

Auth breaks on a new domain until it is whitelisted. For every domain you
deploy to:

1. **Supabase → Authentication → URL Configuration**
   - Site URL: `https://your-domain.com`
   - Redirect URLs: add
     `https://your-domain.com/auth/callback` and
     `https://your-domain.com/reset-password`
   - Keep `duospace://auth` and `duospace://auth/reset-password` for the
     native apps.
2. **Google Cloud Console → Credentials → OAuth client**
   - Authorized JavaScript origins: `https://your-domain.com`
   - Authorized redirect URIs:
     `https://jzlpelxwzjjpddqcrtpu.supabase.co/auth/v1/callback`

`supabase/config.toml` mirrors this list for the CLI.

## Headers and caching

`public/_headers` (Netlify + Cloudflare Pages) sets basic security headers and
immutable caching for hashed `/assets/*` files while keeping `index.html`
uncached so deploys go live immediately.

## Native builds

Native config lives in `capacitor.config.json` (`webDir: "dist"`). Run:

```bash
npm run build
npm run cap:sync   # cap sync + patch native permissions / duospace:// scheme
```

The local plugins `native-plugins/audio-route` and `native-plugins/device-status`
are `file:` dependencies — install with **dev dependencies included**
(`npm ci`, not `npm ci --omit=dev`) or `cap sync` will report those plugins as
not registered in the native project.
