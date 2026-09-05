/**
 * mediaPermissions — one place that knows how to check / request every media
 * permission DuoSpace needs, on every platform it ships to.
 *
 * Kinds:
 *   camera      – live capture (chat camera, QR scanner, Peek Guard, filters)
 *   microphone  – voice notes and calls
 *   photos      – reading the photo library / gallery picker
 *   photos_add  – saving images back to the library
 *   files       – documents / arbitrary file picker + Filesystem writes
 *
 * Native (Capacitor) uses the Camera plugin's permission API for
 * camera/photos and the Filesystem plugin for files. Web maps to
 * getUserMedia + the Permissions API where available, and treats the file
 * input as always-available (browsers gate it behind the user gesture
 * itself, so there is nothing to request).
 *
 * Nothing here throws: every path resolves to a MediaPermissionResult so
 * callers can render a consistent fallback instead of a stack trace.
 */

import { Capacitor } from "@capacitor/core";
import { logInfo, logWarn } from "@/lib/telemetry";

export type MediaPermissionKind =
  | "camera"
  | "microphone"
  | "photos"
  | "photos_add"
  | "files";

export type MediaPermissionState =
  /** Usable right now. */
  | "granted"
  /** Declined this time — asking again may still show a prompt. */
  | "denied"
  /** Permanently declined ("don't ask again" / iOS Settings toggle off). */
  | "blocked"
  /** Hardware or API not present on this device/browser. */
  | "unsupported"
  /** Permission is fine but the device is busy (camera held elsewhere). */
  | "busy";

export interface MediaPermissionResult {
  kind: MediaPermissionKind;
  state: MediaPermissionState;
  granted: boolean;
  /** Human-readable explanation, safe to show in the UI. */
  message: string;
}

const LABEL: Record<MediaPermissionKind, string> = {
  camera: "Camera",
  microphone: "Microphone",
  photos: "Photo library",
  photos_add: "Saving to photos",
  files: "Files",
};

const WHY: Record<MediaPermissionKind, string> = {
  camera: "DuoSpace uses the camera for photos, video, QR sign-in and Peek Guard.",
  microphone: "DuoSpace uses the microphone for voice notes and calls.",
  photos: "DuoSpace needs your photo library to attach and share pictures.",
  photos_add: "DuoSpace needs permission to save pictures to your library.",
  files: "DuoSpace needs file access to attach documents and store backups.",
};

export const permissionLabel = (k: MediaPermissionKind) => LABEL[k];
export const permissionReason = (k: MediaPermissionKind) => WHY[k];

const ok = (kind: MediaPermissionKind): MediaPermissionResult => ({
  kind,
  state: "granted",
  granted: true,
  message: "",
});

const fail = (
  kind: MediaPermissionKind,
  state: Exclude<MediaPermissionState, "granted">,
  message: string,
): MediaPermissionResult => ({ kind, state, granted: false, message });

/** Track which kinds we've already prompted for, so a second denial reads as blocked. */
const askedOnce = new Set<MediaPermissionKind>();

// ─── native mic grant cache ─────────────────────────────────────────────────
// CALL-LATENCY FIX (native): unlike web (which has the Permissions API as a
// free, non-hardware-opening way to check "already granted" — see
// ensureMediaPermission below), Capacitor's WebView has no equivalent for
// microphone, so requestNative() used to fall back to a full
// getUserMedia({audio:true}) probe on EVERY call start, forever — even the
// 100th call after the person granted mic access once and never touched
// Settings since. That's real hardware work (OS audio-session negotiation,
// AGC/echo-cancellation init) sitting on the critical path in front of
// "Connecting…", immediately followed by Daily.co's call.join() opening the
// mic AGAIN a moment later: two sequential mic opens, every single time.
//
// This remembers a successful native grant in localStorage (survives app
// restarts, unlike the in-memory `askedOnce` above) and skips the probe
// entirely once it's set — Daily.co's own open becomes the only one, same
// as the web fast path already does. Trading a small correctness risk (the
// cache could in principle go stale if the person revokes mic access from
// OS Settings between calls) for that: the risk is bounded, because
// invalidateNativeMicGrantCache() below clears it the moment Daily.co's own
// join surfaces a mic permission failure, so at worst one call attempt
// pays for the stale assumption before the cache self-corrects.
const NATIVE_MIC_GRANT_KEY = "duo:native-mic-granted";

