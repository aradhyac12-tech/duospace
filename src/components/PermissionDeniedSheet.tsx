import { useCallback, useMemo, useState } from "react";
import { AlertTriangle, Camera, Image as ImageIcon, Mic, FileText, Settings2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ensureMediaPermission,
  openAppSettings,
  permissionLabel,
  permissionReason,
  recoveryInstructions,
  type MediaPermissionKind,
  type MediaPermissionResult,
} from "@/lib/mediaPermissions";

const ICON: Record<MediaPermissionKind, typeof Camera> = {
  camera: Camera,
  microphone: Mic,
  photos: ImageIcon,
  photos_add: ImageIcon,
  files: FileText,
};

interface Props {
  result: MediaPermissionResult | null;
  onClose: () => void;
  /** Re-run the original action after the user fixes things. */
  onRetry?: () => void;
}

/**
 * Shared fallback UI for every blocked/denied/busy media permission.
 * Explains what's blocked, why the feature needs it, and gives a concrete
 * recovery path — deep-link to OS settings on native, written steps on web.
 */
export function PermissionDeniedSheet({ result, onClose, onRetry }: Props) {
  const [busy, setBusy] = useState(false);
  const Icon = result ? ICON[result.kind] : AlertTriangle;

  const title = useMemo(() => {
    if (!result) return "";
    if (result.state === "busy") return `${permissionLabel(result.kind)} is in use`;
    if (result.state === "unsupported") return `${permissionLabel(result.kind)} unavailable`;
    return `${permissionLabel(result.kind)} access needed`;
  }, [result]);

  const body = useMemo(() => {
    if (!result) return "";
    if (result.state === "busy")
      return "Close any other app or browser tab using the camera, then try again.";
    if (result.state === "unsupported") return result.message;
    return `${permissionReason(result.kind)} ${recoveryInstructions(result.kind)}`;
  }, [result]);

  const handleSettings = useCallback(async () => {
    setBusy(true);
    const opened = await openAppSettings();
    setBusy(false);
    if (opened) onClose();
  }, [onClose]);

  const handleRetry = useCallback(async () => {
    if (!result) return;
    setBusy(true);
    const again = await ensureMediaPermission(result.kind);
    setBusy(false);
    if (again.granted) {
      onClose();
      onRetry?.();
    }
  }, [result, onClose, onRetry]);

  return (
    <Dialog open={!!result} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm rounded-2xl">
        <DialogHeader>
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <Icon className="h-6 w-6 text-destructive" aria-hidden="true" />
          </div>
          <DialogTitle className="text-center">{title}</DialogTitle>
          <DialogDescription className="text-center">{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-col gap-2 sm:flex-col">
          {result?.state !== "unsupported" && (
            <Button className="w-full rounded-xl" disabled={busy} onClick={handleRetry}>
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
              Try again
            </Button>
          )}
          {result?.state === "blocked" && (
            <Button
              variant="outline"
              className="w-full rounded-xl"
              disabled={busy}
              onClick={handleSettings}
            >
              <Settings2 className="mr-2 h-4 w-4" aria-hidden="true" />
              Open settings
            </Button>
          )}
          <Button variant="ghost" className="w-full rounded-xl" onClick={onClose}>
            Not now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Hook that pairs `ensureMediaPermission` with the fallback sheet.
 *
 *   const { ensure, permissionSheet } = useMediaPermission();
 *   if (!(await ensure("photos"))) return;   // sheet shows itself
 */
export function useMediaPermission() {
  const [denied, setDenied] = useState<MediaPermissionResult | null>(null);
  const [retryFn, setRetryFn] = useState<(() => void) | null>(null);

  const ensure = useCallback(
    async (kind: MediaPermissionKind, onRetry?: () => void) => {
      const r = await ensureMediaPermission(kind);
      if (!r.granted) {
        setRetryFn(() => onRetry ?? null);
        setDenied(r);
      }
      return r.granted;
    },
    [],
  );

  /** Surface an already-produced failure (e.g. a getUserMedia rejection). */
  const report = useCallback((r: MediaPermissionResult, onRetry?: () => void) => {
    setRetryFn(() => onRetry ?? null);
    setDenied(r);
  }, []);

  const permissionSheet = (
    <PermissionDeniedSheet
      result={denied}
      onClose={() => setDenied(null)}
      onRetry={retryFn ?? undefined}
    />
  );

  return { ensure, report, permissionSheet };
}
