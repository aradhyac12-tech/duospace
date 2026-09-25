# Offline-first pass — 2026-09-21

Request: "offline support is zero for apk and ipa — it loads everything on every
launch; it should be like WhatsApp: keep messages and everything, work with no
net once loaded, no need to reload after every launch."

## Root causes (confirmed from source)

1. **Launch bounced offline users to the login screen.** supabase-js decides
   `INITIAL_SESSION` via `getSession()`, which — when the ~1h access token is
   expired (nearly every real launch) — tries a network refresh first. Offline it
   fails after a long retry, supabase-js emits `INITIAL_SESSION` with `null`, and
   `AuthContext` read that as "signed out": up to 8 s of boot screen, then
   `/auth`. Even online, nothing could render until the refresh round trip ended.
2. **E2E keys needed the network on every launch.** `useE2E` fetched the
   account key and the partner's public key from Supabase and refused to be
   `ready` until both arrived; `Chat` waited on `ready` before its first fetch.
   Offline: nothing decrypted, nothing sendable.
3. **The "cache" was 60 messages in one Preferences blob**, only readable after
   the two network-gated steps above, not pageable, and rewritten wholesale.
4. **Media was a signed-URL network fetch per image, per launch**; offline every
   photo/voice note was broken.
5. **`useSessionGuard`** ran `getSession()` immediately and every 4 min with no
   offline check (toast spam; `onExpired` redirect risk).
6. **Failed reads replaced the chat with "Couldn't load messages."** and offline
   sends became red "Failed to send" bubbles that needed a manual tap.
7. `useCallHistory` (call rows in the chat timeline) had no cache at all.

## What changed

| Area | Change |
|---|---|
| Auth (`AuthContext.tsx`, `lib/persistedSession.ts`) | User seeded **synchronously** from supabase-js's persisted session → first frame renders with no wait. `INITIAL_SESSION: null` means signed out **only if no persisted session remains**; otherwise "offline session" (stay signed in, re-validate on reconnect/resume). A real server rejection still signs out (supabase-js deletes the session + `SIGNED_OUT`). `SIGNED_IN` keeps user identity stable (fewer channel rebuilds on resume). |
| Session guard | No checks while offline; transport errors don't toast. |
| Network layer (`client.ts`, `lib/connectivity.ts`) | Definitely offline → requests fail instantly (no OS timeout, no auth backoff); REST **reads** capped at 25 s for "Wi-Fi but no internet". `@capacitor/network` may only announce "back online", never veto requests. |
| E2E (`useE2E.ts`) | Own keypair applied from IndexedDB at once, server only **reconciles** (canonical key wins, `keyVersion` bumps → Chat re-decrypts). Partner public key cached per (me, partner). |
| Message store (`lib/localDb/*`, `chatCache.ts`) | One AES-256-GCM record **per message** in IndexedDB (`duo-local-v1`), compound index for O(page) reads, up to 20 000 msgs/conversation. Chat hydrates from it before any network. Server window is stored + **reconciled** (rows the server no longer has are removed); if >1 page arrived while away the **gap is back-filled**; live changes go through a debounced diff-writer; scroll-back pages from local when offline. One-time import of the old 60-message blob. |
| Media (`lib/mediaCache.ts`, `signedStorageUrl.ts`) | `chat-files` images/voice/video ≤25 MB are downloaded once (background, 2 at a time) into IndexedDB; `resolveSignedUrl` then returns a stable local `blob:` URL — instant and offline. LRU cap 400 MB. Documents are never cached (they open via https in the system browser). Offline + uncached → immediate `null` instead of a 2.5 s backoff per item. |
| Outbox (`Chat.tsx`) | Offline text/media sends stay as a "sending" clock (no toast), are already persisted (`pendingSendQueue`), and are re-sent **in order** on reconnect/resume. Real (non-network) errors still become red retry bubbles. Idempotent via `client_message_id`. |
| Chat errors | A failed refresh no longer replaces a visible conversation with an error. |
| Calls in chat | `useCallHistory` shows the last known rows instantly/offline (encrypted via secureStorage, `room_name` dropped). |
| Sign-out / unlink | `wipeLocalConversationData` deletes stored messages **and** cached media (in addition to `secureWipeAll` destroying the key). |

