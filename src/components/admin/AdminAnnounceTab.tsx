import { useEffect, useState } from "react";
import { Loader2, Megaphone, Gift, AlertCircle, Download } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { hapticMedium } from "@/lib/haptics";
import { APP_VERSION } from "@/lib/errors/DuoSpaceError";
import { compareVersions } from "@/lib/semver";
import {
  adminApi, timeAgo, type AnnouncementAudience, type AnnouncementKind,
} from "@/lib/admin/adminApi";
import { Chips, Empty, Spinner, useAdminList } from "./AdminBits";

const KINDS: { value: AnnouncementKind; label: string }[] = [
  { value: "important_update", label: "Important update" },
  { value: "offer", label: "Offer" },
  { value: "announcement", label: "Announcement" },
];
const AUDIENCES: { value: AnnouncementAudience; label: string }[] = [
  { value: "all", label: "Everyone" }, { value: "free", label: "Free" }, { value: "paid", label: "Paid" },
  { value: "linked", label: "Connected" }, { value: "solo", label: "No partner" },
];
export const kindLabel = (k: string) => KINDS.find((x) => x.value === k)?.label ?? k;
export const KindIcon = ({ kind, className }: { kind: string; className?: string }) =>
  kind === "offer" ? <Gift className={className} aria-hidden="true" /> :
  kind === "important_update" ? <AlertCircle className={className} aria-hidden="true" /> :
  <Megaphone className={className} aria-hidden="true" />;

const SEMVER = /^\d+\.\d+\.\d+$/;

