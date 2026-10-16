# Cloudinary media (gradual migration — new media only)

**Status: code complete, NOT deployed, NOT runtime-verified.** Authored without node_modules/network:
`typecheck`, `lint`, `test`, `build`, migration apply and edge-function deploy have not been run.

## Architecture
Supabase = identity, partner model (`profiles.partner_id` / `get_partner_id`), RLS, metadata, lifecycle.
Cloudinary = bytes, transformations, video processing, CDN. No `couple_id`, no couples table.

    client -> sign-cloudinary-upload (JWT checked) -> signature
    client -> Cloudinary (direct, type=authenticated)      # bytes never touch Supabase
    client -> register-cloudinary-media -> verifies asset with Cloudinary Admin API -> media_assets row
    display: client -> signed-cloudinary-url (RLS-checked as the caller) -> signed delivery URL
    delete : client -> delete-cloudinary-media (owner only) -> Cloudinary destroy -> soft delete

## Account setup (manual, Cloudinary dashboard)
1. Create a Cloudinary account/cloud. Note Cloud name, API key, API secret.
2. Settings > Security > **Restricted media types**: enable **Authenticated** handling as needed; make sure
   **"Strict transformations"** is ON (only signed URLs / named transformations deliver) — our URLs are signed.
3. Do NOT create an unsigned upload preset. Do not enable public delivery of the `duospace/` folder.
4. Plan limits apply on top of ours (free: 10 MB image / 100 MB video). Set `MEDIA_MAX_*` to match.
5. If your account uses SHA-256 signatures, change `sha1` in `cloudinaryCore.ts` (default SHA-1 assumed).

## Environment
Client (safe): `VITE_CLOUDINARY_CLOUD_NAME` (turns on Gallery/Memories/avatar uploads),
`VITE_CLOUDINARY_CHAT_MEDIA_ENABLED=true` (Chat opt-in, default off), `VITE_CLOUDINARY_MEDIA_ENABLED=false` (force off).
Server only: `supabase secrets set CLOUDINARY_CLOUD_NAME= CLOUDINARY_API_KEY= CLOUDINARY_API_SECRET=`
(+ optional `MEDIA_MAX_IMAGE_BYTES`, `MEDIA_MAX_VIDEO_BYTES`, `MEDIA_MAX_VIDEO_SECONDS`, `MEDIA_MAX_DIMENSION`).
The API secret exists only in `supabase/functions/_shared/cloudinaryApi.ts` (env read) and is used by pure helpers
that receive it as an argument. Nothing under `src/` references it.

## Deploy order
1. Apply `supabase/migrations/20261004100000_cloudinary_media_assets.sql` (additive).
2. `supabase functions deploy sign-cloudinary-upload register-cloudinary-media delete-cloudinary-media signed-cloudinary-url cleanup-cloudinary-orphans`
3. Set secrets. 4. Ship the app with `VITE_CLOUDINARY_CLOUD_NAME`. 5. Schedule `cleanup-cloudinary-orphans` like `cleanup-orphan-uploads`.
Gallery/Memories reads fall back to the old column list if step 1 is missed; uploads need step 1 + 2.

## Schema
`media_assets`: id, user_id, scope (profile|chat|gallery|memories), media_type/resource_type, delivery_type (always
`authenticated`), cloudinary_public_id (unique), cloudinary_asset_id, original_filename, mime_type, bytes, width, height,
duration, format, folder, status (active|deleting|deleted|delete_failed), timestamps, deleted_at. **No URL is stored.**
`media_upload_intents`: server-side record of each signature issued (service_role only) — register only accepts these.
New nullable `media_asset_id` FK on `messages`, `gallery_items`, `memories` (+ trigger: must reference the row author's own active asset).
Existing `*_url` columns hold `media:<uuid>` for Cloudinary items, so legacy readers keep working.

## RLS
SELECT only for clients: own rows; partner's `profile`/`chat`/`memories` rows via `get_partner_id`; partner's `gallery`
rows only if a visible (shared) `gallery_items` row references them. Soft-deleted rows invisible. No INSERT/UPDATE/DELETE
grant or policy: rows are created/changed only by edge functions after verification. Covered by `src/test/db/mediaAssets.db.test.ts`.

## Folders
`duospace/users/{user_uuid}/{scope}/{media_uuid}` — UUIDs only, derived server-side; the client never chooses a path.

## Delivery & transformations
Client names a variant; the server signs it (`AVATAR`, `CHAT_THUMBNAIL`, `GALLERY_PREVIEW`, `FULLSCREEN`, `VIDEO_STREAM`,
`VIDEO_POSTER`, `VIDEO_THUMBNAIL`) using `f_auto,q_auto` and size limits. Transformations are URL-derived — no stored duplicates.
Image variants requested for a video return `VIDEO_STREAM`. Original is retained in Cloudinary.
**Known limit:** plain signed authenticated URLs do **not** expire (`cache_until` is a client cache hint). True expiry needs
Cloudinary token-based authentication (paid feature) — recommended before large-scale use.

## Usage
    import { uploadMedia, getMediaUrl, deleteMedia } from "@/services/media";
    const { ref } = await uploadMedia(file, { scope: "gallery", onState, onProgress, signal });  // store ref in *_url
    const url = await getMediaUrl(ref, { bucket: "gallery", variant: "GALLERY_PREVIEW" });
Legacy URLs go through the same `getMediaUrl` (and the existing `resolveSignedUrl`, which now dispatches `media:` refs).
States: idle, validating, signing, uploading, processing, registering, complete, failed, cancelled.
If registration fails after upload, `MediaError.mediaId` lets `registerMedia(id)` finish it; unregistered intents are swept after 24 h.

## Surfaces
- Gallery, Memories: new uploads -> Cloudinary when configured; fallback to Supabase Storage on NOT_CONFIGURED/INVALID_FILE. Delete also destroys the asset.
- Avatars: no in-app uploader exists today; `services/media/avatar.ts` is ready (`uploadAvatar`, `resolveAvatarUrl`).
- Chat: flag `VITE_CLOUDINARY_CHAT_MEDIA_ENABLED`. OFF = identical to before. ON = photos/videos only; voice/files and
  disappearing/vanish messages stay on Supabase (their purge machinery only knows Supabase objects).
  **Not wired yet:** deleting/clearing chat messages does not yet delete their Cloudinary assets — keep the flag off until that phase.
- Cache: images keep using `mediaCache` keyed `cld/<id>/<variant>` (bytes, not URLs); signed URLs are memory-only; the Gallery offline snapshot never stores a Cloudinary URL.

## Legacy / migration
Nothing is deleted or rewritten. Buckets `chat-files`, `gallery`, `avatars`, `memories` and `pending_uploads`/`cleanup-orphan-uploads` remain.
A later, separate backfill (copy old objects to Cloudinary, create `media_assets`, set `media_asset_id` + `media:` ref) must be verified before any bucket cleanup.

## Cost
Bandwidth and transformation credits are billed by Cloudinary; each distinct variant is a derived asset on first request. Videos are the main cost driver.