## Privacy trade-offs (deliberate, owner-requested — flip flags to undo)

* Decrypted history now lives on the device (was: last 60). Encrypted at rest
  with the per-user key; **software** AES with the key in the app's IndexedDB —
  not Keystore/Keychain (unchanged limitation, see `secureStorage.ts`).
  `PERSIST_CHAT_CACHE=false` in `chatCache.ts` disables it.
* Cached chat media is **not encrypted at rest** (server copy isn't E2E either);
  sandbox-protected like WhatsApp media. `MEDIA_CACHE_ENABLED=false` disables it.
* Never stored: disappearing/vanish/pending messages, unsent bubbles, blob
  previews, decrypt-failure placeholders.
* An offline session lets someone with the unlocked phone read local data with no
  server check — the app lock (PIN/biometric) is what protects that, as before.

## NOT verified — needs a real device (no Android/iOS toolchain or network here)

* `idbMessageBackend.ts` and `mediaCache.ts` (IndexedDB) — logic reviewed and the
  store logic above them is unit-tested against an in-memory backend, but the
  IndexedDB adapters themselves have not been run. Check on both an APK and an
  IPA: airplane mode → force-quit → reopen → chat + cached photos appear, no login.
* supabase-js behaviour when refresh fails offline was reasoned from its
  documented flow, not observed on this project's exact version.
* iOS WKWebView may evict IndexedDB under storage pressure; the cache then simply
  refills online (it is a cache; the server stays the source of truth).
* Only the 43 new unit tests were run (through a minimal harness — `vitest` could
  not be installed offline). Run `npm test` and `npm run build` before shipping.

## Known gaps / next steps

* **Playlist / Groic** (music) still fetches on open — next in line for the same snapshot pattern (`lib/screenCache.ts`).
* Imported WhatsApp messages (`useImportedMessages`) and message reactions are
  not cached.
* Deletions older than the newest window are only noticed when that range is
  next fetched online.
* No auto-download policy (Wi-Fi only / cellular) yet; no storage-usage row in
  Settings (`getMediaCacheSize()` exists for it).
* Optional: encrypt cached media at rest; native Filesystem storage for videos.


---

## Settings pass — 2026-09-21 (follow-up)

Audited every Settings screen for what it does with no connection.

**Real bugs found and fixed**

| Screen | Problem (offline / failed load) | Fix |
|---|---|---|
| Sign out (`Settings.tsx`) | Took the user id from `supabase.auth.getUser()` (network) so the whole cleanup, including the local-data wipe, was silently skipped offline; and `signOut()` *returns* `{error}` instead of throwing on a network failure, so the "couldn't sign out" toast could never fire — the person stayed signed in with a dead button. My earlier wipe also ran *before* sign-out, so a failed sign-out would have wiped the phone but left the session. | Id comes from the local session. Offline is refused up front with a clear message (sign-out must also stop this phone getting push notifications, which needs the server — a local-only sign-out would leave them on). If the server call errors, the session is still ended with `scope: "local"`. Local data (secureStorage, message store, media, settings cache) is wiped only **after** the session is gone. |
| Settings hub | A failed profile query fell through to `setPartnerLinked(!!undefined)` → **"Not connected yet" for a linked person**; badge zeroed. | Failed query changes nothing; hub is painted from a per-user cache first (`lib/settingsCache.ts`). |
| Profile | Failed load → "no partner"; no cache. | Painted from `partnerCache` + cached own name; a failed refresh with nothing remembered shows "couldn't load", never "no partner". |
| Partner screen | Failed load → showed the **"link a partner" flow to a linked person**; every mutation surfaced a generic "Failed / check your connection". | Seeded from cache; unknown state shows an explanatory card instead of the link UI; server-confirmed "no partner" still clears it. All server-only actions (search, request, accept/decline, invite, join, unlink, nickname) now stop with one clear "You're offline" message (`lib/offlineGuard.ts`). |
| Couple theme (`ThemeContext.tsx`) | Sharing the chosen theme with the partner used `getUser()` (network) and was silently dropped on failure; the partner-theme listener never started if the app launched offline. | Theme applies locally as before; the share is remembered and sent on reconnect; the listener starts as soon as we're online (guarded against double-subscribe). |
| Notification sounds | (Already reworked in v3.11.1 by the local-first `notificationSoundPrefs.ts` — that version is kept as-is; my parallel edit was dropped in the merge.) | — |

**New: Settings → Data & Backup → "Offline & storage"** (`OfflineStorageCard.tsx`,
`lib/offlineSettings.ts`): switches for *Keep chat history on this phone*,
*Save photos & voice notes*, *Only save media on Wi-Fi*; shows saved-message
count and media size with a **Clear** button. Turning history/media **off wipes
what is already stored**, not just stops adding. Wi-Fi-only uses the native
network type (or `navigator.connection` on web). None of this deletes anything
server-side — it only controls the local copy.

**Audited, no change needed:** Appearance, Language, Devices, Security (local
state); Privacy & AI (consent is server-side and **fails closed** when
unreachable — deliberate); Import (needs upload).

**Still not verified on a device:** everything in the earlier list, plus the
Wi-Fi-only check on iOS/Android, and the sign-out flow with real airplane mode.
Known limitation: an offline sign-out is refused rather than queued, because the
push-token cleanup needs the old user's session.


---

## Gallery, Us, Shayari pass — 2026-09-21

Shared building blocks: `lib/localDb/collectionStore.ts` (+ IndexedDB adapter,
`duo-collections-v1`) — encrypted whole-value **snapshots** per screen under the
same per-user key as the message store; `lib/screenCache.ts` — best-effort,
debounced facade (`readScreenCache` / `writeScreenCache`), never throws, honours
the new "Keep shayaris, memories & gallery lists" switch, and drops a pending
write if the user signed out meanwhile (so a wipe can't be undone by a timer).
Wiped on sign-out / unlink via `wipeLocalConversationData`.

Pattern on each screen: paint from the snapshot → fetch → replace → write back;
a failed refresh **with something on screen changes nothing** (no error card);
refetch on reconnect/resume (`useReconnectRefetch`); server-only actions stop
with one "You're offline" message (`requireOnline`).

| Screen | Real bug found | Fix |
|---|---|---|
| Gallery | `fetchGalleryPage` returned `[]` on error, so a failed read became "no photos" and **emptied the grid** (and would have overwritten a cache with nothing); albums did the same. Delete / share-toggle / gallery-sharing updated the UI without checking the server result. | Errors throw; `loadGallery` commits only when **both** lists answered; albums keep the old value on error; every mutation checks the result and is offline-guarded. Grid paints from a snapshot of the newest page of each list + albums; photos come from the on-device media cache (`gallery` bucket is now local-first). Share/copy fallbacks decline `blob:` URLs (byte-based download/share/save keep working). Deleting removes the cached photo. |
| Us | A failed streak query returned `0` ("no streak"); any failed load replaced the page with an error card. | Streak is `null` = unknown (keeps the last value); snapshot of profiles/countdowns/answers/streak (today's answers are only reused if saved today); server-confirmed "no partner" clears stale partner data. |
| Memories (in Us) | Same load-failure-becomes-error; photos re-signed every open. | Snapshot of the raw rows (never signed URLs) + `memories` bucket local-first; deleting removes the cached photo. |
| Shayari | Same; `toggleFavorite` flipped the heart even if the server refused the write. | Snapshot + refetch on reconnect; favourite only flips on success; add/edit/favourite/delete/import are offline-guarded. |

**Cost to know about:** the first time each gallery/memory photo is shown online
it is downloaded a **second** time in the background for the offline copy
(2 at a time, ≤25 MB each, 400 MB LRU cap shared with chat media). On mobile data
that roughly doubles first-view traffic — use *Only save media on Wi-Fi* in
Settings → Data & Backup → Offline & storage if that matters.

**Not verified on a device / known limits:** IndexedDB adapters (as before);
gallery snapshot holds only the newest 40 per list (older pages need the network);
offline uploads/edits are refused with a message, not queued (only chat sends are
queued); videos larger than 25 MB are never cached; snapshots refresh on open and
on reconnect but are not push-updated while the app is closed.
