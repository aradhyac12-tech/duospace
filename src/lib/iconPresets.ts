// Icon Preset Library
//
// Every preset here is an ORIGINAL icon concept inspired by a recognizable
// app CATEGORY (video platform, social app, learning app, etc). None of
// these reproduce, trace, or embed any real company's logo, mark, or
// proprietary artwork. The "symbol" is a generic lucide-react glyph and the
// colors are a generic palette associated with that category of app — the
// same raw material any designer would start from for that category.

export type IconShape = "squircle" | "circle" | "rounded" | "square";
export type IconBgType = "solid" | "gradient";

export interface IconPreset {
  id: string;
  name: string;
  /** Grouping used for the category filter chips */
  category: string;
  /** Extra words the search box matches against */
  keywords: string[];
  /** lucide-react icon component name, e.g. "Play" */
  symbol: string;
  shape: IconShape;
  bgType: IconBgType;
  /** solid fill or gradient "from" color */
  color1: string;
  /** gradient "to" color (ignored when bgType === "solid") */
  color2: string;
  /** color of the symbol / monogram drawn on top */
  fg: string;
  /** short note shown in the UI so it's clear this is category inspiration, not a copy */
  inspiration?: string;
}

export const ICON_CATEGORIES = [
  "Media",
  "Social & Community",
  "Learning",
  "Productivity",
  "Health",
  "Lifestyle",
  "Utilities",
  "Tools",
  "Custom",
] as const;

