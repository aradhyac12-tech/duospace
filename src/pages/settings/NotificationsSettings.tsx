import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, Check, CloudOff, Play, ShieldCheck, Square, Vibrate, Zap } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import type { MessageAlertStatus } from "duospace-callkit-bridge";
import PageHeader from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { hapticSelection } from "@/lib/haptics";
import {
  MESSAGE_SOUNDS, CALL_RINGTONES,
  previewSound, previewHaptic, stopPreviewSound,
  type MessageSoundId, type CallRingtoneId,
} from "@/lib/notificationSounds";
import {
  getLocalSoundPrefs, saveSoundPrefs, subscribeSoundPrefs, syncSoundPrefs,
} from "@/lib/notificationSoundPrefs";
import {
  ALERT_TIERS, previewMessageAlert, stopMessageAlertPreview,
  getMessageAlertStatus, openDndAccessSettings, type MessageAlertLevel,
} from "@/lib/messageAlert";

/**
 * Message sound + call ringtone + haptic pattern picker.
 *
 * Local-first: the choice is read from and written to this device instantly
 * (see notificationSoundPrefs.ts), so rows are never disabled while a network
 * request is out and selecting works offline. The server copy — which decides
 * the sound of pushes when the app is closed — is synced in the background and
 * retried if it fails; the "waiting to sync" note below shows when it hasn't
 * landed yet.
 *
 * The same saved choice also drives the sounds the app plays itself while it
 * is open (chat ping, in-app incoming-call ring — see lib/sounds.ts). The
 * "preview" buttons here play the bundled file through a web <audio> element.
 */
