import { useState, useRef, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import PageHeader from "@/components/PageHeader";
import { MessageSquare, Upload, Info, Undo2 } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type FileKind = "text" | "image" | "video" | "audio" | "document" | "call";

interface ParsedLine {
  sender: string;
  content: string;
  timestamp: Date;
  kind: FileKind;
  // Only set for kind==="image"|"video"|"audio"|"document" — the filename
  // WhatsApp referenced inline (e.g. "IMG-20240101-WA0001.jpg"), resolved
  // against the zip's contents at import time.
  attachName?: string;
}

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|heic)$/i;
const VIDEO_EXT = /\.(mp4|mov|3gp|avi|mkv|webm)$/i;
const AUDIO_EXT = /\.(opus|mp3|m4a|aac|ogg|wav)$/i;

const extToKind = (name: string): FileKind => {
  if (IMAGE_EXT.test(name)) return "image";
  if (VIDEO_EXT.test(name)) return "video";
  if (AUDIO_EXT.test(name)) return "audio";
  return "document";
};

// WhatsApp's own export marks an attached-but-not-included media reference
// two different ways depending on platform/locale:
//   Android: "<attached: IMG-20240101-WA0001.jpg>"
//   iOS:     "IMG-20240101-WA0001.jpg (file attached)"
const ATTACH_RE_ANDROID = /^<attached:\s*(.+?)>$/i;
const ATTACH_RE_IOS = /^(.+?)\s*\(file attached\)$/i;

// Call log lines WhatsApp writes inline in the transcript itself (these are
// NOT junk — WhatsApp's own "chat export" is the only way call history for
// a conversation is ever obtainable outside the app, since WhatsApp has no
// separate call-log export). Covers voice/video, missed, group, with or
// without a trailing duration ("Voice call, 59 sec" / "‎Video call, 12:04").
const CALL_RE = /^(missed\s+)?(group\s+)?(voice|video)\s+call\b[,.]?\s*(.*)$/i;

