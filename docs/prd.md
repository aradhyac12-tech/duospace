# DuoSpace — Product Requirements Document

## What this is

DuoSpace is a private mobile app built for exactly two people in a relationship —
not a general messenger. Every product decision should be checked against that:
if a feature only makes sense for groups, strangers, or public sharing, it
probably doesn't belong here. Internally the project has also been called
"Guardian Grace" (Lovable project name) and "duet sync chat" — same product.

## Who it's for

One couple, using the app together, indefinitely. Not a growth product, not a
multi-tenant SaaS. There is no concept of "other users" beyond the partner —
onboarding pairs two accounts and the app is scoped to that pair from then on.
This shapes almost everything downstream: no public profiles, no discovery, no
friend lists, no ads, no analytics dashboards aimed at monetization.

## Core promise

A single private space that replaces the 5-6 separate apps a couple normally
juggles (WhatsApp, a call app, a shared photo album, a shared music app, a
countdown/anniversary tracker) with one app that's actually built around being
a couple, not a generic contacts list. The value is depth on "just the two of
you," not breadth of features for everyone.

## Feature surface (as of this build)

- **Chat** — real-time 1:1 messaging, E2E-encrypted. Reactions, replies,
  edits, disappearing messages, scheduled messages, voice notes, photo/file
  attachments, WhatsApp chat history import, love letters (themed
  long-form messages), a "nudge" (attention-getting ping), lip-reading
  captions during calls, and "Surprise Mode" (see below).
- **Calls** — voice/video via Daily.co, screen share, PiP, adaptive
  bitrate, call history, live network-quality indicator, live lip-reading
  captions overlay.
- **Gallery** — shared/private photo & video storage, per-item sharing
  toggle, in-app camera with filters.
- **Groic (music hub) / Playlist** — shared music search, queue, "blend"
  invites (merge listening sessions), mood-based recommendations.
- **Map** — live location sharing between partners.
- **Us** — the relationship-specific hub: countdowns to shared dates,
  anniversary tracking, mood detector, memory wall (shared photo+caption
  timeline).
- **Shayari** — a shared poetry/notes space.
- **Surprise Mode** — the flagship "delight" feature: code-defined
  surprises (`CodeSurpriseEditor`) that reveal with a premium animated
  card, WebGL scene, particle/blur effects.
- **Settings** — account, partner management/pairing (QR code and
  request-based), devices & sign-in (passkeys, biometric, PIN app-lock),
  security & privacy, appearance/theme engine, anniversary config, data
  backup/export/import, WhatsApp import.

## Design principles (established this session)

- **Single bold accent, not a rainbow.** One violet accent color carries
  every "this is active / this is the primary action" signal in the app.
  Status colors (success/warning/info/destructive) are separate and muted.
  Multi-color icon menus were explicitly removed as inconsistent with this.
- **Comfortable for daily, lifetime use — not just a demo screenshot.**
  Concretely: respects `prefers-reduced-motion` app-wide, uses muted status
  colors instead of saturated ones, avoids a "wall of settings" (Settings
  defaults collapsed), and touch targets on high-frequency actions (back
  buttons, biometric unlock, delete/confirm) are sized for real daily use,
  not just visual balance.
- **Haptics as a felt layer, not decoration.** Every interactive action
  should have a haptic weight that matches its meaning — a light tick for
  navigation, medium for confirmations/toggles, heavy for high-commitment
  actions (ending a call, deleting data), success/warning/error for
  outcomes. See `design.md` for the full mapping.
- **Privacy is a feature, not a footnote.** E2E encryption, private
  Supabase storage buckets with signed URLs, PIN/biometric app-lock,
  "Vanish Mode" / disappearing messages, and a "Peek Guard" privacy-lock
  overlay all exist because this is deeply personal data for two people,
  not a public social product.

## Non-goals

- No third-party discovery, no public profiles, no ads.
- No group chat / multi-partner support — the data model and RLS policies
  assume exactly one partner relationship per account.
- Not trying to compete on raw feature breadth with general messengers —
  depth on the couple use case is the differentiator.

## Current known gaps (see `phases.md` for detail)

- Native `android/`/`ios/` directories have not been generated in this
  checkout (`cap add android/ios` never run) — no native build has been
  verified from this environment.
- Google OAuth native redirect (`duospace://auth`) needs to be added to
  the Supabase Dashboard redirect-URL allow-list — a dashboard config
  change, not a code change.
- Haptics wiring is comprehensive but not yet 100% — see `phases.md` for
  the remaining files.
