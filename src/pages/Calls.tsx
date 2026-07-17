import PageHeader from "@/components/PageHeader";
import { motion, AnimatePresence } from "framer-motion";
import { Phone, Video, PhoneIncoming, PhoneOutgoing, PhoneMissed, Wifi, Mic, MicOff, VideoIcon, VideoOff, PhoneOff, Monitor, MonitorOff, Trash2, Captions } from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useDailyCall } from "@/hooks/useDailyCall";
import { useToast } from "@/hooks/use-toast";
import LipReadingOverlay from "@/components/LipReadingOverlay";
import { pauseCameraConsumers, resumeCameraConsumers } from "@/lib/cameraBus";

interface NetworkInformation {
  downlink?: number;
  effectiveType?: "slow-2g" | "2g" | "3g" | "4g";
  addEventListener?: (type: "change", listener: () => void) => void;
  removeEventListener?: (type: "change", listener: () => void) => void;
}
interface NavigatorWithConnection extends Navigator {
  connection?: NetworkInformation;
}

type NetworkQuality = "excellent" | "good" | "fair" | "poor";

interface CallRecord {
  id: string;
  caller_id: string;
  receiver_id: string | null;
  call_type: string;
  call_direction: string;
  status: string;
  duration_seconds: number;
  room_name: string | null;
  started_at: string;
  ended_at: string | null;
}

const callIcons = {
  outgoing: PhoneOutgoing,
  incoming: PhoneIncoming,
  missed: PhoneMissed,
};

const qualityLabels: Record<NetworkQuality, { label: string; resolution: string; color: string }> = {
  excellent: { label: "Excellent", resolution: "1080p HD", color: "text-primary" },
  good: { label: "Good", resolution: "720p HD", color: "text-primary" },
  fair: { label: "Fair", resolution: "480p", color: "text-muted-foreground" },
  poor: { label: "Poor", resolution: "360p", color: "text-destructive" },
};

const formatDuration = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

const formatDurationShort = (seconds: number) => {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
};

const formatCallTime = (iso: string) => {
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return `Today, ${time}`;
  if (isYesterday) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
};

