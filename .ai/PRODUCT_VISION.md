# Product vision

DuoSpace is a private app for one couple: end-to-end-encrypted chat, voice/video
calls, shared media, music, a shared map, and small shared rituals (source:
`package.json` description, `README.md`, `docs/prd.md`).

Vision for what comes next (NOT built — see `DO_NOT_BUILD.md`): structured,
uncertainty-labelled relationship reflection that helps two people talk to each
other. It is never a score, never a verdict on a partner, and never runs on
data the person did not knowingly give it. `PHASE_STATUS.md` says which phase
is current; `NEXT_PHASE.md` says what has to be true before that work starts.

Principles that already have code behind them (Phase 1 / 1.6):
- Consent is per feature, revocable, and enforced by code (`src/lib/privacy/`).
- Raw camera/microphone/video never leaves the device (`sensorPolicy.ts`,
  `dataClassification.ts` matrix).
- An AI-derived statement always carries provenance and is never presented as
  something the user said (`src/lib/ai/provenance.ts`).
