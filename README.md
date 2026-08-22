# DuoSpace

A private, end-to-end-encrypted app for two people: chat, audio/video calling,
shared gallery, music, location sharing, and deep personalisation.

React 18 + Vite 5 + TypeScript + Tailwind, Capacitor 8 for Android/iOS, and an
external Supabase backend (Postgres + Auth + Storage + Edge Functions).

## Quick start

```bash
npm ci
npm run dev      # http://localhost:8080
```

Copy `.env.example` to `.env.local` and set `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY`.

## Documentation map

Start with `.ai/` — it is the canonical, code-verified project memory. Where an
older file in `docs/` disagrees with `.ai/`, `.ai/` wins.

| Read this | For |
| --- | --- |
| [`.ai/PROJECT_CONTEXT.md`](.ai/PROJECT_CONTEXT.md) | What the app is, hard product rules, entry points |
| [`.ai/ARCHITECTURE.md`](.ai/ARCHITECTURE.md) | Runtime shape, edge functions, native calling |
| [`.ai/SECURITY_MODEL.md`](.ai/SECURITY_MODEL.md) | Access control, secrets, accepted risks |
| [`.ai/BUILD_AND_RELEASE.md`](.ai/BUILD_AND_RELEASE.md) | Local, native, Supabase and web-hosting builds |
| [`.ai/TEST_PLAN.md`](.ai/TEST_PLAN.md) | Live Supabase + real-device verification checklist |
| [`DEPLOY.md`](DEPLOY.md) | Netlify / Vercel / Cloudflare hosting |
| [`docs/`](docs) | Historical phase audits and QA reports |

## Checks

```bash
npm run lint && npx tsc -b --noEmit && npm test && npm run check:rls && npm run build
```

CI runs the same set with no failure masking.