const Calls = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [browserNetworkQuality, setBrowserNetworkQuality] = useState<NetworkQuality>("good");
  const [isStartingCall, setIsStartingCall] = useState(false);
  const [callHistory, setCallHistory] = useState<CallRecord[]>([]);
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [currentCallId, setCurrentCallId] = useState<string | null>(null);
  const [callMode, setCallMode] = useState<"video" | "voice">("video");
  const [showLipReading, setShowLipReading] = useState(false);
  const callStartTimeRef = useRef<Date | null>(null);

  const {
    joinCall, leaveCall, toggleAudio, toggleVideo, toggleScreenShare,
    switchCamera, listCameras,
    isAudioOn, isVideoOn, isScreenSharing, callState,
    localVideoRef, remoteVideoRef, screenShareRef,
    networkQuality: callNetworkQuality, participantCount, error,
    callDuration,
  } = useDailyCall();

  const [cameras,        setCameras]        = useState<{ deviceId: string; label: string }[]>([]);
  const [showCamPicker,  setShowCamPicker]  = useState(false);

  // Load partner + call history
  useEffect(() => {
    if (!user) return;
    const load = async () => {
      const { data: profile } = await supabase.from("profiles").select("partner_id").eq("user_id", user.id).single();
      if (profile?.partner_id) setPartnerId(profile.partner_id);

      const { data: history } = await supabase
        .from("call_history")
        .select("id,caller_id,receiver_id,room_name,call_type,call_direction,status,started_at,ended_at,duration_seconds,created_at")
        .or(`caller_id.eq.${user.id},receiver_id.eq.${user.id}`)
        .order("started_at", { ascending: false })
        .limit(50);
      if (history) setCallHistory(history as CallRecord[]);
    };
    load();
  }, [user]);

  // Browser network quality
  useEffect(() => {
    const nav = navigator as NavigatorWithConnection;
    const getQuality = (): NetworkQuality => {
      const c = nav.connection;
      if (c) {
        const downlink = c.downlink ?? 0;
        const eff = c.effectiveType;
        if (eff === "4g" && downlink >= 10) return "excellent";
        if (eff === "4g") return "good";
        if (eff === "3g") return "fair";
        return "poor";
      }
      return "good";
    };
    setBrowserNetworkQuality(getQuality());
    const handler = () => setBrowserNetworkQuality(getQuality());
    nav.connection?.addEventListener?.("change", handler);
    return () => nav.connection?.removeEventListener?.("change", handler);
  }, []);

  // Mic/camera permission probe — uses cameraBus for video so PeekGuard
  // and other consumers don't conflict. Audio is mic-only and short-lived.
  const requestMediaPermission = useCallback(async (mode: "video" | "voice") => {
    try {
      // Audio probe (mic) — Daily owns the in-call mic, this just surfaces
      // the permission prompt up-front for a smoother UX.
      const a = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      a.getTracks().forEach((t) => t.stop());
      // Video probe is skipped — Daily.co will request camera permission
      // itself when the call joins, and probing here would race the bus.
      return true;
    } catch {
      toast({ title: "Permission denied", description: `Please allow ${mode === "video" ? "camera and " : ""}microphone access.`, variant: "destructive" });
      return false;
    }
  }, [toast]);

  const activeQuality = callState === "joined" ? callNetworkQuality : browserNetworkQuality;
  const quality = qualityLabels[activeQuality];

  const startCall = async (mode: "video" | "voice") => {
    if (!user) return;

    // Request permissions first
    const hasPermission = await requestMediaPermission(mode);
    if (!hasPermission) return;

    setIsStartingCall(true);
    setCallMode(mode);
    // Hand the camera to the call: stop PeekGuard / MoodDetector / face
    // enrollment streams so Daily.co can claim the device cleanly.
    pauseCameraConsumers("call-start");
    try {
      const { data, error: fnError } = await supabase.functions.invoke("daily-call", {
        body: { action: "create-room", roomName: `duo-${user.id.slice(0, 8)}-${Date.now()}` },
      });
      if (fnError || data?.error) throw new Error(data?.error || fnError?.message || "Failed to create room");

      const { data: tokenData, error: tokenError } = await supabase.functions.invoke("daily-call", {
        body: { action: "get-token", roomName: data.name },
      });
      if (tokenError || tokenData?.error) throw new Error(tokenData?.error || tokenError?.message || "Failed to get token");

      // Save call to history — Fix #4: store full room URL so receiver can join
      callStartTimeRef.current = new Date();
      const { data: callRecord } = await supabase.from("call_history").insert({
        caller_id: user.id,
        receiver_id: partnerId,
        call_type: mode,
        call_direction: "outgoing",
        status: "in_progress",
        room_name: data.url,  // Fix #4: full URL, not just name
        started_at: new Date().toISOString(),
      } as never).select().single();
      if (callRecord) setCurrentCallId((callRecord as { id: string }).id);

      await joinCall(data.url, tokenData.token, mode === "voice"); // CALL-02 FIX: videoOff flag
      // Load available cameras for picker (includes OTG/dongle cameras)
      const cams = await listCameras();
      setCameras(cams);
      toast({ title: mode === "video" ? "Video call started 📹" : "Voice call started 📞" });
    } catch (err: unknown) {
      // Restore other camera consumers if the call failed to start.
      resumeCameraConsumers("call-start-failed");
      toast({ title: "Call failed", description: (err instanceof Error ? err.message : String(err)), variant: "destructive" });
    }
    setIsStartingCall(false);
  };

  const endCall = async () => {
    // Update call history with duration
    if (currentCallId && user) {
      const duration = callDuration;
      await supabase.from("call_history").update({
        status: "completed",
        duration_seconds: duration,
        ended_at: new Date().toISOString(),
      } as never).eq("id", currentCallId);

      // Refresh history
      const { data: history } = await supabase
        .from("call_history")
        .select("id,caller_id,receiver_id,room_name,call_type,call_direction,status,started_at,ended_at,duration_seconds,created_at")
        .or(`caller_id.eq.${user.id},receiver_id.eq.${user.id}`)
        .order("started_at", { ascending: false })
        .limit(50);
      if (history) setCallHistory(history as CallRecord[]);
      setCurrentCallId(null);
    }
    leaveCall();
    // Allow PeekGuard / MoodDetector etc. to reopen the camera.
    resumeCameraConsumers("call-end");
    toast({ title: "Call ended" });
  };

  // Safety net: if the call ever leaves an active state without endCall()
  // being invoked (error, peer drop, or programmatic leave), make sure
  // PeekGuard / MoodDetector can reclaim the camera.
  useEffect(() => {
    if (callState === "idle" || callState === "error") {
      resumeCameraConsumers(`callstate-${callState}`);
    }
  }, [callState]);

  const deleteCallRecord = async (id: string) => {
    await supabase.from("call_history").delete().eq("id", id);
    setCallHistory((prev) => prev.filter((c) => c.id !== id));
  };

  // In-call UI
  if (callState === "joined" || callState === "joining") {
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col flex-1 min-h-0 bg-foreground relative">
        <video ref={remoteVideoRef} autoPlay playsInline
          className={`absolute inset-0 w-full h-full object-cover ${isScreenSharing ? "hidden" : ""}`} />
        <video ref={screenShareRef} autoPlay playsInline
          className="absolute inset-0 w-full h-full object-contain bg-black" style={{ display: "none" }} />

        {participantCount <= 1 && callState === "joined" && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center text-background/80">
              <div className="h-20 w-20 rounded-full bg-background/10 flex items-center justify-center mx-auto mb-4 animate-pulse-soft">
                <Phone className="h-8 w-8" />
              </div>
              <p className="text-lg font-serif">Waiting for partner...</p>
              <p className="text-sm opacity-60 mt-1">Share the call link</p>
            </div>
          </div>
        )}

        {callState === "joining" && (
          <div className="absolute inset-0 flex items-center justify-center bg-foreground">
            <p className="text-lg font-serif animate-pulse-soft text-background/80">Connecting...</p>
          </div>
        )}

        <motion.div drag dragMomentum={false} dragElastic={0.1}
          className="absolute top-14 right-4 w-28 h-40 rounded-2xl overflow-hidden shadow-lg border-2 border-background/20 z-10 cursor-grab active:cursor-grabbing">
          <video ref={localVideoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
          {!isVideoOn && (
            <div className="absolute inset-0 bg-foreground/80 flex items-center justify-center">
              <VideoOff className="h-6 w-6 text-background/60" />
            </div>
          )}
        </motion.div>

        <div className="absolute top-4 left-4 right-16 z-10 flex items-center gap-2">
          <div className="bg-background/20 backdrop-blur-md rounded-full px-3 py-1.5 flex items-center gap-2">
            <Wifi className="h-3.5 w-3.5 text-background" />
            <span className="text-xs text-background font-medium">{quality.resolution}</span>
          </div>
          <div className="bg-background/20 backdrop-blur-md rounded-full px-3 py-1.5">
            <span className="text-xs text-background font-medium font-mono">{formatDuration(callDuration)}</span>
          </div>
          {isScreenSharing && (
            <div className="bg-primary/80 backdrop-blur-md rounded-full px-3 py-1.5 flex items-center gap-1.5">
              <Monitor className="h-3 w-3 text-background" />
              <span className="text-[10px] text-background font-medium">Sharing</span>
            </div>
          )}
          {/* Lip reading toggle */}
          <button
            onClick={() => setShowLipReading(v => !v)}
            aria-label={showLipReading ? "Disable lip reading" : "Enable lip reading"}
            aria-pressed={showLipReading}
            className={`ml-auto rounded-full px-3 py-1.5 flex items-center gap-1.5 backdrop-blur-md ${
              showLipReading ? "bg-green-500/80" : "bg-background/20"
            }`}
          >
            <Captions className="h-3.5 w-3.5 text-background" aria-hidden="true" />
            <span className="text-[10px] text-background font-medium">Lip Read</span>
          </button>
        </div>

        {/* Lip reading overlay */}
        <AnimatePresence>
          {showLipReading && callState === "joined" && (
            <LipReadingOverlay
              videoRef={remoteVideoRef}
              onClose={() => setShowLipReading(false)}
            />
          )}
        </AnimatePresence>

        <div className="absolute bottom-10 left-0 right-0 z-10 safe-bottom" role="toolbar" aria-label="Call controls">
          <div className="flex items-center justify-center gap-3">
            <button onClick={toggleAudio}
              aria-label={isAudioOn ? "Mute microphone" : "Unmute microphone"}
              aria-pressed={!isAudioOn}
              className={`rounded-full flex items-center justify-center transition-colors ${isAudioOn ? "bg-background/20 backdrop-blur-md" : "bg-destructive"}`}
              style={{ width: 52, height: 52 }}>
              {isAudioOn ? <Mic className="h-5 w-5 text-background" aria-hidden="true" /> : <MicOff className="h-5 w-5 text-background" aria-hidden="true" />}
            </button>
            <button onClick={toggleVideo}
              aria-label={isVideoOn ? "Turn off camera" : "Turn on camera"}
              aria-pressed={!isVideoOn}
              className={`rounded-full flex items-center justify-center transition-colors ${isVideoOn ? "bg-background/20 backdrop-blur-md" : "bg-destructive"}`}
              style={{ width: 52, height: 52 }}>
              {isVideoOn ? <VideoIcon className="h-5 w-5 text-background" aria-hidden="true" /> : <VideoOff className="h-5 w-5 text-background" aria-hidden="true" />}
            </button>
            <button onClick={toggleScreenShare}
              aria-label={isScreenSharing ? "Stop screen share" : "Start screen share"}
              aria-pressed={isScreenSharing}
              className={`rounded-full flex items-center justify-center transition-colors ${isScreenSharing ? "bg-primary" : "bg-background/20 backdrop-blur-md"}`}
              style={{ width: 52, height: 52 }}>
              {isScreenSharing ? <MonitorOff className="h-5 w-5 text-background" aria-hidden="true" /> : <Monitor className="h-5 w-5 text-background" aria-hidden="true" />}
            </button>
            {/* CALL-03: Camera picker button — shows only when multiple cameras available */}
            {cameras.length > 1 && (
              <button onClick={() => setShowCamPicker(v => !v)}
                aria-label="Switch camera"
                aria-haspopup="menu"
                aria-expanded={showCamPicker}
                className="rounded-full flex items-center justify-center bg-background/20 backdrop-blur-md"
                style={{ width: 52, height: 52 }}>
                <VideoIcon className="h-5 w-5 text-background opacity-60" aria-hidden="true" />
              </button>
            )}
            <button onClick={endCall}
              aria-label="End call"
              className="h-16 w-16 rounded-full bg-destructive flex items-center justify-center shadow-lg">
              <PhoneOff className="h-7 w-7 text-background" aria-hidden="true" />
            </button>
          </div>

          {/* CALL-03: Camera picker sheet */}
          {showCamPicker && cameras.length > 1 && (
            <div className="mx-4 mt-3 rounded-2xl overflow-hidden border border-white/10"
              style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(20px)" }}>
              <p className="text-[11px] text-white/50 px-4 pt-3 pb-1 uppercase tracking-wider">Select Camera</p>
              {cameras.map(cam => (
                <button key={cam.deviceId}
                  onClick={async () => { await switchCamera(cam.deviceId); setShowCamPicker(false); }}
                  className="w-full flex items-center gap-3 px-4 py-2.5 active:bg-white/10 text-left">
                  <VideoIcon className="h-4 w-4 text-white/50 shrink-0" />
                  <span className="text-sm text-white truncate">{cam.label}</span>
                </button>
              ))}
              <button onClick={() => setShowCamPicker(false)}
                className="w-full text-center text-[11px] text-white/30 py-2.5 border-t border-white/10">
                Cancel
              </button>
            </div>
          )}
        </div>
      </motion.div>
    );
  }

  // Call hub
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }} className="flex-1 min-h-0 overflow-y-auto overscroll-contain" style={{ WebkitOverflowScrolling: "touch" as any }}>
      <PageHeader title="Calls" subtitle="Stay connected" />

      <div className="px-5 space-y-6 pb-24">
        {error && (
          <div className="bg-destructive/10 border border-destructive/20 rounded-xl p-3">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        <div className="bg-card rounded-2xl border border-border p-4 shadow-sm">
          <div className="flex items-center gap-3">
            <Wifi className={`h-5 w-5 ${quality.color}`} />
            <div className="flex-1">
              <p className="text-sm font-medium">Network: {quality.label}</p>
              <p className="text-[11px] text-muted-foreground">Auto quality: {quality.resolution} • Up to 5hr calls</p>
            </div>
            <span className={`text-xs px-2 py-1 rounded-lg bg-muted ${quality.color}`}>
              {activeQuality === "excellent" ? "🟢" : activeQuality === "good" ? "🟡" : activeQuality === "fair" ? "🟠" : "🔴"}
            </span>
          </div>
        </div>

        <div className="flex gap-3">
          <button onClick={() => startCall("voice")} disabled={isStartingCall}
            aria-label="Start voice call"
            className="flex-1 bg-card rounded-2xl border border-border p-5 flex flex-col items-center gap-3 shadow-sm active:scale-[0.98] transition-transform disabled:opacity-50">
            <div className="h-14 w-14 rounded-full bg-accent flex items-center justify-center">
              <Phone className="h-6 w-6 text-foreground" aria-hidden="true" />
            </div>
            <span className="text-sm font-medium">{isStartingCall ? "Starting..." : "Voice Call"}</span>
          </button>
          <button onClick={() => startCall("video")} disabled={isStartingCall}
            aria-label="Start video call"
            className="flex-1 bg-card rounded-2xl border border-border p-5 flex flex-col items-center gap-3 shadow-sm active:scale-[0.98] transition-transform disabled:opacity-50">
            <div className="h-14 w-14 rounded-full bg-foreground flex items-center justify-center">
              <Video className="h-6 w-6 text-background" aria-hidden="true" />
            </div>
            <div>
              <span className="text-sm font-medium block">{isStartingCall ? "Starting..." : "Video Call"}</span>
              <span className="text-[10px] text-muted-foreground">{quality.resolution}</span>
            </div>
          </button>
        </div>

        <div className="bg-card rounded-2xl border border-border p-4 shadow-sm">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Call Features</h3>
          <div className="flex flex-wrap gap-2">
            {["HD Video", "Screen Share", "5hr Duration", "Adaptive Bitrate", "PiP Mode"].map((f) => (
              <span key={f} className="text-[11px] bg-accent/50 text-foreground px-2.5 py-1 rounded-lg">{f}</span>
            ))}
          </div>
        </div>

        <div>
          <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Recent</h2>
          {callHistory.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No calls yet. Start your first call!</p>
          ) : (
            <div className="space-y-1">
              {callHistory.map((call, i) => {
                const direction = call.caller_id === user?.id ? "outgoing" : "incoming";
                const isMissed = call.status === "missed" || (call.duration_seconds === 0 && call.status === "completed");
                const type = isMissed ? "missed" : direction;
                const Icon = callIcons[type as keyof typeof callIcons] || PhoneOutgoing;
                return (
                  <motion.div key={call.id}
                    initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.05 }}
                    className="flex items-center gap-3 p-3 rounded-xl hover:bg-muted/50 transition-colors group">
                    <Icon className={`h-4 w-4 ${isMissed ? "text-destructive" : "text-muted-foreground"}`} />
                    <div className="flex-1">
                      <p className="text-sm font-medium flex items-center gap-2">
                        {call.call_type === "video" ? "Video" : "Voice"} call
                        {isMissed && <span className="text-[10px] text-destructive">Missed</span>}
                      </p>
                      <p className="text-xs text-muted-foreground">{formatCallTime(call.started_at)}</p>
                    </div>
                    {call.duration_seconds > 0 && (
                      <span className="text-xs text-muted-foreground">{formatDurationShort(call.duration_seconds)}</span>
                    )}
                    <button onClick={() => deleteCallRecord(call.id)}
                      aria-label="Delete call record"
                      className="h-7 w-7 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity hover:bg-muted">
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                    </button>
                  </motion.div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
};

export default Calls;
