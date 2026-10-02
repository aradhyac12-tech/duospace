/**
 * Save a chat attachment onto the device instead of opening its raw
 * Supabase storage link in a browser tab.
 *
 * Native (Android/iOS): bytes are fetched, written to
 *   Documents/DuoSpace/<name> via @capacitor/filesystem (visible in the
 *   phone's Files app; on iOS under Files → On My iPhone → DuoSpace, which
 *   needs UIFileSharingEnabled + LSSupportsOpeningDocumentsInPlace in
 *   Info.plist). If the public folder isn't writable (older Android
 *   without storage permission), falls back to the share sheet so the user
 *   can still "Save to device" / open in another app — never a URL.
 * Web: real browser download via a Blob URL + <a download>.
 */
import { Capacitor } from "@capacitor/core";

export type DownloadResult = { ok: true; where: string } | { ok: false; error: string };

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/quicktime": "mov", "audio/webm": "webm", "audio/mpeg": "mp3",
  "audio/mp4": "m4a", "application/pdf": "pdf",
};

function safeName(name: string | undefined, blob: Blob): string {
  let n = (name || "").split("/").pop()!.replace(/[\\/:*?"<>|]+/g, "_").trim();
  // Strip the "<uuid>_" prefix chat uploads put on stored object names.
  n = n.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_/i, "");
  if (!n) n = `duospace_${Date.now()}`;
  if (!/\.[a-z0-9]{2,5}$/i.test(n)) {
    const ext = EXT_BY_MIME[blob.type];
    if (ext) n += `.${ext}`;
  }
  return n;
}

export async function downloadToDevice(src: string, fileName?: string): Promise<DownloadResult> {
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const blob = await res.blob();
    const name = safeName(fileName, blob);

    if (Capacitor.isNativePlatform()) {
      const { Filesystem, Directory } = await import("@capacitor/filesystem");
      const data = await blobToBase64(blob);
      try {
        const path = `DuoSpace/${Date.now()}_${name}`;
        await Filesystem.writeFile({ path, data, directory: Directory.Documents, recursive: true });
        return { ok: true, where: `Documents/DuoSpace` };
      } catch {
        // Public folder not writable → hand the real file to the OS sheet.
        const { Share } = await import("@capacitor/share");
        const written = await Filesystem.writeFile({ path: name, data, directory: Directory.Cache });
        await Share.share({ url: written.uri, dialogTitle: "Save file" });
        return { ok: true, where: "share sheet" };
      }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return { ok: true, where: "Downloads" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
