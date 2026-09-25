import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { PushNotifications, Token, PushNotificationSchema, ActionPerformed } from "@capacitor/push-notifications";
import { DuospaceCallKitBridge } from "duospace-callkit-bridge";
import { DuospaceBackgroundGeolocation } from "duospace-background-geolocation";
import { useAuth } from "./useAuth";
import { supabase } from "@/integrations/supabase/appClient";
import { useToast } from "./use-toast";
import { getDeviceId } from "@/lib/deviceId";
import { clearPendingCallAction, drainPendingCallAction, requestAutoAccept } from "@/lib/nativeCallActionBridge";
import { UNLINK_REQUESTS_CHANGED_EVENT } from "@/lib/partnerUnlink";

/**
 * PHASE 4: a native (background/lock-screen) decline updates call_history
 * from OUTSIDE the CallProvider, so it has no access to the signaling
 * client. It announces the decline on a window event; CallContext listens
 * and — for a self-hosted call whose socket is alive — tells the caller
 * over the signaling layer so its ringing stops without waiting for the
 * DB change to round-trip through Realtime. Harmless if nobody listens
 * (the call engine, or app not running the provider): the DB write above is still
 * the authoritative record and the caller's Realtime recovery still fires.
 */
function announceNativeDecline(callId: string): void {
  try {
    window.dispatchEvent(new CustomEvent("duospace-call-native-decline", { detail: { callId } }));
  } catch { /* non-browser context */ }
}


// Maps every `type` the send-push Edge Function can send (see
// supabase/functions/_shared/pushTypes.ts) to where tapping the
// notification should take the user. Kept as a plain function (not part of
// the hook) so it has no dependency on component state.
function routeForNotificationData(data: Record<string, unknown> | undefined) {
  const type = typeof data?.type === "string" ? data.type : undefined;
  switch (type) {
    case "chat_message":
    case "image_message":
    case "video_message":
    case "audio_message":
    case "file_message":
    case "reply":
    case "reaction":
    case "mention":
    case "group_message":
    case "typing":
      window.location.href = "/chat";
      return;
    case "incoming_audio_call":
    case "incoming_video_call":
    case "missed_call":
    case "call_ended":
    case "call_rejected":
      // Soft navigation — see softNavigate(): a hard reload here dropped the
      // running call/auth state right when the person was trying to answer.
      softNavigate("/chat");
      return;
    case "friend_request":
    case "friend_accepted":
      window.location.href = "/settings";
      return;
    case "unlink_request":
    case "unlink_approved":
    case "unlink_declined":
      // The approval dialog is mounted app-wide (UnlinkRequestHost), so
      // landing anywhere signed-in shows it; the Partner screen also lists it.
      window.location.href = "/settings/partner";
      return;
    case "group_invitation":
      window.location.href = "/us";
      return;
    case "song_added":
      window.location.href = "/playlist";
      return;
    case "custom":
    default:
      // Unknown/legacy payloads (e.g. from before this taxonomy existed)
      // fall back to the old ad hoc "message"/"call" values, then home.
      if (data?.type === "message") window.location.href = "/chat";
      else if (data?.type === "call") window.location.href = "/chat";
      return;
  }
}

/**
 * In-app navigation WITHOUT reloading the WebView.
 *
 * FIX ("lags / can't pick up the call"): the native call-action handler below
 * used to do `window.location.href = "/chat"` for every Accept / tap /
 * full-screen-launch — a hard page load that throws away the whole running
 * React app (auth, realtime channels, the call object, any in-flight accept)
 * and boots it again from scratch, while the call was ringing. On a cold-start
 * Accept it happened twice (the durable pending-action replay re-ran the same
 * handler after the first reload). The global IncomingCallOverlay/CallProvider
 * already live above every route, so all that's needed is to land on a route
 * that renders the call UI — which react-router's BrowserRouter picks up from a
 * pushState + popstate, no reload. Falls back to a hard navigation only if
 * that somehow throws.
 */
function softNavigate(path: string) {
  try {
    if (window.location.pathname === path) return;
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  } catch {
    window.location.href = path;
  }
}

