/**
 * backStack — a tiny LIFO registry so the Android back button can close the
 * thing the person is actually looking at (photo viewer, custom sheet, chat
 * search, selection mode …) before it ever navigates between pages.
 *
 * Components register through `useBackHandler(active, handler)`; the native
 * back listener in useAppNative calls `runTopBackHandler()` first.
 * Radix-based overlays (Dialog / Sheet / Drawer / AlertDialog / menus) need no
 * registration — `dismissOpenRadixLayer()` closes them via Escape.
 */
type Entry = { id: number; handler: () => boolean | void };

let nextId = 1;
const stack: Entry[] = [];

export function pushBackHandler(handler: () => boolean | void): () => void {
  const entry: Entry = { id: nextId++, handler };
  stack.push(entry);
  return () => {
    const i = stack.findIndex((e) => e.id === entry.id);
    if (i !== -1) stack.splice(i, 1);
  };
}

/** Runs the most recently registered handler. Returns true if back was consumed. */
export function runTopBackHandler(): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    const result = stack[i].handler();
    // A handler returning `false` explicitly declines; anything else consumes.
    if (result !== false) return true;
  }
  return false;
}

const RADIX_OPEN_LAYER =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]';

/** Closes the topmost open Radix layer (if any) by sending Escape. */
export function dismissOpenRadixLayer(): boolean {
  if (typeof document === "undefined") return false;
  if (!document.querySelector(RADIX_OPEN_LAYER)) return false;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true }));
  return true;
}
