/**
 * SecurityDashboard — read-only view of Peek Guard's real, locally-logged
 * activity. Opened from PeekConfigDialog.
 *
 * Every number here is either read live from usePeekDetection's current
 * state, computed from lib/peekEventLog.ts's local event history, or
 * derived from the enrolled OwnerProfile. Nothing is simulated. Where the
 * underlying signal genuinely doesn't exist in a browser (CPU%, battery
 * draw — there is no standard cross-platform web API for either; the
 * deprecated Battery Status API was removed from most browsers), this
 * shows the closest honest proxy and says so, rather than a plausible-
 * looking fake number.
 */
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  ShieldCheck, Lock, Gauge, TrendingUp, Clock, AlertTriangle, Zap, Cpu,
} from "lucide-react";
import { useEffect, useState } from "react";
import { getStats, getRecentEvents, type PeekStats, type PeekEvent } from "@/lib/peekEventLog";
import { loadOwnerProfile, type OwnerProfile } from "@/lib/faceRecognition";
import { getPeekSnapshot, clearAllPeekSnapshots } from "@/lib/peekSnapshot";
import type { AppSettings } from "@/contexts/ThemeContext";

interface Props {
  open: boolean;
  onClose: () => void;
  appSettings: AppSettings;
}

/**
 * Privacy score: a transparent, additive checklist of the protections
 * actually configured — not a mysterious single number. Every point is
 * traceable to one setting, shown in the breakdown below the score.
 */
const scorePrivacyConfig = (s: AppSettings, owner: OwnerProfile | null) => {
  const checks: { label: string; on: boolean; points: number }[] = [
    { label: "Peek Guard enabled",            on: !!s.peekGuard,                          points: 25 },
    { label: "Owner face enrolled",           on: !!owner && owner.count > 0,             points: 20 },
    { label: "3+ enrollment angles",          on: !!owner && owner.count >= 3,             points: 10 },
    { label: "Stranger alerts on",            on: !!s.peekAlertOnStranger,                 points: 15 },
    { label: "Multiple-face alerts on",       on: !!s.peekAlertOnMultipleFaces,            points: 10 },
    { label: "Spoof-timeout escalation on",   on: (s.peekStaticStrangerTimeoutMs ?? 0) > 0, points: 15 },
    { label: "Privacy screen / app-switcher hide", on: !!s.privacyMode,                    points: 5 },
  ];
  const score = checks.reduce((a, c) => a + (c.on ? c.points : 0), 0);
  return { score, checks };
};

const reasonLabel = (r: PeekEvent["reason"]) =>
  r === "stranger" ? "Stranger" : r === "multiple" ? "Multiple faces" :
  r === "no-face" ? "No owner" : r === "spoof" ? "Possible spoof" : r;

const timeAgo = (ts: number) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

