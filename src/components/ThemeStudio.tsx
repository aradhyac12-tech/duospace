import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { hapticLight } from "@/lib/haptics";
import { Check, Download, Upload, Trash2, Sparkles, Plus } from "lucide-react";
import {
  CustomTheme, listCustomThemes, saveCustomTheme, deleteCustomTheme,
  applyCustomTheme, clearCustomThemeOverride, getActiveCustomThemeId,
  hexToHsl, hslToHex, exportThemes, importThemes,
} from "@/lib/customThemes";
import { useTheme, THEMES } from "@/contexts/ThemeContext";
import { FONT_PRESETS, applyFontPreset, getActiveFontPresetId } from "@/lib/fontLoader";
import { TEXT_DENSITY_PRESETS, applyTextDensity, getActiveTextDensityId } from "@/lib/textDensity";
import { cn } from "@/lib/utils";

interface Props { open: boolean; onOpenChange: (v: boolean) => void; }


const ThemeStudio = ({ open, onOpenChange }: Props) => {
  const { toast } = useToast();
  const { theme, setTheme, colorMode, toggleColorMode } = useTheme();
  const [themes, setThemes] = useState<CustomTheme[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeFontId, setActiveFontId] = useState<string>(getActiveFontPresetId());
  const [activeDensityId, setActiveDensityId] = useState<string>(getActiveTextDensityId());

  const [name, setName]   = useState("My Theme");
  const [hex, setHex]     = useState("#7c3aed");
  const [h, setH]         = useState(265);
  const [s, setS]         = useState(80);
  const [l, setL]         = useState(60);
  const [accentHex, setAccentHex] = useState("#e9d5ff");
  const [amoled, setAmoled]       = useState(false);
  const [useGradient, setUseGradient] = useState(false);

  useEffect(() => {
    if (!open) return;
    setThemes(listCustomThemes());
    setActiveId(getActiveCustomThemeId());
  }, [open]);

  // Sync hex ↔ HSL sliders
  useEffect(() => {
    const hsl = `${h} ${s}% ${l}%`;
    setHex(hslToHex(hsl));
  }, [h, s, l]);

  const onHexChange = (v: string) => {
    setHex(v);
    const hsl = hexToHsl(v);
    if (hsl) {
      const m = hsl.match(/(\d+) (\d+)% (\d+)%/);
      if (m) { setH(+m[1]); setS(+m[2]); setL(+m[3]); }
    }
  };

  const previewStyle = useMemo(() => {
    const primary = `${h} ${s}% ${l}%`;
    const accent = hexToHsl(accentHex) || "270 25% 86%";
    return {
      "--preview-primary": primary,
      "--preview-accent": accent,
    } as React.CSSProperties;
  }, [h, s, l, accentHex]);

  const buildTheme = (): CustomTheme => ({
    id: `c_${Date.now().toString(36)}`,
    name: name.trim() || "Untitled",
    primary: `${h} ${s}% ${l}%`,
    accent: hexToHsl(accentHex) || "270 25% 86%",
    amoled,
    gradient: useGradient ? { from: `${h} ${Math.min(s, 70)}% 15%`, to: `${(h + 40) % 360} ${Math.min(s, 70)}% 10%` } : null,
    createdAt: Date.now(),
  });

  const apply = (t: CustomTheme) => {
    applyCustomTheme(t, colorMode);
    setActiveId(t.id);
  };

  const saveAndApply = () => {
    const t = buildTheme();
    saveCustomTheme(t);
    setThemes(listCustomThemes());
    apply(t);
    toast({ title: "Theme saved & applied" });
  };

  const selectTheme = (id: typeof THEMES[number]["id"]) => {
    clearCustomThemeOverride();
    setActiveId(null);
    setTheme(id);
  };

  const remove = (id: string) => {
    deleteCustomTheme(id);
    setThemes(listCustomThemes());
    setActiveId(getActiveCustomThemeId());
  };

  const reset = () => {
    clearCustomThemeOverride();
    setActiveId(null);
    toast({ title: "Reset to preset theme" });
  };

  const onExport = () => {
    const blob = new Blob([exportThemes()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "themes.json"; a.click();
    URL.revokeObjectURL(url);
  };

  const onImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    const text = await f.text();
    const added = importThemes(text);
    setThemes(listCustomThemes());
    toast({ title: added > 0 ? `Imported ${added} themes` : "Nothing new to import" });
    e.target.value = "";
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-3xl max-w-[420px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2.5">
            <span className="h-8 w-8 rounded-xl flex items-center justify-center bg-gradient-to-br from-primary/25 to-accent/40 border border-border/60">
              <Sparkles className="h-4 w-4" />
            </span>
            Theme Studio
          </DialogTitle>
          <DialogDescription>Live preview · Save unlimited themes</DialogDescription>
        </DialogHeader>

        <div className="space-y-7 pt-1">

        {/* Live preview card */}
        <motion.div
          layout
          style={previewStyle}
          className="rounded-3xl p-4 border border-border/60 bg-gradient-to-b from-card to-card/60 shadow-sm space-y-3"
        >
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full flex items-center justify-center text-xs font-semibold text-white shrink-0" style={{ background: `hsl(var(--preview-primary))` }}>Aa</div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold">Live preview</p>
              <p className="text-[11px] text-muted-foreground truncate">Bubbles · buttons · accents update instantly</p>
            </div>
          </div>
          <div className="flex flex-col gap-1.5 items-end">
            <div className="rounded-2xl rounded-tr-md px-3 py-2 text-xs text-white max-w-[75%]" style={{ background: `hsl(var(--preview-primary))` }}>Hey, how's your day going? 💭</div>
            <div className="rounded-2xl rounded-tl-md px-3 py-2 text-xs self-start max-w-[75%]" style={{ background: `hsl(var(--preview-accent))` }}>Good! Just saw this new theme ✨</div>
          </div>
        </motion.div>

        {/* Light / Dark mode — applies to whichever preset below is active */}
        <div className="flex items-center justify-between rounded-2xl border border-border/60 bg-card/50 px-4 py-3.5">
          <div>
            <p className="text-sm font-medium">Appearance</p>
            <p className="text-[11px] text-muted-foreground">{colorMode === "dark" ? "Dark mode" : "Light mode"}</p>
          </div>
          <Switch checked={colorMode === "dark"} onCheckedChange={() => { hapticLight(); toggleColorMode(); }} />
        </div>

        {/* Presets — the same list Settings shows, so both stay in sync */}
        <div>
          <div className="flex items-baseline justify-between mb-2.5">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">Presets</p>
            <p className="text-[10px] text-muted-foreground">{THEMES.length} themes</p>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {THEMES.map(t => {
              const active = t.id === theme && !activeId;
              return (
                <button key={t.id} onClick={() => selectTheme(t.id)}
                  className={cn(
                    "group h-[70px] rounded-2xl border active:scale-95 transition-all overflow-hidden relative press",
                    active ? "border-primary/70 ring-1 ring-primary/20" : "border-border/60 hover:border-primary/40",
                  )}
                  style={{ background: t.preview }}
                  title={t.name}
                  aria-label={`${t.name} theme${active ? " (selected)" : ""}`}
                  aria-pressed={active}>
                  <span className="absolute top-1.5 left-1.5 text-[11px] opacity-80" aria-hidden="true">{t.emoji}</span>
                  {active && <Check className="absolute top-1.5 right-1.5 h-3 w-3 text-foreground/80" aria-hidden="true" />}
                  <div className="absolute inset-x-1.5 bottom-1.5 flex items-center justify-between">
                    <span className="text-[9px] font-medium truncate px-0.5 opacity-70 group-hover:opacity-100">{t.name}</span>
                    <div className="h-3 w-3 rounded-full shrink-0 shadow-sm" style={{ background: t.accent }} />
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Typography presets */}
        <div>
          <div className="flex items-baseline justify-between mb-2.5">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">Typography</p>
            <p className="text-[10px] text-muted-foreground">{FONT_PRESETS.length} pairs</p>
          </div>
          <div className="grid grid-cols-2 gap-2 max-h-56 overflow-y-auto pr-1">
            {FONT_PRESETS.map(f => {
              const active = f.id === activeFontId;
              return (
                <button
                  key={f.id}
                  onClick={() => { applyFontPreset(f.id); setActiveFontId(f.id); }}
                  className={cn(
                    "text-left rounded-2xl px-3 py-2.5 border transition-all press",
                    active ? "border-primary/60 bg-primary/5" : "border-border/60 hover:border-primary/30",
                  )}
                >
                  <p className="text-sm truncate" style={{ fontFamily: f.heading }}>Aa · {f.name.split(" · ")[0]}</p>
                  <p className="text-[11px] text-muted-foreground truncate" style={{ fontFamily: f.body }}>
                    {f.name.split(" · ")[1] || "Body sample"}
                  </p>
                </button>
              );
            })}
          </div>
        </div>

        {/* Text density presets */}
        <div>
          <div className="flex items-baseline justify-between mb-2.5">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">Text size &amp; spacing</p>
            <p className="text-[10px] text-muted-foreground">{TEXT_DENSITY_PRESETS.length} presets</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {TEXT_DENSITY_PRESETS.map(d => {
              const active = d.id === activeDensityId;
              return (
                <button
                  key={d.id}
                  onClick={() => { applyTextDensity(d.id); setActiveDensityId(d.id); }}
                  className={cn(
                    "text-left rounded-2xl px-3 py-2.5 border transition-all press",
                    active ? "border-primary/60 bg-primary/5" : "border-border/60 hover:border-primary/30",
                  )}
                >
                  <p className="text-sm font-medium truncate" style={{ fontSize: `${13 * d.scale}px` }}>{d.name}</p>
                  <p className="text-[11px] text-muted-foreground truncate">{d.description}</p>
                </button>
              );
            })}
          </div>
        </div>

        {/* Custom builder */}
        <div className="rounded-3xl border border-border/60 bg-card/40 p-4 space-y-3.5">
          <div className="flex items-center justify-between">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">Build your own</p>
            <div className="h-7 w-7 rounded-full border border-border/60 shadow-sm" style={{ background: `linear-gradient(135deg, ${hex}, ${accentHex})` }} />
          </div>
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="Theme name" className="h-9 rounded-xl text-sm" />

          <div className="flex items-center gap-2">
            <input type="color" value={hex} onChange={e => onHexChange(e.target.value)}
              className="h-10 w-10 rounded-xl border border-border/60 cursor-pointer bg-transparent" />
            <Input value={hex} onChange={e => onHexChange(e.target.value)} className="h-9 rounded-xl flex-1 font-mono text-xs uppercase" />
          </div>

          <div className="space-y-2.5">
            <div>
              <p className="text-[10px] text-muted-foreground mb-1">Hue · {h}°</p>
              <Slider value={[h]} max={360} step={1} onValueChange={v => setH(v[0])} />
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground mb-1">Saturation · {s}%</p>
              <Slider value={[s]} max={100} step={1} onValueChange={v => setS(v[0])} />
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground mb-1">Lightness · {l}%</p>
              <Slider value={[l]} max={100} step={1} onValueChange={v => setL(v[0])} />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <p className="text-[11px] text-muted-foreground flex-1">Accent color</p>
            <input type="color" value={accentHex} onChange={e => setAccentHex(e.target.value)}
              className="h-8 w-8 rounded-lg border border-border/60 cursor-pointer bg-transparent" />
          </div>

          <div className="flex items-center justify-between rounded-xl bg-muted/40 px-3 py-2.5">
            <p className="text-xs">AMOLED black background</p>
            <Switch checked={amoled} onCheckedChange={setAmoled} />
          </div>
          <div className="flex items-center justify-between rounded-xl bg-muted/40 px-3 py-2.5">
            <p className="text-xs">Gradient background</p>
            <Switch checked={useGradient} onCheckedChange={setUseGradient} />
          </div>

          <Button onClick={saveAndApply} className="w-full rounded-full h-9 text-sm">
            <Plus className="h-3.5 w-3.5 mr-1" /> Save & apply
          </Button>
        </div>

        {/* Saved themes */}
        {themes.length > 0 && (
          <div>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-2.5">Saved</p>
            <div className="space-y-1.5">
              <AnimatePresence initial={false}>
                {themes.map(t => (
                  <motion.div key={t.id}
                    layout
                    initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                    className={cn("flex items-center gap-2 rounded-xl border px-3 py-2",
                      activeId === t.id ? "border-primary bg-primary/5" : "border-border/60 bg-card")}>
                    <div className="h-7 w-7 rounded-lg" style={{ background: `hsl(${t.primary})` }} />
                    <p className="text-xs flex-1 truncate">{t.name}</p>
                    {activeId === t.id && <Check className="h-3.5 w-3.5 text-primary" />}
                    <button onClick={() => apply(t)} className="text-[10px] px-2 py-1 rounded-full bg-muted">Apply</button>
                    <button onClick={() => remove(t.id)} aria-label={`Delete ${t.name}`} className="text-muted-foreground active:scale-90"><Trash2 className="h-3.5 w-3.5" aria-hidden="true" /></button>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </div>
        )}

        {/* Tools */}
        <div className="flex gap-2 pt-1 pb-1">
          <Button variant="outline" size="sm" onClick={onExport} className="flex-1 rounded-full text-xs h-8"><Download className="h-3 w-3 mr-1" /> Export</Button>
          <label className="flex-1">
            <span>
              <Button variant="outline" size="sm" asChild className="w-full rounded-full text-xs h-8">
                <span><Upload className="h-3 w-3 mr-1" /> Import</span>
              </Button>
            </span>
            <input type="file" accept="application/json" className="hidden" onChange={onImport} />
          </label>
          <Button variant="ghost" size="sm" onClick={reset} className="rounded-full text-xs h-8">Reset</Button>
        </div>

        </div>
      </DialogContent>
    </Dialog>
  );
};

export default ThemeStudio;
