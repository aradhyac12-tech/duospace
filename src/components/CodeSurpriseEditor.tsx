import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Play, Code2, Eye, Palette, Braces, Save, Plus, Wand2, Upload, Maximize2, Minimize2, AlertTriangle, Loader2, FileArchive, Library as LibraryIcon, Database } from "lucide-react";
import { supabase } from "@/integrations/supabase/appClient";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { hapticWarning, hapticSuccess, hapticSelection } from "@/lib/haptics";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import CodeSurpriseFrame from "@/components/CodeSurpriseFrame";
import { buildSurpriseDocument, defaultSurprisePreset, surprisePresets } from "@/lib/codeSurprises";
import { SURPRISE_LIMITS, findUnresolvedLocalRefs } from "@/lib/surpriseDocument";
import { importSurpriseFiles, summarizeImport, ImportError, type ImportReport } from "@/lib/surpriseImport";
import { collapseAssets, expandAssets, orphanedTokens, type AssetTable } from "@/lib/surpriseAssets";
import { saveToLibrary, surpriseChars, type LibrarySourceType, type LibraryItemFull } from "@/lib/surpriseLibrary";
import SurpriseLibraryPanel from "@/components/surprise/SurpriseLibraryPanel";
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
  // Import / library state. `assetsRef` holds the real bytes behind the
  // short `ds-asset://aN` tokens the text areas show (see surpriseAssets.ts);
  // everything leaving the editor is expanded through it first.
  const assetsRef = useRef<AssetTable>({});
  const sourceRef = useRef<{ type: LibrarySourceType; name: string | null; assets: number }>({ type: "manual", name: null, assets: 0 });
  const importFileRef = useRef<HTMLInputElement>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importReport, setImportReport] = useState<ImportReport | null>(null);
  const [saveUploads, setSaveUploads] = useState(true);
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const [libraryRefresh, setLibraryRefresh] = useState(0);
  const [librarySaving, setLibrarySaving] = useState(false);
  const [unresolvedRefs, setUnresolvedRefs] = useState<string[]>([]);
  // Replacing the editor's contents (import / library "Use") while there are
  // unsaved edits asks first — same guard philosophy as close/discard.
  const [pendingReplace, setPendingReplace] = useState<(() => void) | null>(null);
  const htmlFileRef = useRef<HTMLInputElement>(null);
  const cssFileRef = useRef<HTMLInputElement>(null);
  const jsFileRef = useRef<HTMLInputElement>(null);
  // Snapshot of what's on the server (or the preset) at the moment the
  // editor opened — everything else compares against this to know whether
  // there's anything worth warning about before a close/discard.
  const baselineRef = useRef({ title, html, css, js, maxViews });

  // Built only while the preview is open — with imported media the strings
  // can be MBs, and this used to be rebuilt on every keystroke.
  const previewDocument = useMemo(() => {
    if (!showPreview) return "";
    const full = expandAssets({ html, css, js }, assetsRef.current);
    return buildSurpriseDocument({
      title,
      html_content: full.html,
      css_content: full.css,
      js_content: full.js,
      max_views: maxViews,
    });
  }, [showPreview, css, html, js, maxViews, title]);

  // "Files this code points at that will never load" lint — debounced so
  // typing in a big document isn't re-scanned per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setUnresolvedRefs(findUnresolvedLocalRefs({ html, css, js })), 400);
    return () => clearTimeout(t);
  }, [html, css, js]);

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

  // Runtime errors now arrive through CodeSurpriseFrame (which verifies the
  // message really came from ITS iframe) instead of a global window listener
  // that would toast anything any window posted.
  const handlePreviewError = useCallback((message: string) => {
    toast({ title: "Preview error", description: message, variant: "destructive" });
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

  const resetImportContext = () => {
    assetsRef.current = {};
    sourceRef.current = { type: "manual", name: null, assets: 0 };
    setImportReport(null);
    setLibraryId(null);
  };

  /** Put code in the three fields, folding big data: URIs into tokens. */
  const loadIntoEditor = (parts: { html: string; css: string; js: string }) => {
    const c = collapseAssets(parts);
    assetsRef.current = c.table;
    setHtml(c.html);
    setCss(c.css);
    setJs(c.js);
    return c;
  };

  const guardReplace = (action: () => void) => {
    if (dirty) { hapticWarning(); setPendingReplace(() => action); return; }
    action();
  };

  const runImport = async (files: File[]) => {
    if (!user) return;
    setImportBusy(true);
    try {
      const r = await importSurpriseFiles(files);
      loadIntoEditor({ html: r.html, css: r.css, js: r.js });
      // Take the page's own <title> / file name unless the person already
      // named this one something of their own.
      const untouchedTitle = !title.trim() || surprisePresets.some((p) => p.title === title);
      const nextTitle = untouchedTitle && r.title ? r.title.slice(0, 200) : title;
      if (nextTitle !== title) setTitle(nextTitle);
      setImportReport(r.report);

      const ext = files[0].name.split(".").pop()?.toLowerCase() ?? "";
      const sourceType: LibrarySourceType =
        r.report.source === "zip" ? "zip"
        : files.length === 1 && (ext === "html" || ext === "htm") ? "html"
        : files.length === 1 && ext === "css" ? "css"
        : files.length === 1 && ext === "js" ? "js"
        : "files";
      sourceRef.current = { type: sourceType, name: r.report.sourceName, assets: r.report.inlined.length };
      setLibraryId(null);
      hapticSuccess();
      toast({ title: "Imported", description: summarizeImport(r.report) });

      if (saveUploads) {
        try {
          const id = await saveToLibrary(user.id, {
            title: nextTitle, html: r.html, css: r.css, js: r.js,
            sourceType, sourceName: r.report.sourceName, assetCount: r.report.inlined.length,
          });
          setLibraryId(id);
          setLibraryRefresh((n) => n + 1);
          toast({ title: "Saved to your library", description: "Private — only you can see it." });
        } catch (err) {
          toast({
            title: "Imported, but couldn't save to your library",
            description: err instanceof Error ? err.message : undefined,
            variant: "destructive",
          });
        }
      }
    } catch (err) {
      hapticWarning();
      toast({
        title: "Couldn't import",
        description: err instanceof ImportError ? err.message : "Something went wrong reading those files.",
        variant: "destructive",
      });
    } finally {
      setImportBusy(false);
    }
  };

  const handleImportPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files: File[] = Array.from((e.target.files ?? []) as ArrayLike<File>);
    e.target.value = "";
    if (!files.length) return;
    guardReplace(() => { void runImport(files); });
  };

  const saveCurrentToLibrary = async () => {
    if (!user || librarySaving) return;
    hapticSelection();
    setLibrarySaving(true);
    try {
      const full = expandAssets({ html, css, js }, assetsRef.current);
      const id = await saveToLibrary(user.id, {
        title, ...full,
        sourceType: sourceRef.current.type,
        sourceName: sourceRef.current.name,
        assetCount: sourceRef.current.assets,
      }, libraryId);
      const wasUpdate = !!libraryId;
      setLibraryId(id);
      setLibraryRefresh((n) => n + 1);
      hapticSuccess();
      toast({ title: wasUpdate ? "Library copy updated" : "Saved to your library", description: "Private — not sent to your partner." });
    } catch (err) {
      hapticWarning();
      toast({ title: "Couldn't save to library", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setLibrarySaving(false);
    }
  };

  const useLibraryItem = (item: LibraryItemFull) => {
    guardReplace(() => {
      loadIntoEditor({ html: item.html_content, css: item.css_content, js: item.js_content });
      setTitle(item.title);
      setLibraryId(item.id);
      sourceRef.current = { type: item.source_type, name: item.source_name, assets: item.asset_count };
      setImportReport(null);
      setShowLibrary(false);
      hapticSuccess();
      toast({ title: "Loaded from library", description: item.title });
    });
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
    resetImportContext();
  };

  const startNew = () => {
    setEditing(null);
    resetImportContext();
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
    resetImportContext();
    // Saved surprises can carry embedded media — fold it into short tokens
    // for editing (expanded again on save).
    const c = loadIntoEditor({ html: s.html_content, css: s.css_content, js: s.js_content });
    setTitle(s.title);
    setMaxViews(s.max_views);
    baselineRef.current = { title: s.title, html: c.html, css: c.css, js: c.js, maxViews: s.max_views };
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

    // Tokens back to real data: URIs — what is stored and delivered is the
    // full self-contained code.
    const full = expandAssets({ html, css, js }, assetsRef.current);
    if (orphanedTokens({ html, css, js }, assetsRef.current).length) {
      hapticWarning();
      toast({
        title: "A media placeholder has no file behind it",
        description: "Some ds-asset:// references were pasted in without their file. Re-import the zip, or remove them.",
        variant: "destructive",
      });
      return;
    }
    if (surpriseChars(full) > SURPRISE_LIMITS.maxSurpriseChars) {
      hapticWarning();
      toast({
        title: "This surprise is too large to send",
        description: "Remove some embedded images/audio, or use smaller files, then save again.",
        variant: "destructive",
      });
      return;
    }

    const payload = {
      creator_id: user.id,
      title,
      html_content: full.html,
      css_content: full.css,
      js_content: full.js,
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
          Use presets, write custom code, or import a .zip / HTML, CSS and JS files. JS is optional.
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

      <AlertDialog open={!!pendingReplace} onOpenChange={(open) => { if (!open) setPendingReplace(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-warning" /> Replace what's in the editor?
            </AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved edits. Loading this will replace the HTML, CSS and JS currently in the editor.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { const act = pendingReplace; setPendingReplace(null); act?.(); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Hidden file inputs */}
      <input ref={htmlFileRef} type="file" accept=".html,.htm" className="hidden" onChange={handleFileUpload(setHtml)} />
      <input ref={cssFileRef} type="file" accept=".css" className="hidden" onChange={handleFileUpload(setCss)} />
      <input ref={jsFileRef} type="file" accept=".js" className="hidden" onChange={handleFileUpload(setJs)} />
      {/* One picker for the whole import: a single .zip, or any mix of
          .html/.css/.js (plus images/audio the page refers to by name). */}
      <input
        ref={importFileRef}
        type="file"
        multiple
        accept=".zip,application/zip,.html,.htm,.css,.js,.json,image/*,audio/*,video/*,.woff,.woff2,.ttf,.otf"
        className="hidden"
        onChange={handleImportPick}
      />

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

            {/* Import + library — hidden in focus mode */}
            <div className={`px-4 py-3 border-b border-border/20 space-y-2 ${editorFullscreen ? "hidden" : ""}`}>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => { hapticSelection(); importFileRef.current?.click(); }}
                  disabled={importBusy}
                  className="h-10 px-3 rounded-full bg-accent/60 flex items-center gap-1.5 text-xs font-medium text-foreground disabled:opacity-60 active:scale-95 transition-transform"
                >
                  {importBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <FileArchive className="h-3.5 w-3.5" aria-hidden="true" />}
                  {importBusy ? "Importing…" : "Import zip / files"}
                </button>
                <button
                  onClick={() => { hapticSelection(); setShowLibrary(true); }}
                  className="h-10 px-3 rounded-full bg-muted/60 flex items-center gap-1.5 text-xs font-medium text-foreground active:scale-95 transition-transform"
                >
                  <LibraryIcon className="h-3.5 w-3.5" aria-hidden="true" /> Library
                </button>
                <button
                  onClick={saveCurrentToLibrary}
                  disabled={librarySaving}
                  className="h-10 px-3 rounded-full bg-muted/60 flex items-center gap-1.5 text-xs font-medium text-foreground disabled:opacity-60 active:scale-95 transition-transform"
                >
                  {librarySaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Database className="h-3.5 w-3.5" aria-hidden="true" />}
                  {libraryId ? "Update library copy" : "Save to library"}
                </button>
              </div>

              <label className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                <span>Save uploads to my library <span className="opacity-70">(private — not sent to your partner)</span></span>
                <Switch checked={saveUploads} onCheckedChange={(v) => { hapticSelection(); setSaveUploads(v); }} aria-label="Save uploads to my library" />
              </label>

              {importReport && (
                <details className="rounded-xl bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
                  <summary className="cursor-pointer text-foreground font-medium">
                    Imported {importReport.sourceName} — {summarizeImport(importReport)}
                  </summary>
                  <div className="mt-2 space-y-1.5">
                    {importReport.inlined.length > 0 && (
                      <p>
                        Embedded: {importReport.inlined.slice(0, 6).map((f) => f.path).join(", ")}
                        {importReport.inlined.length > 6 ? ` +${importReport.inlined.length - 6} more` : ""}
                      </p>
                    )}
                    {importReport.skipped.length > 0 && (
                      <p className="text-warning">
                        Not embedded: {importReport.skipped.slice(0, 5).map((f) => `${f.path} (${f.reason})`).join("; ")}
                        {importReport.skipped.length > 5 ? ` +${importReport.skipped.length - 5} more` : ""}
                      </p>
                    )}
                    {importReport.warnings.map((w, i) => (
                      <p key={i} className="text-warning">{w}</p>
                    ))}
                    {importReport.jsFiles.length === 0 && js === "" && <p>No JavaScript in this upload — the JS tab is empty.</p>}
                  </div>
                </details>
              )}

              {unresolvedRefs.length > 0 && (
                <div role="status" className="flex gap-2 rounded-xl bg-warning/10 px-3 py-2 text-[11px] text-foreground">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-warning" aria-hidden="true" />
                  <p>
                    These files are referenced but not included, so they won't load: {unresolvedRefs.slice(0, 4).join(", ")}
                    {unresolvedRefs.length > 4 ? ` +${unresolvedRefs.length - 4} more` : ""}. Import a .zip that contains them, or use full https:// links.
                  </p>
                </div>
              )}
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

            {/* Library overlay */}
            <AnimatePresence>
              {showLibrary && (
                <SurpriseLibraryPanel
                  onClose={() => setShowLibrary(false)}
                  onUse={useLibraryItem}
                  activeId={libraryId}
                  refreshKey={libraryRefresh}
                />
              )}
            </AnimatePresence>

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
                    <CodeSurpriseFrame documentHtml={previewDocument} title={`${title} preview`} onRuntimeError={handlePreviewError} />
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
