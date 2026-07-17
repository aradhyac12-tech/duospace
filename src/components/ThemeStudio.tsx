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
import { FONT_PRESETS, applyFontPreset, getActiveFontPresetId } from "@/lib/fontLoader";
import { cn } from "@/lib/utils";

interface Props { open: boolean; onOpenChange: (v: boolean) => void; }

const PRESETS: Omit<CustomTheme, "id" | "createdAt">[] = [
  // ── Light minimal ───────────────────────────────────────────────
  { name: "Paper & Ink",     primary: "0 0% 10%",    accent: "30 10% 90%",  background: "40 20% 96%",  foreground: "0 0% 8%" },
  { name: "Minimal White",   primary: "0 0% 20%",    accent: "0 0% 92%",    background: "0 0% 99%",    foreground: "0 0% 10%" },
  { name: "Cloud White",     primary: "217 91% 60%", accent: "215 20% 90%", background: "210 25% 98%" },
  { name: "Warm Sand",       primary: "28 25% 45%",  accent: "32 30% 86%",  background: "36 30% 96%" },
  { name: "Cherry Blossom",  primary: "340 55% 60%", accent: "340 60% 92%", background: "345 60% 98%" },
  { name: "Sage & Cream",    primary: "110 20% 45%", accent: "90 25% 85%",  background: "50 25% 96%" },
  { name: "Sky & Peach",     primary: "200 85% 55%", accent: "10 80% 88%",  background: "195 65% 97%" },
  { name: "Blush & Lavender",primary: "280 45% 60%", accent: "320 45% 90%", background: "320 40% 97%" },
  { name: "Arctic Frost",    primary: "205 60% 40%", accent: "205 40% 85%", background: "205 40% 97%" },
  { name: "Desert Clay",     primary: "20 40% 50%",  accent: "25 45% 82%",  background: "30 40% 95%" },
  { name: "Rose Gold",       primary: "350 65% 60%", accent: "340 30% 88%", background: "350 30% 96%" },
  { name: "Emerald",         primary: "155 50% 45%", accent: "150 25% 85%", background: "150 20% 95%" },
  { name: "Lavender",        primary: "270 50% 65%", accent: "270 25% 86%", background: "270 25% 96%" },
  { name: "Ocean Blue",      primary: "200 70% 50%", accent: "195 40% 80%", background: "200 30% 95%" },

  // ── Dark & moody ────────────────────────────────────────────────
  { name: "Midnight Indigo", primary: "240 84% 60%", accent: "240 40% 25%", background: "240 40% 6%",  gradient: { from: "240 50% 10%", to: "260 40% 6%" } },
  { name: "Charcoal Ember",  primary: "14 80% 55%",  accent: "14 30% 22%",  background: "0 0% 10%",    amoled: false },
  { name: "Noir & Gold",     primary: "42 55% 55%",  accent: "42 30% 22%",  background: "0 0% 5%",     amoled: false },
  { name: "Emerald Prestige",primary: "158 55% 30%", accent: "42 40% 55%",  background: "158 30% 8%" },
  { name: "Navy Trust",      primary: "215 80% 50%", accent: "215 40% 20%", background: "220 45% 10%" },
  { name: "Forest & Moss",   primary: "145 40% 40%", accent: "110 25% 60%", background: "150 30% 8%" },
  { name: "Midnight Black",  primary: "220 40% 55%", accent: "220 30% 25%", background: "230 20% 8%" },
  { name: "Slate & Steel",   primary: "215 25% 55%", accent: "215 15% 25%", background: "220 20% 10%" },
  { name: "Ocean Deep",      primary: "195 70% 45%", accent: "205 40% 25%", background: "210 60% 8%" },

  // ── Bold & expressive ───────────────────────────────────────────
  { name: "Neon Mint",       primary: "160 80% 45%", accent: "160 70% 50%", background: "220 30% 6%",  amoled: true, gradient: { from: "160 60% 15%", to: "220 60% 8%" } },
  { name: "Neon Dark",       primary: "280 90% 65%", accent: "200 90% 60%", background: "240 25% 6%",  amoled: true, gradient: { from: "280 70% 15%", to: "200 70% 10%" } },
  { name: "Sunset Blaze",    primary: "18 90% 55%",  accent: "330 80% 60%", background: "20 40% 97%",  gradient: { from: "20 90% 88%", to: "330 70% 90%" } },
  { name: "Warm Sunset",     primary: "20 80% 55%",  accent: "30 60% 85%",  background: "30 40% 95%",  gradient: { from: "20 70% 90%", to: "350 60% 92%" } },
  { name: "Electric Coral",  primary: "355 85% 60%", accent: "260 50% 55%", background: "355 40% 97%" },
  { name: "Autumn Harvest",  primary: "20 65% 40%",  accent: "40 60% 55%",  background: "30 30% 96%" },
  { name: "Terracotta Sage", primary: "12 55% 50%",  accent: "95 25% 55%",  background: "30 30% 96%" },
  { name: "Burnt Sienna",    primary: "20 55% 35%",  accent: "30 50% 60%",  background: "30 30% 96%" },
  { name: "Brutalist Pop",   primary: "14 90% 55%",  accent: "54 100% 55%", background: "0 0% 100%",   foreground: "0 0% 4%" },
  { name: "Vapor Chrome",    primary: "260 90% 75%", accent: "190 90% 80%", background: "230 60% 97%", gradient: { from: "260 80% 90%", to: "190 80% 92%" } },
  { name: "Glass Aurora",    primary: "265 90% 70%", accent: "150 70% 55%", background: "230 40% 8%",  gradient: { from: "230 50% 10%", to: "265 60% 12%" } },
];