export const ICON_PRESETS: IconPreset[] = [
  // ---------- Media ----------
  { id: "video-platform", name: "Video Platform", category: "Media", keywords: ["youtube", "video", "streaming", "watch"], symbol: "Play", shape: "rounded", bgType: "solid", color1: "#FF3B30", color2: "#FF3B30", fg: "#FFFFFF", inspiration: "YouTube-style" },
  { id: "video-player", name: "Video Player", category: "Media", keywords: ["player", "movies", "clips"], symbol: "MonitorPlay", shape: "squircle", bgType: "gradient", color1: "#1E1E2E", color2: "#3A3A55", fg: "#FFFFFF" },
  { id: "music", name: "Music", category: "Media", keywords: ["songs", "audio", "player", "spotify"], symbol: "Music2", shape: "circle", bgType: "gradient", color1: "#1DB954", color2: "#0E7A38", fg: "#FFFFFF" },
  { id: "podcast", name: "Podcast", category: "Media", keywords: ["audio", "shows", "episodes"], symbol: "Mic2", shape: "squircle", bgType: "gradient", color1: "#8E44AD", color2: "#4A235A", fg: "#FFFFFF" },
  { id: "photos", name: "Photos", category: "Media", keywords: ["gallery", "pictures", "camera roll"], symbol: "Image", shape: "rounded", bgType: "gradient", color1: "#FFC371", color2: "#FF5F6D", fg: "#FFFFFF" },
  { id: "albums", name: "Albums / Gallery", category: "Media", keywords: ["collections", "memories"], symbol: "GalleryHorizontalEnd", shape: "squircle", bgType: "gradient", color1: "#F857A6", color2: "#FF5858", fg: "#FFFFFF" },
  { id: "camera", name: "Camera", category: "Media", keywords: ["capture", "photo"], symbol: "Camera", shape: "circle", bgType: "gradient", color1: "#2C3E50", color2: "#4CA1AF", fg: "#FFFFFF" },
  { id: "instagram-social", name: "Instagram-style Social", category: "Media", keywords: ["instagram", "feed", "stories", "camera social"], symbol: "Camera", shape: "squircle", bgType: "gradient", color1: "#F58529", color2: "#8134AF", fg: "#FFFFFF", inspiration: "Instagram-style" },

  // ---------- Social & Community ----------
  { id: "chat", name: "Chat / Messaging", category: "Social & Community", keywords: ["messages", "dm", "conversation"], symbol: "MessageCircle", shape: "circle", bgType: "gradient", color1: "#22C1C3", color2: "#0EA5E9", fg: "#FFFFFF" },
  { id: "calls", name: "Calls", category: "Social & Community", keywords: ["phone", "voice", "dial"], symbol: "Phone", shape: "circle", bgType: "solid", color1: "#34C759", color2: "#34C759", fg: "#FFFFFF" },
  { id: "social-community", name: "Community / Forum", category: "Social & Community", keywords: ["forum", "discuss", "threads"], symbol: "Users", shape: "rounded", bgType: "gradient", color1: "#FF9966", color2: "#FF5E62", fg: "#FFFFFF" },
  { id: "social-community-2", name: "Social Community", category: "Social & Community", keywords: ["network", "friends", "feed"], symbol: "Users2", shape: "squircle", bgType: "gradient", color1: "#396AFC", color2: "#2948FF", fg: "#FFFFFF" },
  { id: "dating", name: "Dating", category: "Social & Community", keywords: ["match", "swipe", "romance"], symbol: "Heart", shape: "circle", bgType: "gradient", color1: "#FF5864", color2: "#FD267A", fg: "#FFFFFF" },
  { id: "contacts", name: "Contacts", category: "Social & Community", keywords: ["address book", "people"], symbol: "Contact", shape: "rounded", bgType: "solid", color1: "#5856D6", color2: "#5856D6", fg: "#FFFFFF" },

  // ---------- Learning ----------
  { id: "duolingo-learning", name: "Duolingo-style Learning", category: "Learning", keywords: ["duolingo", "language", "lessons", "mascot"], symbol: "Bird", shape: "squircle", bgType: "solid", color1: "#58CC02", color2: "#58CC02", fg: "#FFFFFF", inspiration: "Duolingo-style" },
  { id: "prepladder-medical", name: "PrepLadder-style Medical Education", category: "Learning", keywords: ["prepladder", "nursing", "mbbs prep", "exam prep"], symbol: "Stethoscope", shape: "rounded", bgType: "gradient", color1: "#0F2C59", color2: "#1E6FD9", fg: "#FFFFFF", inspiration: "PrepLadder-style" },
  { id: "books-reading", name: "Books / Reading", category: "Learning", keywords: ["ebook", "library", "novel"], symbol: "BookOpen", shape: "rounded", bgType: "gradient", color1: "#D97706", color2: "#92400E", fg: "#FFFFFF" },
  { id: "school-education", name: "School / Education", category: "Learning", keywords: ["classroom", "student", "lms"], symbol: "GraduationCap", shape: "squircle", bgType: "gradient", color1: "#4361EE", color2: "#3A0CA3", fg: "#FFFFFF" },
  { id: "university-campus", name: "University / Campus", category: "Learning", keywords: ["college", "campus", "academic"], symbol: "Landmark", shape: "rounded", bgType: "solid", color1: "#1B2A4A", color2: "#1B2A4A", fg: "#FFFFFF" },

  // ---------- Health ----------
  { id: "medical-mbbs", name: "Medical / MBBS", category: "Health", keywords: ["doctor", "clinical", "med school"], symbol: "Cross", shape: "circle", bgType: "solid", color1: "#E63946", color2: "#E63946", fg: "#FFFFFF" },
  { id: "hospital-healthcare", name: "Hospital / Healthcare", category: "Health", keywords: ["clinic", "care", "patient"], symbol: "HeartPulse", shape: "squircle", bgType: "gradient", color1: "#00B4D8", color2: "#0077B6", fg: "#FFFFFF" },
  { id: "pharmacy", name: "Pharmacy", category: "Health", keywords: ["medicine", "meds", "prescription"], symbol: "Pill", shape: "rounded", bgType: "gradient", color1: "#06D6A0", color2: "#118AB2", fg: "#FFFFFF" },
  { id: "fitness", name: "Fitness", category: "Health", keywords: ["workout", "gym", "exercise"], symbol: "Dumbbell", shape: "squircle", bgType: "gradient", color1: "#FF6B35", color2: "#F7931E", fg: "#FFFFFF" },

  // ---------- Lifestyle ----------
  { id: "finance-banking", name: "Finance / Banking", category: "Lifestyle", keywords: ["bank", "money", "wallet"], symbol: "Landmark", shape: "rounded", bgType: "gradient", color1: "#134E5E", color2: "#71B280", fg: "#FFFFFF" },
  { id: "shopping", name: "Shopping", category: "Lifestyle", keywords: ["store", "cart", "ecommerce"], symbol: "ShoppingBag", shape: "squircle", bgType: "gradient", color1: "#FF9A9E", color2: "#FAD0C4", fg: "#3D2C2E" },
  { id: "food", name: "Food", category: "Lifestyle", keywords: ["delivery", "restaurant", "recipes"], symbol: "UtensilsCrossed", shape: "circle", bgType: "gradient", color1: "#FF7E5F", color2: "#FEB47B", fg: "#FFFFFF" },
  { id: "travel", name: "Travel", category: "Lifestyle", keywords: ["trips", "flights", "explore"], symbol: "Plane", shape: "rounded", bgType: "gradient", color1: "#2193B0", color2: "#6DD5ED", fg: "#FFFFFF" },
  { id: "maps", name: "Maps", category: "Lifestyle", keywords: ["navigation", "gps", "directions"], symbol: "MapPin", shape: "squircle", bgType: "solid", color1: "#34A853", color2: "#34A853", fg: "#FFFFFF" },
  { id: "weather", name: "Weather", category: "Lifestyle", keywords: ["forecast", "climate", "sun rain"], symbol: "CloudSun", shape: "circle", bgType: "gradient", color1: "#56CCF2", color2: "#2F80ED", fg: "#FFFFFF" },
  { id: "news", name: "News", category: "Lifestyle", keywords: ["articles", "headlines", "press"], symbol: "Newspaper", shape: "rounded", bgType: "solid", color1: "#1D1D1F", color2: "#1D1D1F", fg: "#FFFFFF" },
  { id: "games", name: "Games", category: "Lifestyle", keywords: ["gaming", "play", "arcade"], symbol: "Gamepad2", shape: "squircle", bgType: "gradient", color1: "#7B2FF7", color2: "#F107A3", fg: "#FFFFFF" },
  { id: "business", name: "Business", category: "Lifestyle", keywords: ["corporate", "work", "enterprise"], symbol: "Briefcase", shape: "rounded", bgType: "solid", color1: "#2C3E50", color2: "#2C3E50", fg: "#FFFFFF" },

  // ---------- Utilities ----------
  { id: "calculator", name: "Calculator", category: "Utilities", keywords: ["math", "numbers"], symbol: "Calculator", shape: "rounded", bgType: "solid", color1: "#374151", color2: "#374151", fg: "#F97316" },
  { id: "calendar", name: "Calendar", category: "Utilities", keywords: ["schedule", "dates", "events"], symbol: "Calendar", shape: "rounded", bgType: "solid", color1: "#FFFFFF", color2: "#FFFFFF", fg: "#EA4335" },
  { id: "clock", name: "Clock", category: "Utilities", keywords: ["time", "alarm"], symbol: "Clock", shape: "circle", bgType: "solid", color1: "#1C1C1E", color2: "#1C1C1E", fg: "#FFFFFF" },
  { id: "settings", name: "Settings", category: "Utilities", keywords: ["preferences", "gear", "config"], symbol: "Settings", shape: "squircle", bgType: "solid", color1: "#8E8E93", color2: "#8E8E93", fg: "#FFFFFF" },
  { id: "mail", name: "Mail", category: "Utilities", keywords: ["email", "inbox"], symbol: "Mail", shape: "rounded", bgType: "gradient", color1: "#4285F4", color2: "#1A73E8", fg: "#FFFFFF" },

  // ---------- Tools ----------
  { id: "notes", name: "Notes", category: "Tools", keywords: ["memo", "write", "jot"], symbol: "StickyNote", shape: "rounded", bgType: "solid", color1: "#FFD60A", color2: "#FFD60A", fg: "#3D3000" },
  { id: "files", name: "Files", category: "Tools", keywords: ["storage", "documents", "folders"], symbol: "Folder", shape: "rounded", bgType: "solid", color1: "#5AC8FA", color2: "#5AC8FA", fg: "#FFFFFF" },
  { id: "documents", name: "Documents", category: "Tools", keywords: ["docs", "text", "writer"], symbol: "FileText", shape: "rounded", bgType: "gradient", color1: "#4A90D9", color2: "#2C5F9E", fg: "#FFFFFF" },
  { id: "drive-cloud", name: "Drive / Cloud Storage", category: "Tools", keywords: ["cloud", "sync", "backup"], symbol: "Cloud", shape: "squircle", bgType: "gradient", color1: "#00C6FF", color2: "#0072FF", fg: "#FFFFFF" },
  { id: "scanner", name: "Scanner", category: "Tools", keywords: ["scan", "document capture"], symbol: "ScanLine", shape: "rounded", bgType: "solid", color1: "#0F172A", color2: "#0F172A", fg: "#38BDF8" },
  { id: "qr-scanner", name: "QR Scanner", category: "Tools", keywords: ["qr code", "barcode"], symbol: "QrCode", shape: "squircle", bgType: "solid", color1: "#111827", color2: "#111827", fg: "#FFFFFF" },
  { id: "password-manager", name: "Password Manager", category: "Tools", keywords: ["vault", "security", "keys"], symbol: "KeyRound", shape: "rounded", bgType: "gradient", color1: "#1E293B", color2: "#334155", fg: "#FBBF24" },
  { id: "browser", name: "Browser", category: "Tools", keywords: ["web", "internet"], symbol: "Globe", shape: "circle", bgType: "gradient", color1: "#4285F4", color2: "#34A853", fg: "#FFFFFF" },
  { id: "productivity", name: "Productivity", category: "Tools", keywords: ["tasks", "todo", "planner"], symbol: "ListChecks", shape: "rounded", bgType: "gradient", color1: "#845EC2", color2: "#4E3D8C", fg: "#FFFFFF" },
  { id: "developer-coding", name: "Developer / Coding", category: "Tools", keywords: ["code", "ide", "programming"], symbol: "Code2", shape: "squircle", bgType: "solid", color1: "#111827", color2: "#111827", fg: "#10B981" },
  { id: "ai-assistant", name: "AI Assistant", category: "Tools", keywords: ["assistant", "chatbot", "smart"], symbol: "Sparkles", shape: "circle", bgType: "gradient", color1: "#6366F1", color2: "#8B5CF6", fg: "#FFFFFF" },

  // ---------- Custom ----------
  { id: "custom-blank", name: "Custom", category: "Custom", keywords: ["blank", "start from scratch", "monogram"], symbol: "Sparkles", shape: "squircle", bgType: "gradient", color1: "#7C3AED", color2: "#4F46E5", fg: "#FFFFFF" },
];

