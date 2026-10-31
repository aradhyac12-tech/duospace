/**
 * Playback diagnostics — shown from the "Taking longer than usual" row so a stuck song can be explained
 * WITHOUT a computer: what the app thinks (loading / buffering), what the native player is really doing,
 * which kind of stream URL it has, how long each startup stage took, and the last music log lines.
 * "Copy" puts it all on the clipboard to paste into a message.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Copy, Check } from "lucide-react";
import { useGroic } from "@/contexts/GroicContext";
import { getRecentEvents } from "@/lib/telemetry";
import { startupTracer } from "@/lib/music/startupTrace";

function Panel({ onClose }: { onClose: () => void }) {
  const { current, loading, buffering, isPlaying, error, diagnose } = useGroic();
  const [snap, setSnap] = useState<Record<string, unknown> | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      let s: Record<string, unknown>;
      try { s = await diagnose(); } catch (e) { s = { diagnoseError: String(e) }; }
      if (!alive) return;
      setSnap(s);
      setEvents(getRecentEvents().filter((e) => e.context.startsWith("music")).slice(-16)
        .map((e) => `${e.timestamp.slice(11, 19)} ${e.context} · ${e.message}${e.extra ? " " + e.extra : ""}`));
    };
    void tick();
    const id = window.setInterval(tick, 1000);
    return () => { alive = false; window.clearInterval(id); };
  }, [diagnose]);

  const report = {
    ui: { loading, buffering, isPlaying, error, track: current ? { title: current.title, provider: current.provider, providerTrackId: current.providerTrackId } : null },
    native: snap,
    startup: startupTracer.reports().slice(-3),
    events,
  };
  const text = JSON.stringify(report, null, 2);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1800); } catch { /* clipboard blocked */ }
  };

  return createPortal(
    <div role="dialog" aria-label="Playback diagnostics" className="fixed inset-0 z-[3000] bg-background/97 flex flex-col" style={{ paddingTop: "env(safe-area-inset-top, 0px)", paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
      <div className="flex items-center gap-2 px-4 h-14 shrink-0 border-b border-border/50">
        <p className="flex-1 text-sm font-semibold">Playback diagnostics</p>
        <button onClick={copy} className="h-9 px-3 rounded-full bg-primary text-primary-foreground text-xs font-semibold flex items-center gap-1.5 active:scale-95">
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy"}
        </button>
        <button onClick={onClose} aria-label="Close" className="h-9 w-9 rounded-full bg-foreground/[0.08] flex items-center justify-center active:scale-95"><X className="h-4 w-4" /></button>
      </div>
      <pre className="flex-1 overflow-auto p-4 text-[10.5px] leading-snug font-mono whitespace-pre-wrap break-all select-text">{text}</pre>
    </div>,
    document.body,
  );
}

/** Small "Details" link that opens the panel. */
export function DiagnosticsLink({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={(e) => { e.stopPropagation(); setOpen(true); }} className={className ?? "text-[10px] text-muted-foreground underline underline-offset-2"}>Details</button>
      {open && <Panel onClose={() => setOpen(false)} />}
    </>
  );
}
