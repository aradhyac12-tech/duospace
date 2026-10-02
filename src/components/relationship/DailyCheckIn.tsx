/**
 * Today — one card, a few seconds, no typing. Tap how today felt, optionally
 * what would help, get ONE fixed, safe suggestion and a draft you can send
 * in chat. Last check-in is kept on this device only (encrypted backend).
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { buildProductionRelationshipDeps } from "@/lib/relationship/production";
import { CHECKIN_KEY, MOODS, NEEDS, suggestFor, todayKey, type CheckIn, type Mood, type Need } from "@/lib/relationship/checkin";

export default function DailyCheckIn({ userId, onOpenRepair }: { userId: string; onOpenRepair: () => void }) {
  const [c, setC] = useState<CheckIn | null>(null);
  const navigate = useNavigate();
  const backend = buildProductionRelationshipDeps().backend;

  useEffect(() => {
    let live = true;
    backend.get<CheckIn>(userId, CHECKIN_KEY).then((v) => { if (live && v && v.date === todayKey()) setC(v); }, () => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const save = (next: CheckIn) => { setC(next); void backend.set(userId, CHECKIN_KEY, next).catch(() => {}); };
  const pickMood = (mood: Mood) => save({ date: todayKey(), mood, needs: c?.needs ?? [] });
  const toggleNeed = (n: Need) => {
    if (!c) return;
    const has = c.needs.includes(n);
    save({ ...c, needs: has ? c.needs.filter((x) => x !== n) : [...c.needs, n].slice(-2) });
  };
  const s = c ? suggestFor(c) : null;

  return (
    <div className="rounded-2xl border border-border/60 bg-card p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold">How's today between you?</h2>
        <p className="text-[11px] text-muted-foreground">One tap. Stays on your phone.</p>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {MOODS.map((m) => (
          <button key={m.id} onClick={() => pickMood(m.id)} aria-pressed={c?.mood === m.id}
            className={`rounded-xl border px-1 py-2 text-center transition-colors ${c?.mood === m.id ? "border-primary bg-primary/10" : "border-border/60"}`}>
            <div className="text-xl leading-none">{m.emoji}</div>
            <div className="text-[10px] mt-1 text-muted-foreground">{m.label}</div>
          </button>
        ))}
      </div>

      {c && (
        <>
          <div className="space-y-1.5">
            <p className="text-[11px] text-muted-foreground">What would help? (optional)</p>
            <div className="flex flex-wrap gap-1.5">
              {NEEDS.map((n) => (
                <button key={n.id} onClick={() => toggleNeed(n.id)} aria-pressed={c.needs.includes(n.id)}
                  className={`rounded-full border px-3 py-1 text-xs ${c.needs.includes(n.id) ? "border-primary bg-primary/10" : "border-border/60"}`}>{n.label}</button>
              ))}
            </div>
          </div>
          {s && (
            <div className="rounded-xl bg-muted/40 p-3 space-y-2">
              <p className="text-sm">{s.tip}</p>
              {s.message && (
                <div className="flex items-center gap-2">
                  <p className="text-sm italic flex-1">“{s.message}”</p>
                  <Button size="sm" variant="secondary" onClick={() => navigate("/chat", { state: { draft: s.message } })}>Send in chat</Button>
                </div>
              )}
              {s.offerRepair && <button className="text-xs underline text-muted-foreground" onClick={onOpenRepair}>Help me put it into words</button>}
              <p className="text-[10px] text-muted-foreground">{s.basedOn}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
