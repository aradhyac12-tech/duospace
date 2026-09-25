# DuoSpace Gallery — Architecture & Phase 5 Audit

## Status
Gallery was already a mature, working feature (`src/pages/Gallery.tsx`,
~1050 lines) before this phase — Shared/Mine/Theirs tabs, per-item
sharing toggle, resumable chunked uploads, signed private-bucket URLs,
realtime partner sync, selection mode + bulk delete, camera capture. This
phase's job was audit-and-harden-and-extend, not rebuild, per the brief.

## Storage & metadata
`gallery_items` (Postgres) holds metadata (`owner_id`, `file_url`,
`file_type`, `is_shared`, `created_at`); actual bytes live in the private
`gallery` Supabase Storage bucket, folder-keyed by uploader's `auth.uid()`.
URLs are always resolved through `resolveSignedUrl`/`resolveSignedUrls`
(`src/lib/signedStorageUrl.ts`) — the bucket is private, so a raw public
URL 403s; this was already fixed in a prior pass (see the file's own
header comment) and re-verified this pass, not re-touched.

## Security (Part 17) — verified live, one real bug found and fixed
`gallery_items` RLS: SELECT scoped to
`owner_id = auth.uid() OR (is_shared AND owner_id = get_partner_id(auth.uid())) OR (owner via profiles.gallery_shared)`
— correct, verified directly against the live database. INSERT/UPDATE/
DELETE all owner-scoped. No cross-couple exposure at the metadata layer.

**Storage-object-level bug found and fixed:** `storage.objects` had two
UPDATE policies covering the `gallery` bucket (and `chat-files`,
`avatars`, `memories`) — one correctly folder-scoped, and a second,
`"Users can update own files"`, checking only `bucket_id` with **no**
ownership condition at all. Postgres OR's multiple PERMISSIVE policies
for the same command, so the unscoped policy's mere existence let *any*
authenticated user overwrite *any* other user's file in those buckets —
including another couple's gallery photos. Dropped the unscoped policy
(migration `20260824090000_fix_unrestricted_storage_update_policy.sql`,
applied live and verified by re-querying `pg_policies` afterward — each
affected bucket now has exactly one, correctly-scoped UPDATE policy).

