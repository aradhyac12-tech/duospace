import * as LucideIcons from "lucide-react";
import type { ComponentType } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyIconProps = any;

/**
 * Safely resolves a lucide-react icon by name.
 *
 * Icon names on presets/config are just strings (they can come from stored
 * per-app config loaded from IndexedDB, which could in principle be stale
 * after a lucide-react upgrade renames/removes an icon). This guarantees an
 * unknown, renamed, or otherwise-invalid name NEVER throws — it just yields
 * null so callers can skip rendering that glyph instead of crashing.
 */
export function safeLucideIcon(name: string | null | undefined): ComponentType<AnyIconProps> | null {
  if (!name || typeof name !== "string") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candidate = (LucideIcons as any)[name];
  // Guard against name colliding with a non-component export (e.g. a helper
  // function or the `icons` lookup object lucide-react also exports).
  if (typeof candidate !== "function") return null;
  return candidate as ComponentType<AnyIconProps>;
}
