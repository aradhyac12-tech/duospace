# Backup & Restore Integrity — Phase 8.5

Source of truth: `src/hooks/useCloudBackup.ts`. This document describes what
the backup contains, what restore actually writes, and exactly how failure
is handled. Written after closing the write-integrity gap where a failed
Supabase write could previously still result in `setStatus("done")`.

STATICALLY VERIFIED against source. No live Supabase connection was
available this phase — anything requiring an actual failing/succeeding
network call against real tables is marked REQUIRES LIVE SUPABASE below.

## 1. What the backup contains (`gatherUserData`)

| Field | Exported? | Restored? | Notes |
|---|---|---|---|
| `messages` | Yes (all rows where the user is sender or receiver) | Yes | batched upsert, 100 rows/batch, `onConflict: id, ignoreDuplicates: true` |
| `gallery` | Yes (`gallery_items` metadata rows owned by the user) | Yes (metadata only) | see §4 — binaries are NOT included |
| `profile` | Yes (full `profiles` row) | **No** | intentionally not restored — see below |
| auth identity (email/password/session) | No | No | never leaves Supabase Auth; not part of the export at all |
| partner identity / linkage | Indirectly, via `profile.partner_id` if present | No | not written back by `applyRestore` |
| encryption keys | No | No | the backup's own encryption key (device secret) is never included in the payload it encrypts |
| device secret | No | No | same as above — would be self-defeating (the blob is encrypted with it) |
| security settings (PIN, App Lock, Peek Guard, passkeys) | Only insofar as they live on the `profiles` row and get exported with it | No | not restored, same as profile |

### Why `profile` is exported but not restored

`applyRestore()` only calls `supabase.from("messages").upsert(...)` and
`supabase.from("gallery_items").upsert(...)`. It never touches `profiles`.
This is intentional, not an oversight:

