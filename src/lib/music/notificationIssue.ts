/**
 * Turns the Android audio engine's `notificationIssue` reason codes (see
 * MediaPlaybackService.diagnoseNotificationProblem) into something a person
 * can act on. Pure — no React, no Capacitor — so it is unit-tested.
 *
 * A missing music notification is NEVER a playback error: the song keeps
 * playing, the person just can't see the controls. So this only ever informs;
 * it must not touch player state.
 */
export interface NotificationIssueInfo {
  title: string;
  description: string;
  /** True when the fix is in the OS notification settings (offer a button). */
  canOpenSettings: boolean;
}

export function describeNotificationIssue(reason: string): NotificationIssueInfo {
  const code = (reason ?? "").split(":")[0].trim();
  switch (code) {
    case "APP_NOTIFICATIONS_DISABLED":
      return {
        title: "Music controls are hidden",
        description: "Notifications are turned off for DuoSpace. Turn them on to see play/pause on your lock screen and notification shade.",
        canOpenSettings: true,
      };
    case "CHANNEL_BLOCKED":
      return {
        title: "Music controls are hidden",
        description: "The “Now playing” notification category is switched off for DuoSpace. Turn it back on in notification settings.",
        canOpenSettings: true,
      };
    case "CHANNEL_MISSING":
    case "NOT_ACTIVE":
      return {
        title: "Music controls didn't appear",
        description: "Android didn't show the “Now playing” notification. Check DuoSpace's notification settings — playback isn't affected.",
        canOpenSettings: true,
      };
    case "POST_FAILED":
      return {
        title: "Couldn't show music controls",
        description: "Android refused the “Now playing” notification. Playback isn't affected.",
        canOpenSettings: false,
      };
    default:
      return {
        title: "Music controls didn't appear",
        description: "Android didn't show the “Now playing” notification. Playback isn't affected.",
        canOpenSettings: true,
      };
  }
}

/** Returns a function that is true the first time it sees each reason and false afterwards — one toast per problem per session, not one per track change. */
export function createIssueDeduper(): (reason: string) => boolean {
  const seen = new Set<string>();
  return (reason: string) => {
    const key = (reason ?? "").split(":")[0].trim() || "UNKNOWN";
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}