const ThemeStudio = ({ open, onOpenChange }: Props) => {
  const { toast } = useToast();
  const [themes, setThemes] = useState<CustomTheme[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeFontId, setActiveFontId] = useState<string>(getActiveFontPresetId());

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
    hapticLight();
    applyCustomTheme(t);
    setActiveId(t.id);
  };

  const saveAndApply = () => {
    const t = buildTheme();
    saveCustomTheme(t);
    setThemes(listCustomThemes());
    apply(t);
    toast({ title: "Theme saved & applied" });
  };

  const applyPreset = (p: typeof PRESETS[number]) => {
    const t: CustomTheme = { ...p, id: `p_${p.name.replace(/\s/g, "_")}`, createdAt: Date.now() };
    saveCustomTheme(t);
    setThemes(listCustomThemes());
    apply(t);
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
          <DialogTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4" /> Theme Studio
          </DialogTitle>
          <DialogDescription>Live preview · Save unlimited themes</DialogDescription>
        </DialogHeader>

        {/* Live preview card */}
        <motion.div
          layout
          style={previewStyle}
          className="rounded-2xl p-4 border border-border/60 space-y-3"
        >
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full" style={{ background: `hsl(var(--preview-primary))` }} />
            <div className="flex-1">
              <p className="text-sm font-semibold">Preview</p>
              <p className="text-[11px] text-muted-foreground">Buttons · accents · bubbles</p>
            </div>
          </div>
          <div className="flex gap-2">
            <div className="rounded-2xl px-3 py-2 text-xs text-white" style={{ background: `hsl(var(--preview-primary))` }}>You</div>
            <div className="rounded-2xl px-3 py-2 text-xs" style={{ background: `hsl(var(--preview-accent))` }}>Partner</div>
          </div>
        </motion.div>

        {/* Presets */}
        <div>
          <div className="flex items-baseline justify-between mb-2">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Presets</p>
            <p className="text-[10px] text-muted-foreground">{PRESETS.length} themes</p>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {PRESETS.map(p => (
              <button key={p.name} onClick={() => applyPreset(p)}
                className="group h-16 rounded-2xl border border-border/60 active:scale-95 hover:border-foreground/40 transition-all overflow-hidden relative"
                style={{ background: p.gradient
                  ? `linear-gradient(135deg, hsl(${p.gradient.from}), hsl(${p.gradient.to}))`
                  : `hsl(${p.background || "0 0% 50%"})` }}
                title={p.name}>
                <div className="absolute inset-x-1 bottom-1 flex items-center justify-between">
                  <span className="text-[9px] font-medium truncate px-1 opacity-70 group-hover:opacity-100" style={{ color: `hsl(${p.foreground || p.primary})` }}>{p.name}</span>
                  <div className="h-3 w-3 rounded-full shrink-0 shadow-sm" style={{ background: `hsl(${p.primary})` }} />
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Typography presets */}
        <div>
          <div className="flex items-baseline justify-between mb-2">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Typography</p>
            <p className="text-[10px] text-muted-foreground">{FONT_PRESETS.length} pairs</p>
          </div>
          <div className="grid grid-cols-2 gap-2 max-h-56 overflow-y-auto pr-1">
            {FONT_PRESETS.map(f => {
              const active = f.id === activeFontId;
              return (
                <button
                  key={f.id}
                  onClick={() => { hapticLight(); applyFontPreset(f.id); setActiveFontId(f.id); }}
                  className={cn(
                    "text-left rounded-2xl px-3 py-2.5 border transition-all press",
                    active ? "border-foreground/60 bg-foreground/5" : "border-border/60 hover:border-foreground/30",
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




        {/* Custom builder */}
        <div className="space-y-3">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Custom</p>
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="Theme name" className="h-9 rounded-xl text-sm" />

          <div className="flex items-center gap-2">
            <input type="color" value={hex} onChange={e => onHexChange(e.target.value)}
              className="h-10 w-10 rounded-xl border border-border/60 cursor-pointer bg-transparent" />
            <Input value={hex} onChange={e => onHexChange(e.target.value)} className="h-9 rounded-xl flex-1 font-mono text-xs uppercase" />
          </div>

          <div className="space-y-2">
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

          <div className="flex items-center justify-between rounded-xl bg-muted/40 px-3 py-2">
            <p className="text-xs">AMOLED black background</p>
            <Switch checked={amoled} onCheckedChange={setAmoled} />
          </div>
          <div className="flex items-center justify-between rounded-xl bg-muted/40 px-3 py-2">
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
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">Saved</p>
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
                    <button onClick={() => remove(t.id)} className="text-muted-foreground active:scale-90"><Trash2 className="h-3.5 w-3.5" /></button>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </div>
        )}

        {/* Tools */}
        <div className="flex gap-2 pt-1">
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
      </DialogContent>
    </Dialog>
  );
};

export default ThemeStudio;
