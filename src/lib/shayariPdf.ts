import { renderShayariCard, canvasToJpegDataUrl, type ShayariCardEntry } from "@/lib/shayariCard";

// A4 portrait at ~150dpi — sharp on screen, reasonable file size, standard print size.
const PAGE_W = 1240;
const PAGE_H = 1754;

/** Builds a PDF (one shayari per page, same card artwork as the .png export) and returns base64 bytes. */
export async function buildShayariPdfBase64(entries: ShayariCardEntry[]): Promise<string> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "px", format: [PAGE_W, PAGE_H], compress: true });

  entries.forEach((entry, i) => {
    if (i > 0) doc.addPage([PAGE_W, PAGE_H], "portrait");
    const canvas = renderShayariCard(entry, { width: PAGE_W, height: PAGE_H });
    const imgData = canvasToJpegDataUrl(canvas, 0.92);
    doc.addImage(imgData, "JPEG", 0, 0, PAGE_W, PAGE_H);
  });

  const dataUri = doc.output("datauristring");
  return dataUri.split(",")[1];
}

/** Renders each entry as a PNG card and zips them together. Returns base64 zip bytes. */
export async function buildShayariCardsZipBase64(
  entries: (ShayariCardEntry & { fileNameHint: string })[]
): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const { renderShayariCard: render, canvasToPngBase64 } = await import("@/lib/shayariCard");
  const zip = new JSZip();
  const usedNames = new Set<string>();

  entries.forEach((entry, i) => {
    const canvas = render(entry, { width: 1080, height: 1350 });
    const base64 = canvasToPngBase64(canvas);
    let name = `${entry.fileNameHint}.png`;
    let n = 2;
    while (usedNames.has(name)) { name = `${entry.fileNameHint}-${n++}.png`; }
    usedNames.add(name);
    zip.file(name, base64, { base64: true });
  });

  return zip.generateAsync({ type: "base64" });
}
