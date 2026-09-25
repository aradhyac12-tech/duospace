import JSZip from "jszip";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { safeLucideIcon } from "./safeIcon";
import type { IconShape, IconBgType } from "./iconPresets";

export interface IconConfig {
  shape: IconShape;
  bgType: IconBgType;
  color1: string;
  color2: string;
  fg: string;
  /** lucide-react icon name, e.g. "Play". Ignored when useLetter is true or uploadedImage is set. */
  symbol: string;
  /** 1-2 char monogram, used when useLetter is true */
  letter: string;
  useLetter: boolean;
  border: boolean;
  borderColor: string;
  borderWidth: number; // px, at 1024 base canvas
  shadow: boolean;
  /** data URL of a user-uploaded image; overrides symbol/letter generation entirely */
  uploadedImage: string | null;
}

const MASTER = 1024;

// ---- shape path ----
function tracePath(ctx: CanvasRenderingContext2D, shape: IconShape, size: number, inset = 0) {
  const s = size - inset * 2;
  const x = inset, y = inset;
  ctx.beginPath();
  if (shape === "circle") {
    ctx.arc(x + s / 2, y + s / 2, s / 2, 0, Math.PI * 2);
  } else {
    const r = shape === "squircle" ? s * 0.32 : shape === "rounded" ? s * 0.18 : 0;
    const rr = Math.min(r, s / 2);
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + s, y, x + s, y + s, rr);
    ctx.arcTo(x + s, y + s, x, y + s, rr);
    ctx.arcTo(x, y + s, x, y, rr);
    ctx.arcTo(x, y, x + s, y, rr);
  }
  ctx.closePath();
}

function paintBackground(ctx: CanvasRenderingContext2D, size: number, cfg: IconConfig) {
  if (cfg.bgType === "gradient") {
    const g = ctx.createLinearGradient(0, 0, size, size);
    g.addColorStop(0, cfg.color1);
    g.addColorStop(1, cfg.color2);
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = cfg.color1;
  }
  ctx.fillRect(0, 0, size, size);
}

