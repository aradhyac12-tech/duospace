How AI-derived relationship information persists. Implementation:
`ai_insights` table + `src/lib/ai/types.ts`'s `InsightLifecycle`.

## Four categories, never conflated

1. **Temporary context** — not a distinct table; a future feature using
   short-lived context should set `lifecycle: TEMPORARY` and a real
   `expiresAt` rather than inventing a parallel store.
2. **User-provided memory** — `source: USER_REPORTED` / `USER_ENTERED`.
   Full user visibility and deletion (RLS DELETE policy already allows
   owner deletion).
3. **AI-derived memory** — `source: LOCAL_MODEL` / `LOCAL_RULE` /
   `CLOUD_MODEL` / `SHARED_COUPLE_DATA`. Carries confidence, provenance
   (the `source`/`modelVersion` fields), and is immutable post-creation
   at the database layer (`enforce_ai_insight_immutability` trigger) —
   it cannot silently graduate into being treated as a stated fact,
   because the schema itself keeps `source` permanent.
4. **Sensitive relationship data** — anything `HIGHLY_SENSITIVE`
   (`.ai/DATA_CLASSIFICATION.md`). Same table, same RLS; the
   classification field is what a future UI should key its extra caution
   (confirmation dialogs, no-partner-visibility-by-default) off of.

## Correction

`correction: { verdict: NOT_ACCURATE | CORRECT | ADD_CONTEXT, note?, correctedAt }`
— set via an UPDATE that the immutability trigger explicitly allows.
Original `observation`/`confidence`/etc. are preserved untouched
alongside it. No UI for this yet (no insights exist to correct).

## Deletion

RLS allows owner DELETE. No dedicated "delete all AI data for this
feature" bulk action exists yet — a future feature should add one rather
than relying on users finding individual rows.

## Not built this phase

Confidence decay over time (the `lifecycle: EXPIRED` transition has no
automated trigger/cron yet — would need one once real insights exist).

## Phase 2A update

Insights now exist: Relationship Reflection's three analyses. They use
the same four-category model above, unchanged, with two differences
specific to this feature (both already noted in `.ai/AI_OUTPUT_CONTRACT.md`):

- Storage is local-only (`InsightBackend` via secureStorage), not the
  `ai_insights` Supabase table — so "RLS allows owner DELETE" above
  doesn't apply to these; deletion is `deleteLocalInsight()` on-device.
  `updateLocalInsight()` (added this phase, same file) is the one path
  that may overwrite an existing local insight, and only for a
  correction: it refuses any change to `id`/`userId`/`createdAt` and
  re-runs the full safety + provenance check before writing, so
  "preserve provenance" holds exactly the way the DB trigger enforces it
  for the Supabase-backed table.
- Correction now has a real UI (Insights tab, "Rate this") using the
  four-way verdict set from `.ai/AI_OUTPUT_CONTRACT.md`
  (`PARTLY_ACCURATE`/`NOT_RELEVANT` added alongside the original three).
  Nothing about a correction is used to retrain or adjust the provider —
  there is no model to retrain (`LOCAL_RULE`); it is recorded and nothing
  else, per the brief's §20.
