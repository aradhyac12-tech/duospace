// A Cloudinary-backed media item is referenced from the existing *_url columns as
// "media:<media_assets.id>". Old code that only checks "is there a file_url" keeps working;
// old Supabase Storage URLs never start with "media:", so the two worlds never collide.
const RE = /^media:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export const toMediaRef = (mediaId: string) => `media:${mediaId}`;
export const isMediaRef = (v: unknown): v is string => typeof v === "string" && RE.test(v);
export const parseMediaRef = (v: unknown): string | null => (typeof v === "string" ? RE.exec(v)?.[1]?.toLowerCase() ?? null : null);
