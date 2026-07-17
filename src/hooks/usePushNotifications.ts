import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { PushNotifications, Token, PushNotificationSchema, ActionPerformed } from "@capacitor/push-notifications";
import { useAuth } from "./useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "./use-toast";

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
        const data = action.notification.data;
        if (data?.type === "message") window.location.href = "/chat";
        else if (data?.type === "call")   window.location.href = "/calls";
      }
    );

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
