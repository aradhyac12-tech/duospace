import { useCallback, useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Download } from "lucide-react";
import { supabase } from "@/integrations/supabase/appClient";
import { APP_VERSION } from "@/lib/errors/DuoSpaceError";
import { updateVerdict, type UpdateVerdict } from "@/lib/semver";
import { openExternalUrl } from "@/lib/nativeBrowser";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

/**
 * Admin-controlled app update prompt (app_update_config, edited in the admin
 * console). Native builds only - the web build is always the latest deploy.
 *   available -> dismissible card, remembered per latest version
 *   required  -> blocking screen; running version is below the minimum
 * Fails open: if the config can't be read, nobody is ever locked out.
 */
interface Cfg { latest_version: string; min_supported_version: string; message: string | null; android_url: string | null; ios_url: string | null }

const dismissKey = (v: string) => `duo-update-dismissed:${v}`;
const wasDismissed = (v: string) => { try { return localStorage.getItem(dismissKey(v)) === "1"; } catch { return false; } };
const remember = (v: string) => { try { localStorage.setItem(dismissKey(v), "1"); } catch { /* private mode */ } };

const AppUpdateHost = () => {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [verdict, setVerdict] = useState<UpdateVerdict>("ok");
  const [open, setOpen] = useState(true);
  const native = Capacitor.isNativePlatform();

  const check = useCallback(async () => {
    if (!native) return;
    const { data, error } = await (supabase as any).from("app_update_config").select("latest_version,min_supported_version,message,android_url,ios_url").maybeSingle();
    if (error || !data) return; // fail open
    const c = data as Cfg;
    setCfg(c);
    const v = updateVerdict(APP_VERSION, c.latest_version, c.min_supported_version);
    setVerdict(v === "available" && wasDismissed(c.latest_version) ? "ok" : v);
    setOpen(true);
  }, [native]);

  useEffect(() => {
    void check();
    const recheck = () => { if (!document.hidden) void check(); };
    document.addEventListener("visibilitychange", recheck);
    return () => document.removeEventListener("visibilitychange", recheck);
  }, [check]);

  if (!native || !cfg || verdict === "ok") return null;

  const url = Capacitor.getPlatform() === "ios" ? cfg.ios_url : cfg.android_url;
  const required = verdict === "required";

  return (
    <Dialog open={open} onOpenChange={(o) => {
      if (o) return;
      if (required) return; // can't be dismissed
      remember(cfg.latest_version);
      setOpen(false);
    }}>
      <DialogContent
        className="rounded-3xl max-w-[340px]"
        onInteractOutside={(e) => { if (required) e.preventDefault(); }}
        onEscapeKeyDown={(e) => { if (required) e.preventDefault(); }}
      >
        <div className="text-center space-y-3 pt-2">
          <span className="mx-auto h-14 w-14 rounded-full bg-accent/15 flex items-center justify-center">
            <Download className="h-6 w-6 text-accent" aria-hidden="true" />
          </span>
          <DialogTitle className="text-lg">{required ? "Update required" : "Update available"}</DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">
            {cfg.message || (required
              ? "This version of DuoSpace is no longer supported. Please update to keep using it."
              : `DuoSpace ${cfg.latest_version} is ready.`)}
          </DialogDescription>
          <p className="text-[11px] text-muted-foreground">You have {APP_VERSION} · latest is {cfg.latest_version}</p>
          <div className="flex gap-2 pt-1">
            {!required && (
              <Button variant="outline" className="flex-1 rounded-xl" onClick={() => { remember(cfg.latest_version); setOpen(false); }}>
                Later
              </Button>
            )}
            <Button className="flex-1 rounded-xl" disabled={!url} onClick={() => url && void openExternalUrl(url)}>
              {url ? "Update" : "Update (no link set)"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default AppUpdateHost;
