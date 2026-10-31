export type MediaScope = "profile" | "chat" | "gallery" | "memories";
export type MediaKind = "image" | "video";

/** Upload state machine. Every upload ends in complete | failed | cancelled — never stuck. */
export type UploadState =
  | "idle" | "validating" | "signing" | "uploading" | "processing" | "registering"
  | "complete" | "failed" | "cancelled";

export type MediaErrorCode =
  | "INVALID_FILE" | "UNAUTHORIZED" | "SIGN_FAILED" | "NOT_CONFIGURED" | "UPLOAD_FAILED" | "UPLOAD_TIMEOUT"
  | "NETWORK" | "REGISTER_FAILED" | "CANCELLED" | "DUPLICATE" | "OFFLINE" | "DELETE_FAILED" | "UNKNOWN";

export class MediaError extends Error {
  constructor(
    readonly code: MediaErrorCode, message: string,
    /** Set when the bytes are in Cloudinary but registration failed: registerMedia(mediaId) can finish it. */
    readonly mediaId?: string,
    readonly retryable = false,
  ) { super(message); this.name = "MediaError"; }
}

export interface MediaAsset {
  id: string; scope: MediaScope; media_type: MediaKind; mime_type: string | null; bytes: number | null;
  width: number | null; height: number | null; duration: number | null; format: string | null;
  original_filename: string | null; created_at: string;
}

export interface UploadOptions {
  scope: MediaScope;
  filename?: string;
  /** Stable UUID for idempotent retries (Chat derives it from its client message id). */
  clientUploadId?: string;
  onState?: (s: UploadState) => void;
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}
export interface UploadResult {
  mediaId: string;
  /** Value to store in the existing *_url column: "media:<uuid>". Legacy readers keep working. */
  ref: string;
  asset: MediaAsset;
}