const SecurityDashboard = ({ open, onClose, appSettings }: Props) => {
  const [stats, setStats]     = useState<PeekStats | null>(null);
  const [events, setEvents]   = useState<PeekEvent[]>([]);
  const [owner, setOwner]     = useState<OwnerProfile | null>(null);
  // Photo evidence — see lib/peekSnapshot.ts. Loaded per-event, id -> data
  // URL, once events are known; null means "known not to have a photo",
  // undefined means "still loading".
  const [snapshots, setSnapshots] = useState<Record<string, string | null | undefined>>({});
  const [clearingSnapshots, setClearingSnapshots] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStats(getStats());
    const recent = getRecentEvents(8);
    setEvents(recent);
    loadOwnerProfile().then(setOwner);
    setSnapshots({});
    recent.forEach((e) => {
      getPeekSnapshot(e.id).then((url) => setSnapshots((prev) => ({ ...prev, [e.id]: url })));
    });
  }, [open]);

  const handleClearSnapshots = async () => {
    setClearingSnapshots(true);
    await clearAllPeekSnapshots();
    setSnapshots((prev) => Object.fromEntries(Object.keys(prev).map((k) => [k, null])));
    setClearingSnapshots(false);
  };

  if (!stats) return null;
  const { score, checks } = scorePrivacyConfig(appSettings, owner);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" /> Security Dashboard
          </DialogTitle>
          <DialogDescription className="text-[11px]">
            Real activity from this device only — nothing here is uploaded.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 mt-2">
          {/* Privacy score */}
          <section className="rounded-xl border border-border/60 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Privacy score</p>
              <p className="text-lg font-semibold tabular-nums">{score}<span className="text-xs text-muted-foreground">/100</span></p>
            </div>
            <div className="space-y-1">
              {checks.map((c) => (
                <div key={c.label} className="flex items-center justify-between text-[11px]">
                  <span className={c.on ? "text-foreground" : "text-muted-foreground"}>{c.label}</span>
                  <span className={c.on ? "text-success" : "text-muted-foreground"}>
                    {c.on ? `+${c.points}` : "—"}
                  </span>
                </div>
              ))}
            </div>
          </section>

          {/* Activity */}
          <section className="grid grid-cols-2 gap-2">
            <StatCard icon={Lock} label="Locks today" value={String(stats.locksToday)} />
            <StatCard icon={TrendingUp} label="Locks this week" value={String(stats.locksThisWeek)} />
            <StatCard icon={Clock} label="Avg. lock speed"
              value={stats.avgLockSpeedMs != null ? `${stats.avgLockSpeedMs}ms` : "Not enough data"} />
            <StatCard icon={AlertTriangle} label="False-alarm rate"
              value={stats.falsePositiveRate != null
                ? `${Math.round(stats.falsePositiveRate * 100)}% of ${stats.ratedCount} rated`
                : "Not enough data"} />
          </section>

          {/* Live pipeline state */}
          <section className="rounded-xl border border-border/60 p-3 space-y-1.5">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
              <Gauge className="h-3 w-3" /> Pipeline
            </p>
            <Row icon={Cpu} label="Detection" value="Off-thread (Web Worker)" />
            <Row icon={Zap} label="Polling"
              value="Dynamic (idle/normal/movement/threat tiers)" />
            <p className="text-[10px] text-muted-foreground pt-1 leading-relaxed">
              Live CPU/battery draw isn't something a web app can read from
              the browser — there's no standard API for it. Dynamic FPS and
              worker offload (above) are the actual levers that affect it.
            </p>
          </section>

          {/* Enrollment */}
          <section className="rounded-xl border border-border/60 p-3 space-y-1.5">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Owner enrollment</p>
            {owner ? (
              <>
                <Row label="Samples" value={String(owner.count)} />
                <Row label="Enrolled" value={new Date(owner.enrolledAt).toLocaleDateString()} />
                {owner.selfSimFloor != null && (
                  <Row label="Angle diversity"
                    value={owner.selfSimFloor < 0.85 ? "Good — varied angles captured" : "Low — mostly one angle"} />
                )}
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground">Not enrolled yet.</p>
            )}
          </section>

          {/* Recent events */}
          <section className="space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Recent locks</p>
              {Object.values(snapshots).some((v) => !!v) && (
                <button
                  onClick={handleClearSnapshots}
                  disabled={clearingSnapshots}
                  className="text-[10px] text-muted-foreground underline disabled:opacity-50"
                >
                  Clear photos
                </button>
              )}
            </div>
            {events.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No locks logged yet.</p>
            ) : (
              <div className="space-y-1">
                {events.map((e) => {
                  const snap = snapshots[e.id];
                  return (
                    <div key={e.id} className="flex items-center gap-2 text-[11px] py-1 border-b border-border/40 last:border-0">
                      {snap ? (
                        <img src={snap} alt="" className="h-8 w-8 rounded-md object-cover shrink-0 border border-border/60" />
                      ) : (
                        <div className="h-8 w-8 rounded-md bg-muted shrink-0" aria-hidden="true" />
                      )}
                      <span className="flex-1 min-w-0 truncate">{reasonLabel(e.reason)}</span>
                      <span className="text-muted-foreground shrink-0">{timeAgo(e.ts)}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Photo evidence is a small local snapshot from the moment each
              lock fired — stored on this device only, never uploaded, and
              auto-pruned to the most recent 20.
            </p>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
};

const StatCard = ({ icon: Icon, label, value }: { icon: any; label: string; value: string }) => (
  <div className="rounded-xl border border-border/60 p-2.5 space-y-1">
    <Icon className="h-3.5 w-3.5 text-muted-foreground" />
    <p className="text-sm font-semibold tabular-nums leading-none">{value}</p>
    <p className="text-[10px] text-muted-foreground">{label}</p>
  </div>
);

const Row = ({ icon: Icon, label, value }: { icon?: any; label: string; value: string }) => (
  <div className="flex items-center justify-between text-[11px]">
    <span className="flex items-center gap-1.5 text-muted-foreground">
      {Icon && <Icon className="h-3 w-3" />} {label}
    </span>
    <span>{value}</span>
  </div>
);

export default SecurityDashboard;
