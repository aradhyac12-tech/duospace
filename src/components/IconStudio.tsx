import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";
import { hapticLight, hapticMedium, hapticWarning } from "@/lib/haptics";
import {
  Search, Download, Upload, Sparkles, Wand2, Circle, Square, Hexagon, RectangleHorizontal,
  Type, ImageIcon, ChevronDown, Plus, Check,
} from "lucide-react";
import { safeLucideIcon } from "@/lib/safeIcon";
import {
  ICON_CATEGORIES, IconPreset, IconShape, IconBgType,
  searchPresets, generateFromAppName,
} from "@/lib/iconPresets";
import { IconConfig, paintPreview, generateIconAssetZip, downloadBlob, renderDataUrl } from "@/lib/iconGenerator";
import {
  WhiteLabelApp, listApps, getCurrentApp, setCurrentAppId, createApp, isValidPackageId,
} from "@/lib/whitelabelApps";
import { getAppIconConfig, setAppIconConfig, markAppIconExported } from "@/lib/appIconConfig";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** fallback app name (used for "Generate From App Name" if no white-label app has one yet) */
  appName?: string;
  /** called with a data URL once the user applies an icon for THIS device's in-app display */
  onApply?: (dataUrl: string) => void;
}

type View = "gallery" | "customize";

const SHAPES: { id: IconShape; label: string; icon: typeof Circle }[] = [
  { id: "squircle", label: "Squircle", icon: Hexagon },
  { id: "rounded", label: "Rounded", icon: RectangleHorizontal },
  { id: "circle", label: "Circle", icon: Circle },
  { id: "square", label: "Square", icon: Square },
];

const DEFAULT_CFG: IconConfig = {
  shape: "squircle",
  bgType: "gradient",
  color1: "#7C3AED",
  color2: "#4F46E5",
  fg: "#FFFFFF",
  symbol: "Sparkles",
  letter: "A",
  useLetter: false,
  border: false,
  borderColor: "#000000",
  borderWidth: 10,
  shadow: true,
  uploadedImage: null,
};

const MAX_UPLOAD_DIM = 2048;

/** Downscales a huge uploaded photo before it's stored — an 8MP+ photo as a raw
 *  data URL would bloat the per-app config; 2048px is plenty for a 1024 master icon. */