const AdminAnnounceTab = () => {
  const { toast } = useToast();
  const { rows, loading, reload } = useAdminList(() => adminApi.listAnnouncements(), []);

  const [kind, setKind] = useState<AnnouncementKind>("announcement");
  const [audience, setAudience] = useState<AnnouncementAudience>("all");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [ctaLabel, setCtaLabel] = useState("");
  const [ctaUrl, setCtaUrl] = useState("");
  const [days, setDays] = useState("");
  const [push, setPush] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const publish = async () => {
    if (!title.trim() || !body.trim()) { toast({ title: "Add a title and message", variant: "destructive" }); return; }
    if (ctaUrl.trim() && !/^https:\/\//.test(ctaUrl.trim())) { toast({ title: "Link must start with https://", variant: "destructive" }); return; }
    const d = days.trim() ? parseInt(days, 10) : NaN;
    setPublishing(true);
    try {
      await adminApi.publishAnnouncement({
        kind, title: title.trim(), body: body.trim(), audience,
        ctaLabel: ctaLabel.trim() || undefined, ctaUrl: ctaUrl.trim() || undefined,
        expiresAt: Number.isFinite(d) && d > 0 ? new Date(Date.now() + d * 86400_000).toISOString() : null,
        push,
      });
      hapticMedium();
      toast({ title: "Published", description: push ? "In-app card is live and the push is on its way." : "People will see it next time they open the app." });
      setTitle(""); setBody(""); setCtaLabel(""); setCtaUrl(""); setDays(""); setPush(false);
      await reload();
    } catch (e) {
      toast({ title: "Couldn't publish", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally { setPublishing(false); }
  };

  const toggle = async (id: string, active: boolean) => {
    setTogglingId(id);
    try { await adminApi.setAnnouncementActive(id, active); await reload(); }
    catch (e) { toast({ title: "Couldn't update", description: e instanceof Error ? e.message : "", variant: "destructive" }); }
    finally { setTogglingId(null); }
  };

  return (
    <div className="space-y-6">
      <section className="bg-card rounded-2xl border border-border/60 p-4 space-y-3">
        <p className="text-sm font-medium text-foreground">New message to users</p>
        <Chips value={kind} onChange={setKind} options={KINDS} />
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="Title" />
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={500} rows={3} placeholder="Message" />
        <div className="grid grid-cols-2 gap-2">
          <Input value={ctaLabel} onChange={(e) => setCtaLabel(e.target.value)} maxLength={30} placeholder="Button text (optional)" />
          <Input value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} placeholder="https:// link (optional)" inputMode="url" />
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground mb-1.5">Who sees it</p>
          <Chips value={audience} onChange={setAudience} options={AUDIENCES} />
        </div>
        <div className="flex items-center gap-3">
          <Input value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="Hide after … days (blank = never)" />
        </div>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>
            Also send a push notification
            <span className="block text-[11px] text-muted-foreground">Up to 1,000 recipients with a registered device per publish.</span>
          </span>
          <Switch checked={push} onCheckedChange={setPush} />
        </label>
        <Button className="w-full" onClick={publish} disabled={publishing}>
          {publishing ? <Loader2 className="h-4 w-4 animate-spin" /> : "Publish"}
        </Button>
      </section>

      <section className="space-y-2">
        <p className="text-sm font-medium text-foreground">Published</p>
        {loading && rows.length === 0 ? <Spinner /> : rows.length === 0 ? <Empty>Nothing published yet.</Empty> : (
          <div className="bg-card rounded-2xl border border-border/60 divide-y divide-border/40 overflow-hidden">
            {rows.map((a) => {
              const expired = !!a.expires_at && Date.parse(a.expires_at) < Date.now();
              return (
                <div key={a.id} className="px-4 py-3 flex items-start gap-3">
                  <KindIcon kind={a.kind} className="h-4 w-4 text-accent mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <p className="text-sm font-medium text-foreground truncate">{a.title}</p>
                    <p className="text-[11px] text-muted-foreground line-clamp-2">{a.body}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {kindLabel(a.kind)} · {a.audience} · {timeAgo(a.created_at)} · dismissed by {a.dismissed_count}
                      {expired ? " · expired" : ""}
                    </p>
                  </div>
                  <Switch
                    checked={a.active && !expired} disabled={togglingId === a.id || expired}
                    onCheckedChange={(v) => toggle(a.id, v)} aria-label={`Show "${a.title}" to users`}
                  />
                </div>
              );
            })}
          </div>
        )}
      </section>

      <AppUpdateCard />
    </div>
  );
};

const AppUpdateCard = () => {
  const { toast } = useToast();
  const [loaded, setLoaded] = useState(false);
  const [latest, setLatest] = useState("");
  const [min, setMin] = useState("");
  const [message, setMessage] = useState("");
  const [androidUrl, setAndroidUrl] = useState("");
  const [iosUrl, setIosUrl] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    adminApi.getAppUpdate().then((c) => {
      if (c) {
        setLatest(c.latest_version); setMin(c.min_supported_version); setMessage(c.message ?? "");
        setAndroidUrl(c.android_url ?? ""); setIosUrl(c.ios_url ?? "");
      }
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  const save = async () => {
    if (!SEMVER.test(latest.trim()) || !SEMVER.test(min.trim())) {
      toast({ title: "Versions must look like 3.21.0", variant: "destructive" }); return;
    }
    if (compareVersions(min, latest) > 0) {
      toast({ title: "Minimum version can't be higher than the latest", variant: "destructive" }); return;
    }
    setSaving(true);
    try {
      await adminApi.setAppUpdate({ latest: latest.trim(), minSupported: min.trim(), message: message.trim(), androidUrl: androidUrl.trim(), iosUrl: iosUrl.trim() });
      hapticMedium();
      toast({ title: "App update settings saved" });
    } catch (e) {
      toast({ title: "Couldn't save", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally { setSaving(false); }
  };

  if (!loaded) return <Spinner />;
  return (
    <section className="bg-card rounded-2xl border border-border/60 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Download className="h-4 w-4 text-accent" aria-hidden="true" />
        <p className="text-sm font-medium text-foreground">App update</p>
      </div>
      <p className="text-[11px] text-muted-foreground">
        This build is v{APP_VERSION}. Anyone below <b>latest</b> gets a dismissible "update available" card; anyone below <b>minimum</b> is stopped until they update.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Input value={latest} onChange={(e) => setLatest(e.target.value)} placeholder="Latest e.g. 3.21.0" inputMode="decimal" />
        <Input value={min} onChange={(e) => setMin(e.target.value)} placeholder="Minimum e.g. 3.18.0" inputMode="decimal" />
      </div>
      <Input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={300} placeholder="What's new (optional)" />
      <Input value={androidUrl} onChange={(e) => setAndroidUrl(e.target.value)} placeholder="Play Store link (https://)" inputMode="url" />
      <Input value={iosUrl} onChange={(e) => setIosUrl(e.target.value)} placeholder="App Store link (https://)" inputMode="url" />
      <Button className="w-full" onClick={save} disabled={saving}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
      </Button>
    </section>
  );
};

export default AdminAnnounceTab;