export const getPresetById = (id: string): IconPreset | undefined =>
  ICON_PRESETS.find(p => p.id === id);

export const searchPresets = (query: string, category?: string): IconPreset[] => {
  const q = query.trim().toLowerCase();
  return ICON_PRESETS.filter(p => {
    if (category && category !== "All" && p.category !== category) return false;
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q) ||
      p.keywords.some(k => k.includes(q))
    );
  });
};

/** Deterministic accent pick for "Generate From App Name" */
const NAME_PALETTE: [string, string][] = [
  ["#7C3AED", "#4F46E5"], ["#0EA5E9", "#2563EB"], ["#F59E0B", "#EA580C"],
  ["#10B981", "#059669"], ["#EC4899", "#DB2777"], ["#EF4444", "#B91C1C"],
  ["#14B8A6", "#0D9488"], ["#8B5CF6", "#6D28D9"],
];

export const generateFromAppName = (appName: string): IconPreset => {
  const trimmed = appName.trim() || "App";
  let hash = 0;
  for (let i = 0; i < trimmed.length; i++) hash = (hash * 31 + trimmed.charCodeAt(i)) >>> 0;
  const [c1, c2] = NAME_PALETTE[hash % NAME_PALETTE.length];
  return {
    id: "generated-from-name",
    name: `${trimmed} (generated)`,
    category: "Custom",
    keywords: [],
    symbol: "Sparkles",
    shape: "squircle",
    bgType: "gradient",
    color1: c1,
    color2: c2,
    fg: "#FFFFFF",
  };
};