async function downscaleImage(dataUrl: string, maxDim: number): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = reject;
    el.src = dataUrl;
  });
  if (img.width <= maxDim && img.height <= maxDim) return dataUrl;
  const scale = maxDim / Math.max(img.width, img.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

const IconStudio = ({ open, onOpenChange, appName, onApply }: Props) => {
  const { toast } = useToast();
  const [view, setView] = useState<View>("gallery");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("All");
  const [cfg, setCfg] = useState<IconConfig>(DEFAULT_CFG);
  const [presetId, setPresetId] = useState<string | null>(null);
  const [darkPreview, setDarkPreview] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [lastExportedAt, setLastExportedAt] = useState<number | null>(null);

  // --- white-label app selection ---
  const [apps, setApps] = useState<WhiteLabelApp[]>(() => listApps());
  const [currentApp, setCurrentAppState] = useState<WhiteLabelApp>(() => getCurrentApp());
  const [showAppPicker, setShowAppPicker] = useState(false);
  const [showNewApp, setShowNewApp] = useState(false);
  const [newAppName, setNewAppName] = useState("");
  const [newAppPackageId, setNewAppPackageId] = useState("");

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const renderGenRef = useRef(0);

  const results = useMemo(() => searchPresets(query, category), [query, category]);

  // Load the current app's saved icon config whenever the dialog opens or the
  // selected app changes — this is what makes the icon belong to the app,
  // not a single global setting.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingConfig(true);
    (async () => {
      const saved = await getAppIconConfig(currentApp.id);
      if (cancelled) return;
      if (saved) {
        setCfg(saved.config);
        setPresetId(saved.presetId);
        setLastExportedAt(saved.lastExportedAt);
        setView("customize");
      } else {
        setCfg({ ...DEFAULT_CFG, letter: (currentApp.name || appName || "A").slice(0, 1).toUpperCase() });
        setPresetId(null);
        setLastExportedAt(null);
        setView("gallery");
      }
      setLoadingConfig(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentApp.id]);

  // Persist to this app's config on every change — skipped while we're still
  // loading a freshly-selected app's saved config so we don't immediately
  // overwrite it with the previous app's in-memory state.
  useEffect(() => {
    if (!open || loadingConfig) return;
    setAppIconConfig(currentApp.id, presetId, cfg).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg, presetId, open, loadingConfig, currentApp.id]);

  // Race-safe preview: ignore a render that resolves after a newer one started.
  useEffect(() => {
    if (view !== "customize" || !canvasRef.current) return;
    const gen = ++renderGenRef.current;
    const el = canvasRef.current;
    paintPreview(el, cfg, 256, () => renderGenRef.current !== gen).catch(() => {});
  }, [cfg, view]);

  const switchApp = (app: WhiteLabelApp) => {
    hapticLight();
    setCurrentAppId(app.id);
    setCurrentAppState(app);
    setShowAppPicker(false);
  };

  const submitNewApp = () => {
    if (!newAppName.trim() || !isValidPackageId(newAppPackageId)) {
      toast({ title: "Check the details", description: "Name and a valid reverse-DNS package id (e.g. com.brand.app) are required.", variant: "destructive" });
      return;
    }
    const app = createApp({ name: newAppName.trim(), packageId: newAppPackageId.trim(), bundleId: newAppPackageId.trim() });
    setApps(listApps());
    setNewAppName("");
    setNewAppPackageId("");
    setShowNewApp(false);
    switchApp(app);
    toast({ title: "App added", description: `${app.name} now has its own icon configuration.` });
  };

  const openPreset = (p: IconPreset) => {
    hapticLight();
    setPresetId(p.id);
    setCfg(c => ({
      ...c,
      shape: p.shape, bgType: p.bgType, color1: p.color1, color2: p.color2,
      fg: p.fg, symbol: p.symbol, useLetter: false, uploadedImage: null,
    }));
    setView("customize");
  };

  const openCustomBlank = () => {
    hapticLight();
    setPresetId(null);
    setCfg(c => ({ ...c, uploadedImage: null }));
    setView("customize");
  };

  const openGenerateFromName = () => {
    hapticLight();
    const p = generateFromAppName(currentApp.name || appName || "App");
    setPresetId(null);
    setCfg(c => ({ ...c, shape: p.shape, bgType: p.bgType, color1: p.color1, color2: p.color2, fg: p.fg, symbol: p.symbol, useLetter: false, uploadedImage: null }));
    setView("customize");
  };

  const onUploadFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast({ title: "Not an image", description: "Pick a PNG, JPG, or similar image file.", variant: "destructive" });
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const downscaled = await downscaleImage(reader.result as string, MAX_UPLOAD_DIM);
        setPresetId(null);
        setCfg(c => ({ ...c, uploadedImage: downscaled }));
        setView("customize");
      } catch {
        toast({ title: "Couldn't read that image", variant: "destructive" });
      }
    };
    reader.onerror = () => toast({ title: "Couldn't read that image", variant: "destructive" });
    reader.readAsDataURL(file);
  };

  const applyInApp = async () => {
    hapticMedium();
    try {
      const dataUrl = await renderDataUrl(cfg, 512);
      onApply?.(dataUrl);
      toast({ title: "Icon applied", description: `Updated ${currentApp.name}'s in-app display icon on this device.` });
    } catch {
      hapticWarning();
      toast({ title: "Couldn't render icon", variant: "destructive" });
    }
  };

  const exportAssets = async () => {
    hapticMedium();
    setExporting(true);
    try {
      const blob = await generateIconAssetZip(cfg);
      downloadBlob(blob, `${currentApp.packageId || "app"}-icon-assets.zip`);
      await markAppIconExported(currentApp.id);
      setLastExportedAt(Date.now());
      toast({ title: "Icon assets exported", description: `Android + iOS sizes for ${currentApp.name}, ready to drop in.` });
    } catch (err) {
      hapticWarning();
      toast({ title: "Export failed", description: "Try again — see console for details.", variant: "destructive" });
      console.error(err);
    } finally {
      setExporting(false);
    }
  };

  const SymbolPreviewIcon = safeLucideIcon(cfg.symbol);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-3xl max-w-[440px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2.5">
            <span className="h-8 w-8 rounded-xl flex items-center justify-center bg-gradient-to-br from-primary/25 to-accent/40 border border-border/60">
              <Wand2 className="h-4 w-4" />
            </span>
            Icon Studio
          </DialogTitle>
          <DialogDescription>
            {view === "gallery" ? "Pick a starting point, then customize it" : "Fine-tune your icon"}
          </DialogDescription>
        </DialogHeader>

        {/* App selector — every icon config belongs to one app/project, not a global setting */}
        <div className="relative">
          <button
            onClick={() => { hapticLight(); setShowAppPicker(v => !v); }}
            className="w-full h-10 rounded-xl border border-border/60 bg-muted/30 px-3 flex items-center justify-between text-xs font-medium"
          >
            <span className="flex items-center gap-2 truncate">
              <span className="h-2 w-2 rounded-full bg-primary shrink-0" />
              <span className="truncate">Editing icon for <strong>{currentApp.name}</strong></span>
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
          {showAppPicker && (
            <div className="absolute z-20 mt-1 w-full rounded-xl border border-border/60 bg-popover shadow-lg overflow-hidden">
              {apps.map(a => (
                <button
                  key={a.id}
                  onClick={() => switchApp(a)}
                  className="w-full px-3 py-2 flex items-center justify-between text-xs hover:bg-muted/50"
                >
                  <span className="flex flex-col items-start truncate">
                    <span className="font-medium truncate">{a.name}</span>
                    <span className="text-[10px] text-muted-foreground truncate">{a.packageId}</span>
                  </span>
                  {a.id === currentApp.id && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                </button>
              ))}
              <button
                onClick={() => { setShowAppPicker(false); setShowNewApp(true); }}
                className="w-full px-3 py-2 flex items-center gap-2 text-xs text-primary border-t border-border/60"
              >
                <Plus className="h-3.5 w-3.5" /> Add another app
              </button>
            </div>
          )}
        </div>

        {showNewApp && (
          <div className="rounded-2xl border border-border/60 bg-card p-4 space-y-2.5">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wider">New white-label app</p>
            <Input value={newAppName} onChange={e => setNewAppName(e.target.value)} placeholder="App name (e.g. Acme Couples)" className="h-9 rounded-xl text-sm" />
            <Input value={newAppPackageId} onChange={e => setNewAppPackageId(e.target.value)} placeholder="Package id (e.g. com.acme.couples)" className="h-9 rounded-xl text-sm" />
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setShowNewApp(false)} className="flex-1 h-9 rounded-xl text-xs">Cancel</Button>
              <Button onClick={submitNewApp} className="flex-1 h-9 rounded-xl text-xs">Create</Button>
            </div>
          </div>
        )}

        {/* Hidden file input — mounted unconditionally so BOTH the gallery's
            "Upload Icon" tile AND the customize view's "Replace image" button
            can trigger it. (Previously this was only rendered inside the
            gallery view's JSX, so "Replace image" silently did nothing.) */}
        <input ref={uploadInputRef} type="file" accept="image/*" className="hidden" onChange={onUploadFile} />

        {view === "gallery" && (
          <div className="space-y-4 pt-1">
            {/* Quick actions — the three required workflows */}
            <div className="grid grid-cols-3 gap-2">
              <button onClick={openCustomBlank} className="rounded-2xl border border-border/60 bg-card p-3 flex flex-col items-center gap-1.5 active:scale-[0.97] transition-transform">
                <Sparkles className="h-4 w-4 text-primary" />
                <span className="text-[10px] font-medium text-center leading-tight">Create Custom Icon</span>
              </button>
              <button onClick={() => uploadInputRef.current?.click()} className="rounded-2xl border border-border/60 bg-card p-3 flex flex-col items-center gap-1.5 active:scale-[0.97] transition-transform">
                <Upload className="h-4 w-4 text-primary" />
                <span className="text-[10px] font-medium text-center leading-tight">Upload Icon</span>
              </button>
              <button onClick={openGenerateFromName} className="rounded-2xl border border-border/60 bg-card p-3 flex flex-col items-center gap-1.5 active:scale-[0.97] transition-transform">
                <Type className="h-4 w-4 text-primary" />
                <span className="text-[10px] font-medium text-center leading-tight">Generate From App Name</span>
              </button>
            </div>

            {/* Search */}
            <div className="relative">
              <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search app types — video, chat, calculator…"
                className="h-9 rounded-xl pl-8 text-sm"
              />
            </div>

            {/* Category chips */}
            <div data-swipe-nav-ignore className="flex gap-1.5 overflow-x-auto pb-1">
              {(["All", ...ICON_CATEGORIES] as string[]).map(c => (
                <button
                  key={c}
                  onClick={() => { hapticLight(); setCategory(c); }}
                  className={cn(
                    "h-7 px-3 rounded-full text-[11px] font-medium whitespace-nowrap border transition-colors",
                    category === c ? "bg-primary text-primary-foreground border-primary" : "bg-muted/40 text-muted-foreground border-border/60"
                  )}
                >{c}</button>
              ))}
            </div>

            {/* Preset grid */}
            <div className="grid grid-cols-3 gap-2.5 pb-1">
              {results.map(p => {
                const Icon = safeLucideIcon(p.symbol);
                return (
                  <button key={p.id} onClick={() => openPreset(p)} className="flex flex-col items-center gap-1.5 active:scale-[0.96] transition-transform">
                    <div
                      className={cn(
                        "h-14 w-14 flex items-center justify-center shadow-sm",
                        p.shape === "circle" ? "rounded-full" : p.shape === "rounded" ? "rounded-xl" : p.shape === "square" ? "rounded-none" : "rounded-[22%]"
                      )}
                      style={{ background: p.bgType === "gradient" ? `linear-gradient(135deg, ${p.color1}, ${p.color2})` : p.color1 }}
                    >
                      {Icon && <Icon className="h-6 w-6" style={{ color: p.fg }} />}
                    </div>
                    <span className="text-[10px] text-center leading-tight text-muted-foreground line-clamp-2">{p.name}</span>
                  </button>
                );
              })}
              {results.length === 0 && (
                <p className="col-span-3 text-center text-xs text-muted-foreground py-6">No presets match "{query}"</p>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground text-center pb-1">
              Presets are original icon concepts inspired by familiar app categories — not copies of any brand's logo.
            </p>
          </div>
        )}

        {view === "customize" && (
          <div className="space-y-5 pt-1">
            {/* Live preview — plain box; the drawn PNG already has the correct
                shape baked in with transparent corners, so no extra CSS
                rounding is applied here (a fixed rounded-[22%] wrapper used
                to make circle/square previews look wrong). */}
            <div className="flex flex-col items-center gap-2">
              <div className={cn("rounded-3xl p-6 transition-colors", darkPreview ? "bg-[#1c1c1e]" : "bg-[#f2f2f7]")}>
                <canvas ref={canvasRef} className="h-28 w-28" />
              </div>
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span>Light</span>
                <Switch checked={darkPreview} onCheckedChange={setDarkPreview} />
                <span>Dark home screen</span>
              </div>
              {lastExportedAt && (
                <p className="text-[10px] text-muted-foreground">Assets last exported {new Date(lastExportedAt).toLocaleString()}</p>
              )}
            </div>

            {!cfg.uploadedImage && (
              <>
                {/* Symbol vs monogram */}
                <div className="bg-card rounded-2xl border border-border/60 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] text-muted-foreground uppercase tracking-wider">Icon content</p>
                    <div className="flex rounded-full border border-border/60 overflow-hidden">
                      <button onClick={() => { hapticLight(); setCfg(c => ({ ...c, useLetter: false })); }} className={cn("h-7 px-3 text-[11px] font-medium flex items-center gap-1", !cfg.useLetter ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>
                        <ImageIcon className="h-3 w-3" /> Symbol
                      </button>
                      <button onClick={() => { hapticLight(); setCfg(c => ({ ...c, useLetter: true })); }} className={cn("h-7 px-3 text-[11px] font-medium flex items-center gap-1", cfg.useLetter ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>
                        <Type className="h-3 w-3" /> Initial
                      </button>
                    </div>
                  </div>
                  {cfg.useLetter ? (
                    <Input
                      value={cfg.letter}
                      onChange={e => setCfg(c => ({ ...c, letter: e.target.value.slice(0, 2) }))}
                      placeholder="A"
                      maxLength={2}
                      className="h-9 rounded-xl text-sm w-20 text-center"
                    />
                  ) : (
                    <div className="flex items-center gap-2">
                      {SymbolPreviewIcon && (
                        <div className="h-9 w-9 rounded-xl bg-muted flex items-center justify-center">
                          <SymbolPreviewIcon className="h-4 w-4" style={{ color: cfg.fg }} />
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground">Symbol from the preset you picked — switch presets in the gallery to change it.</p>
                    </div>
                  )}
                </div>

                {/* Shape */}
                <div className="bg-card rounded-2xl border border-border/60 p-4 space-y-3">
                  <p className="text-[11px] text-muted-foreground uppercase tracking-wider">Shape</p>
                  <div className="grid grid-cols-4 gap-1.5">
                    {SHAPES.map(s => (
                      <button key={s.id} onClick={() => { hapticLight(); setCfg(c => ({ ...c, shape: s.id })); }}
                        className={cn("h-14 rounded-xl border flex flex-col items-center justify-center gap-1 text-[9.5px] font-medium",
                          cfg.shape === s.id ? "border-primary bg-primary/10" : "border-border/60 bg-muted/30 text-muted-foreground")}>
                        <s.icon className="h-3.5 w-3.5" />
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Background */}
                <div className="bg-card rounded-2xl border border-border/60 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] text-muted-foreground uppercase tracking-wider">Background</p>
                    <div className="flex rounded-full border border-border/60 overflow-hidden">
                      {(["solid", "gradient"] as IconBgType[]).map(t => (
                        <button key={t} onClick={() => { hapticLight(); setCfg(c => ({ ...c, bgType: t })); }} className={cn("h-7 px-3 text-[11px] font-medium capitalize", cfg.bgType === t ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>{t}</button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="flex-1 space-y-1">
                      <span className="text-[10px] text-muted-foreground">{cfg.bgType === "gradient" ? "From" : "Color"}</span>
                      <input type="color" value={cfg.color1} onChange={e => setCfg(c => ({ ...c, color1: e.target.value }))} className="h-9 w-full rounded-xl border border-border/60" />
                    </label>
                    {cfg.bgType === "gradient" && (
                      <label className="flex-1 space-y-1">
                        <span className="text-[10px] text-muted-foreground">To</span>
                        <input type="color" value={cfg.color2} onChange={e => setCfg(c => ({ ...c, color2: e.target.value }))} className="h-9 w-full rounded-xl border border-border/60" />
                      </label>
                    )}
                    <label className="flex-1 space-y-1">
                      <span className="text-[10px] text-muted-foreground">Accent (symbol)</span>
                      <input type="color" value={cfg.fg} onChange={e => setCfg(c => ({ ...c, fg: e.target.value }))} className="h-9 w-full rounded-xl border border-border/60" />
                    </label>
                  </div>
                </div>

                {/* Border & shadow */}
                <div className="bg-card rounded-2xl border border-border/60 p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium">Shadow</p>
                    <Switch checked={cfg.shadow} onCheckedChange={v => { hapticLight(); setCfg(c => ({ ...c, shadow: v })); }} />
                  </div>
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium">Border</p>
                    <Switch checked={cfg.border} onCheckedChange={v => { hapticLight(); setCfg(c => ({ ...c, border: v })); }} />
                  </div>
                  {cfg.border && (
                    <div className="flex items-center gap-3">
                      <input type="color" value={cfg.borderColor} onChange={e => setCfg(c => ({ ...c, borderColor: e.target.value }))} className="h-9 w-14 rounded-xl border border-border/60" />
                      <div className="flex-1">
                        <Slider value={[cfg.borderWidth]} min={2} max={30} step={1} onValueChange={([v]) => setCfg(c => ({ ...c, borderWidth: v }))} />
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            {cfg.uploadedImage && (
              <div className="bg-card rounded-2xl border border-border/60 p-4 space-y-3">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wider">Uploaded image</p>
                <p className="text-xs text-muted-foreground">Cropped to fit your chosen shape. Pick a shape below, or upload a different file.</p>
                <div className="grid grid-cols-4 gap-1.5">
                  {SHAPES.map(s => (
                    <button key={s.id} onClick={() => { hapticLight(); setCfg(c => ({ ...c, shape: s.id })); }}
                      className={cn("h-14 rounded-xl border flex flex-col items-center justify-center gap-1 text-[9.5px] font-medium",
                        cfg.shape === s.id ? "border-primary bg-primary/10" : "border-border/60 bg-muted/30 text-muted-foreground")}>
                      <s.icon className="h-3.5 w-3.5" />
                      {s.label}
                    </button>
                  ))}
                </div>
                <button onClick={() => uploadInputRef.current?.click()} className="w-full h-9 rounded-xl border border-border/60 text-xs font-medium flex items-center justify-center gap-1.5">
                  <Upload className="h-3.5 w-3.5" /> Replace image
                </button>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-2 pb-1">
              <Button variant="outline" onClick={() => { hapticLight(); setView("gallery"); }} className="rounded-xl flex-1 h-10 text-xs">Back to presets</Button>
              <Button onClick={applyInApp} className="rounded-xl flex-1 h-10 text-xs bg-primary text-primary-foreground">Apply in-app</Button>
            </div>
            <button
              onClick={exportAssets}
              disabled={exporting}
              className="w-full h-10 rounded-xl bg-gradient-to-r from-primary/15 to-accent/30 border border-border/60 text-xs font-medium flex items-center justify-center gap-1.5 active:scale-[0.98] transition-transform disabled:opacity-60"
            >
              <Download className="h-3.5 w-3.5" /> {exporting ? "Generating assets…" : `Export Android + iOS icon set for ${currentApp.name}`}
            </button>
            <p className="text-[10px] text-muted-foreground text-center pb-1">
              Downloads a zip with every required size for both platforms, named for this app's package id.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default IconStudio;
