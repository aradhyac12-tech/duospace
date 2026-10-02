/**
 * RecentDevices — Instagram-style "where you're signed in" list.
 * Users can remove a device; removing it means next sign-in from that
 * device fingerprint triggers a fresh email alert.
 */
import { useEffect, useState } from "react";
import { Monitor, Smartphone, Trash2, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/appClient";
import { useToast } from "@/hooks/use-toast";

interface Device {
  id: string;
  label: string | null;
  user_agent: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

function isMobile(ua = "") {
  return /iPhone|iPad|Android/i.test(ua);
}

function formatWhen(iso: string) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

const RecentDevices = () => {
  const { toast } = useToast();
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = async () => {
    const { data, error } = await supabase
      .from("known_devices")
      .select("id, label, user_agent, first_seen_at, last_seen_at")
      .order("last_seen_at", { ascending: false });
    if (!error) setDevices(data ?? []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const remove = async (id: string) => {
    setRemoving(id);
    const { error } = await supabase.from("known_devices").delete().eq("id", id);
    setRemoving(null);
    if (error) {
      toast({ title: "Couldn't remove device", description: error.message, variant: "destructive" });
      return;
    }
    setDevices((d) => d.filter((x) => x.id !== id));
    toast({ title: "Device removed" });
  };

  return (
    <section>
      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2.5">
        Recent devices
      </p>
      <div className="bg-card rounded-2xl border border-border/60 overflow-hidden divide-y divide-border/40">
        {loading ? (
          <div className="px-4 py-6 flex items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : devices.length === 0 ? (
          <div className="px-4 py-4 text-[12px] text-muted-foreground">
            No devices recorded yet. You'll see them here after your next sign-in.
          </div>
        ) : (
          devices.map((d) => {
            const Icon = isMobile(d.user_agent ?? "") ? Smartphone : Monitor;
            return (
              <div key={d.id} className="px-4 py-3 flex items-center gap-3">
                <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <Icon className="h-4 w-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{d.label ?? "Unknown device"}</p>
                  <p className="text-[11px] text-muted-foreground">
                    Last active {formatWhen(d.last_seen_at)}
                  </p>
                </div>
                <button
                  onClick={() => remove(d.id)}
                  disabled={removing === d.id}
                  className="h-10 w-10 rounded-full flex items-center justify-center text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition"
                  aria-label="Remove device"
                >
                  {removing === d.id
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <Trash2 className="h-4 w-4" />}
                </button>
              </div>
            );
          })
        )}
      </div>
      <p className="text-[11px] text-muted-foreground mt-2 px-1 leading-relaxed">
        You'll get an email whenever a new device signs in. Remove one to reset it.
      </p>
    </section>
  );
};

export default RecentDevices;
