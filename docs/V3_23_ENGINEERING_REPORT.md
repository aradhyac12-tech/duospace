# v3.23 — Chat UX + verified generative AI: interim engineering report (2026-10-13)

Status: PARTIAL. Source-only work; **no toolchain or network was available, so no gate was run.** Not production-verified.

## 1. Executive summary
Help Me Reply can now reach a cloud model through the existing `ai-gateway` (consent-gated, honest fallback). Understand has an optional user-tapped "Look closer". Everything else in the spec is audited, partly done, or not started (see 14).

## 2. Baseline audit
- Implemented in source: deterministic extraction/Understand/Repair/Today; server gateway with auth, consent, quota+refund, schema, guard, no-text telemetry; consent features incl. CLOUD_AI_PROCESSING; web cold-boot theme path; grouped context menu.
- Was broken/misleading: `callAiGateway` was never called by Chat sheets; Help Me Reply was deterministic only (`usedModel` never true; local-model manifest BLOCKED).
- Blocked: deployment/secrets state of `ai-gateway`, devices, toolchain.

## 3. UI changes
QuickReplySheet: source badge, cancel, retry, opt-in card, quota/unavailable notices. UnderstandSheet: optional look-closer. MessageContextMenu: Escape, dialog semantics, reduced-transparency, max-height. Composer: layout unchanged (safe-area by DuoSpaceBottomSurface; 44px targets); its 9 hardcoded-English aria-labels now use tr() (p1.composer.* in en/hi/mr/hil/mrl, machine-translated, not run).

## 4. Actual execution path (new)
Chat.tsx → QuickReplySheet.run → local svc.supportResponse (safety first) → requestCloudReply → hasConsent×2 → callAiGateway("QUICK_REPLY") → supabase `ai-gateway` → providers (openai/gemini/sarvam by secrets). Understand: tap → requestCloudUnderstand → callAiGateway("UNDERSTAND").

## 5. Provider/deployment
Providers configured only via Supabase secrets (AI_STD_FAST_*, AI_STD_REASON_*). Deployed/configured state UNKNOWN → live generation NOT VERIFIED. Prereqs: deploy function, set secrets, run `npm run test:ai-live` on staging.

## 6. Privacy/consent
Client sends nothing unless CLOUD_AI_PROCESSING + RELATIONSHIP_INSIGHTS granted; ≤4 prior messages + selected message; disclosure says not end-to-end encrypted while processed; decline keeps local behaviour. Privacy-policy document text NOT updated.

## 7. Quota
Single server-side charge by gateway (reserve-before-call, refund on failure). Client does not charge cloud calls; deterministic paths charge nothing; legacy on-device-model charge path untouched. In-flight guard prevents parallel taps. Cancel only ignores the result — the provider call may still complete.

## 8. Quality evaluation
Dataset `src/test/fixtures/replyEval.v1.json` (14 synthetic cases en/hi/mr/hinglish) + deterministic harness. Live groundedness/tone/latency/cost: NOT RUN. No quality threshold is claimed.

## 9. Localization
New strings in en/hi/mr/hil/mrl; machine-authored, not native-reviewed. Overflow/wrapping not verified visually.

## 10. Files changed
New: contextual/cloudReply.ts, contextual/cloudUnderstand.ts, test/contextual/{cloudReply,cloudUnderstand,replyEval}.test.ts, test/fixtures/replyEval.v1.json, test/themeColdBootSource.test.ts, this report, .ai handoff. Modified: QuickReplySheet.tsx, UnderstandSheet.tsx, MessageContextMenu.tsx, Chat.tsx, i18n.ts, uiCatalogs/{hil,mrl}.ts, phase3kRelationshipUiI18n.test.ts, .ai/CHANGELOG.md.

## 11. Verification gates
npm ci / tsc / lint / test / check:rls / check:lock / check:ai-secrets / verify:lock / build / cap:verify:*: ALL NOT RUN.

## 12. Music/Calls regression
No Music/Calls files touched. Regression tests NOT RUN.

