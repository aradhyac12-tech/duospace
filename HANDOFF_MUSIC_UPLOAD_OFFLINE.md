# Handoff: Upload button + offline view (music / Groic)

## Changes (src/pages/Groic.tsx only)
- Header: new always-visible "Upload" button (opens the existing hidden audio picker). Shelf/page buttons renamed Import -> Upload.
- Offline banner at top of music home when navigator is offline: shows counts of uploaded (My Files) + downloaded
  songs and a Play/Shuffle (or Upload) button. Uploaded files already live in app storage (Directory.Data/groic-local)
  and play via file:// with no network, so they were offline-capable before; this makes that visible.

## Not done / honest limits
- Auto-scanning ALL music already on the phone: needs a native MediaStore plugin + READ_MEDIA_AUDIO permission. Today
  songs only appear after the user picks them (copied into app storage). Web build: uploads last for the session only.
- Sleep timer + fade (native player service) and personal playlists: still pending.

## Not verified
Syntax-checked only; no build/tests/device run. Test: Upload from header, airplane mode banner, play uploaded song offline.
