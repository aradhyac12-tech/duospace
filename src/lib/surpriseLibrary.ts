/**
 * Surprise library — the owner-only "saved uploads" store.
 *
 * Backed by public.surprise_library (see
 * supabase/migrations/20260920110000_surprise_library.sql): RLS restricts
 * every verb to owner_id = auth.uid(), and there is deliberately NO partner
 * policy — saving here never delivers anything to the partner. Delivery is
 * still code_surprises via the editor's Save button.
 *
 * `supabase` is the untyped client (appClient.ts exports it as `any`), same
 * as every other surprise query in this codebase.
 */
import { supabase } from "@/integrations/supabase/appClient";
import { SURPRISE_LIMITS } from "@/lib/surpriseDocument";

export type LibrarySourceType = "manual" | "html" | "css" | "js" | "zip" | "files";

export interface LibraryItem {
  id: string;
  title: string;
  source_type: LibrarySourceType;
  source_name: string | null;
  asset_count: number;
  byte_size: number;
  created_at: string;
  updated_at: string;
}

export interface LibraryItemFull extends LibraryItem {
  html_content: string;
  css_content: string;
  js_content: string;
}

export interface LibrarySaveInput {
  title: string;
  html: string;
  css: string;
  js: string;
  sourceType: LibrarySourceType;
  sourceName?: string | null;
  assetCount?: number;
}

// Listing never pulls the (potentially multi-MB) bodies.
const META_COLUMNS = "id,title,source_type,source_name,asset_count,byte_size,created_at,updated_at";
const FULL_COLUMNS = `${META_COLUMNS},html_content,css_content,js_content`;

export const surpriseChars = (p: { html: string; css: string; js: string }) =>
  p.html.length + p.css.length + p.js.length;

export const listLibrary = async (limit = 100): Promise<LibraryItem[]> => {
  const { data, error } = await supabase
    .from("surprise_library")
    .select(META_COLUMNS)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as LibraryItem[];
};

export const getLibraryItem = async (id: string): Promise<LibraryItemFull> => {
  const { data, error } = await supabase
    .from("surprise_library")
    .select(FULL_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("That library item no longer exists.");
  return data as LibraryItemFull;
};

/** Insert a new library item, or update `existingId` in place. Returns the row id. */
export const saveToLibrary = async (
  ownerId: string,
  input: LibrarySaveInput,
  existingId?: string | null
): Promise<string> => {
  const chars = surpriseChars(input);
  if (chars > SURPRISE_LIMITS.maxSurpriseChars) {
    throw new Error("That's too large to save — remove some embedded media and try again.");
  }
  const payload = {
    owner_id: ownerId,
    title: (input.title || "Untitled upload").slice(0, 200),
    html_content: input.html,
    css_content: input.css,
    js_content: input.js,
    source_type: input.sourceType,
    source_name: input.sourceName ?? null,
    asset_count: input.assetCount ?? 0,
    byte_size: chars,
  };

  if (existingId) {
    const { error } = await supabase
      .from("surprise_library")
      .update(payload)
      .eq("id", existingId)
      .eq("owner_id", ownerId);
    if (error) throw new Error(error.message);
    return existingId;
  }

  const { data, error } = await supabase
    .from("surprise_library")
    .insert(payload)
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
};

export const deleteLibraryItem = async (id: string): Promise<void> => {
  const { error } = await supabase.from("surprise_library").delete().eq("id", id);
  if (error) throw new Error(error.message);
};
