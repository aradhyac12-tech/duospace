import { useMemo, useState } from "react";
import { Check, Image as ImageIcon, ImageOff } from "lucide-react";
import { useTheme } from "@/contexts/ThemeContext";
import { WALLPAPERS, resolveWallpaperStyle } from "@/lib/wallpapers";
import { hapticLight } from "@/lib/haptics";
import { cn } from "@/lib/utils";
import CollapsibleSection from "./CollapsibleSection";

const ALL = "All";

/**
 * Chat-wallpaper section: collapsible, with a live chat preview, category
 * chips and a tile grid. Collapsed, the header still shows the applied
 * wallpaper's thumbnail and name, so nothing is hidden about the current
 * state — you just don't have to scroll past 25 tiles to reach the rest of
 * the page.
 */
export const WallpaperSection = () => {
  const { chatWallpaper, setChatWallpaper, colorMode } = useTheme();
  const [filter, setFilter] = useState<string>(ALL);

  const selected = chatWallpaper ? WALLPAPERS.find(w => w.id === chatWallpaper) : undefined;
  // A raw CSS string saved before wallpapers became ID-based (see wallpapers.ts).
  const isLegacyCustom = !!chatWallpaper && !selected;
  const currentCss = chatWallpaper ? resolveWallpaperStyle(chatWallpaper, colorMode) : null;
  const currentName = selected?.name ?? (isLegacyCustom ? "Custom" : "Default");

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const w of WALLPAPERS) counts.set(w.category, (counts.get(w.category) ?? 0) + 1);
    return [...counts.entries()];
  }, []);

  const visible = filter === ALL ? WALLPAPERS : WALLPAPERS.filter(w => w.category === filter);
  const choose = (id: string | null) => { hapticLight(); setChatWallpaper(id); };

  return (
    <CollapsibleSection
      id="wallpaper"
      title="Chat wallpaper"
      icon={<ImageIcon className="h-4 w-4" />}
      summary={selected?.live ? `${currentName} · live` : currentName}
      preview={
        <span
          className="block h-9 w-9 rounded-xl border border-border/60 overflow-hidden"
          style={{ background: currentCss ?? "hsl(var(--background))" }}
        />
      }
      defaultOpen={false}
    >
      {/* Live preview: the wallpaper behind this theme's own bubbles */}
      <div
        className="relative h-36 rounded-2xl overflow-hidden border border-border/60 mb-3"
        style={{ background: currentCss ?? "hsl(var(--background))" }}
      >
        <span className="absolute top-2 left-2 rounded-full bg-background/70 backdrop-blur px-2 py-0.5 text-[10px] font-medium text-foreground">
          Preview · {currentName}
        </span>
        <div className="absolute inset-x-3 bottom-3 flex flex-col gap-1.5" aria-hidden="true">
          <span className="self-start max-w-[72%] rounded-2xl rounded-bl-md border border-border/50 bg-card px-3 py-1.5 text-[11px] text-card-foreground shadow-sm">
            Good morning ☀️
          </span>
          <span className="self-end max-w-[72%] rounded-2xl rounded-br-md bg-primary px-3 py-1.5 text-[11px] text-primary-foreground shadow-sm">
            Miss you already 💌
          </span>
        </div>
      </div>

      <div
        data-swipe-nav-ignore
        role="group"
        aria-label="Filter wallpapers by category"
        className="flex gap-1.5 overflow-x-auto pb-2 -mx-1 px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {[[ALL, WALLPAPERS.length] as [string, number], ...categories].map(([name, n]) => {
          const on = filter === name;
          return (
            <button
              key={name}
              type="button"
              onClick={() => { hapticLight(); setFilter(name); }}
              aria-pressed={on}
              className={cn(
                "shrink-0 h-8 px-3 rounded-full border text-[11px] font-medium flex items-center gap-1.5 transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                on
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-muted/40 text-muted-foreground border-border/60",
              )}
            >
              {name}
              <span className="opacity-60 tabular-nums">{n}</span>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-3 gap-2.5 mt-1">
        {filter === ALL && (
          <Tile
            name="Default"
            active={!chatWallpaper}
            onClick={() => choose(null)}
            style={{ background: "hsl(var(--background))" }}
            inner={<ImageOff className="h-5 w-5 text-muted-foreground" aria-hidden="true" />}
          />
        )}
        {visible.map(w => (
          <Tile
            key={w.id}
            name={w.name}
            live={w.live}
            active={chatWallpaper === w.id}
            onClick={() => choose(w.id)}
            style={{ background: w.live ? resolveWallpaperStyle(w.id, colorMode) ?? undefined : (colorMode === "dark" ? w.dark : w.light) }}
          />
        ))}
      </div>

      {isLegacyCustom && (
        <p className="text-[10px] text-muted-foreground mt-3">
          You're using a custom wallpaper from an earlier version. Pick one above to replace it.
        </p>
      )}
      {selected?.live && (
        <p className="text-[10px] text-muted-foreground mt-3">
          Dynamic Sky shifts continuously through night, dawn, day and dusk colors as the real time changes — like Apple's dynamic wallpapers.
        </p>
      )}
    </CollapsibleSection>
  );
};

interface TileProps {
  name: string;
  active: boolean;
  onClick: () => void;
  style: React.CSSProperties;
  live?: boolean;
  inner?: React.ReactNode;
}

const Tile = ({ name, active, onClick, style, live, inner }: TileProps) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    aria-label={`${name} wallpaper${live ? ", live" : ""}${active ? ", selected" : ""}`}
    className="group press text-left rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
  >
    <span
      className={cn(
        "relative flex aspect-[4/5] items-center justify-center overflow-hidden rounded-2xl border-2 transition-colors",
        active ? "border-primary" : "border-border/50 group-hover:border-primary/40",
      )}
      style={style}
    >
      {inner}
      {live && (
        <span className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-full bg-black/40 backdrop-blur px-1.5 py-0.5 text-[9px] font-medium text-white">
          <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" /> Live
        </span>
      )}
      {active && (
        <span className="absolute top-1.5 right-1.5 h-5 w-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow">
          <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" />
        </span>
      )}
      {/* Tiny bubbles so each tile reads as "a chat on this wallpaper" */}
      <span className="absolute inset-x-2 bottom-2 flex flex-col gap-1" aria-hidden="true">
        <span className="block h-2 w-3/5 rounded-full bg-card/90" />
        <span className="block h-2 w-2/5 self-end rounded-full bg-primary" />
      </span>
    </span>
    <span className={cn("mt-1 block truncate text-center text-[11px]", active ? "font-medium text-foreground" : "text-muted-foreground")}>
      {name}
    </span>
  </button>
);

export default WallpaperSection;
