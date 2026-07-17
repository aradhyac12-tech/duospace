/**
 * GoogleDriveBackup — Settings panel:
 * - Connect / disconnect a per-user Google account (App User Connector).
 * - Trigger a test backup.
 * - View recent backup results.
 *
 * OAuth handshake: we call `gdrive-connect-start` for an authorize URL, open it,
 * and the connector gateway redirects back to `/settings?gdrive_callback=1` with
 * a `connection_key` in the query string. We POST that key to `gdrive-connect-callback`.
 */
import { useEffect, useState, useCallback } from "react";
import { HardDrive, Check, X, Loader2, PlayCircle, LogOut, AlertCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface Secrets {
  google_drive_email: string | null;
  google_drive_connected_at: string | null;
  last_backup_at: string | null;
  last_backup_size: number | null;
  last_backup_error: string | null;
}
interface Run {
  id: string;
  status: string;
  size_bytes: number | null;
  error: string | null;
  created_at: string;
}

const fmtBytes = (b: number | null) => {
  if (!b) return "—";
  const s = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return `${(b / Math.pow(1024, i)).toFixed(1)} ${s[i]}`;
};
const fmtTime = (iso: string | null) => {
  if (!iso) return "Never";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

const GoogleDriveBackup = () => {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [secrets, setSecrets] = useState<Secrets | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [backingUp, setBackingUp] = useState(false);

  const load = useCallback(async () => {
    const [s, r] = await Promise.all([
      supabase.from("user_secrets")
        .select("google_drive_email, google_drive_connected_at, last_backup_at, last_backup_size, last_backup_error")
        .maybeSingle(),
      supabase.from("backup_runs")
        .select("id, status, size_bytes, error, created_at")
        .order("created_at", { ascending: false })
        .limit(5),
    ]);
    setSecrets((s.data as Secrets) ?? null);
    setRuns((r.data as Run[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Handle OAuth return: /settings?gdrive_callback=1&connection_key=...
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("gdrive_callback") !== "1") return;
    const key = params.get("connection_key");
    // Clean URL right away
    const cleanUrl = window.location.pathname + window.location.hash;
    window.history.replaceState({}, "", cleanUrl);
    if (!key) {
      const err = params.get("error");
      toast({ title: "Google Drive connection cancelled", description: err ?? undefined, variant: "destructive" });
      return;
    }
    (async () => {
      const { data, error } = await supabase.functions.invoke("gdrive-connect-callback", {
        body: { connection_key: key },
      });
      if (error) {
        toast({ title: "Couldn't save connection", description: error.message, variant: "destructive" });
        return;
      }
      toast({ title: "Google Drive connected", description: (data as { email?: string })?.email });
      load();
    })();
  }, [toast, load]);

  const connect = async () => {
    setConnecting(true);
    try {
      const redirect_uri = `${window.location.origin}/settings?gdrive_callback=1`;
      const { data, error } = await supabase.functions.invoke("gdrive-connect-start", {
        body: { redirect_uri },
      });
      if (error) throw error;
      const url = (data as { authorize_url?: string })?.authorize_url;
      if (!url) throw new Error("No authorize URL returned");
      window.location.href = url;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: "Couldn't start Google connection", description: msg, variant: "destructive" });
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    const { error } = await supabase.functions.invoke("gdrive-disconnect");
    if (error) {
      toast({ title: "Disconnect failed", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: "Google Drive disconnected" });
    load();
  };

  const runBackup = async () => {
    setBackingUp(true);
    const { data, error } = await supabase.functions.invoke("gdrive-test-backup");
    setBackingUp(false);
    const result = data as { status?: string; error?: string | null };
    if (error || result?.status !== "success") {
      toast({
        title: "Backup failed",
        description: result?.error ?? error?.message ?? "Unknown error",
        variant: "destructive",
      });
    } else {
      toast({ title: "Backup uploaded ✓" });
    }
    load();
  };

  const connected = !!secrets?.google_drive_connected_at;

  return (
    <section>
      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2.5">
        Google Drive
      </p>
      <div className="bg-card rounded-2xl border border-border/60 overflow-hidden">
        {/* Status row */}
        <div className="px-4 py-3 flex items-center gap-3">
          <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <HardDrive className="h-4 w-4 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : connected ? (
              <>
                <p className="text-sm font-medium truncate">
                  {secrets?.google_drive_email ?? "Connected"}
                </p>
                <p className="text-[11px] text-muted-foreground truncate">
                  Connected {fmtTime(secrets?.google_drive_connected_at ?? null)}
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium">Not connected</p>
                <p className="text-[11px] text-muted-foreground">
                  Connect your Google account to back up privately to Drive.
                </p>
              </>
            )}
          </div>
          {connected ? (
            <span className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
              <Check className="h-3 w-3" /> Live
            </span>
          ) : null}
        </div>

        {/* Actions */}
        <div className="border-t border-border/40 px-3 py-2 flex flex-wrap gap-2">
          {!connected ? (
            <button
              onClick={connect}
              disabled={connecting}
              className="flex-1 min-w-[140px] inline-flex items-center justify-center gap-2 h-10 rounded-xl bg-primary text-primary-foreground text-sm font-medium active:scale-[0.98] transition disabled:opacity-60"
            >
              {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <HardDrive className="h-4 w-4" />}
              Connect Google Drive
            </button>
          ) : (
            <>
              <button
                onClick={runBackup}
                disabled={backingUp}
                className="flex-1 min-w-[140px] inline-flex items-center justify-center gap-2 h-10 rounded-xl bg-primary text-primary-foreground text-sm font-medium active:scale-[0.98] transition disabled:opacity-60"
              >
                {backingUp ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
                Run test backup
              </button>
              <button
                onClick={disconnect}
                className="inline-flex items-center justify-center gap-2 h-10 px-3 rounded-xl border border-border text-sm text-muted-foreground hover:text-destructive hover:border-destructive/40 active:scale-[0.98] transition"
              >
                <LogOut className="h-4 w-4" /> Disconnect
              </button>
            </>
          )}
        </div>

        {/* Last backup */}
        {connected && (
          <div className="border-t border-border/40 px-4 py-3 text-[12px] flex items-center justify-between">
            <span className="text-muted-foreground">Last backup</span>
            <span className="font-medium">
              {fmtTime(secrets?.last_backup_at ?? null)}
              {secrets?.last_backup_size ? ` • ${fmtBytes(secrets.last_backup_size)}` : ""}
            </span>
          </div>
        )}

        {/* Recent runs */}
        {runs.length > 0 && (
          <div className="border-t border-border/40 divide-y divide-border/40">
            <p className="px-4 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Recent results
            </p>
            {runs.map((r) => (
              <div key={r.id} className="px-4 py-2.5 flex items-center gap-3">
                <div className={`h-6 w-6 rounded-full flex items-center justify-center shrink-0 ${
                  r.status === "success" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" :
                                            "bg-destructive/10 text-destructive"
                }`}>
                  {r.status === "success" ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-medium truncate">
                    {r.status === "success" ? `Backup ${fmtBytes(r.size_bytes)}` : "Failed"}
                  </p>
                  {r.error && (
                    <p className="text-[10px] text-destructive/80 truncate flex items-center gap-1">
                      <AlertCircle className="h-2.5 w-2.5 shrink-0" /> {r.error}
                    </p>
                  )}
                </div>
                <span className="text-[10px] text-muted-foreground shrink-0">{fmtTime(r.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
};

export default GoogleDriveBackup;
