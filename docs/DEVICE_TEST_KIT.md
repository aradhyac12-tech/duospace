# Device & Live Verification Kit (Phase 3H)

Everything here must be run on a machine / phone that can reach `*.supabase.co` and `huggingface.co`. Results go into `docs/eval/` and are sent back for review. **Never paste keys, passwords or tokens into reports or chats.**

## 0. Prerequisites
Node ≥ 22, npm 10.9.x (`packageManager: npm@10.9.2`), Android Studio (SDK 35+, JDK 21), an S24 Ultra with USB debugging, optionally a second Android phone. Staging project: `otaficrlkiscaihdwxnt`. Get its **anon key** and **service-role key** from the Supabase dashboard → Project Settings → API (staging only; the service-role key is used by script §1 only, never in the app).

## 1. HTTP auth + RLS (real JWTs, real API) — ~1 minute
```
npm ci
STAGING_URL=https://otaficrlkiscaihdwxnt.supabase.co \
STAGING_ANON_KEY=<staging anon key> \
STAGING_SERVICE_ROLE_KEY=<staging service-role key> \
node scripts/verify/http-rls-e2e.mjs
```
Creates three throw-away users, runs 24 checks (sign-in, wrong password, refresh, tampered JWT, share/read/withdraw, F1 re-withdraw, stranger/anon, forged owner, hidden payload, account switch on one client, unlink), deletes the users, writes `docs/eval/phase3h_http_rls.json` (no secrets). Refuses to run against production. **Send the JSON back.**

## 2. Local AI artifact — needs ~400 MB download
```
node scripts/verify/fetch-local-model.mjs
```
Resolves commit `028493f` of `HuggingFaceTB/SmolLM2-360M-Instruct` to its full hash, downloads the 5 manifest files into `models/` (git-ignored), computes SHA-256 locally, compares with Hugging Face's published LFS hash, writes `docs/eval/phase3h_model_artifact.json`, and prints a manifest snippet. **Do not paste the snippet yourself — send the JSON back.** Local AI stays NOT VERIFIED until a device runtime test passes.

## 3. Android build (uses the repo's own gates)
```
# point the app at STAGING. build:staging REFUSES to build without these,
# or if they point at production (plain `npm run build` would silently use production).
echo "VITE_SUPABASE_URL=https://otaficrlkiscaihdwxnt.supabase.co" > .env.staging
echo "VITE_SUPABASE_PUBLISHABLE_KEY=<staging publishable key>" >> .env.staging
npm run build:staging
grep -rl "otaficrlkiscaihdwxnt" dist/assets | head -1   # must print a file: proves staging is baked in
npm run cap:add:android        # first time only (runs deps gate → cap add → patches → native gate → assets)
npm run cap:sync
cd android && ./gradlew assembleDebug && cd ..
npm run cap:verify:apk
sha256sum android/app/build/outputs/apk/debug/app-debug.apk
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```
Record: APK path, SHA-256, versionName/versionCode (`aapt dump badging`), applicationId `com.duospace.app`.
(Release/AAB needs the CI keystore secret; a debug build is enough for device QA.)

## 4. Device matrix (fill one row per test)
| # | Area | Test | Device / Android | Network | Result (PASS/FAIL) | Notes / screenshot |
|---|---|---|---|---|---|---|
| A1 | Auth | sign up, log in, log out, log in again | | | | |
| A2 | Auth | account switch A → B on the same phone: **no A data visible** (chat, memory, Insights, notifications) | | | | |
| A3 | Auth | force-stop + reopen keeps session; airplane mode → reopen shows offline state, no crash | | | | |
| R1 | Relationship | pair A↔B; unlink; relink | | | | |
| M1 | Memory | create, edit, correct, delete, delete-all | | | | |
| M2 | Sharing | A shares → B sees; A withdraws → B loses it; A corrects shared → B never sees old one as current | | | | |
| M3 | Sharing | turn sharing consent off while a share is in progress → nothing stays shared | | | | |
| M4 | Offline | airplane mode → delete-all → must refuse with a clear message; reconnect → retry works | | | | |
| M5 | Unlink | unlink while memories are shared → memories show private after reopen (reconcile) | | | | |
| C1 | Chat | send/receive, attachments, offline send → reconnect, no duplicates | | | | |
| N1 | Notifications | foreground/background/killed/locked; tap opens right screen; no memory text in previews | | | | |
| K1 | Calling | A→B ring, accept, reject, hang up, lock screen, Wi-Fi↔cellular | | | | |
| S1 | Safety | Hindi "वो मुझे मारता है" in Repair → safety hold; region India shows 112 | | | | |
| P1 | Privacy | Logcat during M1–M3 contains no memory text (`adb logcat | grep -i <a unique test phrase>`) | | | | |
| P2 | Privacy | screenshot of memory screen (currently allowed: `PrivacyScreen.enable=false`) — record only | | | | |
| T1 | Timing | cold launch, warm launch, login, chat open, send latency (stopwatch/`adb shell am start -W`) | | | | |

## 5. What to send back
`docs/eval/phase3h_http_rls.json`, `docs/eval/phase3h_model_artifact.json`, the filled matrix, APK SHA-256, and any Logcat excerpts for failures (redact personal content).