**Left alone, flagged not fixed:** `surprise-assets`' INSERT/DELETE
policies are *also* unscoped by folder — but consistently so on both
operations, which reads as an intentional design for that one bucket
(access possibly controlled at a referencing table's RLS instead) rather
than the same copy-paste mistake. Not touched without confirming that
first — a genuine open question, not resolved this pass.

## Realtime (Part 18)
Already correctly implemented: one channel per `(user, partner)` pair,
INSERT/UPDATE/DELETE handlers, `cancelled` flag guarding in-flight async
signed-URL resolution against a torn-down effect, refs (`myItemsRef`/
`partnerItemsRef`) avoiding stale closures without channel churn. No
changes needed.

## "Our Moments" date grouping (Parts 4/5/8) — added this phase
`groupByDate()` — a pure display transform (Today / Yesterday /
"August 2026" via `date-fns`) over each tab's existing item list, in the
same newest-first order the data already arrives in. Additive: doesn't
touch the Shared/Mine/Theirs structure, the data model, or any query —
just adds subtle group labels inside `GalleryGrid`.

## Full-screen viewer gestures (Parts 9/10) — added this phase
- **Swipe-down-to-dismiss**: the existing horizontal swipe (prev/next)
  drag was extended to free-axis; `onDragEnd` picks vertical vs
  horizontal by whichever offset dominates.
- **Double-tap zoom**: toggles a 2.5x CSS transform centered on the tap
  point. Not pinch-to-zoom — implementing a correct multi-touch pinch/pan
  state machine needs real-device gesture testing this sandbox can't do,
  and a half-working pinch is worse than an honest gap. **Pinch-to-zoom
  and pan-while-zoomed are NOT implemented** — logged as a known
  limitation, not silently skipped.
- **Known interaction caveat**: the drag wrapper (now free-axis) sits
  around the native `<video controls>` element too, same as the
  pre-existing horizontal-only version did for scrubbing. This wasn't
  newly introduced, but the caveat is now double-axis instead of single —
  a vertical drag intended to scrub might register as dismiss-swipe
  instead. Not verified on-device.

## Music ↔ Gallery video interaction (Parts 11/35) — real gap, fixed
Gallery never imported `useGroic` before this phase — a Gallery video's
autoplay could run underneath whatever was already playing in Music, with
nothing pausing it. Fixed in `MediaViewer`: pauses music once (if it was
playing) the first time a video is viewed in a given viewer session,
resumes once when the viewer closes. Deliberately scoped to "a video is
being viewed at all," not per-swiped-item — repeatedly calling `toggle()`
per item would need to track async state changes this component can't
reliably observe; see the inline comment for why a naive per-item
pause/resume would risk a stale-closure double-pause bug.

## Favorites (Part 20) — implemented this pass
Shared couple favorites, per the brief's own stated default ("prefer
shared couple favorites unless there is a strong existing reason for
personal favorites") — a single `is_favorite` boolean on `gallery_items`,
not a separate per-user favorites table. Either partner can toggle it on
anything they can already see, including the other partner's items.

**RLS approach, and why:** the existing owner-only UPDATE policy correctly
protects `file_url`/`is_shared`/etc, but would also have blocked a partner
from ever toggling favorite on a shared item. Rather than widen that
policy wholesale (which would let a partner change *any* column on
someone else's row), this adds a second, narrower UPDATE policy scoped to
the partner + item-visibility condition, plus a `BEFORE UPDATE` trigger
that rejects a non-owner update touching any column besides `is_favorite`.
Applied live and verified: `pg_policies` shows the owner policy untouched
and the new partner policy scoped exactly as intended.

UI: a heart toggle on every grid tile (all three tabs — mine/shared/
theirs, not just the uploader's own tab, since favoriting is a couple-wide
action) and in the full-screen viewer's toolbar. Both call the same
`toggleFavorite()`, which branches on which local array (`myItems` vs
`partnerItems`) actually owns the row rather than assuming the caller's
own tab, and also patches `viewList` directly (a separate open-viewer
snapshot that isn't derived from those arrays — without that patch, the
heart inside an already-open viewer wouldn't visually update until closed
and reopened).

**Known minor gap, not fixed:** if your partner toggles favorite on the
exact item you have open in the full-screen viewer at that moment, the
realtime UPDATE handler updates `myItems`/`partnerItems` correctly but
doesn't patch `viewList` the way the local toggle does — the open
viewer's heart would show stale state until you close and reopen it. A
narrow, rare race; not worth the complexity of syncing a third piece of
state for it right now.

## Albums (Part 19) — implemented this pass
`gallery_albums` + a `gallery_album_items` join table, modeled the same
way every other couple-scoped table in this app already is (`gallery_items`,
`playlist_songs`): an owning row plus `get_partner_id()` for the pair,
not a new "couples" entity that doesn't exist elsewhere in the schema.
Applied live via the Supabase MCP connector, re-verified against
`pg_policies` afterward (7 policies total, all correctly scoped), and
mirrored into a local migration file.

**RLS worth calling out:** an album is a couple object (either partner
can rename/delete it — deliberately different from a `gallery_items` row,
which stays personally owned by whoever uploaded it, since an album only
exists because someone decided to group shared memories together). The
join table's INSERT policy additionally requires the referenced
`gallery_item` to actually be visible to the couple — without that,
someone could reference an arbitrary `gallery_items.id` belonging to a
totally unrelated couple's private photo into their own album. It
wouldn't leak the photo's bytes (signed URLs and `gallery_items` SELECT
are still couple-scoped separately), but it's a real data-integrity hole
that would've otherwise shipped unnoticed.

**Realtime is refetch-on-change, not per-row patching** — a deliberate
simplicity tradeoff from how `gallery_items`' realtime handler works.
Album membership changes are low-frequency compared to photo uploads;
correctness mattered more here than shaving a refetch.

**UI:** an album strip (cover thumbnail + item count + "New") sits above
the existing Shared/Mine/Theirs tabs; opening an album swaps the tabs out
for a dedicated detail view rather than becoming a fourth tab value — an
album is a cross-cutting view over either partner's items, not a peer of
the ownership-based tabs. Adding items to an album goes through the
existing multi-select flow ("Add to Album" in the bulk-action bar
alongside Delete); removing goes through a small per-tile control inside
the album detail view.

**Known UI limitation, not a backend one:** multi-select (and so "Add to
Album") is only available from the Mine tab — that restriction already
existed before this pass (bulk delete was Mine-only too) and this didn't
widen it. The RLS itself *does* allow adding a partner's shared photo to
an album; there's just no single-item "add to album" affordance on the
Shared/Theirs tabs yet to reach that path from the UI.

## Search (Part 21) — not implemented, by design
The brief gates it explicitly ("add search only if there is meaningful
metadata to search"). There still isn't much to search on beyond
date/type — no captions, tags, or location data exist in this schema —
so building search now would mean inventing metadata to search on,
which isn't what the brief asked for.

## Performance (Part 29)
Grid already lazy-loads images (`loading="lazy"`), doesn't decode full
video into the grid (metadata-only preload + poster-less `<video>` for
thumbnails). **Not verified**: behavior at 500–1000+ items — no
virtualization exists, and a very large gallery would render every
thumbnail's DOM node at once. Flagged, not fixed — virtualizing the grid
is a real change to the rendering architecture the "don't rebuild what
works" instruction argues against doing speculatively without a couple
actually hitting that scale.

## Verification
Same environment constraints as the Music hardening pass: no network, no
`node_modules` — everything above is **CODE VERIFIED** by reading/tracing
source and, for the database items, direct live queries against the
connected Supabase project. Nothing here has run on an actual device.
**REQUIRES REAL DEVICE**: gesture feel (swipe-down/double-tap on real
touch hardware), large-library scroll performance, native share/download/
camera flows, video-controls-vs-drag-wrapper interaction.