## 13. Device (S24 Ultra)
Not performed. Splash colour (#121316 fixed) vs light themes needs a device look.

## 14. Risks / not done
Unexecuted code may not compile; client trusts gateway guard + schema; Repair/COMPLEX_CONFLICT not wired; composer/typography polish, Today/Reflection review, privacy-policy text, composer aria-label i18n, contrast/locale-wrap tests not done.

## 15. Recommendation
NOT READY for release. Run the gates, fix fallout, deploy/configure gateway on staging, run live eval + device checklist.

## Addendum (slice 9) — privacy text
No in-app privacy-policy page exists in source (src/pages/legal has only CopyrightPolicy.tsx), so the published policy/whitepaper must be updated by the owner/legal outside this archive to cover: cloud processing of selected chat text for Help me reply / Understand, ≤5 messages per request, not E2E while processed, provider(s) used, retention (none stored by DuoSpace; provider retention per provider terms — CONFIRM). Settings → Privacy & AI "Cloud AI processing" description was reworded to state what is sent (English only; not localized).

## v3.23.1 verification-fix pass (source-only; toolchain still unavailable)
Baseline: `npm ci` could not install (no network) → tsc/lint/vitest/build/check:*/cap:* ALL NOT RUN; no owner-supplied test output was available. Nothing below has been executed.

Bugs found and fixed
1. cloudUnderstand used ONE global in-flight promise → a different message/user could receive another request's result. Now keyed (hash of user+text+context+language; no raw text stored/logged), bounded (max 4 distinct in flight, extras refused → honest "unavailable"), cleaned up on success AND failure. New `contextual/inflight.ts`.
2. cloudReply had the mirror problem (switching message mid-flight got UNAVAILABLE; key lacked userId). Same keyed dedupe.
3. QuickReplySheet: closing the sheet now invalidates the in-flight run (late result ignored; provider call is NOT cancelled).
4. Server guard: UNDERSTAND evidence must now quote the SELECTED message (`currentText`), not surrounding context. Added guard test.
5. contextualUi.test.tsx mocked consent without `hasConsent` (would have broken after slice 1); mock extended with cloud-consent OFF. No assertion changed/removed.

Tests added (NOT RUN): cloudReply/cloudUnderstand concurrency + cleanup + bound tests; quickReplyLifecycle.test.tsx (one gateway call per open under rerenders, repeated taps, message switch with late result, close/reopen, provider failure labelling, no-consent no-call, on-device-model not double-charged, nothing auto-sent); guard test for context-sourced evidence.

Consent audit: cloud needs BOTH CLOUD_AI_PROCESSING and RELATIONSHIP_INSIGHTS (client precheck + server). "Allow on-device help" grants only on-device insights; "Allow AI service" is a separate explicit card that states what is sent. Declining sets a per-sheet flag only; nothing is granted. Fallbacks are labelled "Suggested on your phone".
Known limitation: "Another" in cloud mode re-requests the same mode (no variation hint), so the model may return a similar reply.
Live staging: NOT RUN (no staging credentials/network here). UI redesign beyond slices 1–8: NOT done in this pass; no device verification.
Recommendation: NOT READY.

### v3.23.1 UI convergence (source-only, not visually verified)
- Help Me Reply: hierarchy is now selected message (compact, header) → one flat draft surface (no bordered card) → source disclosure → notices/opt-in (divider, not a nested card) → tone/intent options (BELOW the draft) → Another/Shorter/More casual → primary "Use this reply" (min 44px). Controls are quiet filled pills (min 36px, wrap, focus ring) using semantic tokens only.
- Understand: statement + "Why?" evidence → optional cloud reading (only if consent already granted; divider, labelled possible interpretation) → ONE next action → Repair pills only when offersRepair. Late cloud result no longer leaks across messages (token guard) — test: understandCloudLifecycle.test.tsx.
- No theme/token additions. Dark/AMOLED/light/high-contrast/reduced-transparency: NOT visually checked (no renderer/device this session).