function readNativeMicGrantCache(): boolean {
  try {
    return window.localStorage.getItem(NATIVE_MIC_GRANT_KEY) === "1";
  } catch {
    return false; // localStorage unavailable (rare) — fall through to a real probe.
  }
}

function writeNativeMicGrantCache(granted: boolean): void {
  try {
    if (granted) window.localStorage.setItem(NATIVE_MIC_GRANT_KEY, "1");
    else window.localStorage.removeItem(NATIVE_MIC_GRANT_KEY);
  } catch {
    /* best-effort only */
  }
}

/**
 * Call this the moment a Daily.co join (or any other post-probe use of the
 * mic) turns out to have been denied after all, so the next call attempt
 * re-probes honestly instead of trusting a now-stale cached grant. Safe to
 * call unconditionally — a no-op on web and when nothing was cached.
 */
export function invalidateNativeMicGrantCache(): void {
  writeNativeMicGrantCache(false);
}

// ─── native ──────────────────────────────────────────────────────────────────

type CapState = "prompt" | "prompt-with-rationale" | "granted" | "denied" | "limited";

const mapCapState = (
  kind: MediaPermissionKind,
  s: CapState | undefined,
): MediaPermissionResult => {
  // iOS "limited" photo access is a usable grant — the OS picker handles scoping.
  if (s === "granted" || s === "limited") return ok(kind);
  if (s === "denied") {
    return fail(
      kind,
      askedOnce.has(kind) ? "blocked" : "denied",
      `${LABEL[kind]} access was denied.`,
    );
  }
  return fail(kind, "denied", `${LABEL[kind]} access wasn't granted.`);
};

async function requestNative(kind: MediaPermissionKind): Promise<MediaPermissionResult> {
  if (kind === "microphone") {
    const result = await requestMicrophoneViaGum(kind);
    // Remember a real grant so the next call start can skip this probe
    // entirely (see the native mic grant cache above) — and just as
    // importantly, clear any stale cached grant the instant a fresh probe
    // says otherwise (revoked from Settings since the last call).
    writeNativeMicGrantCache(result.granted);
    return result;
  }

  if (kind === "files") {
    try {
      const { Filesystem } = await import("@capacitor/filesystem");
      const current = await Filesystem.checkPermissions();
      if (current.publicStorage === "granted") return ok(kind);
      askedOnce.add(kind);
      const next = await Filesystem.requestPermissions();
      return mapCapState(kind, next.publicStorage as CapState);
    } catch (e) {
      // Filesystem permissions are a no-op on iOS and on Android 13+ for
      // app-scoped storage — treat an API failure as "nothing to gate".
      logWarn("permissions", "filesystem permission check unavailable", e);
      return ok(kind);
    }
  }

  try {
    const { Camera } = await import("@capacitor/camera");
    const current = await Camera.checkPermissions();
    const field = kind === "camera" ? "camera" : "photos";
    if ((current as unknown as Record<string, CapState>)[field] === "granted") return ok(kind);
    if ((current as unknown as Record<string, CapState>)[field] === "limited") return ok(kind);
    askedOnce.add(kind);
    const next = await Camera.requestPermissions({
      permissions: [field === "camera" ? "camera" : "photos"],
    });
    return mapCapState(kind, (next as unknown as Record<string, CapState>)[field]);
  } catch (e) {
    logWarn("permissions", `native ${kind} request failed`, e);
    return fail(kind, "unsupported", `${LABEL[kind]} isn't available on this device.`);
  }
}

