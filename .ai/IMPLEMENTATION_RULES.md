RESTORED 2026-09-19 from this project's own prior session content (was
missing from this snapshot — see .ai/KNOWN_ISSUES.md KI-01).

Working rules for any AI agent making changes to DuoSpace.

1. Inspect before modifying. Read the actual file, not just the doc that
   describes it.
2. Source code is authoritative over documentation when they disagree —
   but log the disagreement, don't just silently trust one side.
3. Never fabricate verification. If a build, test, or live-DB/device
   check cannot actually be run in your current environment, say so
   explicitly (BLOCKED BY ENVIRONMENT / NOT TESTABLE / NOT VERIFIED)
   rather than inferring a PASS from the code looking correct.
4. RLS changes that can't cross-reference OLD vs NEW row values within a
   single `USING`/`WITH CHECK` expression need a `BEFORE UPDATE` trigger
   instead (see `call_history_transition_guard`/
   `partner_requests_transition_guard` for the established pattern).
5. Before touching Capacitor native sync, inspect `native/` and
   `native-plugins/*/android|ios` for custom modifications first.
6. New secrets or third-party API keys: prefer
   `client -> authenticated Edge Function (service-role) -> third party`
   over exposing anything beyond the public anon key to client code.
7. Every meaningful change: log WHY / WHAT / RISK / TEST / RESULT
   somewhere durable (`.ai/CHANGELOG.md` or the relevant `docs/*.md`).
8. Scope discipline: a partial, honest pass that lists what it did NOT
   reach is more valuable than an inflated complete-sounding one.
9. When `package.json` and `package-lock.json` disagree, do not
   hand-write lockfile entries — that produces a lockfile that looks
   resolved but isn't. Flag it and provide the exact command
   (`npm install`) for an environment that can actually run it.
10. Client-side TypeScript looseness (`as any` on a `.from()`/`.rpc()`
    call) is not itself a security bypass as long as RLS/triggers still
    enforce the real boundary at the database layer — don't conflate a
    typing convenience with an authorization gap, but don't assume every
    `any` is automatically safe either; check what it's actually hiding.
11. **Session delivery (standing owner rule, 2026-10-03):** when working on an
    uploaded project zip, ALWAYS deliver the updated zip at the end of the
    session, and do it BEFORE the token / context budget runs out: when the
    budget is getting low, stop starting new work, finish what is in flight,
    update `.ai/CHANGELOG.md` + the `.ai/HANDOFF_*.md` for the session, build the
    zip and hand it over. A half-finished session still ends with a zip and an
    honest "done / not done / not verified" list, never with only chat text.
    Build it from the working tree excluding `node_modules/`, `dist/`, `.git/`,
    and name it `duospace-v<package.json version>-<short-topic>.zip`.
12. **Native version stamping:** the native build number (Android
    `versionCode`, iOS `CURRENT_PROJECT_VERSION`) is derived from
    `package.json` `version` as major*10000+minor*100+patch by
    `scripts/native-version.mjs`, applied by `scripts/patch-native-permissions.mjs`
    (`stampNativeVersion`) and committed in `android/app/build.gradle`. The
    in-app updater compares exactly this number. Therefore: bump
    `package.json` version for every build you intend to ship OTA, keep minor and
    patch <= 99, and publish the release under the same x.y.z in the admin
    console. Never hard-code a versionCode.
13. **OTA / self-update is for sideloaded builds only.** Never ship the
    `duospace-app-update` plugin (it declares `REQUEST_INSTALL_PACKAGES`) in a
    Google Play upload. Admin-only access to uploading/publishing releases is
    enforced in Postgres (`private.assert_admin()` / `public.is_app_admin()`);
    do not move that check into the client or an edge function.

## Session delivery rule (standing)
- When working on an uploaded project zip, ALWAYS deliver the updated zip at the end of the session (before tokens run out).

## Session delivery rule
- When working on an uploaded project zip, ALWAYS deliver the updated zip at the end of the session (before tokens run out).