- The `profiles` row for the restoring account already exists (the user is
  signed in — that's how they got a `userId` to restore into). Overwriting
  it from an old backup would silently roll back things like the user's
  current display name, avatar, partner link, and security settings to
  whatever they were at backup time.
- `profile.user_id` in the backup is a snapshot of an auth identity. Writing
  it back is exactly the kind of accidental-credential-restore this phase
  was told to avoid.
- Restoring `partner_id` from a stale backup could re-link a user to a
  partner they've since unlinked from, or worse, silently overwrite a
  *different* partner link than the one they currently have.

Net effect: cloud restore recovers **conversation history and gallery
metadata**, not account/profile/security state. This should be stated in
the restore UI copy (currently the UI does not make this distinction
explicit — flagged as a product-level documentation gap, not a code bug).

## 2. Message write behavior

- Messages are restored in batches of 100 via `upsert(..., { onConflict:
  "id", ignoreDuplicates: true })`.
- **Every batch's Supabase response is now inspected.** If any batch
  returns an `error`, restore stops immediately — no further batches are
  attempted.
- The thrown error names the failing batch index (e.g. "batch 3 of 7") and
  how many messages were successfully written before the failure, so the
  UI can show something meaningful instead of a generic failure.
- `ignoreDuplicates: true` means re-running a restore after a partial
  failure is safe to retry from the top — already-written rows are skipped,
  not duplicated or overwritten.

## 3. Gallery write behavior

- Gallery metadata is restored in a single upsert call (not batched — the
  existing code does not batch gallery writes, and this phase did not
  introduce batching since gallery sets are expected to be much smaller
  than message history; if that assumption breaks in practice, batching
  gallery the same way as messages is the follow-up).
- The upsert's `error` field is now checked. On failure, restore stops and
  throws, reporting how many messages (if any) were already restored
  successfully before the gallery step failed.

## 4. Gallery binaries are NOT part of the backup

`gatherUserData()` only selects `gallery_items` table columns
(`id, file_url, file_type, file_name, is_shared, created_at`) — it does not
download or re-upload the actual image/video bytes from Storage.
`applyRestore()` correspondingly only re-inserts those metadata rows.

**What this means in practice:** after a restore, gallery items reappear in
the list, but `file_url` points at a Storage object that only exists if the
original bucket object is still present (i.e. restoring on the *same*
account without the underlying files ever having been deleted). If the
Storage objects are gone, restored gallery rows will show as broken/missing
images.

If product requirements state that gallery **files** (not just metadata)
must be restorable independent of the original Storage objects, that is a
product-level gap, not something this phase invented a fix for — doing so
safely (re-uploading potentially large binary blobs through the encrypted
backup path) is a bigger change than "close the write-integrity gap" and
was out of scope for Phase 8.5. Flagging it here rather than silently
shipping a backup that claims more than it delivers.

**Action item for the UI/release docs:** state plainly ("backs up your
messages and gallery info — not your photo files") wherever backup/restore
is described to the user.

## 5. Partial-failure behavior (the write-integrity fix)

Before this phase, `applyRestore()` awaited each `upsert()` call without
checking its `error` field. Supabase's JS client does **not** throw on a
database-level error for `upsert()` — it resolves normally with
`{ data, error }`. That meant a failed write (RLS rejection, constraint
violation, network blip mid-request) could pass silently, restore would
finish its loop, and the caller (`restore()` / `importJSON()`) would reach
`setProgress(100); setStatus("done")` regardless.

Fixed by:
- Checking `error` after every messages batch and after the gallery upsert.
- Throwing immediately on the first failure — no batch after the failing
  one is attempted ("do not silently continue").
- The thrown error is caught by the existing try/catch in `restore()` and
  `importJSON()`, which already routes to `setStatus("error")` — so a
  failed write can no longer reach `"done"`.

**What is still best-effort, by design:** restore is not atomic across
messages and gallery (two separate REST calls), and message batches are
not wrapped in a DB transaction either. A failure on batch 5 of 7 leaves
batches 1–4 committed. There is no rollback. The error message reports
exactly how much was written so the user/UI isn't misled about partial
state, but "stop and report partial failure" is the ceiling of what's
achievable without a server-side transactional RPC spanning both tables —
that would be a real architectural change, out of scope for this phase per
the "no broad architectural changes" constraint.

## 6. Wrong-key behavior

`decryptBlob()` runs AES-GCM decrypt with the provided key (device secret,
or a manually pasted key for cross-device restore). AES-GCM is an
authenticated cipher — decrypting with the wrong key does not produce
garbage JSON, it fails the GCM auth tag check and `crypto.subtle.decrypt`
rejects. The `restore()` catch block turns that into: *"Couldn't restore
with that key — double check it was copied correctly from the original
device"* when a manual key was supplied, or a generic wrong-key message
otherwise. No partial write can happen here — decryption fails before
`applyRestore()` is ever called.

## 7. Wrong-account behavior

`validatePayload()` runs before any write. It requires `payload.userId` to
be present and to exactly equal the currently signed-in `userId`; if it
doesn't match, it throws *"This backup belongs to a different account.
Restore blocked."* It also defensively scans `payload.messages` for any row
whose `sender_id`/`receiver_id` don't include the current user, and blocks
if found. Both checks run before `applyRestore()` touches the database.

## 8. Corrupted-payload behavior

`validatePayload()` checks: payload is a non-null object, `version` is a
number, `userId` is a non-empty string, and — if present — `messages` and
`gallery` are arrays. Anything else throws a descriptive error
("Backup file is empty or unreadable.", "Not a valid DuoSpace backup
(missing version).", "Backup is corrupted (messages/gallery)."). This runs
before any write, so a corrupted payload never reaches `applyRestore`'s
upsert calls.

## 9. Same-device restore

Uses `getOrCreateDeviceSecret()` with no `manualKey` argument — the device's
own locally-stored secret (Capacitor `Preferences` on native, `localStorage`
on web) is used to decrypt. This is the expected/default path and requires
no user input beyond picking a backup to restore.

## 10. Cross-device restore

The caller can pass a `manualKey` (the string shown by `exportDeviceSecret()`
/ "Show Encryption Key" on the original device) which overrides
`getOrCreateDeviceSecret()` for that one restore call. This was a P0 fix
from the prior phase (cross-device restore was previously structurally
impossible — no UI path existed to supply a foreign device's key). Static
review this phase confirms the code path exists and is wired correctly;
actual cross-device round-tripping needs a real second device.

## 11. What remains REQUIRES LIVE DEVICE TESTING

- An actual RLS rejection or constraint violation mid-batch, to confirm the
  new error-surfacing path fires exactly as designed against a real
  Supabase response shape. REQUIRES LIVE SUPABASE.
- Cross-device restore end-to-end (device A backs up, device B pastes the
  key and restores). REQUIRES REAL ANDROID / REQUIRES REAL IOS.
- Retrying a restore after a genuine partial failure, to confirm
  `ignoreDuplicates: true` actually produces the expected "resume from
  where it stopped" behavior against live data rather than just in theory.
  REQUIRES LIVE SUPABASE.
- Gallery binaries-missing behavior (§4) rendering as a broken image in the
  actual Gallery UI rather than just being inferred from the schema.
  REQUIRES LIVE SUPABASE.

Everything else in this document is STATICALLY VERIFIED / AUTOMATED TESTED
against the current source in this repository.