async function svgToImage(svgMarkup: string): Promise<HTMLImageElement> {
  const svg = svgMarkup.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ');
  const url = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

async function symbolImage(symbol: string, color: string, px: number): Promise<HTMLImageElement | null> {
  const IconComp = safeLucideIcon(symbol);
  if (!IconComp) return null;
  try {
    const markup = renderToStaticMarkup(
      createElement(IconComp, { color, strokeWidth: 1.6, width: px, height: px })
    );
    return await svgToImage(markup);
  } catch {
    // Rendering a bad/unavailable glyph must never crash the app — the
    // background/monogram/shape still render fine without the symbol.
    return null;
  }
}

async function uploadedImageEl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/**
 * Renders the fully "baked" icon: background shape (clipped) + border + shadow + symbol/letter/upload.
 * `fullBleed` skips shape clipping and draws a full square (used for iOS, which applies its own mask).
 */
async function renderMaster(cfg: IconConfig, fullBleed: boolean): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  canvas.width = MASTER;
  canvas.height = MASTER;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, MASTER, MASTER);

  const inset = cfg.shadow && !fullBleed ? MASTER * 0.04 : 0;

  if (cfg.shadow && !fullBleed) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = MASTER * 0.035;
    ctx.shadowOffsetY = MASTER * 0.018;
    tracePath(ctx, cfg.shape, MASTER, inset);
    ctx.fillStyle = "rgba(0,0,0,0.001)";
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  if (fullBleed) {
    ctx.rect(0, 0, MASTER, MASTER);
  } else {
    tracePath(ctx, cfg.shape, MASTER, inset);
  }
  ctx.clip();
  paintBackground(ctx, MASTER, cfg);

  if (cfg.uploadedImage) {
    const img = await uploadedImageEl(cfg.uploadedImage);
    // cover-fit
    const scale = Math.max(MASTER / img.width, MASTER / img.height);
    const w = img.width * scale, h = img.height * scale;
    ctx.drawImage(img, (MASTER - w) / 2, (MASTER - h) / 2, w, h);
  } else if (cfg.useLetter && cfg.letter) {
    ctx.fillStyle = cfg.fg;
    ctx.font = `700 ${MASTER * 0.46}px 'Space Grotesk', 'Inter', sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(cfg.letter.slice(0, 2).toUpperCase(), MASTER / 2, MASTER / 2 + MASTER * 0.03);
  } else {
    const px = Math.round(MASTER * 0.5);
    const img = await symbolImage(cfg.symbol, cfg.fg, px);
    if (img) ctx.drawImage(img, (MASTER - px) / 2, (MASTER - px) / 2, px, px);
  }
  ctx.restore();

  if (cfg.border && !fullBleed) {
    ctx.save();
    tracePath(ctx, cfg.shape, MASTER, inset + cfg.borderWidth / 2);
    ctx.lineWidth = cfg.borderWidth;
    ctx.strokeStyle = cfg.borderColor;
    ctx.stroke();
    ctx.restore();
  }

  return canvas;
}

/** Transparent foreground-only layer for Android adaptive icons: symbol/letter/upload in the ~66% safe zone. */
async function renderAdaptiveForeground(cfg: IconConfig): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  canvas.width = MASTER;
  canvas.height = MASTER;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, MASTER, MASTER);

  if (cfg.uploadedImage) {
    const img = await uploadedImageEl(cfg.uploadedImage);
    const safe = MASTER * 0.66;
    const scale = Math.min(safe / img.width, safe / img.height);
    const w = img.width * scale, h = img.height * scale;
    ctx.drawImage(img, (MASTER - w) / 2, (MASTER - h) / 2, w, h);
  } else if (cfg.useLetter && cfg.letter) {
    ctx.fillStyle = cfg.fg;
    ctx.font = `700 ${MASTER * 0.32}px 'Space Grotesk', 'Inter', sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(cfg.letter.slice(0, 2).toUpperCase(), MASTER / 2, MASTER / 2 + MASTER * 0.02);
  } else {
    const px = Math.round(MASTER * 0.34);
    const img = await symbolImage(cfg.symbol, cfg.fg, px);
    if (img) ctx.drawImage(img, (MASTER - px) / 2, (MASTER - px) / 2, px, px);
  }
  return canvas;
}

/**
 * Monochrome layer for Android 13+ themed icons. The OS only ever uses this
 * layer's alpha channel — it discards RGB entirely and tints the shape with
 * the user's wallpaper-derived theme color. So the correct "monochrome"
 * asset is just the foreground's silhouette forced to opaque white; it is
 * not a lower-fidelity fallback, it's what Android actually asks for.
 */
async function renderAdaptiveMonochrome(cfg: IconConfig): Promise<HTMLCanvasElement> {
  return renderAdaptiveForeground({ ...cfg, fg: "#FFFFFF" });
}

function renderAdaptiveBackground(cfg: IconConfig): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = MASTER;
  canvas.height = MASTER;
  const ctx = canvas.getContext("2d")!;
  paintBackground(ctx, MASTER, cfg);
  return canvas;
}

function resize(src: HTMLCanvasElement, size: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, size, size);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error(`Failed to encode PNG at ${size}px`));
    }, "image/png");
  });
}

/** Live preview canvas for the studio UI — draws directly into the given <canvas> element. */
export async function paintPreview(
  canvasEl: HTMLCanvasElement,
  cfg: IconConfig,
  size = 256,
  isStale?: () => boolean
) {
  const master = await renderMaster(cfg, false);
  // The config may have changed again while renderMaster was awaiting async
  // work (symbol SVG load, etc); if a newer paintPreview call has since
  // started, drop this stale result instead of painting over it.
  if (isStale?.()) return;
  canvasEl.width = size;
  canvasEl.height = size;
  const ctx = canvasEl.getContext("2d")!;
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(master, 0, 0, size, size);
}

