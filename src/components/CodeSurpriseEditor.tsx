import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Play, Code2, Eye, Palette, Braces, Save, Plus, Wand2, Upload, Maximize2, Minimize2, AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/appClient";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { hapticWarning, hapticSuccess, hapticSelection } from "@/lib/haptics";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import CodeSurpriseFrame from "@/components/CodeSurpriseFrame";
import { buildSurpriseDocument, defaultSurprisePreset, surprisePresets } from "@/lib/codeSurprises";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface Surprise {
  id: string;
  title: string;
  html_content: string;
  css_content: string;
  js_content: string;
  max_views: number;
  views_used: number;
  is_active: boolean;
  created_at: string;
}

interface CodeSurpriseEditorProps {
  partnerId?: string | null;
}

const CodeSurpriseEditor = ({ partnerId }: CodeSurpriseEditorProps) => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [surprises, setSurprises] = useState<Surprise[]>([]);
  const [editing, setEditing] = useState<Surprise | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [title, setTitle] = useState(defaultSurprisePreset.title);
  const [html, setHtml] = useState(defaultSurprisePreset.html_content);
  const [css, setCss] = useState(defaultSurprisePreset.css_content);
  const [js, setJs] = useState(defaultSurprisePreset.js_content);
  const [maxViews, setMaxViews] = useState(1);
  const [editorFullscreen, setEditorFullscreen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const htmlFileRef = useRef<HTMLInputElement>(null);
  const cssFileRef = useRef<HTMLInputElement>(null);
  const jsFileRef = useRef<HTMLInputElement>(null);
  // Snapshot of what's on the server (or the preset) at the moment the
  // editor opened — everything else compares against this to know whether
  // there's anything worth warning about before a close/discard.
  const baselineRef = useRef({ title, html, css, js, maxViews });

  const previewDocument = useMemo(() => buildSurpriseDocument({
    title,
    html_content: html,
    css_content: css,
    js_content: js,
    max_views: maxViews,
  }), [css, html, js, maxViews, title]);

  // Cheap dirty-check against the baseline — drives the unsaved-changes
  // guard on close/Escape without needing a deep-equal library.
  useEffect(() => {
    const b = baselineRef.current;
    setDirty(title !== b.title || html !== b.html || css !== b.css || js !== b.js || maxViews !== b.maxViews);
  }, [title, html, css, js, maxViews]);

  useEffect(() => {
    if (!user) return;
    loadSurprises();
  }, [user]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === "code-surprise-error" && event.data?.message) {
        toast({ title: "Preview error", description: event.data.message, variant: "destructive" });
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [toast]);

  // Close guard: unsaved edits get a confirm step instead of silently
  // vanishing. Escape mirrors the visible close button rather than a
  // separate, easy-to-miss keyboard-only behavior.
  const requestCloseEditor = useCallback(() => {
    if (dirty) { hapticWarning(); setConfirmClose(true); return; }
    setShowEditor(false);
  }, [dirty]);

  const discardAndClose = () => {
    setConfirmClose(false);
    setShowEditor(false);
  };

  // ESC: focus mode exits focus mode first (content stays); otherwise it's
  // the same "close editor" path as the X button, unsaved-changes guard
  // included. Cmd/Ctrl+S saves from anywhere in the editor without reaching
  // for the mouse — the efficiency the brief asks for over visual polish.
  // Listener is attached once per editor session (not per keystroke) —
  // saveSurpriseRef always points at the latest save closure instead.
  const saveSurpriseRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!showEditor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (editorFullscreen) setEditorFullscreen(false);
        else requestCloseEditor();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveSurpriseRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showEditor, editorFullscreen, requestCloseEditor]);


  const loadSurprises = async () => {
    if (!user) return;
    const { data, error } = await supabase
      .from("code_surprises")
      .select("id,creator_id,title,html_content,css_content,js_content,is_active,max_views,views_used,created_at")
      .eq("creator_id", user.id)
      .order("created_at", { ascending: false }) as any;
    if (error) {
      toast({ title: "Couldn't load surprises", description: error.message, variant: "destructive" });
      return;
    }
    if (data) setSurprises(data);
  };

  const applyPreset = (presetId: string) => {
    const preset = surprisePresets.find((item) => item.id === presetId);
    if (!preset) return;
    hapticSelection();
    setEditing(null);
    setTitle(preset.title);
    setHtml(preset.html_content);
    setCss(preset.css_content);
    setJs(preset.js_content);
    setMaxViews(preset.max_views);
  };

  const startNew = () => {
    setEditing(null);
    const preset = surprisePresets.find((p) => p.id === defaultSurprisePreset.id) ?? defaultSurprisePreset;
    setTitle(preset.title);
    setHtml(preset.html_content);
    setCss(preset.css_content);
    setJs(preset.js_content);
    setMaxViews(preset.max_views);
    baselineRef.current = { title: preset.title, html: preset.html_content, css: preset.css_content, js: preset.js_content, maxViews: preset.max_views };
    setDirty(false);
    setShowEditor(true);
  };

  const editSurprise = (s: Surprise) => {
    setEditing(s);
    setTitle(s.title);
    setHtml(s.html_content);
    setCss(s.css_content);
    setJs(s.js_content);
    setMaxViews(s.max_views);
    baselineRef.current = { title: s.title, html: s.html_content, css: s.css_content, js: s.js_content, maxViews: s.max_views };
    setDirty(false);
    setShowEditor(true);
  };

  const handleFileUpload = (setter: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setter(reader.result as string);
      toast({ title: `${file.name} loaded` });
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const saveSurprise = async () => {
    if (!user) return;

    const payload = {
      creator_id: user.id,
      title,
      html_content: html,
      css_content: css,
      js_content: js,
      max_views: maxViews,
      views_used: 0,
      is_active: true,
    };

    const { error } = editing
      ? await supabase.from("code_surprises").update(payload as any).eq("id", editing.id)
      : await supabase.from("code_surprises").insert(payload as any);

    if (error) {
      hapticWarning();
      toast({ title: "Couldn't save surprise", description: error.message, variant: "destructive" });
      return;
    }

    hapticSuccess();
    baselineRef.current = { title, html, css, js, maxViews };
    setDirty(false);
    toast({
      title: editing ? "Updated" : "Surprise created!",
      description: partnerId ? "Ready to show on your partner's app." : "Connect your partner to deliver it live.",
    });
    setShowEditor(false);
    loadSurprises();
  };
  useEffect(() => { saveSurpriseRef.current = () => { void saveSurprise(); }; });

  const requestDelete = (id: string) => {
    hapticWarning();
    setPendingDeleteId(id);
  };

  const confirmDelete = async () => {
    if (!pendingDeleteId) return;
    const id = pendingDeleteId;
    setPendingDeleteId(null);
    hapticWarning();
    const { error } = await supabase.from("code_surprises").delete().eq("id", id);
    if (error) {
      toast({ title: "Couldn't delete surprise", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: "Deleted" });
    loadSurprises();
  };

  const toggleActive = async (s: Surprise) => {
    const { error } = await supabase.from("code_surprises").update({ is_active: !s.is_active } as any).eq("id", s.id);
    if (error) {
      toast({ title: "Couldn't update surprise", description: error.message, variant: "destructive" });
      return;
    }
    loadSurprises();
  };

  const runPreview = () => {
    setShowPreview(true);
  };

  // Tab inserts real indentation instead of jumping focus — the single
  // biggest everyday friction point in a plain <textarea> "code editor".
  // Shift+Tab is left alone (default browser behavior) so keyboard users
  // still have a way to tab backward out of the field.
  const handleTabIndent = (setter: (v: string) => void) => (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab" || e.shiftKey) return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart, selectionEnd, value } = el;
    const next = value.slice(0, selectionStart) + "  " + value.slice(selectionEnd);
    setter(next);
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = selectionStart + 2;
    });
  };

  return (
    <section>
      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2.5">Code Surprises</p>
      <div className="bg-card rounded-2xl border border-border/60 p-3 mb-2.5">
        <p className="text-sm font-medium">Full-screen partner surprises</p>
        <p className="text-[11px] text-muted-foreground mt-1">
          Use presets, write custom code, or upload HTML/CSS/JS files. JS is optional.
          {partnerId ? " Your partner will receive active surprises." : " Connect your partner first."}
        </p>
      </div>
      <div className="space-y-2">
        {surprises.map(s => (
          <div key={s.id} className="bg-card rounded-2xl border border-border/60 p-3 flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-accent/50 flex items-center justify-center">
              <Code2 className="h-4 w-4 text-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{s.title}</p>
              <p className="text-[10px] text-muted-foreground">{s.views_used}/{s.max_views} views • {s.is_active ? "Active" : "Paused"}</p>
            </div>
            <div className="flex gap-1.5">
              <button onClick={() => toggleActive(s)} aria-label={s.is_active ? "Deactivate surprise" : "Activate surprise"} className={`h-9 w-9 rounded-full flex items-center justify-center ${s.is_active ? "bg-primary/10" : "bg-muted"}`}>
                <Eye className={`h-3 w-3 ${s.is_active ? "text-primary" : "text-muted-foreground"}`} aria-hidden="true" />
              </button>
              <button onClick={() => editSurprise(s)} aria-label="Edit surprise" className="h-9 w-9 rounded-full bg-muted flex items-center justify-center">
                <Code2 className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
              </button>
              <button onClick={() => requestDelete(s.id)} aria-label="Delete surprise" className="h-9 w-9 rounded-full bg-destructive/10 flex items-center justify-center">
                <X className="h-3 w-3 text-destructive" aria-hidden="true" />
              </button>
            </div>
          </div>
        ))}
        <button onClick={startNew}
          className="w-full bg-card rounded-2xl border border-dashed border-border/60 p-3 flex items-center justify-center gap-2 text-sm text-muted-foreground active:scale-[0.98] transition-transform">
          <Plus className="h-4 w-4" /> New Surprise
        </button>
      </div>

      <AlertDialog open={!!pendingDeleteId} onOpenChange={(open) => { if (!open) setPendingDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this surprise?</AlertDialogTitle>
            <AlertDialogDescription>
              This can't be undone. If it's currently active for your partner, they'll no longer be able to open it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> Discard changes?
            </AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved edits to this surprise. Closing now will lose them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={discardAndClose} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Hidden file inputs */}
      <input ref={htmlFileRef} type="file" accept=".html,.htm" className="hidden" onChange={handleFileUpload(setHtml)} />
      <input ref={cssFileRef} type="file" accept=".css" className="hidden" onChange={handleFileUpload(setCss)} />
      <input ref={jsFileRef} type="file" accept=".js" className="hidden" onChange={handleFileUpload(setJs)} />

      {/* Editor modal */}
      <AnimatePresence>
        {showEditor && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[80] bg-background flex flex-col"
          >
            <div className="safe-top px-4 pt-3 pb-2 flex items-center justify-between border-b border-border/30">
              <button onClick={requestCloseEditor} aria-label="Close editor" className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
                <X className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              </button>
              <Input value={title} onChange={(e) => setTitle(e.target.value)}
                className="mx-3 h-8 rounded-full text-sm text-center flex-1" placeholder="Title" />
              <div className="flex gap-1.5">
                <button
                  onClick={() => { setEditorFullscreen((v) => !v); }}
                  aria-label={editorFullscreen ? "Exit focus mode" : "Focus editor"}
                  className="h-8 w-8 rounded-full bg-muted flex items-center justify-center"
                >
                  {editorFullscreen ? <Minimize2 className="h-3.5 w-3.5 text-muted-foreground" /> : <Maximize2 className="h-3.5 w-3.5 text-muted-foreground" />}
                </button>
                <button onClick={runPreview} className="h-8 px-3 rounded-full bg-accent/60 flex items-center justify-center gap-1 text-xs font-medium text-foreground">
                  <Play className="h-3.5 w-3.5" /> Test
                </button>
                <button onClick={saveSurprise} aria-label={dirty ? "Save (unsaved changes) — Ctrl/Cmd+S" : "Save"} className="relative h-8 px-3 rounded-full bg-primary text-primary-foreground flex items-center gap-1 text-xs font-medium">
                  <Save className="h-3 w-3" /> Save
                  {dirty && <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-amber-400" aria-hidden="true" />}
                </button>
              </div>
            </div>

            {/* Presets — hidden in focus mode */}
            <div className={`px-4 py-3 border-b border-border/20 space-y-2 ${editorFullscreen ? "hidden" : ""}`}>
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                <Wand2 className="h-3.5 w-3.5" /> Presets
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {surprisePresets.map((preset) => (
                  <button
                    key={preset.id}
                    onClick={() => applyPreset(preset.id)}
                    className="shrink-0 flex items-center gap-1 rounded-full border border-border/50 bg-muted/40 px-3 py-1.5 text-[11px] font-medium text-foreground active:scale-95 transition-transform"
                  >
                    {("reactive" in preset && (preset as any).reactive) && (
                      <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
                    )}
                    {preset.title}
                  </button>
                ))}
              </div>
            </div>

            {/* Max views — hidden in focus mode */}
            <div className={`flex items-center gap-2 px-4 py-2 border-b border-border/20 ${editorFullscreen ? "hidden" : ""}`}>
              <span className="text-[10px] text-muted-foreground">Max views:</span>
              {[1, 3, 5, 10, 999].map(n => (
                <button key={n} onClick={() => { setMaxViews(n); }}
                  className={`h-6 px-2 rounded-full text-[10px] font-medium ${maxViews === n ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                  {n === 999 ? "∞" : n}
                </button>
              ))}
            </div>

            <Tabs defaultValue="html" className="flex-1 flex flex-col min-h-0">
              <span id="editor-tab-hint" className="sr-only">
                Tab inserts two spaces of indentation. Press Shift+Tab to move focus to the previous control instead.
              </span>
              <TabsList className={`mx-3 sm:mx-5 mt-2 bg-muted/50 rounded-xl ${editorFullscreen ? "h-10" : "h-9"}`}>
                <TabsTrigger value="html" className="text-[11px] flex-1 gap-1"><Code2 className="h-3 w-3" />HTML</TabsTrigger>
                <TabsTrigger value="css" className="text-[11px] flex-1 gap-1"><Palette className="h-3 w-3" />CSS</TabsTrigger>
                <TabsTrigger value="js" className="text-[11px] flex-1 gap-1"><Braces className="h-3 w-3" />JS (optional)</TabsTrigger>
              </TabsList>
              <TabsContent value="html" className="flex-1 px-2 sm:px-5 pb-2 sm:pb-5 mt-2 min-h-0 flex flex-col gap-2 data-[state=inactive]:hidden">
                <div className="flex justify-end">
                  <button onClick={() => htmlFileRef.current?.click()} className="flex items-center gap-1 text-[10px] text-muted-foreground bg-muted/40 rounded-full px-2.5 py-1">
                    <Upload className="h-3 w-3" /> Upload .html
                  </button>
                </div>
                <textarea value={html} onChange={(e) => setHtml(e.target.value)} onKeyDown={handleTabIndent(setHtml)}
                  className="w-full flex-1 min-h-[62vh] sm:min-h-[68vh] rounded-xl bg-card border border-border/30 p-4 text-[13px] leading-6 font-mono resize-none outline-none focus:ring-1 focus:ring-primary/30"
                  style={{ paddingBottom: "max(env(safe-area-inset-bottom), 16px)" }}
                  placeholder="<div>Your HTML here</div>" spellCheck={false} autoCorrect="off" autoCapitalize="off"
                  aria-label="HTML source" aria-describedby="editor-tab-hint" />
              </TabsContent>
              <TabsContent value="css" className="flex-1 px-2 sm:px-5 pb-2 sm:pb-5 mt-2 min-h-0 flex flex-col gap-2 data-[state=inactive]:hidden">
                <div className="flex justify-end">
                  <button onClick={() => cssFileRef.current?.click()} className="flex items-center gap-1 text-[10px] text-muted-foreground bg-muted/40 rounded-full px-2.5 py-1">
                    <Upload className="h-3 w-3" /> Upload .css
                  </button>
                </div>
                <textarea value={css} onChange={(e) => setCss(e.target.value)} onKeyDown={handleTabIndent(setCss)}
                  className="w-full flex-1 min-h-[62vh] sm:min-h-[68vh] rounded-xl bg-card border border-border/30 p-4 text-[13px] leading-6 font-mono resize-none outline-none focus:ring-1 focus:ring-primary/30"
                  style={{ paddingBottom: "max(env(safe-area-inset-bottom), 16px)" }}
                  placeholder="body { ... }" spellCheck={false} autoCorrect="off" autoCapitalize="off"
                  aria-label="CSS source" aria-describedby="editor-tab-hint" />
              </TabsContent>
              <TabsContent value="js" className="flex-1 px-2 sm:px-5 pb-2 sm:pb-5 mt-2 min-h-0 flex flex-col gap-2 data-[state=inactive]:hidden">
                <div className="flex justify-end gap-2">
                  <button onClick={() => { setJs(""); toast({ title: "JS cleared — surprise will work with HTML+CSS only" }); }}
                    className="flex items-center gap-1 text-[10px] text-muted-foreground bg-muted/40 rounded-full px-2.5 py-1">
                    <X className="h-3 w-3" /> Clear JS
                  </button>
                  <button onClick={() => jsFileRef.current?.click()} className="flex items-center gap-1 text-[10px] text-muted-foreground bg-muted/40 rounded-full px-2.5 py-1">
                    <Upload className="h-3 w-3" /> Upload .js
                  </button>
                </div>
                <textarea value={js} onChange={(e) => setJs(e.target.value)} onKeyDown={handleTabIndent(setJs)}
                  className="w-full flex-1 min-h-[62vh] sm:min-h-[68vh] rounded-xl bg-card border border-border/30 p-4 text-[13px] leading-6 font-mono resize-none outline-none focus:ring-1 focus:ring-primary/30"
                  style={{ paddingBottom: "max(env(safe-area-inset-bottom), 16px)" }}
                  placeholder="// Optional — leave empty if not needed" spellCheck={false} autoCorrect="off" autoCapitalize="off"
                  aria-label="JavaScript source" aria-describedby="editor-tab-hint" />
              </TabsContent>
            </Tabs>

            {/* Preview overlay */}
            <AnimatePresence>
              {showPreview && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  className="absolute inset-0 z-10 bg-background flex flex-col">
                  <div className="safe-top px-4 pt-3 pb-2 flex items-center justify-between">
                    <p className="text-sm font-medium">Preview</p>
                    <button onClick={() => setShowPreview(false)} aria-label="Close preview" className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
                      <X className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    </button>
                  </div>
                  <div className="flex-1 p-4">
                    <CodeSurpriseFrame documentHtml={previewDocument} title={`${title} preview`} />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
};

export default CodeSurpriseEditor;
