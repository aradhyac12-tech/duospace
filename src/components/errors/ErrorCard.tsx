/**
 * ErrorCard — the premium, user-facing presentation of a DuoSpaceErrorPayload.
 *
 * Shows: icon, title, short explanation, error code, retry/copy/report
 * actions, and an expandable technical-details section that only reveals
 * stack traces / raw details when Developer Mode is on (never in a
 * production build for a normal user).
 */
import { useState } from "react";
import {
  AlertTriangle,
  RotateCw,
  Copy,
  Bug,
  ChevronDown,
  ChevronUp,
  Wifi,
  ShieldAlert,
  LifeBuoy,
  Info,
  XCircle,
  Flame,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { errorManager } from "@/lib/errors/errorManager";
import type { DuoSpaceErrorPayload, ErrorSeverity } from "@/lib/errors/types";
import { cn } from "@/lib/utils";

const SEVERITY_STYLES: Record<ErrorSeverity, { icon: typeof AlertTriangle; ring: string; badge: string }> = {
  INFO: { icon: Info, ring: "bg-info/10 text-info", badge: "bg-info/10 text-info" },
  WARNING: { icon: AlertTriangle, ring: "bg-warning/10 text-warning", badge: "bg-warning/10 text-warning" },
  ERROR: { icon: XCircle, ring: "bg-destructive/10 text-destructive", badge: "bg-destructive/10 text-destructive" },
  CRITICAL: { icon: ShieldAlert, ring: "bg-destructive/10 text-destructive", badge: "bg-destructive/10 text-destructive" },
  FATAL: { icon: Flame, ring: "bg-destructive/10 text-destructive", badge: "bg-destructive/10 text-destructive" },
};

export interface ErrorCardProps {
  error: DuoSpaceErrorPayload;
  /** Called when the user taps Retry. Omit to hide the retry button regardless of `retryable`. */
  onRetry?: () => void | Promise<void>;
  /** Called when the user taps "Report bug". Defaults to copying diagnostics + toast. */
  onReportBug?: (error: DuoSpaceErrorPayload) => void;
  /** Show stack trace / raw details. Should be gated on a Developer Mode setting. */
  developerMode?: boolean;
  /** Support URL shown as a link at the bottom of the card. */
  supportUrl?: string;
  className?: string;
}

export function ErrorCard({
  error,
  onRetry,
  onReportBug,
  developerMode = false,
  supportUrl = "https://duospace.app/support",
  className,
}: ErrorCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const { toast } = useToast();

  const { icon: Icon, ring, badge } = SEVERITY_STYLES[error.severity];

  const handleRetry = async () => {
    if (!onRetry) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  const handleCopy = async () => {
    const text = errorManager.copyDiagnostics(error);
    try {
      await navigator.clipboard.writeText(text);
      toast({ description: "Error details copied." });
    } catch {
      toast({ description: "Couldn't copy to clipboard.", variant: "destructive" });
    }
  };

  const handleReport = () => {
    if (onReportBug) {
      onReportBug(error);
      return;
    }
    void handleCopy();
    toast({ description: "Details copied — paste them into a bug report." });
  };

  return (
    <div
      className={cn(
        "w-full max-w-sm rounded-2xl border bg-card text-card-foreground shadow-lg overflow-hidden",
        className,
      )}
      role="alert"
    >
      <div className="p-5 flex flex-col items-center text-center gap-3">
        <div className={cn("h-14 w-14 rounded-full flex items-center justify-center", ring)}>
          <Icon className="h-7 w-7" />
        </div>

        <div className="space-y-1">
          <p className="text-base font-semibold">{error.title}</p>
          <p className="text-sm text-muted-foreground max-w-[280px]">{error.recoverySuggestion}</p>
        </div>

        <span className={cn("text-[11px] font-mono px-2 py-0.5 rounded-full", badge)}>{error.code}</span>

        <div className="flex flex-wrap gap-2 justify-center pt-1">
          {error.retryable && onRetry && (
            <Button size="sm" onClick={handleRetry} disabled={retrying} className="gap-1.5">
              <RotateCw className={cn("h-3.5 w-3.5", retrying && "animate-spin")} />
              {retrying ? "Retrying…" : "Retry"}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={handleCopy} className="gap-1.5">
            <Copy className="h-3.5 w-3.5" />
            Copy
          </Button>
          <Button size="sm" variant="outline" onClick={handleReport} className="gap-1.5">
            <Bug className="h-3.5 w-3.5" />
            Report bug
          </Button>
        </div>
      </div>

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-center gap-1 py-2 text-xs text-muted-foreground border-t hover:bg-muted/50 transition-colors"
      >
        Technical details
        {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>

      {expanded && (
        <div className="px-5 pb-4 space-y-2 text-xs text-muted-foreground border-t pt-3 bg-muted/20">
          <Row label="Category" value={error.category} />
          <Row label="Severity" value={error.severity} />
          <Row label="Screen" value={error.screen ?? "—"} />
          <Row label="Component" value={error.component ?? "—"} />
          <Row label="Timestamp" value={error.timestamp} />
          <Row label="Session" value={error.sessionId} />
          <Row label="App version" value={error.appVersion} />
          <Row label="Occurrences" value={String(error.occurrenceCount)} />
          <Row
            label="Device"
            value={`${error.device.platform} · ${error.device.isNative ? "native" : "web"} · ${
              error.device.online ? "online" : "offline"
            }`}
          />
          {!error.device.online && (
            <div className="flex items-center gap-1.5 text-warning pt-1">
              <Wifi className="h-3.5 w-3.5" />
              This device is currently offline.
            </div>
          )}

          {/* Stack traces and raw details are gated behind Developer Mode —
              never surfaced to a normal user, even if the underlying payload
              always carries them for the dev log panel. */}
          {developerMode && (
            <div className="pt-2 space-y-2">
              {error.details && (
                <pre className="whitespace-pre-wrap break-all bg-background/80 rounded-lg p-2 max-h-40 overflow-auto">
                  {JSON.stringify(error.details, null, 2)}
                </pre>
              )}
              {error.stack && (
                <pre className="whitespace-pre-wrap break-all bg-background/80 rounded-lg p-2 max-h-40 overflow-auto">
                  {error.stack}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      <a
        href={supportUrl}
        target="_blank"
        rel="noreferrer"
        className="flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium text-primary border-t hover:bg-muted/50 transition-colors"
      >
        <LifeBuoy className="h-3.5 w-3.5" />
        Contact support
      </a>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="shrink-0">{label}</span>
      <span className="text-right break-all">{value}</span>
    </div>
  );
}
