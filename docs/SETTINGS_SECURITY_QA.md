# Settings, Security & Onboarding — QA Matrix (Phase 6)

Scope: the Settings hub redesign, its six new dedicated subview pages,
Profile, and Onboarding. This is a manual test matrix — nothing in this
repo checkout was build/typecheck-verified (no `node_modules`/network in
the sandbox that produced it). Run `npm run build` and a full typecheck
before trusting any of this on a device.

## 0. What changed structurally

- `src/pages/Settings.tsx` — was a single ~1450-line always-expanded
  accordion. Now a hub: 8 summary rows, each either a short sheet/dialog
  (Account, Anniversary) or a link to a dedicated page.
- New pages: `src/pages/settings/{PartnerSettings,DevicesSettings,
  SecuritySettings,AppearanceSettings,DataBackupSettings,ImportSettings}.tsx`,
  routed at `/settings/{partner,devices,security,appearance,data,import}`.
- New shared components: `src/components/settings/{ConfirmActionDialog,
  SettingsHubRow}.tsx`.
- `Profile.tsx` and `Onboarding.tsx` — audited, not restructured (they were
  already close to the target shape); fixes listed in §7–8.
- **No changes** to: crypto (`hashPin`/`verifyPin`/E2E key handling),
  WebAuthn/passkey registration or login logic, Supabase RLS, or any
  edge function. This was a placement/layout/disclosure pass only.

## 1. Cross-cutting checks (apply to every page below)

| # | Check | Expected |
|---|---|---|
| C1 | Cold navigation to a `/settings/*` route directly (deep link / refresh) | Page loads its own data independently; hub state isn't required |
| C2 | Back button from any subview | Returns to Settings hub, hub re-fetches nothing stale (partner/pending-count refetch on mount) |
| C3 | Airplane mode / offline before opening a subview | Page renders its shell; any query that fails shows an error state or empty state, not an infinite spinner |
| C4 | Airplane mode mid-action (toggle, save, submit) | Action fails gracefully with a toast; UI reverts to pre-action state, not stuck "in progress" |
| C5 | Rapid double-tap on any primary action button | Second tap is a no-op while the first is in flight (all mutating handlers below check a `pending`/`loading`/`saving` guard before firing) |
| C6 | Backgrounding the app mid-action, returning later | No duplicate submission on resume; in-flight requests either complete or the UI shows the true end state |
| C7 | Session expires (token invalid) while on a subview | Supabase call returns an auth error → generic "check your connection / try again" toast; does **not** silently pretend to succeed |

## 2. Settings hub (`/settings`)

| Flow | Steps | Expected |
|---|---|---|
| Search filter | Type "pin" | Only Security row shown (keyword match) |
| Search filter, no match | Type "zzz" | Empty list, no crash |
| Partner row badge | Have a pending partner request in DB | Badge shows count on Partner row |
| Deep link `/settings?invite=CODE` | Open link while not yet partnered | Immediately redirected to `/settings/partner?invite=CODE`, no dialog flashes on the hub itself |
| Account sheet — username save | Enter valid username (3+ chars, `[a-z0-9_.]`), tap Save | Loading spinner on button, disabled during save, success toast, sheet stays open |
| Account sheet — username taken | Enter a username another user already has | Toast "Username taken", input keeps value for retry |
| Account sheet — username too short | Enter 1–2 chars | Toast "Username too short", no network call fired |
| Account sheet — network loss during save | Toggle airplane mode, tap Save | Toast "Error / check your connection", button re-enables, value not lost |
| Sign out — happy path | Account sheet → Sign Out → confirm dialog → Sign Out | Dialog shows what-happens/data-affected/reversible/auth copy; button shows spinner; push token cleared; session ends; app redirects to Auth automatically (no explicit navigate call — verify `ProtectedRoute` still catches the cleared session) |
| Sign out — duplicate tap | Tap Sign Out confirm button twice fast | Second tap no-ops (`signingOut` guard); only one `signOut()` call fires |
| Sign out — cancel | Open confirm dialog, tap Cancel | Dialog closes, still signed in, no network call |
| Sign out — dialog dismiss during pending | Tap Sign Out, then try Esc/backdrop while spinner is showing | Dismiss is blocked (`onInteractOutside`/`onEscapeKeyDown` guarded) until the call resolves |
| Sign out — network failure | Airplane mode → Sign Out confirm | Toast "Couldn't sign out — check your connection", dialog stays open, user can retry, session is untouched |
| Anniversary — set date | Open dialog, pick date | Saved immediately (no separate Save button), toast, hub row updates to show the date |
| Anniversary — remove | Open dialog with a date set, tap Remove | Clears date, hub row reverts to "Not set" |

