/**
 * Editing a shayari — small pure helpers so the rules are testable without
 * rendering the page.
 *
 * Only the person who wrote a shayari may edit it. That is enforced for real
 * by the database (the "Update own shayaris" policy on public.shayaris only
 * matches rows where user_id = auth.uid(), and an UPDATE can't reassign
 * user_id); hiding the button for the partner's shayaris is just the UI
 * matching that rule.
 */

export interface EditableShayari {
  user_id: string;
  title: string | null;
  content: string;
}

export interface ShayariDraft {
  title: string;
  content: string;
}

export interface ShayariEditPatch {
  title: string | null;
  content: string;
}

/** True only for the shayari's author. */
export function canEditShayari(item: Pick<EditableShayari, "user_id">, userId: string | null | undefined): boolean {
  return !!userId && item.user_id === userId;
}

export type ShayariEditResult =
  | { status: "invalid" }              // nothing to save (empty body)
  | { status: "unchanged" }            // same text as before — no write needed
  | { status: "changed"; patch: ShayariEditPatch };

/** Normalises the draft the same way "add" does (trim; empty title → null). */
export function buildShayariEditPatch(original: Pick<EditableShayari, "title" | "content">, draft: ShayariDraft): ShayariEditResult {
  const content = draft.content.trim();
  if (!content) return { status: "invalid" };
  const title = draft.title.trim() || null;
  if (title === (original.title ?? null) && content === original.content) return { status: "unchanged" };
  return { status: "changed", patch: { title, content } };
}
