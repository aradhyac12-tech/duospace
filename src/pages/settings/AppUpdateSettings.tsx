import { motion } from "framer-motion";
import { Capacitor } from "@capacitor/core";
import { CheckCircle2, Loader2, RefreshCw, Download } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useAppUpdate } from "@/hooks/useAppUpdate";
import { APP_VERSION } from "@/lib/errors";
import { formatBytes, type CellularPolicy } from "@/lib/appUpdate";

const POLICIES: { value: CellularPolicy; label: string; blurb: string }[] = [
  { value: "wifi-only", label: "Wi-Fi only", blurb: "Never use mobile data. The download waits for Wi-Fi." },
  { value: "ask", label: "Ask me on mobile data", blurb: "Download on Wi-Fi automatically; ask before using mobile data." },
  { value: "always", label: "Wi-Fi or mobile data", blurb: "Download on whatever connection you have." },
];

const AppUpdateSettings = () => {
  const u = useAppUpdate();
  const native = Capacitor.isNativePlatform();
  const isIos = Capacitor.getPlatform() === "ios";
  const busy = u.phase === "checking";
  const current = u.installed?.versionName ?? APP_VERSION;

  const status = (() => {
    if (!native) return "Updates are checked inside the DuoSpace app.";
    if (!u.supported) return "This install is updated by the store it came from.";
    if (busy) return "Checking…";
    if (u.release) return `Version ${u.release.version_name} is available${u.release.mandatory ? " (required)" : ""}.`;
    if (u.phase === "error" && !u.release) return u.error ?? "Couldn't check for updates.";
    if (u.lastCheckedAt) return "You're on the latest version.";
    return "Not checked yet.";
  })();

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-24 bg-background"
    >
      <PageHeader title="App updates" subtitle="Keep DuoSpace up to date" />

      <div className="px-5 pt-5 space-y-5">
        <div className="bg-card rounded-2xl border border-border/60 p-4 space-y-3">
          <div className="flex items-center gap-3">
            <span className="h-10 w-10 rounded-full bg-accent/15 flex items-center justify-center shrink-0">
              {u.release ? (
                <Download className="h-[18px] w-[18px] text-accent" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="h-[18px] w-[18px] text-accent" aria-hidden="true" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">
                DuoSpace {current}
                {u.installed && <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">build {u.installed.versionCode}</span>}
              </p>
              <p className="text-[11px] text-muted-foreground">{status}</p>
            </div>
          </div>

          {u.release?.release_notes.trim() && (
            <p className="text-sm text-foreground/90 whitespace-pre-wrap rounded-xl bg-secondary/60 px-3 py-2.5">
              {u.release.release_notes}
            </p>
          )}

          <div className="flex gap-2">
            {u.release && u.supported && (
              <Button className="flex-1" onClick={() => u.undismiss()}>
                <Download className="h-4 w-4" />
                {isIos ? "Get update" : `Update${u.release.file_size_bytes ? ` (${formatBytes(u.release.file_size_bytes)})` : ""}`}
              </Button>
            )}
            <Button
              variant="outline"
              className={u.release ? "" : "flex-1"}
              disabled={!native || !u.supported || busy}
              onClick={() => void u.check(false)}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Check for updates
            </Button>
          </div>
        </div>

        {native && u.supported && !isIos && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">Download updates over</p>
            <RadioGroup
              value={u.cellularPolicy}
              onValueChange={(v) => void u.setCellularPolicy(v as CellularPolicy)}
              className="bg-card rounded-2xl border border-border/60 divide-y divide-border/40 overflow-hidden gap-0"
            >
              {POLICIES.map((p) => (
                <label key={p.value} htmlFor={`policy-${p.value}`} className="flex items-start gap-3 px-4 py-3.5 cursor-pointer">
                  <RadioGroupItem id={`policy-${p.value}`} value={p.value} className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">{p.label}</span>
                    <span className="block text-[11px] text-muted-foreground">{p.blurb}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
            <p className="text-[11px] text-muted-foreground px-1">
              Wi-Fi only is enforced by Android itself, so a download never switches to mobile data on its own.
            </p>
          </div>
        )}
      </div>
    </motion.div>
  );
};

export default AppUpdateSettings;
