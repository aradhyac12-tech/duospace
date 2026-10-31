import { Image, MapPin, Music, Heart, BookOpen, Compass, type LucideIcon } from "lucide-react";

// ─── Duo shared-space hub — canonical destination list ──────────────────────
// This is the single source of truth for GridMenu.tsx (the in-chat sparkle
// "Hub" shortcut) — the only way these destinations are reached, per
// product direction the dock stays a strict 2-tab Chat/Calls model. A
// short-lived Phase 1 experiment also exposed this list as its own
// standalone "Duo" primary dock tab (src/pages/Duo.tsx); that page and its
// dock tab were removed after causing a confusing extra navigation
// affordance, but this shared list stayed — pulling it out once here still
// means adding/removing/reordering a shared feature only ever happens in
// one place, even with a single consumer.
//
// `description` is new (GridMenu's compact tiles never needed one; the
// Duo page's richer list rows do) and purely presentational — it doesn't
// change what route is reached or what that route's own page does.

export interface DuoHubItem {
  /** i18n key stem: label = `hub.${key}`, description = `hub.${key}.desc`. English `label`/`description` stay as the fallback. */
  key: string;
  path: string;
  icon: LucideIcon;
  label: string;
  description: string;
  /** "frequent" gets the slightly more prominent tile treatment in both
   * GridMenu and the Duo page — things a couple opens often. */
  tier: "frequent" | "more";
}

export const DUO_HUB_ITEMS: DuoHubItem[] = [
  { key: "gallery", path: "/gallery", icon: Image, label: "Gallery", description: "Your shared photos and videos", tier: "frequent" },
  { key: "music", path: "/groic", icon: Music, label: "Music", description: "Listen together, live", tier: "frequent" },
  { key: "us", path: "/us", icon: Heart, label: "Us", description: "Memories, moods, and your countdown", tier: "more" },
  { key: "map", path: "/map", icon: MapPin, label: "Map", description: "See where you both are", tier: "more" },
  { key: "shayari", path: "/shayari", icon: BookOpen, label: "Shayari", description: "Verses to share with each other", tier: "more" },
  { key: "reflection", path: "/reflection", icon: Compass, label: "Reflection", description: "A private space to reflect on values, expectations, and how you communicate", tier: "more" },
];