const ANDROID_LEGACY = [
  { dpi: "mdpi", size: 48 }, { dpi: "hdpi", size: 72 }, { dpi: "xhdpi", size: 96 },
  { dpi: "xxhdpi", size: 144 }, { dpi: "xxxhdpi", size: 192 },
];
const ANDROID_ADAPTIVE = [
  { dpi: "mdpi", size: 108 }, { dpi: "hdpi", size: 162 }, { dpi: "xhdpi", size: 216 },
  { dpi: "xxhdpi", size: 324 }, { dpi: "xxxhdpi", size: 432 },
];
// [pointSize, scale, idiom, filename]
const IOS_SIZES: [number, number, string, string][] = [
  [20, 2, "iphone", "AppIcon-20@2x.png"], [20, 3, "iphone", "AppIcon-20@3x.png"],
  [29, 2, "iphone", "AppIcon-29@2x.png"], [29, 3, "iphone", "AppIcon-29@3x.png"],
  [40, 2, "iphone", "AppIcon-40@2x.png"], [40, 3, "iphone", "AppIcon-40@3x.png"],
  [60, 2, "iphone", "AppIcon-60@2x.png"], [60, 3, "iphone", "AppIcon-60@3x.png"],
  [20, 1, "ipad", "AppIcon-20@1x.png"], [20, 2, "ipad", "AppIcon-20@2x-ipad.png"],
  [29, 1, "ipad", "AppIcon-29@1x.png"], [29, 2, "ipad", "AppIcon-29@2x-ipad.png"],
  [40, 1, "ipad", "AppIcon-40@1x.png"], [40, 2, "ipad", "AppIcon-40@2x-ipad.png"],
  [76, 1, "ipad", "AppIcon-76@1x.png"], [76, 2, "ipad", "AppIcon-76@2x.png"],
  [83.5, 2, "ipad", "AppIcon-83.5@2x.png"],
  [1024, 1, "ios-marketing", "AppIcon-1024.png"],
];

function iosContentsJson(): string {
  const images = IOS_SIZES.map(([pt, scale, idiom, filename]) => ({
    size: `${pt}x${pt}`,
    idiom,
    filename,
    scale: `${scale}x`,
  }));
  return JSON.stringify({ images, info: { version: 1, author: "xcode" } }, null, 2);
}

/**
 * Builds a downloadable zip containing:
 *  - resources/icon.png, icon-foreground.png, icon-background.png, icon-monochrome.png
 *    (source files for `npx capacitor-assets generate`)
 *  - android mipmap densities: ic_launcher.png + ic_launcher_round.png (legacy)
 *  - android mipmap densities: ic_launcher_foreground/background/monochrome.png (adaptive, incl. Android 13+ themed icon)
 *  - ios AppIcon.appiconset PNGs + Contents.json
 *  - icon-preview-1024.png, favicon-512.png, apple-touch-icon-180.png
 */
