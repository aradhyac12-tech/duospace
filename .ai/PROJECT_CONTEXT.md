> **Superseded (2026-09-23):** DuoSpace calling is now self-hosted only (WebSocket signaling + LiveKit). Mentions of the previous provider below are historical. Current architecture: `docs/calling-architecture.md`; migration record: `docs/CALLING_MIGRATION_DAILY_TO_SELF_HOSTED.md`.

RESTORED 2026-09-19 from this project's own prior session content (was
missing from this snapshot — see .ai/KNOWN_ISSUES.md KI-01).

READ THIS FIRST. SOURCE CODE IS AUTHORITATIVE. UNVERIFIED INFORMATION
MUST NOT BE PRESENTED AS VERIFIED.

## What DuoSpace is

A privacy-first, couples-only private communication app. Two paired
users get chat, calls, shared media, music, map/location sharing, and
relationship-oriented features (memories, mood, countdowns, shayari).
Product owner and lead developer: Aradhya, working solo, directing an AI
assistant as the engineering team across sessions via uploaded zip
snapshots.

## Stage

Pre-launch, actively hardening. Not production-ready — see
`.ai/CURRENT_STATE.md` and `docs/PHASE_4_SECURITY_AUDIT.md`.

## Stack

React + TypeScript, Vite, Tailwind, Framer Motion, shadcn/ui. Supabase
(Postgres/RLS/Realtime/Storage/~22 Edge Functions). Capacitor,
`android`/`ios` generated not committed. Daily.co (default calling) +
native Telecom/CallKit; a self-hosted LiveKit scaffold exists as an
opt-in parallel track. As of the Phase 1 privacy foundation: a full
data-classification/consent/privacy-gate/AI-insight-contract system
exists as infrastructure, with no relationship-AI feature built on it
yet (feature freeze — see `.ai/DO_NOT_BUILD.md`).

## Environment constraints for any AI agent working from a sandbox like this one

No network egress (`npm ci` 403s). No live Supabase connection, no
Docker, no Android SDK, no Xcode, no physical devices, as configured in
every sandbox this project has run in so far. Every claim about live DB
behavior, RLS enforcement, or a real build/device must be marked NOT
TESTABLE / BLOCKED BY ENVIRONMENT rather than PASS.

## AI safety stance

DuoSpace must never become a surveillance tool between partners. See
`.ai/DO_NOT_CHANGE.md` and `.ai/DO_NOT_BUILD.md`.

## Documentation map

`.ai/` is the canonical, code-verified project memory — where an older
`docs/` file disagrees, `.ai/` wins. `docs/PHASE_4_SECURITY_AUDIT.md` is
the ongoing, dated security-finding log. This file set has repeatedly
gone missing between session snapshots — see `.ai/KNOWN_ISSUES.md` KI-01
— check the export/sync pipeline if this keeps happening.
