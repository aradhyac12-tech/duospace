/**
 * MoodHistory — trends view over the mood_logs data MoodDetector.tsx has
 * been writing. Everything here is aggregated from real rows fetched for
 * the signed-in user; nothing is simulated. Opened from wherever the
 * "Today's mood" check-in card links out to (see MoodDetector.tsx).
 *
 * Mood → valence mapping matches MoodDetector.tsx's `moodToValence` table
 * exactly (kept as a small local copy rather than importing, since
 * MoodDetector doesn't currently export it — if that table changes there,
 * update it here too).
 */
import { useEffect, useMemo, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { TrendingUp, TrendingDown, Minus, Sun, Sunset, Moon, Cloud as CloudIcon } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid } from "recharts";
import { supabase } from "@/integrations/supabase/appClient";
import { useAuth } from "@/hooks/useAuth";
import { Shimmer } from "@/components/skeletons/Shimmer";
import { ErrorCard } from "@/components/errors/ErrorCard";
import { useErrorManager } from "@/lib/errors/useErrorManager";
import type { DuoSpaceErrorPayload } from "@/lib/errors/types";

interface Props { open: boolean; onClose: () => void; }

interface MoodRow {
  mood: string;
  confidence: number;
  valence: number | null;
  detected_at: string;
}

const EMOJI: Record<string, string> = {
  Happy: "😊", Sad: "😢", Neutral: "😐", Loving: "😍",
  Frustrated: "😤", Surprised: "😲", Calm: "😌",
};

const LOOKBACK_DAYS = 30;

const dayKey = (iso: string) => new Date(iso).toLocaleDateString("en-CA"); // YYYY-MM-DD, local

const timeOfDay = (iso: string): "Morning" | "Afternoon" | "Evening" | "Night" => {
  const h = new Date(iso).getHours();
  if (h >= 5 && h < 12) return "Morning";
  if (h >= 12 && h < 17) return "Afternoon";
  if (h >= 17 && h < 21) return "Evening";
  return "Night";
};

/** Positivity score 0-100 from average valence (-1..1). */
const toScore = (avgValence: number) => Math.round(((avgValence + 1) / 2) * 100);

const mode = (values: string[]): string | null => {
  if (values.length === 0) return null;
  const counts: Record<string, number> = {};
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  return Object.entries(counts).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
};