const runWhatsAppImport = async (
  user: { id: string },
  toast: ReturnType<typeof useToast>["toast"],
  setImportProgress: (s: string) => void,
  parsed: ParsedLine[],
  selfSender: string | null,
  zip: any | null,
  onDone: (batchId: string, count: number) => void,
) => {
  setImportProgress(`Importing ${parsed.length} items…`);

  const nudged = parsed.map((msg, i) => {
    if (i === 0) return msg;
    const prevTs = parsed[i - 1].timestamp.getTime();
    if (msg.timestamp.getTime() > prevTs) return msg;
    return { ...msg, timestamp: new Date(prevTs + 1) };
  });
  for (let i = 1; i < nudged.length; i++) {
    if (nudged[i].timestamp.getTime() <= nudged[i - 1].timestamp.getTime()) {
      nudged[i] = { ...nudged[i], timestamp: new Date(nudged[i - 1].timestamp.getTime() + 1) };
    }
  }

  const { supabase } = await import("@/integrations/supabase/client");
  const batchId = crypto.randomUUID();

  // ─── Resolve media against the zip first (if one was provided) ──────────
  // Builds attachName (lowercased basename) -> uploaded storage path, so the
  // insert loop below just looks each row's attachName up instead of
  // re-searching the zip per row.
  const mediaRows = nudged.filter(m => m.attachName);
  const resolvedMedia = new Map<string, string>();
  if (zip && mediaRows.length) {
    const zipEntries = Object.keys(zip.files).filter(f => !zip.files[f].dir);
    const byBasename = new Map<string, string>();
    for (const path of zipEntries) {
      const base = path.split("/").pop()?.toLowerCase();
      if (base) byBasename.set(base, path);
    }
    let done = 0;
    for (const m of mediaRows) {
      const base = m.attachName!.toLowerCase();
      if (resolvedMedia.has(base)) { done++; continue; }
      const zipPath = byBasename.get(base);
      done++;
      setImportProgress(`Uploading media… ${done}/${mediaRows.length}`);
      if (!zipPath) continue; // referenced but not present in this export (common: "Media omitted" exports)
      try {
        const blob: Blob = await zip.files[zipPath].async("blob");
        const safeName = base.replace(/[^a-z0-9_.-]/gi, "_");
        const storagePath = `${user.id}/imports/${batchId}/${done}_${safeName}`;
        const { error: upErr } = await supabase.storage.from("chat-files").upload(storagePath, blob);
        if (upErr) {
          if (import.meta.env.DEV) console.error(`[WA Import] media upload failed for ${base}:`, upErr.message);
          continue;
        }
        const { data: urlData } = supabase.storage.from("chat-files").getPublicUrl(storagePath);
        resolvedMedia.set(base, urlData.publicUrl);
      } catch (mediaErr) {
        if (import.meta.env.DEV) console.error(`[WA Import] media read failed for ${base}:`, mediaErr);
      }
    }
  }

  // ─── Insert rows ──────────────────────────────────────────────────────
  const BATCH = 100;
  let inserted = 0;
  let failed = 0;
  let mediaIncluded = 0;
  let mediaMissing = 0;
  for (let i = 0; i < nudged.length; i += BATCH) {
    const batch = nudged.slice(i, i + BATCH).map(msg => {
      const fileUrl = msg.attachName ? resolvedMedia.get(msg.attachName.toLowerCase()) ?? null : null;
      if (msg.attachName) { if (fileUrl) mediaIncluded++; else mediaMissing++; }
      // A media reference that couldn't be resolved (no zip, or the file
      // wasn't actually in it) still gets imported as a labeled text row
      // instead of silently dropping the line or showing WhatsApp's raw
      // "<attached: ...>" placeholder verbatim.
      const content = msg.attachName && !fileUrl
        ? `📎 ${msg.attachName} (not included in this export)`
        : msg.content;
      return {
        owner_id: user.id,
        sender_name: msg.sender,
        content,
        original_timestamp: msg.timestamp.toISOString(),
        is_self: selfSender !== null && msg.sender === selfSender,
        file_url: fileUrl,
        file_type: msg.attachName && !fileUrl ? "text" : msg.kind,
        import_batch_id: batchId,
      };
    });
    const { error: batchErr } = await supabase.from("imported_chats" as any).insert(batch);
    if (batchErr) {
      failed += batch.length;
      if (import.meta.env.DEV) console.error(`[WA Import] Batch ${i}–${i + BATCH} failed:`, batchErr.message);
    } else {
      inserted += batch.length;
    }
    setImportProgress(`Importing… ${Math.min(i + BATCH, nudged.length)}/${nudged.length}`);
  }

  if (failed > 0 && inserted === 0) {
    toast({ title: "Import failed", description: `All ${failed} items failed to save. Check your connection and try again.`, variant: "destructive" });
    return;
  }
  if (failed > 0) {
    toast({ title: `Partially imported`, description: `${inserted} saved, ${failed} failed. Try again to retry missing batches.`, variant: "default" });
  } else {
    const mediaNote = mediaIncluded ? ` (${mediaIncluded} photo/video/file${mediaMissing ? `, ${mediaMissing} unavailable` : ""})` : "";
    toast({ title: `Imported ${inserted} items 📱${mediaNote}`, description: "Scroll up in chat to see them, in the right place on the timeline." });
  }
  onDone(batchId, inserted);
};

/**
 * WhatsApp import is a one-way, high-volume write to imported_chats, so it
 * gets an explicit disclosure card before the file picker rather than
 * hiding behind a single unlabeled button. It now also extracts referenced
 * photos/videos/voice notes/documents out of the export .zip (not just the
 * transcript text), and turns WhatsApp's inline call-log lines ("Voice
 * call", "Missed video call", ...) into distinct call entries instead of
 * plain text — that inline log is the only call history WhatsApp ever
 * exports at all, there's no separate call-log export. Each import run is
 * tagged with a batch id so it can be undone as a whole.
 */
