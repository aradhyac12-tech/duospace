/**
 * Storage — what DuoSpace keeps on this phone, and the two controls the person
 * actually has (WhatsApp's "Manage storage" + "Media auto-download", scaled to a
 * two-person app: there is one conversation, so no per-chat list).
 *
 *  - Downloaded media by kind, with a "Clear" action. Clearing removes the
 *    saved COPIES only; photos / voice notes download again when opened online.
 *    Messages, snapshots and everything on the server are untouched.
 *  - "Download media on Wi-Fi only": hold background saving back on mobile data
 *    (opening a photo still streams it). Default off = previous behaviour.
 *
 * Chat history and screen data are deliberately not listed as switches: they are
 * always kept (see lib/offlineSettings.ts).
 */
import { useCallback, useEffect, useState } from "react";
import { HardDrive, Trash2, Wifi } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import ConfirmActionDialog from "@/components/settings/ConfirmActionDialog";
import { getMediaCacheStats, wipeMediaCache } from "@/lib/mediaCache";
import { getOfflinePref, setOfflinePref } from "@/lib/offlineSettings";
import type { MediaStats } from "@/lib/nativeMediaStore";
import { hapticSelection, hapticSuccess } from "@/lib/haptics";
import { formatBytes } from "@/lib/formatBytes";

const ROWS: Array<{ key: keyof Pick<MediaStats, "photos" | "audio" | "video" | "other">; label: string }> = [
  { key: "photos", label: "Photos" },
  { key: "audio", label: "Voice notes" },
  { key: "video", label: "Videos" },
  { key: "other", label: "Other" },
];

const StorageCard = () => {
  const [stats, setStats] = useState<MediaStats | null>(null);
  const [wifiOnly, setWifiOnly] = useState<boolean>(() => getOfflinePref("wifiOnlyMedia"));
  const [confirmOpen, setConfirmOpen] = useState(false);

  const refresh = useCallback(async () => {
    try { setStats(await getMediaCacheStats()); } catch { setStats(null); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const onToggle = (next: boolean) => {
    hapticSelection();
    setOfflinePref("wifiOnlyMedia", next);
    setWifiOnly(getOfflinePref("wifiOnlyMedia"));
  };

  const onClear = async () => {
    await wipeMediaCache();
    hapticSuccess();
    await refresh();
  };

  return (
    <>
      <div className="bg-card rounded-2xl border border-border/60 divide-y divide-border/40 mb-2" data-testid="storage-card">
        <div className="flex items-center gap-3 px-4 py-3">
          <HardDrive className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Saved on this phone</p>
            <p className="text-[11px] text-muted-foreground">
              Chats and your lists are always kept so the app works offline.
            </p>
          </div>
          <p className="text-sm font-medium tabular-nums" data-testid="storage-total">
            {stats ? formatBytes(stats.size) : "…"}
          </p>
        </div>

        {stats && ROWS.filter((r) => stats[r.key].count > 0).map((r) => (
          <div key={r.key} className="flex items-center justify-between px-4 py-2.5 pl-11">
            <p className="text-[13px] text-muted-foreground">{r.label} · {stats[r.key].count}</p>
            <p className="text-[13px] tabular-nums">{formatBytes(stats[r.key].size)}</p>
          </div>
        ))}

        <div className="flex items-center gap-3 px-4 py-3">
          <Wifi className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Download media on Wi-Fi only</p>
            <p className="text-[11px] text-muted-foreground">
              On mobile data new photos and voice notes still show, but aren't saved until you're on Wi-Fi.
            </p>
          </div>
          <Switch checked={wifiOnly} onCheckedChange={onToggle} aria-label="Download media on Wi-Fi only" />
        </div>

        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          disabled={!stats || stats.count === 0}
          className="flex w-full items-center gap-3 px-4 py-3 text-left disabled:opacity-40"
        >
          <Trash2 className="h-4 w-4 text-destructive shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-destructive">Clear downloaded media</p>
            <p className="text-[11px] text-muted-foreground">Frees space. Messages are not deleted.</p>
          </div>
        </button>
      </div>

      <ConfirmActionDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Clear downloaded media?"
        whatHappens="Removes the saved copies of photos, voice notes and videos from this phone."
        dataAffected="Only the copies on this phone. Messages, your lists and everything on the server stay."
        reversible
        reversibleNote="Each item downloads again when you open it while online."
        authRequired={false}
        confirmLabel="Clear media"
        onConfirm={onClear}
      />
    </>
  );
};

export default StorageCard;