// Fix #11: Actually persist the push token to Supabase so server can deliver notifications.
export const usePushNotifications = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [pushToken, setPushToken] = useState<string | null>(null);
  const [isSupported, setIsSupported] = useState(false);

  useEffect(() => {
    const isPlatformSupported = Capacitor.isNativePlatform();
    setIsSupported(isPlatformSupported);
    if (!isPlatformSupported || !user) return;

    const initPushNotifications = async () => {
      try {
        const permStatus = await PushNotifications.requestPermissions();
        if (permStatus.receive === "granted") {
          await PushNotifications.register();
        }
      } catch (error) {
        /* AUDIT FIX #16: push init error — silent in production */
      }
    };

    // BUG-06 FIX: Store resolved listener handles synchronously so cleanup
    // can call .remove() before a re-mount registers new listeners.
    // Previously all four addListener calls returned Promises and cleanup
    // called .then(l => l.remove()) — async, so on rapid unmount→remount
    // the old listeners were never removed before new ones registered,
    // causing duplicate toast notifications and double push_token writes.
    const listenerHandles: Array<{ remove: () => void }> = [];

    const registrationPromise = PushNotifications.addListener("registration", async (token: Token) => {
      setPushToken(token.value);
      // Persist token to profiles table so Edge Function can send FCM/APNs
      try {
        await supabase
          .from("profiles")
          .update({ push_token: token.value, push_platform: Capacitor.getPlatform() })
          .eq("user_id", user.id);
      } catch (err) {
        /* AUDIT FIX #16: push token save error — silent in production */
      }
    });

    const errorPromise = PushNotifications.addListener("registrationError", (error) => {
      /* AUDIT FIX #16: push registration error — silent in production */
    });

    const notificationPromise = PushNotifications.addListener(
      "pushNotificationReceived",
      (notification: PushNotificationSchema) => {
        const pushType = typeof notification.data?.type === "string" ? notification.data.type : undefined;

        // Immediate fresh location fix for every push received while the JS
        // bridge is alive (foreground, or backgrounded-but-not-suspended).
        // On Android this overlaps with CallNotificationService.kt's own
        // native-triggered fix (which also covers a fully cold/killed-
        // process wakeup that this JS listener can never see) — calling
        // both is intentional and harmless, not a double-write: each is
        // just one more upsert of the same `locations` row. On iOS, this is
        // the only trigger for ordinary (non-call) message pushes — see
        // docs/BACKGROUND_LOCATION_NATIVE.md for why calls are hooked
        // natively (CallKitManager.swift) but messages are not. Best-effort
        // by design: never let a location-fix failure affect notification
        // handling below.
        if (Capacitor.isNativePlatform()) {
          DuospaceBackgroundGeolocation.requestImmediateFix({ reason: `push:${pushType ?? "unknown"}` }).catch(() => {
            /* best-effort — see comment above */
          });
        }

        // PHASE 8J FIX (Final Release Audit — native call notification audit):
        // incoming_audio_call/incoming_video_call are sent data-only
        // specifically so no generic OS/Capacitor notification is
        // auto-shown for them — CallNotificationService.kt (native) is the
        // only thing meant to render them, as a full-screen ringing UI with
        // its own looping ringtone (see that file's header comment). This
        // handler still fires on the JS side whenever the app is
        // foregrounded (Capacitor delivers pushNotificationReceived
        // independently of the native FCM service also receiving the same
        // message), and previously showed a generic toast unconditionally —
        // so a foregrounded call push produced the full-screen ringing
        // overlay AND a "New notification: Incoming video call" toast
        // simultaneously. call_ended/missed_call/call_rejected are also
        // excluded here since CallContext/IncomingCallOverlay already
        // surface those in-call-flow states; a toast on top is redundant,
        // not additive information.
        const type = typeof notification.data?.type === "string" ? notification.data.type : undefined;
        const isCallLifecycleType =
          type === "incoming_audio_call" || type === "incoming_video_call" ||
          type === "missed_call" || type === "call_ended" || type === "call_rejected";
        if (isCallLifecycleType) return;
        // Unlink requests/answers surface in-app (approval dialog + status
        // toasts from UnlinkRequestHost) — a second toast would be noise. The
        // push still matters as a signal though: if realtime happens to be
        // down, it's what makes the app re-check right now.
        if (type === "unlink_request" || type === "unlink_approved" || type === "unlink_declined") {
          window.dispatchEvent(new CustomEvent(UNLINK_REQUESTS_CHANGED_EVENT));
          return;
        }
        toast({ title: notification.title || "New notification", description: notification.body });
      }
    );

    const actionPromise = PushNotifications.addListener(
      "pushNotificationActionPerformed",
      (action: ActionPerformed) => {
        routeForNotificationData(action.notification.data);
      }
    );

    // Fired by MainActivity.kt (see scripts/patch-native-permissions.mjs)
    // when the user taps Accept/Decline on a full-screen incoming-call
    // notification, or taps the notification itself while the call is
    // still ringing. Not a Capacitor API — a plain CustomEvent the native
    // side dispatches into the WebView via evaluateJavascript.
    const handleNativeCallAction = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { callId?: string; action?: string; conversationId?: string; callType?: string; roomName?: string }
        | undefined;
      if (!detail?.callId) return;

      // The native side ALSO wrote this action to a durable localStorage slot
      // (for the cold-start case where no listener existed yet). A live
      // listener that handles it here must consume that slot too, otherwise
      // the next app boot replays the same Accept a second time.
      clearPendingCallAction();

      if (detail.action === "decline") {
        // Same effect as tapping Decline inside the app.
        supabase.from("call_history").update({ status: "missed" }).eq("id", detail.callId).then(
          () => announceNativeDecline(detail.callId),
          () => {},
        );
        return;
      }
      if (detail.action === "mute" || detail.action === "unmute" || detail.action === "end") {
        // Originates from DuoSpaceConnection (Bluetooth/car head-unit mute
        // button or a Telecom-initiated hangup) during an already-active
        // call — not a "go answer this call" action, so it must NOT
        // navigate anywhere. useCall() isn't reachable from this hook
        // (it runs in ProtectedRoutes, above <CallProvider> in the tree —
        // see CallContext.tsx), so this is handed off via a second,
        // decoupled event that CallContext listens for directly, rather
        // than restructuring the provider tree to thread the call object
        // down to here.
        // callId travels with it: CallContext only applies it to the call
        // it belongs to, so a late "end" from an OLD call's Telecom
        // connection can no longer hang up the call you're on now.
        window.dispatchEvent(new CustomEvent("duospace-call-control", { detail: { action: detail.action, callId: detail.callId } }));
        return;
      }
      if (detail.action === "accept") {
        // ALREADY-ANSWERED FIX: the OS (Android's full-screen call
        // notification, or a replayed cold-start action — see
        // src/lib/nativeCallActionBridge.ts) already reported this call
        // as accepted. Flag it so IncomingCallOverlay accepts it directly
        // instead of making the person tap Accept a second time inside
        // the app — whichever of "the call is already showing" or "the
        // call hasn't hydrated yet" turns out to be true, both are
        // covered (see that component's own consumeAutoAccept call and
        // its 'duospace-call-auto-accept' listener).
        requestAutoAccept(detail.callId);
        window.dispatchEvent(new CustomEvent("duospace-call-auto-accept", { detail: { callId: detail.callId } }));
      }
      if (!detail.action) {
        window.dispatchEvent(new CustomEvent("duospace-call-reveal", { detail: { callId: detail.callId } }));
      }
      // "accept" or a plain tap: navigate in — IncomingCallOverlay's
      // active-call check (on mount / resume) picks up the still-ringing
      // call_history row and renders the answer UI itself. /calls already
      // renders the call UI too, so leave someone who's there where they are.
      if (window.location.pathname !== "/calls") softNavigate("/chat");
    };
    window.addEventListener("duospace-call-action", handleNativeCallAction);
    listenerHandles.push({ remove: () => window.removeEventListener("duospace-call-action", handleNativeCallAction) });

    // COLD-START LOST-ACTION FIX: drain whatever call action the native
    // side persisted durably (see nativeCallActionBridge.ts's doc comment
    // for the full race this closes) and replay it through the exact same
    // handler above — so a cold-start Accept/Decline that fired before
    // this listener even existed still takes effect once the app catches
    // up, instead of silently vanishing. One-shot on mount, not polled;
    // drainPendingCallAction() itself clears whatever it returns, so this
    // can never double-apply the same action.
    void drainPendingCallAction().then((pending) => {
      if (!pending) return;
      // Only "answer this call" style actions are worth replaying on boot.
      // mute/unmute/end describe a moment that has already passed — replaying
      // an "end" on the next launch used to hang up whatever call was live.
      if (pending.action !== "accept" && pending.action !== "decline" && pending.action !== "open") return;
      handleNativeCallAction({ detail: { callId: pending.callId, action: pending.action } } as unknown as Event);
    });

    // Fired by MainActivity's handleDuospaceNotificationIntent (see
    // scripts/patch-native-permissions.mjs) when the user taps any
    // non-ringing notification built by DuoSpaceMessagingService.kt — chat
    // messages, reactions, missed/ended/declined call log entries, partner
    // requests, etc. Every Android push is data-only now (see fcm.ts), so
    // Capacitor's own "pushNotificationActionPerformed" never fires for
    // these — this native CustomEvent is the only tap signal on Android.
    const handleNativeNotificationTap = (event: Event) => {
      const detail = (event as CustomEvent).detail as { type?: string; conversationId?: string } | undefined;
      if (!detail?.type) return;
      routeForNotificationData(detail);
    };
    window.addEventListener("duospace-notification-tap", handleNativeNotificationTap);
    listenerHandles.push({ remove: () => window.removeEventListener("duospace-notification-tap", handleNativeNotificationTap) });

    // MISSING-LISTENER FIX (iOS CallKit actions had no effect in-app):
    // native/ios/CallKitManager.swift + native-plugins/callkit-bridge have
    // fired/defined a `callAction` event ever since CallKit support was
    // added — answering, ending, or muting via CallKit's native lock-screen
    // UI, or a Bluetooth/CarPlay button — but nothing in this app ever
    // registered a listener for it. Android's equivalent (`duospace-call-
    // action` / `duospace-call-control` window CustomEvents from
    // CallBridge.kt) was fully wired; the iOS side of the "answer/end/mute
    // from the native call UI" story was dead on arrival. This mirrors
    // handleNativeCallAction's own logic exactly, translating CallKit's
    // event shape into the SAME two window events so every downstream
    // consumer (this hook's own decline handling above, CallContext.tsx's
    // mute/unmute/end listener) is shared code, not a parallel iOS path.
    let callActionListenerHandle: { remove: () => void } | null = null;
    if (Capacitor.getPlatform() === "ios") {
      DuospaceCallKitBridge.addListener("callAction", (event) => {
        const { callId, action, wasAnswered } = event;
        if (!callId) return;
        if (action === "accept") {
          // Same ALREADY-ANSWERED fix as Android's handleNativeCallAction
          // above — CallKit already reported this answered, so skip the
          // redundant in-app tap. See nativeCallActionBridge.ts.
          requestAutoAccept(callId);
          window.dispatchEvent(new CustomEvent("duospace-call-auto-accept", { detail: { callId } }));
          if (window.location.pathname !== "/calls") softNavigate("/chat");
          return;
        }
        if (action === "mute" || action === "unmute") {
          window.dispatchEvent(new CustomEvent("duospace-call-control", { detail: { action } }));
          return;
        }
        if (action === "end") {
          if (wasAnswered) {
            // A real hangup of an already-answered/active call — same path
            // as Android's Bluetooth/Telecom-originated "end".
            window.dispatchEvent(new CustomEvent("duospace-call-control", { detail: { action: "end" } }));
          } else {
            // Declined via CallKit before ever answering — same effect as
            // Android's ACTION_DECLINE (see handleNativeCallAction above).
            supabase.from("call_history").update({ status: "missed" }).eq("id", callId).then(
              () => announceNativeDecline(callId),
              () => {},
            );
          }
        }
      }).then((handle) => {
        callActionListenerHandle = handle;
      }).catch(() => {});
    }

    // iOS VoIP push token (PushKit) — completely separate from the regular
    // FCM/APNs `registration` listener above. Fires on first registration
    // and again on rotation (PushKitManager.onTokenUpdated in
    // native/ios/PushKitManager.swift); every rotation must be re-upserted
    // or send-voip-push will keep sending to a dead token until it hard-
    // fails and gets pruned. No-op on Android — DuospaceCallKitBridge's
    // Android side never emits this event (see definitions.ts).
    let voipListenerHandle: { remove: () => void } | null = null;
    if (Capacitor.getPlatform() === "ios") {
      DuospaceCallKitBridge.addListener("voipTokenUpdated", async ({ token }) => {
        try {
          const deviceId = await getDeviceId();
          // Upsert on (user_id, device_id, token_type) so a rotated token
          // on the same install replaces the old row instead of
          // accumulating one per rotation (see the partial unique index
          // in 20260808_ios_voip_push.sql). is_valid reset to true in case
          // this device's previous VoIP token had been pruned after a
          // permanent APNs failure.
          await supabase.from("push_tokens").upsert(
            {
              user_id: user.id,
              token,
              platform: "ios",
              token_type: "apns_voip",
              device_id: deviceId,
              is_valid: true,
              invalidated_reason: null,
              last_used_at: new Date().toISOString(),
            } as never,
            { onConflict: "user_id,device_id,token_type" },
          );
        } catch {
          /* Silent — same policy as the rest of this hook's push-registration errors. */
        }
      }).then((handle) => {
        voipListenerHandle = handle;
      }).catch(() => {});
    }

    // Collect resolved handles as soon as they're ready
    Promise.all([registrationPromise, errorPromise, notificationPromise, actionPromise])
      .then((handles) => listenerHandles.push(...handles))
      .catch(() => {});

    initPushNotifications();

    return () => {
      // Synchronous removal for already-resolved handles
      listenerHandles.forEach((l) => l.remove());
      voipListenerHandle?.remove();
      // Was never removed before: every re-run of this effect stacked another
      // iOS "callAction" listener, so one CallKit Accept fired N times.
      callActionListenerHandle?.remove();
      // Belt-and-suspenders for any still-pending promises
      Promise.all([registrationPromise, errorPromise, notificationPromise, actionPromise])
        .then((handles) => handles.forEach((l) => l.remove()))
        .catch(() => {});
    };
  }, [user, toast]);

  return { pushToken, isSupported };
};