const MoodHistory = ({ open, onClose }: Props) => {
  const { user } = useAuth();
  const { capture } = useErrorManager("MoodHistory");
  const [rows, setRows] = useState<MoodRow[] | null>(null);
  // Distinct from `rows === null` (loading) and `rows.length === 0` (truly
  // no check-ins) — a fetch failure used to fall through to the empty
  // state, which reads as "you haven't checked in" when the real story is
  // "this couldn't be loaded."
  const [loadError, setLoadError] = useState<DuoSpaceErrorPayload | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!open || !user) return;
    let cancelled = false;
    setLoadError(null);
    (async () => {
      const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
      const { data, error } = await supabase
        .from("mood_logs")
        .select("mood, confidence, valence, detected_at")
        .eq("user_id", user.id)
        .gte("detected_at", since)
        .order("detected_at", { ascending: true });
      if (cancelled) return;
      if (error) {
        setLoadError(capture("DS-MOOD-002", { component: "MoodHistory", action: "load", cause: error }));
        setRows(null);
        return;
      }
      setRows((data ?? []) as MoodRow[]);
    })();
    return () => { cancelled = true; };
  }, [open, user, capture, reloadTick]);

  const stats = useMemo(() => {
    if (!rows) return null;
    const todayKey = dayKey(new Date().toISOString());
    const today = rows.filter((r) => dayKey(r.detected_at) === todayKey);
    const last7 = rows.filter((r) => Date.now() - new Date(r.detected_at).getTime() <= 7 * 86400000);
    const prev7 = rows.filter((r) => {
      const age = Date.now() - new Date(r.detected_at).getTime();
      return age > 7 * 86400000 && age <= 14 * 86400000;
    });

    const avgValence = (list: MoodRow[]) =>
      list.length ? list.reduce((a, r) => a + (r.valence ?? 0), 0) / list.length : null;

    const todayAvg = avgValence(today);
    const monthAvg = avgValence(rows);
    const todayScore = todayAvg != null ? toScore(todayAvg) : null;
    const monthScore = monthAvg != null ? toScore(monthAvg) : null;
    const last7Score = avgValence(last7);
    const prev7Score = avgValence(prev7);
    const trend =
      last7Score == null || prev7Score == null ? null :
      last7Score - prev7Score > 0.05 ? "up" :
      last7Score - prev7Score < -0.05 ? "down" : "flat";

    const dominant = mode(rows.map((r) => r.mood));

    // Per-day bars for the last 7 days, oldest first — always 7 bars even
    // for days with zero entries, so the chart's x-axis is a real calendar
    // week rather than a compressed "days that happen to have data" axis.
    const days: { label: string; score: number | null }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = dayKey(d.toISOString());
      const dayRows = rows.filter((r) => dayKey(r.detected_at) === key);
      const v = avgValence(dayRows);
      days.push({ label: d.toLocaleDateString(undefined, { weekday: "short" }), score: v != null ? toScore(v) : null });
    }

    const byTod: Record<string, MoodRow[]> = { Morning: [], Afternoon: [], Evening: [], Night: [] };
    for (const r of rows) byTod[timeOfDay(r.detected_at)].push(r);

    return { todayScore, monthScore, trend, dominant, days, byTod, totalEntries: rows.length };
  }, [rows]);

  const chartData = stats?.days.map((d) => ({ name: d.label, score: d.score ?? 0, hasData: d.score != null })) ?? [];

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <CloudIcon className="h-4 w-4" /> Mood history
          </DialogTitle>
          <DialogDescription className="text-[11px]">
            Based on your last {LOOKBACK_DAYS} days — private to you.
          </DialogDescription>
        </DialogHeader>

        {!rows && !loadError ? (
          <div className="space-y-3 py-2" aria-busy="true" aria-label="Loading mood history">
            <div className="grid grid-cols-2 gap-2">
              <Shimmer className="h-14 rounded-xl" />
              <Shimmer className="h-14 rounded-xl" />
            </div>
            <Shimmer className="h-32 rounded-xl" />
          </div>
        ) : loadError ? (
          <div className="flex justify-center py-4">
            <ErrorCard error={loadError} onRetry={() => setReloadTick((t) => t + 1)} className="max-w-full" />
          </div>
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted-foreground py-6 text-center">
            No mood check-ins in the last {LOOKBACK_DAYS} days yet.
          </p>
        ) : (
          <div className="space-y-5 mt-2">
            <section className="grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-border/60 p-2.5 space-y-1">
                <p className="text-[10px] text-muted-foreground">Today</p>
                <p className="text-lg font-semibold tabular-nums">
                  {stats!.todayScore != null ? stats!.todayScore : "—"}
                  {stats!.todayScore != null && <span className="text-xs text-muted-foreground">/100</span>}
                </p>
              </div>
              <div className="rounded-xl border border-border/60 p-2.5 space-y-1">
                <p className="text-[10px] text-muted-foreground">30-day average</p>
                <p className="text-lg font-semibold tabular-nums">
                  {stats!.monthScore != null ? stats!.monthScore : "—"}
                  {stats!.monthScore != null && <span className="text-xs text-muted-foreground">/100</span>}
                </p>
              </div>
            </section>

            <section className="rounded-xl border border-border/60 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Last 7 days</p>
                {stats!.trend && (
                  <span className={`flex items-center gap-1 text-[10px] ${
                    stats!.trend === "up" ? "text-success" : stats!.trend === "down" ? "text-destructive" : "text-muted-foreground"
                  }`}>
                    {stats!.trend === "up" ? <TrendingUp className="h-3 w-3" /> :
                     stats!.trend === "down" ? <TrendingDown className="h-3 w-3" /> : <Minus className="h-3 w-3" />}
                    vs. prior week
                  </span>
                )}
              </div>
              <div className="h-32">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} className="opacity-20" />
                    <XAxis dataKey="name" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={24} />
                    <Tooltip
                      formatter={(v: number, _n, p: any) => p.payload.hasData ? [`${v}/100`, "Positivity"] : ["No data", ""]}
                    />
                    <Bar dataKey="score" radius={[4, 4, 0, 0]} className="fill-primary" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>

            <section className="rounded-xl border border-border/60 p-3 space-y-1.5">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Dominant mood (30d)</p>
              <p className="text-sm flex items-center gap-2">
                {stats!.dominant && <span className="text-lg">{EMOJI[stats!.dominant] ?? "•"}</span>}
                {stats!.dominant ?? "—"}
                <span className="text-[10px] text-muted-foreground">({stats!.totalEntries} check-ins)</span>
              </p>
            </section>

            <section className="rounded-xl border border-border/60 p-3 space-y-2">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">By time of day</p>
              {(["Morning", "Afternoon", "Evening", "Night"] as const).map((tod) => {
                const list = stats!.byTod[tod];
                const Icon = tod === "Morning" ? Sun : tod === "Afternoon" ? Sun : tod === "Evening" ? Sunset : Moon;
                const domMood = list.length ? mode(list.map((r) => r.mood)) : null;
                return (
                  <div key={tod} className="flex items-center justify-between text-[11px]">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <Icon className="h-3 w-3" /> {tod}
                    </span>
                    <span>
                      {domMood ? `${EMOJI[domMood] ?? ""} ${domMood}` : "No data"}
                      {list.length > 0 && <span className="text-muted-foreground"> ({list.length})</span>}
                    </span>
                  </div>
                );
              })}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default MoodHistory;
