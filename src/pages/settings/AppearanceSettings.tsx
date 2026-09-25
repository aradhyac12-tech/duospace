import { useState, useRef } from "react";
import { getEffectsPreference, setEffectsPreference, type EffectsPreference } from "@/lib/perfProfile";
import { motion } from "framer-motion";
import PageHeader from "@/components/PageHeader";
import {
  Image, Upload, Sun, Moon, MonitorSmartphone, Clock, Sparkles, Wand2,
} from "lucide-react";
import { useTheme } from "@/contexts/ThemeContext";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { hapticLight } from "@/lib/haptics";
import { cn } from "@/lib/utils";
import ThemeStudio from "@/components/ThemeStudio";
import IconStudio from "@/components/IconStudio";
import { ThemeSection } from "@/components/settings/ThemePicker";
import { WallpaperSection } from "@/components/settings/WallpaperPicker";

/**
 * Appearance: app name, app icon (+ Icon Studio for native asset export),
 * theme mode/colors (+ Theme Studio), and chat wallpaper. Purely cosmetic —
 * no security implications — so this page can be as visual/exploratory as
 * it wants without the "what happens / is it reversible" framing that
 * applies to the security-relevant pages.
 */
const AppearanceSettings = () => {
  const {
    colorMode,
    themeMode, setThemeMode, scheduleDarkStart, scheduleDarkEnd, setScheduleTimes,
    appIcon, setAppIcon, appName, setAppName,
  } = useTheme();
  const { toast } = useToast();
  const [appNameInput, setAppNameInput] = useState(appName);
  const appIconInputRef = useRef<HTMLInputElement>(null);
  const [showThemeStudio, setShowThemeStudio] = useState(false);
  const [effectsPref, setEffectsPref] = useState<EffectsPreference>(getEffectsPreference);
  const [showIconStudio, setShowIconStudio] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-24 bg-background"
    >
      <PageHeader title="Appearance" subtitle="Name, icon, theme & wallpaper" />

      <div className="px-5 pt-5 space-y-2">
        {/* App name */}
        <div className="bg-card rounded-2xl border border-border/60 p-4 space-y-2">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wider">App Name</p>
          <div className="flex gap-2">
            <Input
              value={appNameInput}
              onChange={e => setAppNameInput(e.target.value)}
              placeholder="DuoSpace"
              maxLength={32}
              className="h-9 rounded-xl flex-1 text-sm"
            />
            <Button
              onClick={() => {
                const val = appNameInput.trim();
                if (!/^[a-zA-Z0-9._]{3,32}$/.test(val)) {
                  toast({ title: "Invalid name", description: "Letters, numbers, . and _ only. Min 3 characters.", variant: "destructive" });
                  return;
                }
                setAppName(val);
                toast({ title: "Name updated", description: "Changes the in-app display name only." });
              }}
              size="sm"
              className="rounded-xl bg-primary text-primary-foreground h-9 px-4 text-xs"
            >Save</Button>
          </div>
          <p className="text-[10px] text-muted-foreground">Letters, numbers, . and _ only · 3–32 chars · In-app display only</p>
        </div>

        {/* App icon */}
        <div className="bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-muted flex items-center justify-center overflow-hidden">
            {appIcon ? <img loading="lazy" decoding="async" src={appIcon} alt="" className="h-full w-full object-cover" /> : <Image className="h-5 w-5 text-muted-foreground" />}
          </div>
          <div className="flex-1">
            <p className="text-sm font-medium">App Icon</p>
            <p className="text-[11px] text-muted-foreground">Changes in-app display & browser tab · Home screen icon unchanged</p>
          </div>
          <div className="flex items-center gap-2">
            {appIcon && <button onClick={() => setAppIcon(null)} className="text-[10px] text-destructive">Remove</button>}
            <button onClick={() => appIconInputRef.current?.click()} aria-label="Upload custom app icon" className="h-7 px-3 rounded-full bg-muted text-[11px] text-foreground"><Upload className="h-3 w-3" aria-hidden="true" /></button>
          </div>
        </div>
        <input ref={appIconInputRef} type="file" accept="image/*" className="hidden" onChange={async e => {
          const file = e.target.files?.[0]; if (!file) return;
          const reader = new FileReader();
          reader.onload = () => setAppIcon(reader.result as string);
          reader.onerror = () => toast({ title: "Couldn't read that image", variant: "destructive" });
          reader.readAsDataURL(file); e.target.value = "";
        }} />
        <button
          onClick={() => { setShowIconStudio(true); }}
          className="w-full h-9 rounded-xl bg-gradient-to-r from-primary/15 to-accent/30 border border-border/60 text-xs font-medium flex items-center justify-center gap-1.5 active:scale-[0.98] transition-transform"
        >
          <Wand2 className="h-3.5 w-3.5" /> Open Icon Studio — presets, custom, export Android/iOS
        </button>

        {/* Theme */}
        <div className="bg-card rounded-2xl border border-border/60 p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wider">Appearance mode</p>
            <span className="text-[10px] text-muted-foreground flex items-center gap-1">
              {colorMode === "dark" ? <Moon className="h-3 w-3" /> : <Sun className="h-3 w-3" />}
              {colorMode === "dark" ? "Dark now" : "Light now"}
            </span>
          </div>
          <div className="grid grid-cols-5 gap-1.5 mb-3">
            {([
              { id: "light" as const, label: "Light", icon: Sun },
              { id: "dark" as const, label: "Dark", icon: Moon },
              { id: "auto" as const, label: "Auto", icon: MonitorSmartphone },
              { id: "schedule" as const, label: "Timed", icon: Clock },
              { id: "dynamic" as const, label: "Dynamic", icon: Sparkles },
            ]).map(opt => (
              <button
                key={opt.id}
                onClick={() => { hapticLight(); setThemeMode(opt.id); }}
                aria-pressed={themeMode === opt.id}
                className={cn(
                  "h-14 rounded-xl border flex flex-col items-center justify-center gap-1 text-[9.5px] font-medium transition-all",
                  themeMode === opt.id
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border/60 bg-muted/30 text-muted-foreground"
                )}
              >
                <opt.icon className="h-3.5 w-3.5" />
                {opt.label}
              </button>
            ))}
          </div>
          {themeMode === "auto" && (
            <p className="text-[10px] text-muted-foreground mb-3">Follows your device's system light/dark setting automatically.</p>
          )}
          {themeMode === "schedule" && (
            <div className="mb-3 space-y-2">
              <p className="text-[10px] text-muted-foreground">Switches to dark mode in the evening and back to light in the morning.</p>
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <label className="text-[10px] text-muted-foreground mb-1 block">Dark from</label>
                  <input type="time" value={scheduleDarkStart}
                    onChange={e => { setScheduleTimes(e.target.value, scheduleDarkEnd); }}
                    className="w-full h-9 rounded-xl border border-border/60 bg-muted/30 px-3 text-sm" />
                </div>
                <div className="flex-1">
                  <label className="text-[10px] text-muted-foreground mb-1 block">Light from</label>
                  <input type="time" value={scheduleDarkEnd}
                    onChange={e => { setScheduleTimes(scheduleDarkStart, e.target.value); }}
                    className="w-full h-9 rounded-xl border border-border/60 bg-muted/30 px-3 text-sm" />
                </div>
              </div>
            </div>
          )}
          {themeMode === "dynamic" && (
            <p className="text-[10px] text-muted-foreground mb-3">
              Theme colors — and the Dynamic Sky wallpaper below — continuously shift through the day like Apple's dynamic wallpapers, with no hard switch at any point.
            </p>
          )}
        </div>

        {/* Theme colors — collapsible, previews rendered in the active mode */}
        <ThemeSection onOpenStudio={() => setShowThemeStudio(true)} />

        {/* Wallpaper — collapsible; header keeps showing the applied one */}
        <WallpaperSection />

        {/* Performance — see src/lib/perfProfile.ts */}
        <div className="bg-card rounded-2xl border border-border/60 p-4">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-3">Performance</p>
          <div className="grid grid-cols-3 gap-1.5 mb-2">
            {([
              { id: "auto" as const, label: "Auto" },
              { id: "lite" as const, label: "Smooth" },
              { id: "full" as const, label: "Full glass" },
            ]).map(opt => (
              <button
                key={opt.id}
                onClick={() => { hapticLight(); setEffectsPref(opt.id); setEffectsPreference(opt.id); }}
                aria-pressed={effectsPref === opt.id}
                className={cn(
                  "h-10 rounded-xl border text-[11px] font-medium transition-all",
                  effectsPref === opt.id
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border/60 bg-muted/30 text-muted-foreground"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground">
            Smooth turns off the see-through blur behind the dock, headers and sheets so scrolling stays fluid on
            slower phones. Auto picks it for you when your device looks low-powered.
          </p>
        </div>
      </div>

      <ThemeStudio open={showThemeStudio} onOpenChange={setShowThemeStudio} />
      <IconStudio open={showIconStudio} onOpenChange={setShowIconStudio} appName={appName} onApply={setAppIcon} />
    </motion.div>
  );
};

export default AppearanceSettings;
