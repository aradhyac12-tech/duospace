// Shared helpers for the OTA / in-app update edge functions.
//
// The iOS manifest endpoint is fetched by iOS itself (itms-services), which
// cannot send an Authorization header, so its only auth is an HMAC-signed,
// short-lived link minted by app-release-download. The signing key is derived
// from the service-role key, which never leaves the server.

const enc = new TextEncoder();

async function hmacKey(serviceKey: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    enc.encode(`app-release-manifest:${serviceKey}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function signManifestLink(serviceKey: string, releaseId: string, exp: number): Promise<string> {
  const key = await hmacKey(serviceKey);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(`${releaseId}.${exp}`)));
}

export async function verifyManifestLink(
  serviceKey: string, releaseId: string, exp: number, sigHex: string,
): Promise<boolean> {
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const sig = fromHex(sigHex);
  if (!sig) return false;
  const key = await hmacKey(serviceKey);
  return await crypto.subtle.verify("HMAC", key, sig, enc.encode(`${releaseId}.${exp}`));
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function releaseFileName(platform: string, versionName: string, versionCode: number): string {
  return `duospace-${versionName}-${versionCode}.${platform === "ios" ? "ipa" : "apk"}`;
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function iosManifestPlist(opts: {
  ipaUrl: string; bundleId: string; versionName: string; title: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key><string>software-package</string>
          <key>url</key><string>${xmlEscape(opts.ipaUrl)}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key><string>${xmlEscape(opts.bundleId)}</string>
        <key>bundle-version</key><string>${xmlEscape(opts.versionName)}</string>
        <key>kind</key><string>software</string>
        <key>title</key><string>${xmlEscape(opts.title)}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
}
