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
| [`.ai/PRIVACY_MODEL.md`](.ai/PRIVACY_MODEL.md) | The privacy-gate pipeline every sensitive processing step must pass through |
| [`.ai/CONSENT_MODEL.md`](.ai/CONSENT_MODEL.md) | Feature-specific, revocable consent — what's enforced and where |
| [`.ai/AI_OUTPUT_CONTRACT.md`](.ai/AI_OUTPUT_CONTRACT.md) | The shape every future relationship-AI insight must have |
| [`.ai/BUILD_AND_RELEASE.md`](.ai/BUILD_AND_RELEASE.md) | Local, native, Supabase and web-hosting builds |
| [`.ai/TEST_PLAN.md`](.ai/TEST_PLAN.md) | Live Supabase + real-device verification checklist |
| [`DEPLOY.md`](DEPLOY.md) | Netlify / Vercel / Cloudflare hosting |
| [`docs/`](docs) | Historical phase audits and QA reports |

## Privacy & AI architecture

DuoSpace has no relationship-AI feature yet — what exists is the
foundation one will be built on (`src/lib/privacy/`, `src/lib/ai/`, the
`user_consents`/`ai_insights` tables). The short version: every future
AI feature is off by default, consent is per-feature and revocable, raw
microphone/camera/video data can never reach the cloud regardless of
consent (a hard rule, not a toggle), and every AI-generated insight must
carry its own confidence, uncertainty, and provenance rather than
asserting a bare fact. See `.ai/PRIVACY_MODEL.md`, `.ai/CONSENT_MODEL.md`,
and `.ai/AI_SAFETY_SPEC.md` for the full picture, and
`docs/PHASE_1_PRIVACY_CONSENT_LOCAL_AI_FINAL_REPORT.md` for how this was
built and what's still open.

## Checks

```bash
npm run lint && npx tsc -b --noEmit && npm test && npm run check:rls && npm run build
```

CI runs the same set with no failure masking.

## Deployment

See [DEPLOYMENT_INVARIANTS.md](./DEPLOYMENT_INVARIANTS.md) — the permanent rules that keep Vercel, Lovable Publish, Cloudflare Pages and Netlify builds green. Run `npm run verify:lock && npm run build` before every push.
