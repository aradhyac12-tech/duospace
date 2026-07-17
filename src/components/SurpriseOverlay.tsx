import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import CodeSurpriseFrame from "@/components/CodeSurpriseFrame";
import { buildSurpriseDocument } from "@/lib/codeSurprises";

interface Surprise {
  id: string;
  title: string;
  html_content: string;
  css_content: string;
  js_content: string;
  max_views: number;
  views_used: number;
  creator_id: string;
}

const SurpriseOverlay = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [surprise, setSurprise] = useState<Surprise | null>(null);
  const [show, setShow] = useState(false);
  const [partnerId, setPartnerId] = useState<string | null>(null);

  const surpriseDocument = useMemo(() => {
    if (!surprise) return "";

    return buildSurpriseDocument({
      title: surprise.title,
      html_content: surprise.html_content,
      css_content: surprise.css_content,
      js_content: surprise.js_content,
      max_views: surprise.max_views,
    });
  }, [surprise]);

  const checkSurprises = useCallback(async () => {
    if (!user || !partnerId) return;

    const { data, error } = await supabase
      .from("code_surprises")
      .select("id,creator_id,title,html_content,css_content,js_content,is_active,max_views,views_used,created_at")
      .eq("creator_id", partnerId)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error || !data?.length) return;

    const nextSurprise = data[0] as Surprise;
    if (nextSurprise.views_used >= nextSurprise.max_views) return;

    const seenKey = `seen-surprises:${partnerId}`;
    const seen = JSON.parse(sessionStorage.getItem(seenKey) || "[]") as string[];

    if (seen.includes(nextSurprise.id)) return;

    setSurprise(nextSurprise);
    setShow(true);
    // Track analytics
    if (user) {
      supabase.from("code_surprise_events").insert([
        { surprise_id: nextSurprise.id, user_id: user.id, event_type: "received" },
        { surprise_id: nextSurprise.id, user_id: user.id, event_type: "opened" },
      ] as any);
    }
    sessionStorage.setItem(seenKey, JSON.stringify([...seen, nextSurprise.id]));

    const nextViews = nextSurprise.views_used + 1;
    await supabase
      .from("code_surprises")
      .update({ views_used: nextViews, is_active: nextViews < nextSurprise.max_views } as any)
      .eq("id", nextSurprise.id);
  }, [partnerId, user]);

  useEffect(() => {
    if (!user) return;
    const loadPartner = async () => {
      const { data } = await supabase
        .from("profiles")
        .select("partner_id")
        .eq("user_id", user.id)
        .single();

      setPartnerId(data?.partner_id ?? null);
    };

    loadPartner();
  }, [user]);

  useEffect(() => {
    if (!partnerId) return;

    const timeout = setTimeout(() => {
      checkSurprises();
    }, 1200);

    return () => clearTimeout(timeout);
  }, [checkSurprises, partnerId]);

  useEffect(() => {
    if (!partnerId) return;

    const channel = supabase
      .channel("code-surprises-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "code_surprises" }, (payload) => {
        const creatorId = (payload.new as { creator_id?: string } | null)?.creator_id;
        if (creatorId === partnerId) {
          checkSurprises();
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [checkSurprises, partnerId]);

  const handleClose = () => {
    setShow(false);
    if (surprise && user) {
      supabase.from("code_surprise_events").insert({
        surprise_id: surprise.id,
        user_id: user.id,
        event_type: "finished",
      } as any);
    }
    setTimeout(() => setSurprise(null), 300);
  };

  return (
    <AnimatePresence>
      {show && surprise && (
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ type: "spring", duration: 0.5 }}
          className="fixed inset-0 z-[100] bg-background flex flex-col"
        >
          <div className="safe-top px-4 pt-3 flex items-center justify-between">
            <p className="text-sm font-semibold">{surprise.title}</p>
            <button onClick={handleClose} className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>
          <div className="flex-1 p-4">
            <CodeSurpriseFrame documentHtml={surpriseDocument} title={surprise.title} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default SurpriseOverlay;
