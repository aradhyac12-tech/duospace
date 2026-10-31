import { Mic, Music3, Headphones, Zap, Radio, Sparkles, Coffee, Waves, Music2, Heart, Moon, Music4, Cloud, Leaf, Flame, Sun, Disc3, type LucideIcon } from "lucide-react";

/** One glyph per genre id — drawn big and tilted on the browse tiles and as a watermark on the genre page. */
const ICONS: Record<string, LucideIcon> = {
  pop: Mic, indie: Music3, hiphop: Headphones, rock: Zap, electronic: Radio, dance: Sparkles,
  lofi: Coffee, chill: Waves, acoustic: Music2, rnb: Heart, jazz: Moon, classical: Music4,
  ambient: Cloud, folk: Leaf, metal: Flame, reggae: Sun,
};
export const genreIcon = (id: string): LucideIcon => ICONS[id] ?? Disc3;
