import { useEffect, useMemo, useRef, useState } from "react";
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
import { Check, Download, Upload, Trash2, Sparkles, Plus, Type, TextCursorInput, SlidersHorizontal } from "lucide-react";
import {
  CustomTheme, listCustomThemes, saveCustomTheme, deleteCustomTheme,
  applyCustomTheme, buildCustomThemeTokens, clearCustomThemeOverride, getActiveCustomThemeId,
  hexToHsl, hslToHex, exportThemes, importThemes,
} from "@/lib/customThemes";
import { useTheme, ThemeColor, THEME_IDENTITIES } from "@/contexts/ThemeContext";
import { deriveTokens, auditThemeTokens } from "@/lib/themeEngine";
import ThemePreview from "@/components/settings/ThemePreview";
import CollapsibleSection from "@/components/settings/CollapsibleSection";
import { ThemePicker } from "@/components/settings/ThemePicker";
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

  // Preview: shows the builder's colours while the person is editing them,
  // otherwise whatever look is currently applied (preset or applied custom
  // theme). Built with the SAME engine functions the app applies, so what is
  // previewed is what Save & apply produces.
  const [touched, setTouched] = useState(false);
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    setTouched(true);
  }, [h, s, l, accentHex, amoled, useGradient]);

  const builderTheme = useMemo((): CustomTheme => ({
    id: "preview", name: "preview",
    primary: `${h} ${s}% ${l}%`,
    accent: hexToHsl(accentHex) || "270 25% 86%",
    amoled,
    gradient: useGradient ? { from: `${h} ${Math.min(s, 70)}% 15%`, to: `${(h + 40) % 360} ${Math.min(s, 70)}% 10%` } : null,
    createdAt: 0,
  }), [h, s, l, accentHex, amoled, useGradient]);

  const previewTokens = useMemo(() => {
    if (touched) return buildCustomThemeTokens(builderTheme, colorMode).tokens;
    const active = activeId ? themes.find(t => t.id === activeId) : undefined;
    if (active) return buildCustomThemeTokens(active, colorMode).tokens;
    return deriveTokens(THEME_IDENTITIES[theme] ?? THEME_IDENTITIES.midnight, colorMode);
  }, [touched, builderTheme, activeId, themes, theme, colorMode]);

  // Advisory only — never blocks saving or applying.
  const auditHint = useMemo(
    () => (touched ? auditThemeTokens(previewTokens, builderTheme.gradient)[0]?.message : undefined),
    [touched, previewTokens, builderTheme.gradient],
  );

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
    setTouched(false);
  };

  const saveAndApply = () => {
    const t = buildTheme();
    saveCustomTheme(t);
    setThemes(listCustomThemes());
    apply(t);
    toast({ title: "Theme saved & applied" });
  };

  const selectTheme = (id: ThemeColor) => {
    clearCustomThemeOverride();
    setActiveId(null);
    setTouched(false);
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

        {/* Preview — real DuoSpace micro-UI painted from the actual tokens */}
        <div>
          <ThemePreview tokens={previewTokens} size="md" />
          {auditHint && <p className="mt-2 text-[11px] text-muted-foreground" role="note">{auditHint}</p>}
        </div>

        {/* Light / Dark mode — applies to whichever preset below is active */}
        <div className="flex items-center justify-between rounded-2xl border border-border/60 bg-card/50 px-4 py-3.5">
          <div>
            <p className="text-sm font-medium">Appearance</p>
            <p className="text-[11px] text-muted-foreground">{colorMode === "dark" ? "Dark mode" : "Light mode"}</p>
          </div>
          <Switch checked={colorMode === "dark"} onCheckedChange={() => { hapticLight(); toggleColorMode(); }} />
        </div>

        {/* Presets — the same picker Settings uses, so both stay in sync */}
        <div>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-2.5">Presets</p>
          <ThemePicker customActive={!!activeId} onSelect={selectTheme} />
        </div>

        {/* Typography presets */}
        <CollapsibleSection id="studio-typography" title="Typography" icon={<Type className="h-4 w-4" />} summary={`${FONT_PRESETS.length} font pairs`}>
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
        </CollapsibleSection>

        {/* Text density presets */}
        <CollapsibleSection id="studio-density" title="Text size & spacing" icon={<TextCursorInput className="h-4 w-4" />} summary={`${TEXT_DENSITY_PRESETS.length} presets`}>
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
        </CollapsibleSection>

        {/* Custom builder — advanced: everything it had before, one tap deeper */}
        <CollapsibleSection
          id="studio-advanced"
          title="Advanced · Build your own"
          icon={<SlidersHorizontal className="h-4 w-4" />}
          summary="Custom colour, AMOLED, gradient, save"
          preview={<span className="h-7 w-7 rounded-full border border-border/60 shadow-sm block" style={{ background: `linear-gradient(135deg, ${hex}, ${accentHex})` }} />}
        >
          <div className="space-y-3.5">
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
        </CollapsibleSection>

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
