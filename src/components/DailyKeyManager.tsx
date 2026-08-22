/**
 * DailyKeyManager — user brings their own Daily.co API key.
 * If either partner supplies a key, calls work. If both do, each partner's calls
 * consume their own quota (partner falls back only when the caller has none).
 */
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { KeyRound, Check, Loader2, Trash2, Info } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { hapticLight, hapticSuccess, hapticError } from "@/lib/haptics";

interface Row {
  daily_api_key: string | null;
  daily_key_hint: string | null;
  daily_provides_calls: boolean;
}

const DailyKeyManager = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [row, setRow] = useState<Row | null>(null);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await supabase
        .from("user_secrets")
        .select("daily_api_key,daily_key_hint,daily_provides_calls")
        .eq("user_id", user.id)
        .maybeSingle();
      setRow(data ?? { daily_api_key: null, daily_key_hint: null, daily_provides_calls: false });
      setLoading(false);
    })();
  }, [user]);

  const save = async () => {
    if (!user || !value.trim()) return;
    setSaving(true);
    hapticLight();
    const key = value.trim();
    const hint = key.slice(-4);
    const { error } = await supabase.from("user_secrets").upsert(
      { user_id: user.id, daily_api_key: key, daily_key_hint: hint, daily_provides_calls: true },
      { onConflict: "user_id" },
    );
    setSaving(false);
    if (error) {
      hapticError();
      toast({ title: "Couldn't save key", description: error.message, variant: "destructive" });
      return;
    }
    hapticSuccess();
    setRow({ daily_api_key: key, daily_key_hint: hint, daily_provides_calls: true });
    setValue("");
    toast({ title: "Daily.co key saved" });
  };

  const remove = async () => {
    if (!user) return;
    hapticLight();
    const { error } = await supabase
      .from("user_secrets")
      .update({ daily_api_key: null, daily_key_hint: null, daily_provides_calls: false })
      .eq("user_id", user.id);
    if (error) {
      toast({ title: "Failed to remove", description: error.message, variant: "destructive" });
      return;
    }
    setRow({ daily_api_key: null, daily_key_hint: null, daily_provides_calls: false });
    toast({ title: "Key removed" });
  };

  const toggleProvides = async (v: boolean) => {
    if (!user || !row?.daily_api_key) return;
    hapticLight();
    await supabase.from("user_secrets").update({ daily_provides_calls: v }).eq("user_id", user.id);
    setRow({ ...row, daily_provides_calls: v });
  };

  return (
    <section>
      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2.5">
        Daily.co · Video &amp; voice
      </p>

      <div className="bg-card rounded-2xl border border-border/60 overflow-hidden divide-y divide-border/40">
        <div className="px-4 py-3 flex items-center gap-3">
          <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <KeyRound className="h-4 w-4 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Your Daily.co API key</p>
            <p className="text-[11px] text-muted-foreground truncate">
              {loading
                ? "Loading…"
                : row?.daily_api_key
                ? `Connected · ••••${row.daily_key_hint}`
                : "Not connected — using partner's key or platform fallback"}
            </p>
          </div>
          {row?.daily_api_key && <Check className="h-4 w-4 text-primary" />}
        </div>

        {row?.daily_api_key ? (
          <>
            <div className="px-4 py-3 flex items-center gap-3">
              <div className="flex-1">
                <p className="text-sm font-medium">Use my key for calls I start</p>
                <p className="text-[11px] text-muted-foreground">Your quota only. Partner can still call using theirs.</p>
              </div>
              <Switch checked={row.daily_provides_calls} onCheckedChange={toggleProvides} />
            </div>
            <button
              onClick={remove}
              className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-muted/40"
            >
              <Trash2 className="h-4 w-4 text-destructive shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-medium text-destructive">Remove key</p>
                <p className="text-[11px] text-muted-foreground">Falls back to partner's key</p>
              </div>
            </button>
          </>
        ) : (
          <div className="px-4 py-3 space-y-2">
            <Input
              value={value}
              onChange={e => setValue(e.target.value)}
              placeholder="Paste your Daily.co API key"
              className="h-9 rounded-xl text-sm font-mono"
              autoComplete="off"
              spellCheck={false}
            />
            <div className="flex gap-2">
              <Button onClick={save} disabled={!value.trim() || saving} size="sm" className="flex-1 rounded-full h-9 text-xs">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save key"}
              </Button>
              <a
                href="https://dashboard.daily.co/developers"
                target="_blank"
                rel="noreferrer"
                className="text-[11px] px-3 py-1.5 rounded-full border border-border text-muted-foreground flex items-center"
              >
                Get key
              </a>
            </div>
          </div>
        )}
      </div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="mt-2 px-1 flex items-start gap-1.5 text-[10.5px] text-muted-foreground leading-relaxed"
      >
        <Info className="h-3 w-3 mt-[1px] shrink-0" />
        <p>Only one partner needs a key for calls to work. When both add one, each caller uses their own quota — if yours runs out, your partner can still call you.</p>
      </motion.div>
    </section>
  );
};

export default DailyKeyManager;
