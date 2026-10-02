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
