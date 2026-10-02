import { useCallback, useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Crown, FlaskConical, Heart, Megaphone, Gift, AlertCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/appClient";
import { useAuth } from "@/hooks/useAuth";
import { ENTITLEMENT_CHANGED_EVENT } from "@/hooks/useEntitlement";
import { hapticMedium } from "@/lib/haptics";
import { openExternalUrl } from "@/lib/nativeBrowser";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

/**
 * App-wide card for messages that come from the app's admin:
 *   1. user_notices   - "an admin has granted you Founder/Beta" (and the
 *      gentler "your access has ended"). Written by a database trigger on
 *      entitlements, so it appears no matter how the grant was made.
 *   2. announcements  - important updates, offers, announcements.
 * One card at a time; grant notices go first. Closing a card marks it seen/
 * dismissed on the server so it never comes back.
 */
interface Notice { id: string; kind: "plan_granted" | "plan_revoked"; plan: string | null; title: string; body: string }
interface Announcement { id: string; kind: string; title: string; body: string; cta_label: string | null; cta_url: string | null }

const PERKS = ["Pro features, unlocked", "Higher media & music limits", "Priority AI and support"];

const UserNoticeHost = () => {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const reduceMotion = useReducedMotion();
  const [notices, setNotices] = useState<Notice[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [open, setOpen] = useState(true);

  const load = useCallback(async () => {
    if (!userId) { setNotices([]); setAnnouncements([]); return; }
    const [n, a] = await Promise.all([
      (supabase as any).from("user_notices").select("id,kind,plan,title,body").is("seen_at", null).order("created_at", { ascending: true }).limit(5),
      (supabase as any).rpc("get_my_announcements"),
    ]);
    // A failed re-check never makes a card disappear from under someone.
    if (!n.error) {
      const rows = (n.data ?? []) as Notice[];
      setNotices(rows);
      if (rows.some((r) => r.kind === "plan_granted" || r.kind === "plan_revoked")) {
        window.dispatchEvent(new Event(ENTITLEMENT_CHANGED_EVENT));
      }
    }
    if (!a.error) setAnnouncements((a.data ?? []) as Announcement[]);
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    void load();
    const channel = supabase
      .channel(`user-notices-${userId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "user_notices", filter: `user_id=eq.${userId}` }, () => { setOpen(true); void load(); })
      .subscribe();
    const recheck = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", recheck);
    return () => {
      document.removeEventListener("visibilitychange", recheck);
      supabase.removeChannel(channel);
    };
  }, [userId, load]);

  const notice = notices[0] ?? null;
  const announcement = notice ? null : announcements[0] ?? null;
  const showing = !!(notice || announcement);

  useEffect(() => { if (showing) setOpen(true); }, [notice?.id, announcement?.id, showing]);

  const close = async () => {
    hapticMedium();
    if (notice) {
      setNotices((p) => p.filter((x) => x.id !== notice.id));
      await (supabase as any).rpc("mark_notice_seen", { _notice_id: notice.id });
    } else if (announcement) {
      setAnnouncements((p) => p.filter((x) => x.id !== announcement.id));
      await (supabase as any).rpc("dismiss_announcement", { _announcement_id: announcement.id });
    }
  };

  if (!showing) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) void close(); }}>
      <DialogContent className="rounded-3xl max-w-[340px] p-0 overflow-hidden border-border/60">
        {notice ? <NoticeBody notice={notice} reduceMotion={!!reduceMotion} onDone={close} /> : announcement ? (
          <AnnouncementBody a={announcement} onDone={close} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
};

const NoticeBody = ({ notice, reduceMotion, onDone }: { notice: Notice; reduceMotion: boolean; onDone: () => void }) => {
  const granted = notice.kind === "plan_granted";
  const Icon = notice.plan === "BETA" ? FlaskConical : Crown;
  return (
    <div>
      <div className="bg-gradient-to-br from-accent/30 via-accent/10 to-transparent px-6 pt-8 pb-5 text-center">
        <motion.div
          initial={reduceMotion ? false : { scale: 0.5, rotate: -12, opacity: 0 }}
          animate={{ scale: 1, rotate: 0, opacity: 1 }}
          transition={{ type: "spring", stiffness: 260, damping: 16 }}
          className="mx-auto h-16 w-16 rounded-full bg-accent/20 flex items-center justify-center"
        >
          {granted ? <Icon className="h-8 w-8 text-accent" aria-hidden="true" /> : <Heart className="h-8 w-8 text-accent" aria-hidden="true" />}
        </motion.div>
        <DialogTitle className="text-lg font-semibold mt-4">{notice.title}</DialogTitle>
        <DialogDescription className="text-sm text-foreground/80 mt-2 leading-relaxed">{notice.body}</DialogDescription>
      </div>
      {granted && (
        <ul className="px-6 py-4 space-y-1.5">
          {PERKS.map((p) => (
            <li key={p} className="text-[13px] text-foreground/90 flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-accent shrink-0" aria-hidden="true" /> {p}
            </li>
          ))}
        </ul>
      )}
      <div className="px-6 pb-6 pt-2">
        <Button className="w-full rounded-xl" onClick={onDone}>{granted ? "Enjoy!" : "Got it"}</Button>
      </div>
    </div>
  );
};

const AnnouncementBody = ({ a, onDone }: { a: Announcement; onDone: () => void }) => {
  const Icon = a.kind === "offer" ? Gift : a.kind === "important_update" ? AlertCircle : Megaphone;
  const label = a.kind === "offer" ? "Offer" : a.kind === "important_update" ? "Important update" : "Announcement";
  return (
    <div className="px-6 py-6 space-y-3">
      <div className="flex items-center gap-2 text-accent">
        <Icon className="h-4 w-4" aria-hidden="true" />
        <span className="text-[11px] font-semibold uppercase tracking-wide">{label}</span>
      </div>
      <DialogTitle className="text-lg font-semibold">{a.title}</DialogTitle>
      <DialogDescription className="text-sm text-foreground/80 leading-relaxed whitespace-pre-line">{a.body}</DialogDescription>
      <div className="flex gap-2 pt-2">
        <Button variant="outline" className="flex-1 rounded-xl" onClick={onDone}>Close</Button>
        {a.cta_url && (
          <Button className="flex-1 rounded-xl" onClick={() => { void openExternalUrl(a.cta_url!); onDone(); }}>
            {a.cta_label || "Open"}
          </Button>
        )}
      </div>
    </div>
  );
};

export default UserNoticeHost;
