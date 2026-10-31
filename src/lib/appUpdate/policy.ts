import type { CellularPolicy, ConnectionKind, InstalledApp, ReleaseInfo } from "./types";

export type NetworkDecision =
  | { action: "offline" }
  | { action: "ask" }
  | { action: "start"; allowCellular: boolean };

/**
 * Pure decision: may a download start now, and over which networks?
 *
 * `explicit` is the user's answer to the "you're on mobile data" prompt and
 * always wins. Otherwise:
 *   always    -> Wi-Fi or cellular
 *   wifi-only -> Wi-Fi only (on cellular the OS queues the job until Wi-Fi)
 *   ask       -> on cellular, ask first; on Wi-Fi start Wi-Fi-only so a later
 *                drop to mobile data pauses instead of silently spending it
 * `unknown` is treated like Wi-Fi: never block an update on a guess.
 */
export function decideNetwork(
  connection: ConnectionKind,
  policy: CellularPolicy,
  explicit?: boolean,
): NetworkDecision {
  if (connection === "none") return { action: "offline" };
  if (explicit !== undefined) return { action: "start", allowCellular: explicit };
  if (policy === "always") return { action: "start", allowCellular: true };
  if (policy === "wifi-only") return { action: "start", allowCellular: false };
  return connection === "cellular" ? { action: "ask" } : { action: "start", allowCellular: false };
}

export const DISMISS_WINDOW_MS = 24 * 60 * 60 * 1000;

/** "Later" hides the prompt for 24h for that release; never for a mandatory one. */
export function isDismissed(
  stored: { code: number; at: number } | null,
  releaseCode: number,
  mandatory: boolean,
  now: number,
): boolean {
  if (mandatory || !stored) return false;
  return stored.code === releaseCode && now - stored.at < DISMISS_WINDOW_MS;
}

export function formatBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return "";
  const mb = n / (1024 * 1024);
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

const SEMVER = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

/** -1 / 0 / 1, or null when either side is not a plain x.y.z. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const ma = SEMVER.exec(a.trim());
  const mb = SEMVER.exec(b.trim());
  if (!ma || !mb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Final, local gate between "the server returned a release" and "show the
 * user an update". The server already filters, but this guarantees an
 * up-to-date app is never nagged, even against an older server or a release
 * whose numbers disagree:
 *   - the release must be for THIS package (when both sides report one)
 *   - its build number must be greater than the installed one
 *   - its version name must be greater than the installed one (when both
 *     are plain x.y.z); an equal or lower version name is never an update
 */
export function isNewerThanInstalled(release: ReleaseInfo, installed: InstalledApp): boolean {
  if (release.package_name && installed.packageName && release.package_name !== installed.packageName) return false;
  if (!(release.version_code > installed.versionCode)) return false;
  const cmp = compareSemver(release.version_name, installed.versionName);
  if (cmp !== null && cmp <= 0) return false;
  return true;
}