export async function generateIconAssetZip(cfg: IconConfig): Promise<Blob> {
  const zip = new JSZip();

  const master = await renderMaster(cfg, false);
  const masterFullBleed = await renderMaster(cfg, true);
  const adaptiveFg = await renderAdaptiveForeground(cfg);
  const adaptiveBg = renderAdaptiveBackground(cfg);
  const adaptiveMono = await renderAdaptiveMonochrome(cfg);

  // --- resources/ (capacitor-assets source files) ---
  zip.file("resources/icon.png", await resize(masterFullBleed, 1024));
  zip.file("resources/icon-foreground.png", await resize(adaptiveFg, 1024));
  zip.file("resources/icon-background.png", await resize(adaptiveBg, 1024));
  zip.file("resources/icon-monochrome.png", await resize(adaptiveMono, 1024));

  // --- Android legacy mipmaps ---
  for (const { dpi, size } of ANDROID_LEGACY) {
    const blob = await resize(master, size);
    zip.file(`android/app/src/main/res/mipmap-${dpi}/ic_launcher.png`, blob);
    zip.file(`android/app/src/main/res/mipmap-${dpi}/ic_launcher_round.png`, blob);
  }
  // --- Android adaptive layers (foreground, background, monochrome) ---
  for (const { dpi, size } of ANDROID_ADAPTIVE) {
    zip.file(`android/app/src/main/res/mipmap-${dpi}/ic_launcher_foreground.png`, await resize(adaptiveFg, size));
    zip.file(`android/app/src/main/res/mipmap-${dpi}/ic_launcher_background.png`, await resize(adaptiveBg, size));
    zip.file(`android/app/src/main/res/mipmap-${dpi}/ic_launcher_monochrome.png`, await resize(adaptiveMono, size));
  }
  const adaptiveIconXml =
    `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n` +
    `    <background android:drawable="@mipmap/ic_launcher_background"/>\n` +
    `    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n` +
    `    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>\n` +
    `</adaptive-icon>\n`;
  zip.file("android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml", adaptiveIconXml);
  zip.file("android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml", adaptiveIconXml);

  // --- iOS AppIcon.appiconset ---
  const iosFolder = "ios/App/App/Assets.xcassets/AppIcon.appiconset";
  for (const [pt, scale, , filename] of IOS_SIZES) {
    const px = Math.round(pt * scale);
    zip.file(`${iosFolder}/${filename}`, await resize(masterFullBleed, px));
  }
  zip.file(`${iosFolder}/Contents.json`, iosContentsJson());

  // --- misc / web ---
  zip.file("icon-preview-1024.png", await resize(master, 1024));
  zip.file("favicon-512.png", await resize(masterFullBleed, 512));
  zip.file("apple-touch-icon-180.png", await resize(masterFullBleed, 180));

  zip.file(
    "README.txt",
    "Generated by the DuoSpace Icon Studio.\n\n" +
      "Quick path (recommended): copy the resources/ folder into your project root\n" +
      "(replacing the existing resources/icon.png etc.) then run:\n" +
      "  npx @capacitor/assets generate\n" +
      "This regenerates every Android/iOS size correctly, including adaptive-icon XML\n" +
      "and the Android 13+ monochrome themed-icon layer.\n\n" +
      "Manual path: the android/ and ios/ folders in this zip already contain every\n" +
      "size Android and iOS require (legacy mipmaps, adaptive icon layers incl.\n" +
      "monochrome, and the full AppIcon.appiconset with Contents.json) if you'd\n" +
      "rather drop them in directly.\n\n" +
      "Whole-project path: run `node scripts/apply-whitelabel.mjs <appId>` from the\n" +
      "project root after placing this zip's resources/ folder at\n" +
      "whitelabel/<appId>/resources/ — it patches capacitor.config.ts, the Android\n" +
      "manifest/strings/applicationId, and the iOS Info.plist/bundle id to match\n" +
      "that app's registered name and package/bundle id, then (if @capacitor/assets\n" +
      "is installed) regenerates the native icons from these files.\n"
  );

  return zip.generateAsync({ type: "blob" });
}

/** Expected file counts, used to sanity-check a generated zip (and for reporting). */
export function getExpectedAssetManifest() {
  return {
    resources: 4, // icon, icon-foreground, icon-background, icon-monochrome
    androidLegacyFiles: ANDROID_LEGACY.length * 2, // ic_launcher + ic_launcher_round per density
    androidAdaptiveFiles: ANDROID_ADAPTIVE.length * 3, // foreground + background + monochrome per density
    androidXmlFiles: 2, // ic_launcher.xml + ic_launcher_round.xml
    iosImageFiles: IOS_SIZES.length,
    iosJsonFiles: 1, // Contents.json
    misc: 3, // icon-preview-1024, favicon-512, apple-touch-icon-180
  };
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function renderDataUrl(cfg: IconConfig, size = 512): Promise<string> {
  const master = await renderMaster(cfg, false);
  const blob = await resize(master, size);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}