## 3. Partner (`/settings/partner`)

| Flow | Steps | Expected |
|---|---|---|
| Load — linked | Open page while partnered | Shows partner card (avatar/name/Unlink) + pet-name editor; loading spinner only until first fetch resolves |
| Load — not linked | Open page while unpartnered | Shows Scan / Find by username / Create invite / Enter invite code rows |
| Load — query fails | Airplane mode, open page | Spinner clears (doesn't hang); falls through to unlinked-state UI rather than an infinite loader — **gap**: currently no explicit "couldn't load" message here, falls back to unlinked UI. *(Known limitation — see §9.)* |
| Pending requests — realtime | Partner sends a request while this page is open | Row appears without manual refresh (Supabase realtime channel subscribed on mount) |
| Accept request | Tap Accept | Button shows spinner, tries 3 fallback RPC paths in order (`accept_partner_request` → `accept_partner_request_v2` → manual update+unlink+relink), succeeds once, partner card renders |
| Accept request — already handled by other side | Two people race to accept/decline same request | Manual-fallback path checks current status before writing; shows "Request already handled" instead of corrupting state |
| Accept request — duplicate tap | Tap Accept twice fast | `requestActionId` guard prevents second call while first is in flight |
| Decline request | Tap Decline | Row removed, toast confirms; failure keeps row and shows error toast for retry |
| Scan partner's QR | Tap "Scan partner's QR" → grant camera → scan | Uses `QRSignInScanner`; success closes dialog + toast; camera permission denial should show the scanner's own permission-denied UI (verify `QRSignInScanner` internals separately — out of scope for this pass) |
| Find by username — search | Type 2+ chars, tap search | Spinner on search button; results list or "No users found" toast |
| Find by username — send request | Tap Request on a result | Toast "Request sent"; tapping again on an already-requested user surfaces "Request already sent" (unique-constraint code 23505) rather than a generic error |
| **Create an invite code** *(previously dead code — now wired)* | Tap "Create an invite code" | Button disabled + spinner while generating; on success opens Invite dialog with code, Copy code / Copy link / Share buttons all work; retries up to 5x internally on code collision before surfacing a failure toast |
| **Enter invite code** *(previously dead code — now wired)* | Tap "Have an invite code?" → type code → Connect | Connect button disabled while `acceptingInvite`; invalid/expired code shows a specific toast; own invite code shows "Can't use your own invite" |
| Invite deep link | Arrive via `?invite=CODE` from the hub redirect | `joinCode` pre-filled from URL param, dialog auto-opens |
| Unlink partner | Tap Unlink → confirm dialog → Unlink | Dialog states data (chats/photos) is kept, only the link is removed, reversible via new invite; on success partner card disappears, replaced by the unlinked-state rows |
| Unlink — network failure | Airplane mode → confirm Unlink | Toast "Failed to unlink — check your connection", partner card remains, no partial state |
| Pet name — save | Edit pet name, tap Save | Spinner on Save; failure keeps edit mode open with entered text (not discarded) |
| CodeSurpriseEditor | Scroll to bottom of linked-partner view | Renders with `partnerId` passed through; not otherwise touched in this pass |

## 4. Devices & Sign-in (`/settings/devices`)

| Flow | Steps | Expected |
|---|---|---|
| QR code dialog | Tap "QR code" row | Opens with two tabs: Scan / Show; defaults to "Show" |
| Show my QR | "Show my QR" tab | Renders `QRSignInDisplay mode="device_pairing"` with instructions above it |
| Scan a QR | "Scan a QR" tab, scan a signup-invite QR by mistake | `onSignupInvite` callback fires a toast redirecting them to use it from Auth instead, dialog closes (doesn't silently misroute them into a broken state) |
| Invite via QR | Tap "Invite a new user via QR" | Opens `QRSignInDisplay mode="signup_invite"`; scanning device should land on Sign Up, not Sign In — verify against `QRSignInScanner`'s mode branch (unchanged in this pass) |
| Add a passkey | Tap "Add a passkey" | Opens `PasskeyRegister`; unsupported browsers show the "not supported" message instead of a broken button; iframe preview shows "open in new tab" fallback |
| Passkey register — happy path | Enter device name, tap Add | Button disabled + spinner during `registerPasskey()`; success toast + dialog closes via `onDone` |
| Passkey register — failure | Cancel the OS biometric prompt | Toast "Couldn't add passkey" with the underlying error message; button re-enables for retry |
| Add email+password | Only shown when `user.email` is empty or provider is `qr` | Row hidden entirely for normal email accounts (verify this condition against real QR-signup account metadata — flagged as unverified in sandbox) |
| Recent devices — load | Open page | Spinner → list or "No devices recorded yet" empty state |
| Recent devices — remove | Tap trash icon on a device | Per-row spinner via `removing` state; success removes row + toast; failure shows error toast, row stays |
| Recent devices — duplicate tap | Tap remove twice fast on same row | Second tap blocked by `disabled={removing === d.id}` |

## 5. Security & Privacy (`/settings/security`)

| Flow | Steps | Expected |
|---|---|---|
| Toggle notifications/haptics/privacy/moodDetection | Flip switch | Applies instantly, no confirmation (non-destructive, easily reversible) |
| Toggle App Lock **on** (no PIN set yet) | Flip switch on | Applies instantly, then auto-opens PIN setup dialog (`enter` step) since there's nothing to lock with yet |
| Toggle App Lock **off** | Flip switch off while currently on | **Does not apply instantly** — opens `ConfirmActionDialog` ("Turn off App Lock?") stating what happens, that no data is deleted, reversibility, and that no re-auth is required; only applies on explicit confirm |
| Toggle App Lock off — cancel | Confirm dialog → Cancel | Switch stays on, no change |
| Peek Guard toggle on | Flip on | "Peek Guard setup" row appears (Configure button) |
| Change PIN — no existing PIN | Tap Change | Starts at `enter` step (no verify step, nothing to verify against) |
| Change PIN — existing PIN | Tap Change | Starts at `verify` step; must enter correct current PIN first |
| Change PIN — wrong current PIN | Enter wrong 6 digits | Dots flash red, 500ms clear, attempt counter increments, "N attempts left" message |
| Change PIN — 5 failed attempts | Fail verify 5 times | Keypad disables, toast "Too many attempts — close and try again later"; dialog must be closed and reopened to retry (no lockout timer persisted — **note for future hardening**, not a regression from this pass) |
| Change PIN — mismatch on confirm | Enter new PIN, then different PIN on confirm step | Returns to `enter` step, toast "PINs didn't match, try again", no partial save |
| Change PIN — success | Enter matching PIN twice | `hashPin()` called, stored, dialog closes, toast "PIN saved ✓" — **crypto path unchanged from pre-redesign** |
| Haptic intensity picker | Tap subtle/standard/strong | Applies immediately with a selection haptic as feedback; only visible when haptics enabled |
| Mood history | Tap "View" (only visible when moodDetection on) | Opens `MoodHistory` dialog — unchanged component |

## 6. Appearance (`/settings/appearance`)

| Flow | Steps | Expected |
|---|---|---|
| App name — valid | Type valid name, Save | Toast "Name updated" + note it's display-only |
| App name — invalid | Type `<3 chars` or special characters outside `. _` | Toast "Invalid name" with the rule spelled out, no save call fires |
| App icon — upload | Tap upload, pick image | FileReader converts to data URL; on read failure shows "Couldn't read that image" toast instead of silently doing nothing |
| App icon — remove | Tap Remove (only shown when icon set) | Clears icon, falls back to default |
| Icon Studio | Tap "Open Icon Studio" | Opens unmodified `IconStudio` component with presets/custom/export flow |
| Theme mode — Light/Dark/Auto | Tap each | Applies instantly with haptic; "Auto" shows explanatory note |
| Theme mode — Timed (schedule) | Select Timed, set start/end times | Two `<input type="time">` fields shown; changing either calls `setScheduleTimes` with both values (not just the changed one) |
| Theme mode — Dynamic | Select Dynamic | Explanatory note about continuous color shift + ties to Dynamic Sky wallpaper |
| Theme swatch picker | Tap a theme swatch | Applies + haptic; selected swatch shows a checkmark |
| Theme Studio | Tap "Open Theme Studio" | Opens unmodified `ThemeStudio` |
| Wallpaper — pick | Tap a wallpaper thumbnail | Applies + haptic; live/animated wallpapers show a pulsing dot badge |
| Wallpaper — remove | Tap Remove (shown only when one is set) | Clears wallpaper |

## 7. Data & Backup (`/settings/data`)

| Flow | Steps | Expected |
|---|---|---|
| Backup now | Tap Backup | `BackupManager`'s own progress/status UI runs (unchanged) |
| Restore — confirm dialog copy | Tap a backup in the list | Dialog now states: what merges, that there's no exact undo, and that auth isn't required beyond being signed in *(tightened this pass — see diff in `BackupManager.tsx`)* |
| Restore — cancel | Confirm dialog → Cancel | No restore call fires |
| Restore — failure (network-level) | Airplane mode → confirm | `useCloudBackup` surfaces `status: "error"` → toast; unchanged hook behavior for this specific failure mode |
| Restore — failure (write-level, Phase 8.5) | A Supabase write error mid-restore (e.g. RLS rejection, constraint violation) rather than a network failure | Previously could reach `status: "done"` regardless — `applyRestore()` didn't check the `error` field on message/gallery upsert responses. Fixed: now checks every write, stops immediately, and surfaces which batch failed. See `docs/BACKUP_RESTORE_INTEGRITY.md`. REQUIRES LIVE SUPABASE to trigger a real write-level failure and confirm |
| Manual export / import / device secret | Use existing buttons | Unchanged — `BackupManager` internals untouched beyond the restore-dialog copy |
| Daily key manager | Scroll down | `DailyKeyManager` unchanged |

## 8. Import — WhatsApp (`/settings/import`)

| Flow | Steps | Expected |
|---|---|---|
| Disclosure card | Open page | Shows what-happens / data-affected / reversible(**No**, honestly stated) / auth-required before any file picker interaction |
| Pick .txt file | Choose file | Progress text updates: "Reading file…" → "Parsing messages…" → "Importing… X/Y" |
| Pick .zip file | Choose file | Extracts first `.txt` inside via JSZip; missing `.txt` inside zip shows "ZIP import failed" toast |
| Unreadable file | Empty/corrupt file | "Could not read file" toast, `importingWhatsApp` resets so the button isn't stuck disabled |
| No messages parsed | File with no matching lines | "No messages found" toast with a formatting hint |
| Multiple senders detected | File has >1 distinct sender name | Opens "Which one is you?" dialog before importing; picking a name imports with `is_self` flags set correctly; "Skip / not sure" imports with no self-flag |
| Import — full success | All batches insert | Toast "Imported N messages 📱" |
| Import — partial failure | Some batches fail (simulate by cutting network mid-import) | Toast "Partially imported — X saved, Y failed. Try again to retry missing batches." — **note**: retry currently re-imports the *whole* file, which will duplicate the X already-saved messages; there's no batch-level resume. *(Known limitation — see §9.)* |
| Import — total failure | All batches fail | "Import failed" toast, no false success message |
| Duplicate tap on file row while importing | Tap row again mid-import | Row is `disabled={importingWhatsApp}` — no double file-picker |

## 9. Known limitations (not fixed in this pass — flagging honestly rather than silently)

- **PartnerSettings load failure** has no distinct error state; a failed initial fetch is indistinguishable from "genuinely unpartnered." Low severity (read-only, page still usable), but worth a dedicated error banner in a future pass.
- **WhatsApp import retry is not resumable** — a partial failure requires re-importing the whole file, which will insert duplicate rows for messages that already saved. Fixing this needs either a client-side content hash per message or a unique constraint + upsert, which is a schema-touching change out of scope for a visual/IA redesign pass.
- **PIN verify lockout (5 attempts) doesn't persist** across dialog close/reopen — closing and reopening the Change PIN dialog resets the attempt counter. Pre-existing behavior, unchanged by this pass; flagged for a future hardening pass, not a regression.
- **QRSignInScanner's own camera-permission-denied UI** was not independently re-audited in this pass — it's invoked from three places now (Partner, Devices, Auth) but its internals weren't part of this diff.

## 10. Explicit non-changes (verify these did NOT change)

- `hashPin` / `verifyPin` implementations and call sites — identical logic, only the dialog's page location moved.
- WebAuthn registration/login (`registerPasskey`, `PasskeyLogin`) — untouched.
- All Supabase RPCs (`accept_partner_request`, `accept_invite`, `unlink_partner`, `search_users`) — called with the same parameters as before.
- RLS policies, edge functions, migrations — none touched in this pass.
- `signOutAndClearPushTokens()` — byte-for-byte the same function, just now defined in the hub instead of the old monolith.
