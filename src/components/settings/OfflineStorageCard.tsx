import { useCallback, useEffect, useState } from "react";
import { HardDrive, Loader2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { getOfflinePrefs, setOfflinePref, type OfflinePrefs } from "@/lib/offlineSettings";
import { getMediaCacheSize, wipeMediaCache } from "@/lib/mediaCache";
import { countLocalMessages } from "@/lib/chatCache";
import { getCachedPartner } from "@/lib/partnerCache";
import { wipeLocalConversationData, collectionStore } from "@/lib/localDb";

/**
 * Settings → Data & Backup → "Offline & storage".
 *
 * The controls for what this phone keeps so DuoSpace opens instantly and works
 * without a connection (see docs/OFFLINE_FIRST.md). Everything here is only a
 * LOCAL copy — the server stays the source of truth, so turning things off or
 * clearing them never deletes anything for you or your partner; it just means
 * the app fetches it again next time.
 */
const formatBytes = (n: number): string => {
  if (n < 1024 * 1024) return `${Math.max(0, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

const Row = ({
  title, description, checked, disabled, onChange,
}: { title: string; description: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) => (
  <div className="flex items-center gap-3 px-4 py-3">
    <div className="flex-1 min-w-0">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-[11px] text-muted-foreground leading-relaxed">{description}</p>
    </div>
    <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={`${title} — ${checked ? "on" : "off"}`} />
  </div>
);

const OfflineStorageCard = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [prefs, setPrefs] = useState<OfflinePrefs>(getOfflinePrefs);
  const [mediaBytes, setMediaBytes] = useState<number | null>(null);
  const [messageCount, setMessageCount] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);

  const refresh = useCallback(async () => {
    setMediaBytes(await getMediaCacheSize());
    const partnerId = user ? getCachedPartner(user.id)?.partnerId : null;
    setMessageCount(user && partnerId ? await countLocalMessages(user.id, partnerId) : 0);
  }, [user]);

  useEffect(() => { void refresh(); }, [refresh]);

  const update = <K extends keyof OfflinePrefs>(key: K, value: OfflinePrefs[K]) => {
    setOfflinePref(key, value);
    setPrefs((p) => ({ ...p, [key]: value }));
  };

  const toggleHistory = async (on: boolean) => {
    update("chatHistory", on);
    if (!on && user) {
      // Off means off: remove what's already stored, not just stop adding.
      await wipeLocalConversationData(user.id).catch(() => {});
      toast({ title: "Chat history removed from this phone", description: "Messages will load from the internet each time you open the chat." });
    }
    void refresh();
  };

  const toggleScreenData = async (on: boolean) => {
    update("screenData", on);
    if (!on && user) {
      await collectionStore.wipeUser(user.id).catch(() => {});
      toast({ title: "Saved lists removed from this phone", description: "Shayaris, Us, memories and the gallery will load from the internet each time." });
    }
  };

  const toggleMedia = async (on: boolean) => {
    update("mediaCache", on);
    if (!on) {
      await wipeMediaCache();
      toast({ title: "Saved media removed from this phone" });
    }
    void refresh();
  };

  const clearMedia = async () => {
    setClearing(true);
    await wipeMediaCache();
    setClearing(false);
    toast({ title: "Saved media cleared", description: "Photos and voice notes will download again when you open them." });
    void refresh();
  };

  return (
    <div className="bg-card rounded-2xl border border-border/60 divide-y divide-border/40 mb-2">
      <div className="flex items-center gap-3 px-4 py-3">
        <HardDrive className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">Offline &amp; storage</p>
          <p className="text-[11px] text-muted-foreground">
            What this phone keeps so DuoSpace opens instantly and works without internet.
            Your chat stays on the server either way.
          </p>
        </div>
      </div>

      <Row
        title="Keep chat history on this phone"
        description={`Messages open instantly and can be read offline. Stored encrypted.${messageCount ? ` ${messageCount.toLocaleString()} saved.` : ""}`}
        checked={prefs.chatHistory}
        onChange={toggleHistory}
      />
      <Row
        title="Keep shayaris, memories & gallery lists"
        description="These screens open instantly and offline. Stored encrypted."
        checked={prefs.screenData}
        onChange={toggleScreenData}
      />
      <Row
        title="Save photos & voice notes"
        description="Opened photos (chat, memories, gallery) and voice notes are kept so they show offline. Stored as ordinary files inside the app."
        checked={prefs.mediaCache}
        onChange={toggleMedia}
      />
      <Row
        title="Only save media on Wi-Fi"
        description="Never use mobile data to save photos and voice notes for offline."
        checked={prefs.wifiOnlyMedia}
        disabled={!prefs.mediaCache}
        onChange={(v) => update("wifiOnlyMedia", v)}
      />

      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">Saved media</p>
          <p className="text-[11px] text-muted-foreground">{mediaBytes === null ? "Checking…" : `${formatBytes(mediaBytes)} used (limit 400 MB, oldest removed first)`}</p>
        </div>
        <button
          type="button"
          onClick={clearMedia}
          disabled={clearing || !mediaBytes}
          className="h-8 px-3 rounded-full bg-muted text-[11px] text-foreground disabled:opacity-50 flex items-center gap-1 active:scale-95 transition-transform"
        >
          {clearing ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : null}
          Clear
        </button>
      </div>
    </div>
  );
};

export default OfflineStorageCard;
