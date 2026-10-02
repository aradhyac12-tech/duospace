/**
 * One shared vocabulary for "something just happened (push arrived / notification
 * tapped / call action / app resumed) — refresh status NOW".
 *
 * Sources:
 *  - duospace-push-arrived  : native (CallBridge.notifyPush, every FCM push) and
 *                             usePushNotifications' pushNotificationReceived
 *  - duospace-notification-tap / duospace-call-action : MainActivity, on tap
 *  - visibilitychange       : app resumed
 * Consumers (useDeviceStatus, LocationContext) throttle themselves, so duplicate
 * deliveries of the same push are harmless.
 */
export const STATUS_REFRESH_EVENTS = [
  "duospace-push-arrived",
  "duospace-notification-tap",
  "duospace-call-action",
] as const;

/** Subscribes to every refresh trigger (incl. app resume). Returns an unsubscribe. */
export function onStatusRefreshTrigger(handler: (reason: string) => void): () => void {
  const listeners: Array<[string, EventListener]> = STATUS_REFRESH_EVENTS.map((name) => [
    name,
    (() => handler(name)) as EventListener,
  ]);
  for (const [name, fn] of listeners) window.addEventListener(name, fn);
  const onVis = () => { if (!document.hidden) handler("resume"); };
  document.addEventListener("visibilitychange", onVis);
  return () => {
    for (const [name, fn] of listeners) window.removeEventListener(name, fn);
    document.removeEventListener("visibilitychange", onVis);
  };
}
