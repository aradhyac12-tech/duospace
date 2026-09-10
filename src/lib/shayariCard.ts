// Renders a single shayari as a canvas "card" — used for both the .png
// card export and as the per-page artwork inside the PDF export, so the
// two formats look identical. Colors and fonts are read live from the
// page's CSS custom properties, so the card always matches whatever
// theme (including a custom Theme Studio theme, light/dark) is active —
// same design tokens the in-app Shayari list uses, not a hardcoded palette.

export interface ShayariCardEntry {
  title: string | null;
  content: string;
  authorName?: string | null;
  createdAt?: string | null;
  isFavorite?: boolean;
}

function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function hsl(triplet: string, alpha = 1): string {
  return alpha < 1 ? `hsl(${triplet} / ${alpha})` : `hsl(${triplet})`;
}

function fontFamily(varName: string, fallback: string): string {
  // --font-heading / --font-body are already full font-family stacks (e.g.
  // "'Space Grotesk', system-ui, sans-serif") — safe to drop straight into
  // ctx.font.
  return cssVar(varName, fallback);
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Wraps text respecting explicit newlines (a shayari's line breaks are the point) and only word-wraps a line that overflows maxWidth. */
function wrapPreservingBreaks(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine === "") { out.push(""); continue; }
    const words = rawLine.split(" ");
    let current = "";
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && current) {
        out.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    out.push(current);
  }
  return out;
}

export interface RenderCardOptions {
  width?: number;
  height?: number;
}

export function renderShayariCard(entry: ShayariCardEntry, opts: RenderCardOptions = {}): HTMLCanvasElement {
  const width = opts.width ?? 1080;
  const height = opts.height ?? 1350;
  const scale = width / 1080; // keeps proportions consistent across card (1080) and page (1240) sizes

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  const bgCanvas = cssVar("--bg-canvas", "230 20% 97%");
  const cardHsl = cssVar("--card", "0 0% 100%");
  const foreground = cssVar("--foreground", "230 15% 14%");
  const mutedFg = cssVar("--muted-foreground", "230 8% 45%");
  const primary = cssVar("--primary", "255 90% 62%");
  const border = cssVar("--border", "230 12% 88%");
  const headingFont = fontFamily("--font-heading", "'Space Grotesk', system-ui, sans-serif");
  const bodyFont = fontFamily("--font-body", "'Inter', system-ui, sans-serif");

  // Outer wash
  ctx.fillStyle = hsl(bgCanvas);
  ctx.fillRect(0, 0, width, height);

  // Inset card panel with soft shadow — mirrors the in-app bg-card rounded-2xl border shadow-sm treatment
  const pad = 56 * scale;
  const panelX = pad, panelY = pad, panelW = width - pad * 2, panelH = height - pad * 2;
  ctx.save();
  ctx.shadowColor = hsl("230 20% 10%", 0.16);
  ctx.shadowBlur = 40 * scale;
  ctx.shadowOffsetY = 16 * scale;
  ctx.fillStyle = hsl(cardHsl);
  roundRectPath(ctx, panelX, panelY, panelW, panelH, 28 * scale);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = hsl(border);
  ctx.lineWidth = 1.5 * scale;
  roundRectPath(ctx, panelX, panelY, panelW, panelH, 28 * scale);
  ctx.stroke();

  const contentPad = panelX + 56 * scale;
  const contentW = panelW - 112 * scale;
  let cursorY = panelY + 96 * scale;

  // Big translucent quote mark, matching the in-app decorative " glyph
  ctx.fillStyle = hsl(mutedFg, 0.12);
  ctx.font = `700 ${170 * scale}px ${headingFont}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText("\u201C", contentPad - 8 * scale, panelY + 150 * scale);

  // Favorite mark
  if (entry.isFavorite) {
    ctx.fillStyle = hsl(primary);
    ctx.font = `${28 * scale}px ${bodyFont}`;
    ctx.textAlign = "right";
    ctx.fillText("\u2665", panelX + panelW - 56 * scale, panelY + 80 * scale);
    ctx.textAlign = "left";
  }

  // Title
  if (entry.title) {
    ctx.fillStyle = hsl(primary);
    ctx.font = `700 ${26 * scale}px ${headingFont}`;
    ctx.fillText(entry.title.toUpperCase(), contentPad, cursorY);
    cursorY += 56 * scale;
  } else {
    cursorY += 12 * scale;
  }

  // Content — italic body font, generous line height, left-indented like the in-app pl-3 treatment
  const bodySize = 40 * scale;
  const lineHeight = bodySize * 1.65;
  ctx.font = `italic 500 ${bodySize}px ${bodyFont}`;
  ctx.fillStyle = hsl(foreground, 0.92);
  const indent = contentPad + 20 * scale;
  const lines = wrapPreservingBreaks(ctx, entry.content, contentW - 20 * scale);
  const maxLines = Math.floor((panelH - 96 * scale - 140 * scale - (cursorY - panelY)) / lineHeight);
  const visibleLines = lines.length > maxLines ? [...lines.slice(0, Math.max(1, maxLines - 1)), "\u2026"] : lines;
  for (const line of visibleLines) {
    ctx.fillText(line, indent, cursorY);
    cursorY += lineHeight;
  }

  // Footer — author · date, left; DuoSpace wordmark, right
  const footerY = panelY + panelH - 56 * scale;
  ctx.strokeStyle = hsl(border);
  ctx.lineWidth = 1 * scale;
  ctx.beginPath();
  ctx.moveTo(contentPad, footerY - 32 * scale);
  ctx.lineTo(panelX + panelW - 56 * scale, footerY - 32 * scale);
  ctx.stroke();

  ctx.font = `500 ${22 * scale}px ${bodyFont}`;
  ctx.fillStyle = hsl(mutedFg);
  const metaBits = [entry.authorName, entry.createdAt ? new Date(entry.createdAt).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" }) : null].filter(Boolean);
  ctx.fillText(metaBits.join("  ·  "), contentPad, footerY);

  ctx.textAlign = "right";
  ctx.font = `600 ${22 * scale}px ${headingFont}`;
  ctx.fillStyle = hsl(primary, 0.85);
  ctx.fillText("DuoSpace", panelX + panelW - 56 * scale, footerY);
  ctx.textAlign = "left";

  return canvas;
}

export function canvasToPngBase64(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/png").split(",")[1];
}

export function canvasToJpegDataUrl(canvas: HTMLCanvasElement, quality = 0.92): string {
  return canvas.toDataURL("image/jpeg", quality);
}

export function sanitizeFileFragment(s: string, fallback: string): string {
  const cleaned = s.trim().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 40);
  return cleaned || fallback;
}
