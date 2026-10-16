# Handoff 2026-10-13 — v3.23 slice 1: real cloud "Help me reply" (via existing gateway)

Base: duospace-v3_22_29-fallback-safe.zip (package.json still says 3.22.22; NOT bumped).

## Audit finding (evidence)
- `callAiGateway` (src/lib/ai/cloud/gatewayClient.ts) was used ONLY by compatibility/cloud.ts. QuickReplySheet and UnderstandSheet never called it.
- registry.ts: only local-rule-v1 + local-model-v1 (needs verified model; manifest BLOCKED). So Help me reply was deterministic templates; `usedModel` was never true in practice.
- Server `ai-gateway` (supabase/functions/ai-gateway + _shared/ai/*) already has: JWT auth, minimised strict request, server-side consent (CLOUD_AI_PROCESSING + RELATIONSHIP_INSIGHTS), reserve-before-call quota with refund on failure, Zod schema, grounding/unsafe guard, no-text telemetry. Providers: openai/gemini/sarvam, configured ONLY by Supabase secrets (AI_STD_FAST_PROVIDER/_MODEL etc.). Whether those secrets are set / function deployed: UNKNOWN from source — live generation NOT VERIFIED.

## Changed
- NEW src/lib/relationship/contextual/cloudReply.ts — consent precheck (no gateway call without both consents), QUICK_REPLY via callAiGateway, client re-validation, single in-flight guard, no client quota charge, result carries `source`.
- src/components/chat/QuickReplySheet.tsx — on-device result computed first (safety hold/refusal/insufficient never go to cloud); cloud attempted only when consented; honest badge (AI service vs on-device); cancel (ignores late result), retry, opt-in card with disclosure; refs prevent re-trigger/re-charge. Local-model `consumeAiQuota` path left as before.
- src/pages/Chat.tsx — passes minimal `recent` context (≤4 prior messages) via buildReplyContext.
- Strings p1.reply.{cancel,retry,badge.ai,badge.device,notice.quota,notice.unavailable,cloud.*} in en/hi/mr (i18n.ts) + hil/mrl catalogs. Machine-authored, NOT native-reviewed.
- NEW src/test/contextual/cloudReply.test.ts.

## NOT done / NOT verified
- No node_modules and no network in this session: tsc, lint, vitest, build, check:* all NOT RUN. New code and tests are unexecuted — run `npm ci && npx tsc -p tsconfig.app.json --noEmit && npm test` first.
- UnderstandSheet not wired to UNDERSTAND task (still deterministic-only; correct for quota). Optional contextual path = next slice.
- Repair/COMPLEX_CONFLICT, context-menu/composer/visual polish, eval dataset (en/hi/mr/Hinglish), theme cold-boot audit, privacy-policy text update: not started.
- Existing key p1.reply.consentBody ("nothing is sent anywhere") is true only before cloud opt-in; revisit wording.
- Consent copy says "not end-to-end encrypted while processed" — confirm with owner/legal.
- Device (S24 Ultra) validation: not performed.
- Deploy prerequisites for live generation: deploy ai-gateway; set AI_STD_FAST_PROVIDER/AI_STD_FAST_MODEL (+ provider API key secret) in Supabase; run `npm run test:ai-live` against staging.

- 2026-10-13 slice 2: added src/test/fixtures/replyEval.v1.json (14 synthetic cases en/hi/mr/hinglish) + src/test/contextual/replyEval.test.ts (deterministic only; NOT run; live quality eval NOT run).
- 2026-10-13 slice 3: p1.reply.consentBody reworded in en/hi/mr/hil/mrl (on-device by default; cloud only if user allows) + matching expectation in phase3kRelationshipUiI18n.test.ts. Not run.
- 2026-10-13 slice 4: Understand now has an OPTIONAL user-tapped "Look closer" (cloudUnderstand.ts, UNDERSTAND task via callAiGateway), shown only when both cloud consents are already granted; deterministic Understand unchanged (still no quota). Evidence must appear literally in the message; hidden-motive wording rejected; cannotTell shown as uncertainty. Strings en/hi/mr/hil/mrl (p1.understand.cloud.*). Tests: src/test/contextual/cloudUnderstand.test.ts. NOT RUN.
- 2026-10-13 slice 5: MessageContextMenu audit: already grouped (normal · relationship help · edit/pin/delete), plain labels, >=44px targets, safe-bottom; no Repair in menu (stays inside Understand, only when offersRepair). Added Escape-to-close, role=dialog/aria-modal, reduced-transparency fallback, max-h + overscroll-contain. Not run; no device check.
- 2026-10-13 slice 6: theme cold-boot SOURCE audit: index.html inline script (saved mode + duo-boot-tokens snapshot) runs before the module; main.tsx calls bootTheme() before createRoot; no second theme system. Added src/test/themeColdBootSource.test.ts (not run). OPEN (needs device): native splash/windowBackground is fixed #121316 in capacitor.config.json, so a light-theme user may see a dark splash first; not changed (native behaviour).
- 2026-10-13 slice 7: composer audit (no change) + docs/V3_23_ENGINEERING_REPORT.md (interim, honest).
- 2026-10-13 slice 8: MessageComposer aria-labels -> tr("p1.composer.*") (9 keys x 5 catalogs). Visual layout untouched. Not run; en text identical to previous labels.
- 2026-10-13 slice 9: PrivacyAISettings cloud-AI description now states what is sent; no policy page in source -> owner/legal must update published policy (see report addendum). Not run.
- 2026-10-13 slice 10: self-review fix in QuickReplySheet: auto-run now once per opened message (facts.confidence change could re-fire and double-charge cloud); skip cloud when on-device model already produced+charged the reply. Not run; a component test for "one gateway call per open" is still TODO (needs jsdom run).
- 2026-10-13 v3.23.1: keyed bounded dedupe (inflight.ts) for cloudReply/cloudUnderstand; close invalidates run; server guard evidence=selected message only; quickReplyLifecycle component test written (NOT RUN); contextualUi consent mock fixed. Toolchain still unavailable. See report "v3.23.1" section.
- 2026-10-13 v3.23.1 UI: reply sheet + Understand hierarchy reworked (flat surfaces, options below draft, action before repair); Understand stale cloud result guard; understandCloudLifecycle.test.tsx added. NOT RUN, NOT visually verified.
