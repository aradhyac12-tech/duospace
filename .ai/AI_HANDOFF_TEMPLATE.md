# AI handoff template — copy to the top of a new session

**Repository state:** (zip name / commit) — source is authoritative; docs are not.
**Phase:** (see PHASE_STATUS.md)  **Goal of this session:**
**Read first:** `.ai/PROJECT_CONTEXT.md`, `CURRENT_STATE.md`, `DO_NOT_CHANGE.md`,
`DO_NOT_BUILD.md`, `KNOWN_ISSUES.md`.

## Verified vs claimed
| Item | Status (PASS/FAIL/PARTIAL/BLOCKED/NOT VERIFIED/NOT IMPLEMENTED) | Evidence (command + output, or file:line) |
|---|---|---|

## Environment
Network? Node/npm version? `node_modules` present? Android SDK / Xcode / device?
Anything unavailable is BLOCKED, never PASS.

## Changes made (files) / Changes NOT made
## Privacy check (mandatory if a sensor, consent, telemetry or server write was touched)
- New camera/mic use registered in `src/lib/privacy/sensorPolicy.ts`?
- Derived data classified in `dataClassification.ts` and routed through `PrivacyGate`?
- Anything written to logs/telemetry/partner-visible rows? Redacted?
## Open blockers / next step
