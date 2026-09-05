import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Check, Play, Vibrate } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/appClient";
import { Capacitor } from "@capacitor/core";
import { hapticSelection } from "@/lib/haptics";
import {
  MESSAGE_SOUNDS, CALL_RINGTONES, DEFAULT_MESSAGE_SOUND, DEFAULT_CALL_RINGTONE,
  previewSound, previewHaptic,
  type MessageSoundId, type CallRingtoneId,
} from "@/lib/notificationSounds";

/**
 * Message sound + call ringtone + haptic pattern picker.
 *
 * The real notification/ringing sound always plays natively — even when
 * the app is fully closed — via the Android notification channel the
 * selected sound maps to (see NotificationChannels.kt) or, for calls, the
 * bundled asset CallRingingService.kt plays directly. This page's "preview"
 * buttons are a web <audio>/navigator.vibrate convenience for choosing, not
 * the actual delivery path.
 */
const NotificationsSettings = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [messageSound, setMessageSound] = useState<MessageSoundId>(DEFAULT_MESSAGE_SOUND);
  const [callRingtone, setCallRingtone] = useState<CallRingtoneId>(DEFAULT_CALL_RINGTONE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await supabase
        .from("notification_preferences")
        .select("message_sound, call_ringtone")
        .eq("user_id", user.id)
        .maybeSingle();
      if (data) {
        setMessageSound((data.message_sound as MessageSoundId) ?? DEFAULT_MESSAGE_SOUND);
        setCallRingtone((data.call_ringtone as CallRingtoneId) ?? DEFAULT_CALL_RINGTONE);
      }
      setLoading(false);
    })();
  }, [user]);

  const applyIosCallKitRingtone = async (soundId: CallRingtoneId) => {
    if (Capacitor.getPlatform() !== "ios") return;
    try {
      const { DuospaceCallKitBridge } = await import("duospace-callkit-bridge");
      await DuospaceCallKitBridge.setRingtone({ soundId });
    } catch {
      // Best-effort — the FCM/APNs-side default still applies even if this fails.
    }
  };

  const save = async (next: { messageSound?: MessageSoundId; callRingtone?: CallRingtoneId }) => {
    if (!user) return;
    setSaving(true);
    const payload = {
      user_id: user.id,
      message_sound: next.messageSound ?? messageSound,
      call_ringtone: next.callRingtone ?? callRingtone,
    };
    const { error } = await supabase.from("notification_preferences").upsert(payload as never, { onConflict: "user_id" });
    setSaving(false);
    if (error) {
      toast({ title: "Couldn't save", description: "Try again in a moment.", variant: "destructive" });
      return;
    }
    if (next.callRingtone) await applyIosCallKitRingtone(next.callRingtone);
  };

  const pickMessageSound = (id: MessageSoundId) => {
    hapticSelection();
    const opt = MESSAGE_SOUNDS.find(s => s.id === id);
    if (opt) { previewSound(opt.previewFile); previewHaptic(opt.pattern); }
    setMessageSound(id);
    void save({ messageSound: id });
  };

  const pickCallRingtone = (id: CallRingtoneId) => {
    hapticSelection();
    const opt = CALL_RINGTONES.find(s => s.id === id);
    if (opt) { previewSound(opt.previewFile); previewHaptic(opt.pattern); }
    setCallRingtone(id);
    void save({ callRingtone: id });
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-24 bg-background"
    >
      <PageHeader title="Notifications" subtitle="Sound, ringtone & haptics" />

      <div className="px-5 pt-5 space-y-5">
        <section className="space-y-2">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wider px-1">Message sound</p>
          <div className="bg-card rounded-2xl border border-border/60 divide-y divide-border/40 overflow-hidden">
            {MESSAGE_SOUNDS.map(opt => (
              <SoundRow
                key={opt.id}
                label={opt.label}
                description={opt.description}
                selected={messageSound === opt.id}
                disabled={loading || saving}
                onSelect={() => pickMessageSound(opt.id)}
                onPreview={() => { previewSound(opt.previewFile); previewHaptic(opt.pattern); }}
              />
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wider px-1">Call ringtone</p>
          <div className="bg-card rounded-2xl border border-border/60 divide-y divide-border/40 overflow-hidden">
            {CALL_RINGTONES.map(opt => (
              <SoundRow
                key={opt.id}
                label={opt.label}
                description={opt.description}
                selected={callRingtone === opt.id}
                disabled={loading || saving}
                onSelect={() => pickCallRingtone(opt.id)}
                onPreview={() => { previewSound(opt.previewFile); previewHaptic(opt.pattern); }}
              />
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground px-1 flex items-center gap-1">
            <Vibrate className="h-3 w-3" /> Each sound has its own vibration pattern — felt automatically, on or off screen.
          </p>
        </section>
      </div>
    </motion.div>
  );
};

const SoundRow = ({
  label, description, selected, disabled, onSelect, onPreview,
}: {
  label: string; description: string; selected: boolean; disabled: boolean;
  onSelect: () => void; onPreview: () => void;
}) => (
  <div className="flex items-center gap-3 px-4 py-3">
    <button
      className="flex-1 flex flex-col items-start text-left disabled:opacity-50"
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="text-sm font-medium">{label}</span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </button>
    <Button
      variant="ghost" size="icon" className="h-8 w-8 rounded-full shrink-0"
      onClick={onPreview} aria-label={`Preview ${label}`}
    >
      <Play className="h-3.5 w-3.5" />
    </Button>
    <div className={`h-6 w-6 rounded-full shrink-0 flex items-center justify-center border ${selected ? "bg-accent border-accent" : "border-border/60"}`}>
      {selected && <Check className="h-3.5 w-3.5 text-accent-foreground" />}
    </div>
  </div>
);

export default NotificationsSettings;