const ImportSettings = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [importingWhatsApp, setImportingWhatsApp] = useState(false);
  const [importProgress, setImportProgress] = useState("");
  const [undoing, setUndoing] = useState(false);
  const [lastBatch, setLastBatch] = useState<{ id: string; count: number } | null>(null);
  const whatsappFileRef = useRef<HTMLInputElement>(null);
  const zipRef = useRef<any | null>(null);
  const [waSenderPick, setWaSenderPick] = useState<{
    senders: string[];
    parsed: ParsedLine[];
  } | null>(null);

  // Find the most recent import batch this device knows about so "Undo
  // last import" survives a reload of this page, not just the same session.
  useEffect(() => {
    if (!user) return;
    (async () => {
      const { supabase } = await import("@/integrations/supabase/client");
      const { data } = await supabase
        .from("imported_chats" as any)
        .select("import_batch_id")
        .eq("owner_id", user.id)
        .not("import_batch_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(1);
      const batchId = (data as any)?.[0]?.import_batch_id as string | undefined;
      if (!batchId) return;
      const { count } = await supabase
        .from("imported_chats" as any)
        .select("id", { count: "exact", head: true })
        .eq("owner_id", user.id)
        .eq("import_batch_id", batchId);
      setLastBatch({ id: batchId, count: count ?? 0 });
    })();
  }, [user]);

  const handleUndo = useCallback(async () => {
    if (!user || !lastBatch) return;
    setUndoing(true);
    const { supabase } = await import("@/integrations/supabase/client");
    // RLS's existing "Delete own imported chats" policy (auth.uid() =
    // owner_id) already scopes this correctly — import_batch_id is just an
    // extra filter on top of that same ownership check.
    const { error } = await supabase
      .from("imported_chats" as any)
      .delete()
      .eq("owner_id", user.id)
      .eq("import_batch_id", lastBatch.id);
    setUndoing(false);
    if (error) {
      toast({ title: "Couldn't undo import", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: `Removed ${lastBatch.count} imported items` });
    setLastBatch(null);
  }, [user, lastBatch, toast]);

  const doImport = (parsed: ParsedLine[], selfSender: string | null) => {
    if (!user) return;
    setImportingWhatsApp(true);
    runWhatsAppImport(user, toast, setImportProgress, parsed, selfSender, zipRef.current, (batchId, count) => {
      setImportingWhatsApp(false);
      setImportProgress("");
      zipRef.current = null;
      if (count > 0) setLastBatch({ id: batchId, count });
    });
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-24 bg-background"
    >
      <PageHeader title="Import WhatsApp Chat" subtitle="Bring an exported chat history into DuoSpace" />

      <div className="px-5 pt-5 space-y-3">
        <div className="bg-muted/40 rounded-2xl border border-border/60 p-4 space-y-2">
          <div className="flex items-center gap-2">
            <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Before you import</p>
          </div>
          <p className="text-[12px] text-foreground/90 leading-relaxed">
            Every message in the export is added to your chat timeline at its original date and time. Import the
            <span className="font-medium"> .zip</span> export (not just the .txt) to also bring in photos, videos, voice notes,
            and documents — WhatsApp's call history is included too, since it only ever appears as lines in the transcript itself.
          </p>
          <dl className="space-y-1.5 pt-1">
            <div className="flex gap-2 text-[11px]"><dt className="w-24 shrink-0 font-medium text-muted-foreground">Data affected</dt><dd className="text-foreground/90">Adds new rows to your imported chat history — your existing DuoSpace messages aren't touched.</dd></div>
            <div className="flex gap-2 text-[11px]"><dt className="w-24 shrink-0 font-medium text-muted-foreground">Reversible</dt><dd className="text-foreground/90">Yes — use "Undo last import" right after, to remove everything from that run.</dd></div>
            <div className="flex gap-2 text-[11px]"><dt className="w-24 shrink-0 font-medium text-muted-foreground">Authentication</dt><dd className="text-foreground/90">Not required beyond being signed in.</dd></div>
          </dl>
        </div>

        <div className="bg-card rounded-2xl border border-border/60">
          <button onClick={() => whatsappFileRef.current?.click()} disabled={importingWhatsApp}
            className="w-full flex items-center gap-3 px-4 py-3 text-left active:scale-[0.98] transition-transform disabled:opacity-50">
            <MessageSquare className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{importingWhatsApp ? (importProgress || "Importing...") : "Choose file to import"}</p>
              <p className="text-[11px] text-muted-foreground">Upload exported .txt or .zip · appears in chat timeline</p>
            </div>
            <Upload className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        {lastBatch && !importingWhatsApp && (
          <button onClick={handleUndo} disabled={undoing}
            className="w-full flex items-center gap-3 px-4 py-3 text-left rounded-2xl border border-destructive/30 bg-destructive/5 active:scale-[0.98] transition-transform disabled:opacity-50">
            <Undo2 className="h-4 w-4 text-destructive shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-destructive">{undoing ? "Removing…" : "Undo last import"}</p>
              <p className="text-[11px] text-muted-foreground">Removes the {lastBatch.count} items from your most recent import</p>
            </div>
          </button>
        )}

        <input ref={whatsappFileRef} type="file" accept=".txt,.zip" className="hidden"
          onChange={async e => {
            const file = e.target.files?.[0];
            if (!file || !user) return;
            setImportingWhatsApp(true); setImportProgress("Reading file…");
            zipRef.current = null;
            try {
              let text = "";
              if (file.name.endsWith(".txt")) {
                text = await file.text();
              } else if (file.name.endsWith(".zip")) {
                try {
                  const JSZip = (await import("jszip")).default;
                  const zip = await JSZip.loadAsync(file);
                  const txtFile = Object.keys(zip.files).find(f => f.endsWith(".txt"));
                  if (txtFile) text = await zip.files[txtFile].async("text");
                  else throw new Error("No .txt file found inside ZIP");
                  zipRef.current = zip; // kept for the media-extraction pass in runWhatsAppImport
                } catch (zipErr: any) {
                  toast({ title: "ZIP import failed", description: zipErr?.message || String(zipErr), variant: "destructive" });
                  setImportingWhatsApp(false); e.target.value = ""; return;
                }
              }
              if (!text.trim()) {
                toast({ title: "Could not read file", variant: "destructive" });
                setImportingWhatsApp(false); return;
              }

              setImportProgress("Parsing messages…");
              const lines = text.split("\n");
              const stripMarks = (s: string) => s.replace(/^[\u200e\u200f\ufeff]+/, "");
              const re = /^\[?(\d{1,4}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[APap][Mm])?)\]?\s*[-–]?\s*([^:]+):\s*(.*)/;
              const JUNK_CONTENT = [
                /^<Media omitted>$/i, /^image omitted$/i, /^video omitted$/i, /^sticker omitted$/i,
                /^audio omitted$/i, /^document omitted$/i, /^GIF omitted$/i, /^null$/i,
                /^This message was deleted$/i, /^You deleted this message\.?$/i,
                /^Messages and calls are end.to.end encrypted/i, /^Your messages.*security code/i, /^\s*$/,
              ];
              const isJunk = (content: string) => JUNK_CONTENT.some(p => p.test(content.trim()));

              let dayFirst: boolean | null = null;
              {
                const dateRe = /^\[?(\d{1,4}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/;
                for (const rawLine of lines) {
                  const dm = stripMarks(rawLine).match(dateRe);
                  if (!dm) continue;
                  const dp = dm[1].replace(/[\-\.]/g, "/");
                  const p = dp.split("/");
                  if (p.length !== 3 || p[0].length === 4) continue;
                  const first = parseInt(p[0], 10);
                  const second = parseInt(p[1], 10);
                  if (first > 12) { dayFirst = true; break; }
                  if (second > 12) { dayFirst = false; break; }
                }
                if (dayFirst === null) dayFirst = true;
              }

              const parseTimestamp = (datePart: string, timePart: string): Date | null => {
                const dp = datePart.replace(/[\-\.]/g, "/");
                const parts = dp.split("/");
                if (parts.length !== 3) return null;
                let [a, b, c] = parts;
                let month: string, day: string, year: string;
                if (a.length === 4) {
                  [year, month, day] = [a, b, c];
                } else if (dayFirst) {
                  [day, month, year] = [a, b, c];
                } else {
                  [month, day, year] = [a, b, c];
                }
                if (year.length === 2) year = (parseInt(year) <= 29 ? "20" : "19") + year;
                const tp = timePart.trim().replace(/\s*(am|pm)$/i, m => " " + m.trim().toUpperCase());
                const is12h = /[AP]M$/i.test(tp);
                let ts: Date;
                if (is12h) {
                  ts = new Date(`${month}/${day}/${year} ${tp}`);
                } else {
                  const [hh, mm, ss = "00"] = tp.split(":");
                  ts = new Date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hh.padStart(2, "0")}:${mm}:${ss}`);
                }
                return isNaN(ts.getTime()) ? null : ts;
              };

              const parsed: ParsedLine[] = [];
              for (const rawLine of lines) {
                const line = stripMarks(rawLine);
                const m = line.match(re);
                if (m) {
                  const [, datePart, timePart, sender, content] = m;
                  const ts = parseTimestamp(datePart, timePart);
                  const trimmedContent = content.trim();
                  if (!ts) continue;
                  if (isJunk(trimmedContent)) continue;

                  const androidAttach = trimmedContent.match(ATTACH_RE_ANDROID);
                  const iosAttach = !androidAttach ? trimmedContent.match(ATTACH_RE_IOS) : null;
                  const attachMatch = androidAttach || iosAttach;
                  const callMatch = !attachMatch ? trimmedContent.match(CALL_RE) : null;

                  if (attachMatch) {
                    const attachName = attachMatch[1].trim();
                    parsed.push({ sender: sender.trim(), content: trimmedContent, timestamp: ts, kind: extToKind(attachName), attachName });
                  } else if (callMatch) {
                    const missed = !!callMatch[1];
                    const isVideo = /video/i.test(callMatch[3]);
                    const duration = callMatch[4]?.trim();
                    const label = `${missed ? "Missed " : ""}${isVideo ? "Video" : "Voice"} call${duration ? ` · ${duration}` : ""}`;
                    parsed.push({ sender: sender.trim(), content: label, timestamp: ts, kind: "call" });
                  } else {
                    parsed.push({ sender: sender.trim(), content: trimmedContent, timestamp: ts, kind: "text" });
                  }
                } else if (parsed.length > 0 && line.trim() && parsed[parsed.length - 1].kind === "text") {
                  parsed[parsed.length - 1].content += "\n" + line.trim();
                }
              }

              if (!parsed.length) {
                toast({ title: "No messages found", description: "Check the file format — try exporting without media.", variant: "destructive" });
                setImportingWhatsApp(false); e.target.value = ""; return;
              }

              const distinctSenders = Array.from(new Set(parsed.map(p => p.sender)));
              if (distinctSenders.length > 1) {
                setWaSenderPick({ senders: distinctSenders, parsed });
                setImportingWhatsApp(false);
                e.target.value = "";
                return;
              }
              doImport(parsed, null);
            } catch (err: unknown) {
              toast({ title: "Import failed", description: (err instanceof Error ? err.message : String(err)), variant: "destructive" });
              setImportingWhatsApp(false); setImportProgress("");
            }
            e.target.value = "";
          }} />
      </div>

      <Dialog open={!!waSenderPick} onOpenChange={(open) => { if (!open) setWaSenderPick(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Which one is you?</DialogTitle>
            <DialogDescription>
              This chat has messages from {waSenderPick?.senders.length} names. Pick the one that's you
              so we can label the chat correctly for both of you.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-2">
            {waSenderPick?.senders.map((name) => (
              <button
                key={name}
                onClick={() => {
                  const pick = waSenderPick;
                  setWaSenderPick(null);
                  if (pick) doImport(pick.parsed, name);
                }}
                className="w-full text-left px-4 py-3 rounded-xl bg-muted/50 border border-border/60 active:scale-[0.98] transition-transform"
              >
                <p className="text-sm font-medium truncate">{name}</p>
              </button>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => {
              const pick = waSenderPick;
              setWaSenderPick(null);
              if (pick) doImport(pick.parsed, null);
            }}>
              Skip / not sure
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
};

export default ImportSettings;