const NotificationsSettings = () => {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const { toast } = useToast();

  const initial = userId ? getLocalSoundPrefs(userId) : null;
  const [messageSound, setMessageSound] = useState<MessageSoundId>(initial?.messageSound ?? "classic");
  const [callRingtone, setCallRingtone] = useState<CallRingtoneId>(initial?.callRingtone ?? "classic");
  const [pendingSync, setPendingSync] = useState<boolean>(initial?.dirty ?? false);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [alertStatus, setAlertStatus] = useState<MessageAlertStatus | null>(null);
  const [alertPreview, setAlertPreview] = useState<MessageAlertLevel | null>(null);
  const isIos = Capacitor.getPlatform() === "ios";

  // Re-read the phone's ringer / Do Not Disturb state on open and whenever the
  // person comes back from the system "Do Not Disturb access" screen.
  useEffect(() => {
    let alive = true;
    const load = () => { void getMessageAlertStatus().then((st) => { if (alive) setAlertStatus(st); }); };
    load();
    document.addEventListener("visibilitychange", load);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", load);
      void stopMessageAlertPreview();
    };
  }, []);

  const toggleAlertPreview = async (level: MessageAlertLevel) => {
    if (alertPreview === level) {
      await stopMessageAlertPreview();
      setAlertPreview(null);
      return;
    }
    setAlertPreview(level);
    await previewMessageAlert(level);
    // Previews are ~6 s (native service / in-app both cap it).
    window.setTimeout(() => setAlertPreview((cur) => (cur === level ? null : cur)), 6_200);
  };

  useEffect(() => {
    if (!userId) return;
    const local = getLocalSoundPrefs(userId);
    setMessageSound(local.messageSound);
    setCallRingtone(local.callRingtone);
    setPendingSync(local.dirty);

    // Pull the server's value (or push a pending local one) — the page is
    // already usable while this runs.
    void syncSoundPrefs(userId);
    const unsubscribe = subscribeSoundPrefs((p, dirty) => {
      setMessageSound(p.messageSound);
      setCallRingtone(p.callRingtone);
      setPendingSync(dirty);
    });
    return () => { unsubscribe(); stopPreviewSound(); };
  }, [userId]);

  const persist = async (patch: { messageSound?: MessageSoundId; callRingtone?: CallRingtoneId }) => {
    if (!userId) return;
    const result = await saveSoundPrefs(userId, patch);
    if (!result.ok) {
      toast({
        title: "Saved on this device",
        description: `Couldn't reach the server yet${result.code ? ` (${result.code})` : ""} — it will retry automatically. Pushes keep the old sound until it does.`,
      });
    }
  };

  const play = (key: string, file: string, pattern: number[]) => {
    setPlayingKey(key);
    previewSound(file, () => setPlayingKey((cur) => (cur === key ? null : cur)));
    previewHaptic(pattern);
  };

  const togglePreview = (key: string, file: string, pattern: number[]) => {
    if (playingKey === key) { stopPreviewSound(); setPlayingKey(null); return; }
    play(key, file, pattern);
  };

  const pickMessageSound = (id: MessageSoundId) => {
    hapticSelection();
    const opt = MESSAGE_SOUNDS.find((s) => s.id === id);
    if (opt) play(`msg:${id}`, opt.previewFile, opt.pattern);
    setMessageSound(id);
    void persist({ messageSound: id });
  };

  const pickCallRingtone = (id: CallRingtoneId) => {
    hapticSelection();
    const opt = CALL_RINGTONES.find((s) => s.id === id);
    if (opt) play(`call:${id}`, opt.previewFile, opt.pattern);
    setCallRingtone(id);
    void persist({ callRingtone: id });
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-24 bg-background"
    >
      <PageHeader title="Notifications" subtitle="Sound, ringtone & haptics" />

      <div className="px-5 pt-5 space-y-5">
        {pendingSync && (
          <p className="text-[11px] text-muted-foreground px-1 flex items-center gap-1" role="status">
            <CloudOff className="h-3 w-3" /> Saved on this device — waiting to sync. Notifications sent while the app is closed use the old sound until it does.
          </p>
        )}

        <section className="space-y-2">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wider px-1">Important &amp; urgent alerts</p>
          <div className="bg-card rounded-2xl border border-border/60 divide-y divide-border/40 overflow-hidden">
            {(["important", "urgent"] as const).map((level) => {
              const tier = ALERT_TIERS[level];
              const Icon = level === "urgent" ? AlertTriangle : Zap;
              return (
                <div key={level} className="flex items-center gap-3 px-4 py-3">
                  <Icon className={`h-4 w-4 shrink-0 ${level === "urgent" ? "text-destructive" : "text-amber-500"}`} aria-hidden="true" />
                  <div className="flex-1 flex flex-col items-start text-left">
                    <span className="text-sm font-medium">{tier.label} <span className="text-muted-foreground font-normal">· /{level}</span></span>
                    <span className="text-xs text-muted-foreground">{tier.description}</span>
                  </div>
                  <Button
                    variant="ghost" size="sm" className="shrink-0 rounded-full gap-1.5"
                    onClick={() => void toggleAlertPreview(level)}
                    aria-label={`${alertPreview === level ? "Stop" : "Test"} ${tier.label} alert`}
                  >
                    {alertPreview === level ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                    {alertPreview === level ? "Stop" : "Test"}
                  </Button>
                </div>
              );
            })}
          </div>

          {alertStatus?.supported && (
            <div className="rounded-2xl border border-border/60 bg-card px-4 py-3 space-y-2 text-xs text-muted-foreground" role="status">
              <p>
                Alerts play on your phone&apos;s <span className="text-foreground">alarm volume</span> (now {alertStatus.alarmVolumePercent}%,
                raised while ringing) and vibrate like an alarm, so they ring when your phone is on silent or in Do Not Disturb.
                {alertStatus.ringerMode !== "normal" || alertStatus.interruptionFilter !== "all"
                  ? ` Right now: ${alertStatus.ringerMode !== "normal" ? `ringer on ${alertStatus.ringerMode}` : "ringer on"}${alertStatus.interruptionFilter !== "all" ? ", Do Not Disturb on" : ""}.`
                  : ""}
              </p>
              {alertStatus.dndAccessGranted ? (
                <p className="flex items-start gap-1.5 text-foreground">
                  <ShieldCheck className="h-3.5 w-3.5 mt-0.5 shrink-0 text-emerald-500" aria-hidden="true" />
                  Do Not Disturb access is on — an alert pauses Do Not Disturb (even Total silence) while it rings, then puts it back.
                </p>
              ) : (
                <>
                  <p>
                    Do Not Disturb set to <span className="text-foreground">Total silence</span>, or with alarms turned off, still blocks alarms.
                    Allow DuoSpace to get past that too:
                  </p>
                  <Button variant="outline" size="sm" className="rounded-full" onClick={() => void openDndAccessSettings()}>
                    Allow Do Not Disturb access
                  </Button>
                </>
              )}
              <p>Tap Test to hear and feel it right now — try it with your phone on silent.</p>
            </div>
          )}
          {isIos && (
            <p className="text-[11px] text-muted-foreground px-1">
              On iPhone these alerts break through Focus and Do Not Disturb as Time Sensitive notifications with their own long sound.
              iOS does not let an app override the silent switch unless Apple approves it for Critical Alerts.
            </p>
          )}
        </section>

        <section className="space-y-2">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wider px-1">Message sound</p>
          <div className="bg-card rounded-2xl border border-border/60 divide-y divide-border/40 overflow-hidden">
            {MESSAGE_SOUNDS.map((opt) => (
              <SoundRow
                key={opt.id}
                label={opt.label}
                description={opt.description}
                selected={messageSound === opt.id}
                playing={playingKey === `msg:${opt.id}`}
                onSelect={() => pickMessageSound(opt.id)}
                onPreview={() => togglePreview(`msg:${opt.id}`, opt.previewFile, opt.pattern)}
              />
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wider px-1">Call ringtone</p>
          <div className="bg-card rounded-2xl border border-border/60 divide-y divide-border/40 overflow-hidden">
            {CALL_RINGTONES.map((opt) => (
              <SoundRow
                key={opt.id}
                label={opt.label}
                description={opt.description}
                selected={callRingtone === opt.id}
                playing={playingKey === `call:${opt.id}`}
                onSelect={() => pickCallRingtone(opt.id)}
                onPreview={() => togglePreview(`call:${opt.id}`, opt.previewFile, opt.pattern)}
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
  label, description, selected, playing, onSelect, onPreview,
}: {
  label: string; description: string; selected: boolean; playing: boolean;
  onSelect: () => void; onPreview: () => void;
}) => (
  <div className="flex items-center gap-3 px-4 py-3">
    <button
      type="button"
      className="flex-1 flex flex-col items-start text-left"
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="text-sm font-medium">{label}</span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </button>
    <Button
      variant="ghost" size="icon" className="h-8 w-8 rounded-full shrink-0"
      onClick={onPreview} aria-label={`${playing ? "Stop" : "Preview"} ${label}`}
    >
      {playing ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
    </Button>
    <div className={`h-6 w-6 rounded-full shrink-0 flex items-center justify-center border ${selected ? "bg-accent border-accent" : "border-border/60"}`}>
      {selected && <Check className="h-3.5 w-3.5 text-accent-foreground" />}
    </div>
  </div>
);

export default NotificationsSettings;