// ─── web ─────────────────────────────────────────────────────────────────────

async function requestMicrophoneViaGum(
  kind: MediaPermissionKind,
): Promise<MediaPermissionResult> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return fail(kind, "unsupported", "This device has no microphone API.");
  }
  try {
    askedOnce.add(kind);
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return ok(kind);
  } catch (err) {
    return fromGumError(kind, err);
  }
}

/** Map a getUserMedia rejection onto our permission model. */
export function fromGumError(
  kind: MediaPermissionKind,
  err: unknown,
): MediaPermissionResult {
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return fail(kind, "unsupported", `${LABEL[kind]} requires a secure (HTTPS) connection.`);
  }
  const name = (err as { name?: string } | undefined)?.name;
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return fail(
        kind,
        askedOnce.has(kind) ? "blocked" : "denied",
        `${LABEL[kind]} permission was denied.`,
      );
    case "NotFoundError":
    case "OverconstrainedError":
      return fail(kind, "unsupported", `No ${LABEL[kind].toLowerCase()} was found on this device.`);
    case "NotReadableError":
    case "AbortError":
      return fail(
        kind,
        "busy",
        `${LABEL[kind]} is already in use by another app or tab.`,
      );
    default:
      return fail(
        kind,
        "denied",
        (err as { message?: string } | undefined)?.message ||
          `Could not start the ${LABEL[kind].toLowerCase()}.`,
      );
  }
}

async function requestWeb(kind: MediaPermissionKind): Promise<MediaPermissionResult> {
  // Web has no library/file permission model — the picker IS the permission.
  if (kind === "photos" || kind === "photos_add" || kind === "files") return ok(kind);
  if (kind === "microphone") return requestMicrophoneViaGum(kind);

  if (!navigator.mediaDevices?.getUserMedia) {
    return fail(kind, "unsupported", "This browser does not support camera access.");
  }
  try {
    askedOnce.add(kind);
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach((t) => t.stop());
    return ok(kind);
  } catch (err) {
    return fromGumError(kind, err);
  }
}

// ─── public API ──────────────────────────────────────────────────────────────

/** Read the current state without prompting (best effort). */
export async function checkMediaPermission(
  kind: MediaPermissionKind,
): Promise<MediaPermissionResult> {
  if (Capacitor.isNativePlatform()) {
    if (kind === "camera" || kind === "photos" || kind === "photos_add") {
      try {
        const { Camera } = await import("@capacitor/camera");
        const c = await Camera.checkPermissions();
        const field = kind === "camera" ? "camera" : "photos";
        return mapCapState(kind, (c as unknown as Record<string, CapState>)[field]);
      } catch {
        return fail(kind, "unsupported", `${LABEL[kind]} isn't available on this device.`);
      }
    }
    return ok(kind);
  }
  if (kind === "camera" || kind === "microphone") {
    try {
      const name = kind === "camera" ? "camera" : "microphone";
      // Permissions API isn't universal (Safari lacks camera/microphone).
      const status = await (navigator.permissions as Permissions | undefined)?.query({
        name: name as PermissionName,
      });
      if (status?.state === "granted") return ok(kind);
      if (status?.state === "denied")
        return fail(kind, "blocked", `${LABEL[kind]} permission is blocked.`);
    } catch {
      /* not supported — fall through */
    }
  }
  return fail(kind, "denied", "");
}

