import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { PushNotifications, Token, PushNotificationSchema, ActionPerformed } from "@capacitor/push-notifications";
import { useAuth } from "./useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "./use-toast";

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
      window.location.href = "/chat";
      return;
    case "friend_request":
    case "friend_accepted":
      window.location.href = "/settings";
      return;
    case "group_invitation":
      window.location.href = "/us";
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

      if (detail.action === "decline") {
        // Same effect as tapping Decline inside the app.
        supabase.from("call_history").update({ status: "missed" }).eq("id", detail.callId).then(
          () => {},
          () => {},
        );
        return;
      }
      // "accept" or a plain tap: navigate in — IncomingCallOverlay's
      // active-call check (on mount / resume) picks up the still-ringing
      // call_history row and renders the answer UI itself.
      window.location.href = "/chat";
    };
    window.addEventListener("duospace-call-action", handleNativeCallAction);
    listenerHandles.push({ remove: () => window.removeEventListener("duospace-call-action", handleNativeCallAction) });

    // Collect resolved handles as soon as they're ready
    Promise.all([registrationPromise, errorPromise, notificationPromise, actionPromise])
      .then((handles) => listenerHandles.push(...handles))
      .catch(() => {});

    initPushNotifications();

    return () => {
      // Synchronous removal for already-resolved handles
      listenerHandles.forEach((l) => l.remove());
      // Belt-and-suspenders for any still-pending promises
      Promise.all([registrationPromise, errorPromise, notificationPromise, actionPromise])
        .then((handles) => handles.forEach((l) => l.remove()))
        .catch(() => {});
    };
  }, [user, toast]);

  return { pushToken, isSupported };
};
