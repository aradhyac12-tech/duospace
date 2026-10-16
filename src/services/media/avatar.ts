// Avatar support. NOTE: the app currently has no in-app avatar uploader (profiles.avatar_url is
// only displayed / filled from auth metadata), so nothing calls uploadAvatar() yet. These helpers
// exist so the first avatar-editing screen can use Cloudinary without further plumbing:
//   const { ref } = await uploadAvatar(file);  await supabase.from("profiles").update({ avatar_url: ref })
// and every display site passes avatar_url through resolveAvatarUrl().
import { getMediaUrl, uploadMedia } from "./mediaService";
import { isMediaRef } from "./mediaRef";
import type { UploadOptions, UploadResult } from "./types";

export const uploadAvatar = (file: Blob, opts: Omit<UploadOptions, "scope"> = {}): Promise<UploadResult> =>
  uploadMedia(file, { ...opts, scope: "profile" });

/** Legacy / external avatar URLs (Google metadata, old Supabase URLs) pass through untouched. */
export async function resolveAvatarUrl(avatarUrl: string | null | undefined): Promise<string | null> {
  if (!avatarUrl) return null;
  return isMediaRef(avatarUrl) ? getMediaUrl(avatarUrl, { bucket: "avatars", variant: "AVATAR" }) : avatarUrl;
}