/**
 * Ensure a permission, prompting if needed. Safe to call from a click
 * handler; always resolves.
 *
 * CALL-LATENCY FIX: this used to unconditionally probe via
 * getUserMedia({audio:true}) on every single invocation — including calls
 * where the person granted mic access the last time and every time before
 * that. Opening a live audio stream is real hardware work (OS audio-
 * session negotiation, AGC/echo-cancellation pipeline init), not a cheap
 * permission check, and Daily.co's own call.join() opens the mic AGAIN a
 * moment later regardless — so every call start was paying for two
 * sequential mic opens on the critical path in front of "Connecting…"
 * before this fix. On web, the Permissions API (checkMediaPermission)
 * gives an honest, instant, non-hardware-opening answer for microphone —
 * if it says "granted", skip the redundant probe entirely and let
 * Daily.co's own open be the only one. Native has no equivalent API, so it
 * instead trusts a persisted "we saw this grant succeed before" cache (see
 * NATIVE_MIC_GRANT_KEY below) once one exists; the very first native call
 * still pays for one real probe, same as before. Browsers where the
 * Permissions API doesn't cover microphone either (Safari) fall through to
 * the full probe unchanged, since there's no non-probing signal to trust
 * there at all.
 */
export async function ensureMediaPermission(
  kind: MediaPermissionKind,
): Promise<MediaPermissionResult> {
  if (kind === "microphone" && !Capacitor.isNativePlatform()) {
    const quick = await checkMediaPermission(kind);
    if (quick.granted) {
      logInfo("permissions", `${kind} -> granted (fast path, no probe)`);
      return quick;
    }
  }
  // NATIVE FAST PATH: mirrors the web one above, using the persisted grant
  // cache instead of the Permissions API (which native's WebView doesn't
  // reliably expose for microphone — see the cache's own comment). Only
  // trusted once we've actually seen a successful probe on this device;
  // first-ever call still goes through the real getUserMedia probe below,
  // same as before.
  if (kind === "microphone" && Capacitor.isNativePlatform() && readNativeMicGrantCache()) {
    logInfo("permissions", `${kind} -> granted (native fast path, cached grant)`);
    return ok(kind);
  }
  const result = Capacitor.isNativePlatform()
    ? await requestNative(kind)
    : await requestWeb(kind);
  logInfo("permissions", `${kind} -> ${result.state}`);
  return result;
}

/** Ensure several permissions at once; returns the first failure, or granted. */
export async function ensureMediaPermissions(
  kinds: MediaPermissionKind[],
): Promise<MediaPermissionResult> {
  for (const k of kinds) {
    const r = await ensureMediaPermission(k);
    if (!r.granted) return r;
  }
  return ok(kinds[0] ?? "camera");
}

/**
 * Try to open the OS app-settings screen so the user can flip a blocked
 * permission back on. Returns false when we can't (web, or plugin absent) —
 * the caller then shows written instructions instead.
 */
export async function openAppSettings(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    // Optional dependency, resolved at runtime only: present when the app is
    // built with the native-settings plugin. Kept out of static imports so
    // the web bundle never tries to resolve it.
    const specifier = "capacitor-native-settings";
    const mod = (await import(/* @vite-ignore */ specifier)) as {
      NativeSettings?: { open: (o: unknown) => Promise<unknown> };
    };
    if (mod?.NativeSettings?.open) {
      await mod.NativeSettings.open({
        optionAndroid: "application_details",
        optionIOS: "App",
      });
      return true;
    }
  } catch {
    /* plugin not installed */
  }
  try {
    // iOS accepts the app-settings URL directly; Android ignores it.
    if (Capacitor.getPlatform() === "ios") {
      const { Browser } = await import("@capacitor/browser");
      await Browser.open({ url: "app-settings:" });
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** Written recovery steps, used when we can't deep-link into settings. */
export function recoveryInstructions(kind: MediaPermissionKind): string {
  const platform = Capacitor.getPlatform();
  const what = LABEL[kind];
  if (platform === "ios")
    return `Open Settings → DuoSpace and turn on ${what}, then come back and try again.`;
  if (platform === "android")
    return `Open Settings → Apps → DuoSpace → Permissions and allow ${what}, then try again.`;
  return `Tap the lock/camera icon in your browser's address bar, allow ${what} for this site, then reload and try again.`;
}
