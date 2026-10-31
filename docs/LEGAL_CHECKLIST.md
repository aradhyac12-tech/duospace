# Legal / privacy checklist (from the "vibe-coded app liability" video, audited 2026-10-02)

Not legal advice. Have a lawyer review before launch. Status after v3.20.5:

| # | Item | Status | Where |
|---|------|--------|-------|
| 1 | Age gate on signup (COPPA / DPDP / GDPR-K) | DONE in code | `lib/legal/ageGate.ts`, `pages/Auth.tsx` (DOB field + OAuth "I am 18+" box). Stores only `age_gate` metadata, never the DOB. `MIN_AGE = 18` (change deliberately). 24h device block after a failed attempt. |
| 2 | Fonts from Google leak visitor IPs (LG München I, 3 O 17493/20) | DONE in code, ONE STEP LEFT | Run `npm run fonts:fetch` once on a networked machine and commit `public/fonts/`. Until then fonts fall back to the system stack (no Google request is made either way). Guard: `test/legal/noThirdPartyLoads.test.ts`. |
| 3 | Session replay / analytics | Already clean | No analytics or replay dependency; `telemetry.ts` is first-party and redacted. Guard test fails if one is added. |
| 4 | Email unsubscribe + postal address (CAN-SPAM) | Guarded | `send-email` is transactional only and now REFUSES marketing-type mail. Before any launch/waitlist email: add unsubscribe link + `List-Unsubscribe` header + postal address + suppression list. |
| 5 | Renewal terms next to the buy button (CA ARL) | DONE (v3.20.4) | `lib/monetization/billingCopy.ts`. Still needed for Play: confirm the Play listing shows price/renewal/cancel too. |
| 6 | DMCA agent for user uploads | PAGE DONE, FILING IS YOURS | `/legal/copyright` is public. Register an agent (~$6, dmca.copyright.gov), then set `VITE_DMCA_AGENT_NAME/EMAIL/ADDRESS`. Preflight warns until set. |

## Found beyond the video (not changed)
- `lib/faceRecognition.ts` and `workers/faceDetection.worker.ts` load MediaPipe WASM from cdn.jsdelivr.net at runtime (third-party request with the user's IP). Bundle it locally.
- Face detection touches biometric data (e.g. Illinois BIPA, GDPR Art. 9): needs explicit consent text and a retention/deletion statement before it ships.
- No Terms of Service or Privacy Policy page exists in the app (Play requires a privacy policy URL).
