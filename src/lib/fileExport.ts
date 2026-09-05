import { Capacitor } from "@capacitor/core";

function base64ToBlob(base64: string, mimeType: string): Blob {
  const byteChars = atob(base64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

export interface SaveOrShareOptions {
  fileName: string;
  /** Text content, or base64 when isBase64 is true (binary formats: PDF, PNG, ZIP). */
  data: string;
  isBase64?: boolean;
  mimeType: string;
  dialogTitle?: string;
}

/**
 * Writes a file to the Capacitor cache dir and opens the native Share sheet
 * on-device; falls back to a Blob + <a download> on web. One shared code
 * path for every export format (native format, PDF, PNG card, zip of
 * cards, plain text) instead of re-deriving this branch per format.
 */
export async function saveOrShareFile({ fileName, data, isBase64, mimeType, dialogTitle }: SaveOrShareOptions): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { Filesystem, Directory, Encoding } = await import("@capacitor/filesystem");
    const { Share } = await import("@capacitor/share");
    const written = await Filesystem.writeFile({
      path: fileName,
      data,
      directory: Directory.Cache,
      ...(isBase64 ? {} : { encoding: Encoding.UTF8 }),
    });
    await Share.share({ url: written.uri, dialogTitle: dialogTitle || "Share" });
  } else {
    const blob = isBase64 ? base64ToBlob(data, mimeType) : new Blob([data], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }
}
