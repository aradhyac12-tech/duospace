import { ArrowRight, CheckCircle2, Download, Loader2, RefreshCw, ShieldAlert, Smartphone, Sparkles, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Capacitor } from "@capacitor/core";
import { formatBytes } from "@/lib/appUpdate";
import { useAppUpdate } from "@/hooks/useAppUpdate";

/** Download -> Install, so the user always knows where they are. */
function Steps({ phase }: { phase: string }) {
  const stage = phase === "ready" || phase === "installing" || phase === "needs_permission" ? 2 : 1;
  const items = ["Download", "Install"];
  return (
    <ol className="flex items-center gap-2 text-[11px] font-medium" aria-label="Update steps">
      {items.map((label, i) => {
        const n = i + 1;
        const done = stage > n;
        const active = stage === n;
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={
                "flex h-5 w-5 items-center justify-center rounded-full text-[10px] " +
                (done || active ? "bg-accent text-accent-foreground" : "bg-secondary text-muted-foreground")
              }
            >
              {done ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> : n}
            </span>
            <span className={active || done ? "text-foreground" : "text-muted-foreground"}>{label}</span>
            {n < items.length && <span className="h-px w-6 bg-border" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * State-dependent body of the update prompt (title, notes, progress, buttons).
 * Used inside a dismissible sheet for optional updates and inside a blocking
 * overlay for mandatory ones.
 */
export function UpdateBody({ onLater }: { onLater?: () => void }) {
  const u = useAppUpdate();
  const r = u.release;
  if (!r) return null;

  const isIos = Capacitor.getPlatform() === "ios";
  const size = formatBytes(r.file_size_bytes);
  const pct = u.progress.total > 0 ? Math.min(100, Math.round((u.progress.bytes / u.progress.total) * 100)) : 0;
  const busyPhase = u.phase === "downloading" || u.phase === "waiting_wifi";

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 pr-8">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent/15">
          {u.phase === "ready" ? (
            <CheckCircle2 className="h-5 w-5 text-accent" aria-hidden="true" />
          ) : (
            <Sparkles className="h-5 w-5 text-accent" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-accent">
            {u.phase === "ready" ? "Ready to install" : r.mandatory ? "Update required" : "Update available"}
          </p>
          <h2 className="text-lg font-semibold leading-tight text-foreground">DuoSpace {r.version_name}</h2>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            {u.installed && (
              <span className="inline-flex items-center gap-1 tabular-nums">
                {u.installed.versionName} <ArrowRight className="h-3 w-3" aria-hidden="true" /> {r.version_name}
              </span>
            )}
            {size && !isIos && <span className="rounded-full bg-secondary px-2 py-0.5">{size}</span>}
          </p>
        </div>
      </div>

      {r.release_notes.trim() && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-foreground">What's new</p>
          <div className="max-h-40 overflow-y-auto rounded-xl bg-secondary/60 px-3 py-2.5 text-sm text-foreground/90 whitespace-pre-wrap">
            {r.release_notes}
          </div>
        </div>
      )}

      {r.mandatory && u.phase === "available" && (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldAlert className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          This version is required to keep using DuoSpace.
        </p>
      )}

      {!isIos && (busyPhase || u.phase === "ready" || u.phase === "installing" || u.phase === "needs_permission") && (
        <Steps phase={u.phase} />
      )}

      {u.phase === "available" && (
        <>
          {!isIos && u.connection === "cellular" && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Smartphone className="h-4 w-4 shrink-0" aria-hidden="true" /> You're on mobile data.
            </p>
          )}
          <div className="flex gap-2">
            <Button className="h-11 flex-1 rounded-xl" onClick={() => void u.startDownload()}>
              <Download className="h-4 w-4" /> {isIos ? "Get update" : "Update now"}
            </Button>
            {!r.mandatory && onLater && (
              <Button variant="outline" className="h-11 rounded-xl" onClick={onLater}>Later</Button>
            )}
          </div>
        </>
      )}

      {u.phase === "confirm_cellular" && (
        <div className="space-y-3">
          <p className="flex items-start gap-2 text-sm text-foreground">
            <Smartphone className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            You're on mobile data. This update is {size || "a large download"}. Download it now?
          </p>
          <div className="flex gap-2">
            <Button className="h-11 flex-1 rounded-xl" onClick={() => void u.startDownload(true)}>Use mobile data</Button>
            <Button variant="outline" className="h-11 flex-1 rounded-xl" onClick={() => void u.startDownload(false)}>
              <Wifi className="h-4 w-4" /> Wait for Wi-Fi
            </Button>
          </div>
        </div>
      )}

      {busyPhase && (
        <div className="space-y-3">
          {u.phase === "waiting_wifi" ? (
            <p className="flex items-start gap-2 text-sm text-foreground">
              <Wifi className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              Waiting for Wi-Fi. The download starts by itself when you connect.
            </p>
          ) : (
            <div className="space-y-1.5">
              <Progress value={pct} aria-label="Download progress" />
              <p className="flex justify-between text-xs tabular-nums text-muted-foreground">
                <span>{pct}%</span>
                <span>
                  {u.progress.total > 0
                    ? `${formatBytes(u.progress.bytes) || "0 MB"} of ${formatBytes(u.progress.total)}`
                    : "Starting…"}
                </span>
              </p>
            </div>
          )}
          <Button variant="outline" className="h-11 w-full rounded-xl" onClick={() => void u.cancel()}>Cancel download</Button>
        </div>
      )}

      {u.phase === "ready" && (
        <div className="space-y-2">
          {u.error && <p className="text-sm text-destructive">{u.error}</p>}
          <p className="text-xs text-muted-foreground">Downloaded and verified. Your chats and data stay as they are.</p>
          <Button className="h-11 w-full rounded-xl" onClick={() => void u.install()}>Install now</Button>
        </div>
      )}

      {u.phase === "installing" && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Opening the installer…
        </p>
      )}

      {u.phase === "needs_permission" && (
        <div className="space-y-3">
          <p className="text-sm text-foreground">
            Android needs your permission to install updates from DuoSpace. Turn on “Allow from this source”,
            then come back.
          </p>
          <Button className="h-11 w-full rounded-xl" onClick={() => void u.openInstallSettings()}>Open settings</Button>
        </div>
      )}

      {u.phase === "handoff" && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Opening…
        </p>
      )}

      {u.phase === "error" && (
        <div className="space-y-3">
          <p className="text-sm text-destructive">{u.error}</p>
          <div className="flex gap-2">
            <Button className="h-11 flex-1 rounded-xl" onClick={() => void u.startDownload()}>
              <RefreshCw className="h-4 w-4" /> Try again
            </Button>
            {!r.mandatory && onLater && (
              <Button variant="outline" className="h-11 rounded-xl" onClick={onLater}>Later</Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
