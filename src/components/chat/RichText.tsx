/**
 * RichText
 * ────────
 * Renders message text with:
 *   - Full word-wrap / overflow-wrap so no bubble ever forces horizontal scroll.
 *   - URL detection: turns bare https?:// and www. links into tappable spans
 *     that open a small action sheet (Open in browser / Copy link) — same
 *     pattern WhatsApp uses on mobile (no <a href> that navigates away
 *     without warning).
 *   - Preserves existing whitespace-pre-wrap / newline behaviour unchanged.
 *
 * Usage: drop-in replacement for the <p> in MessageBubble's text branch.
 *   <RichText text={msg.decryptedContent} isMine={isMine} />
 */
import { useState, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ExternalLink, Copy, X } from "lucide-react";
import { hapticLight, hapticSuccess } from "@/lib/haptics";
import { Capacitor } from "@capacitor/core";
import { logError } from "@/lib/telemetry";

// URL regex: matches http(s):// or www. prefixed URLs.
// Deliberately conservative — doesn't try to match every possible TLD,
// just the obvious patterns a user would type in a chat message.
const URL_RE = /https?:\/\/[^\s<>"']+|www\.[^\s<>"'.][^\s<>"']*/gi;

type Segment = { type: "text"; value: string } | { type: "url"; value: string; href: string };

function parseSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text)) !== null) {
    if (match.index > last) {
      segments.push({ type: "text", value: text.slice(last, match.index) });
    }
    const raw = match[0];
    // Strip trailing punctuation that is almost never part of a URL
    const href = raw.replace(/[.,!?;:'")\]}>]+$/, "");
    const trailing = raw.slice(href.length);
    segments.push({ type: "url", value: href, href: href.startsWith("http") ? href : `https://${href}` });
    if (trailing) segments.push({ type: "text", value: trailing });
    last = match.index + raw.length;
  }
  if (last < text.length) segments.push({ type: "text", value: text.slice(last) });
  return segments;
}

interface LinkSheetProps {
  url: string;
  anchorRef: React.RefObject<HTMLElement>;
  onClose: () => void;
}

/** Small bottom-anchored action sheet — Open / Copy / Cancel */
const LinkSheet = ({ url, onClose }: LinkSheetProps) => {
  // Close on outside tap
  useEffect(() => {
    const id = setTimeout(() => {
      const handler = () => onClose();
      document.addEventListener("pointerdown", handler, { once: true });
      return () => document.removeEventListener("pointerdown", handler);
    }, 50);
    return () => clearTimeout(id);
  }, [onClose]);

  const openUrl = useCallback(async () => {
    hapticLight();
    if (Capacitor.isNativePlatform()) {
      try {
        const { Browser } = await import("@capacitor/browser");
        await Browser.open({ url });
      } catch (e) {
        logError("chat.RichText", "Browser.open failed, falling back to window.open", e);
        window.open(url, "_blank", "noopener,noreferrer");
      }
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
    onClose();
  }, [url, onClose]);

  const copyUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
      hapticSuccess();
    } catch {
      // Fallback for older WebViews
      const el = document.createElement("textarea");
      el.value = url;
      el.style.cssText = "position:fixed;opacity:0;pointer-events:none;";
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      el.remove();
      hapticSuccess();
    }
    onClose();
  }, [url, onClose]);

  // Truncate very long URLs for display
  const displayUrl = url.length > 52 ? url.slice(0, 49) + "…" : url;

  // STACKING-CONTEXT FIX: MessageBubble (this sheet's ancestor in the DOM)
  // wraps every bubble in framer-motion `motion.div`s, which animate via a
  // CSS `transform` — and per the CSS spec, any ancestor with `transform`
  // (or `filter`/`perspective`/`will-change: transform`) becomes the
  // containing block for `position: fixed` descendants, trapping them
  // inside that ancestor's own stacking context instead of the viewport
  // root. That's why this sheet's `z-[10500]` (already higher than every
  // other overlay in the app) still rendered clipped behind the message
  // composer bar instead of over the whole screen: it was being stacked
  // relative to the animated bubble, not the page. Rendering through a
  // portal straight onto document.body — the same fix GridMenu.tsx already
  // uses for its own bottom sheet — escapes that ancestor entirely, so the
  // z-index actually applies against the real page root.
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      className="fixed inset-0 z-[10500] flex items-end justify-center"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        initial={{ y: 80, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 80, opacity: 0 }}
        transition={{ type: "spring", stiffness: 420, damping: 34 }}
        className="w-full max-w-sm mx-3 mb-6 rounded-2xl overflow-hidden"
        style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* URL preview */}
        <div className="px-4 py-3 border-b border-border/60 flex items-start justify-between gap-2">
          <p className="text-[11px] text-muted-foreground break-all leading-relaxed flex-1">{displayUrl}</p>
          <button onClick={onClose} className="shrink-0 text-muted-foreground hover:text-foreground mt-0.5">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {/* Actions */}
        <button
          onClick={openUrl}
          className="w-full flex items-center gap-3 px-4 py-3.5 text-sm font-medium text-foreground hover:bg-accent/10 active:bg-accent/20 transition-colors border-b border-border/40"
        >
          <ExternalLink className="h-4 w-4 text-primary shrink-0" />
          Open link
        </button>
        <button
          onClick={copyUrl}
          className="w-full flex items-center gap-3 px-4 py-3.5 text-sm font-medium text-foreground hover:bg-accent/10 active:bg-accent/20 transition-colors"
        >
          <Copy className="h-4 w-4 text-muted-foreground shrink-0" />
          Copy link
        </button>
      </motion.div>
    </motion.div>,
    document.body,
  );
};

interface RichTextProps {
  text: string;
  isMine: boolean;
  className?: string;
}

const RichText = ({ text, isMine, className }: RichTextProps) => {
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);

  // DIAGNOSTIC: if segments ever come back looking wrong for text that
  // obviously contains a URL, this is the first thing to check — it means
  // URL_RE itself isn't matching (e.g. the text arrived already
  // HTML-escaped, or wrapped in markdown-style [text](url) that this
  // regex was never designed to parse), not the tap handler or the sheet
  // below. A parse failure here degrades to plain, unstyled text with no
  // visible error, which is exactly what "links show as plain text"
  // looks like from the outside — logging it turns that silent case into
  // one that shows up in the console instead.
  let segments: Segment[] = [];
  try {
    segments = parseSegments(text);
  } catch (e) {
    logError("chat.RichText", "parseSegments threw — falling back to plain text", e);
    segments = [{ type: "text", value: text }];
  }
  const hasLinks = segments.some((s) => s.type === "url");

  return (
    <>
      <p
        className={`text-[14px] leading-relaxed whitespace-pre-wrap break-words overflow-wrap-anywhere ${className ?? ""}`}
        // overflow-wrap: anywhere is the key fix — it allows breaking even
        // inside a word/URL that has no natural break point, which is exactly
        // what causes the horizontal scroll on long URLs or unbroken strings.
        style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}
      >
        {hasLinks
          ? segments.map((seg, i) =>
              seg.type === "url" ? (
                <span
                  key={i}
                  ref={i === segments.findIndex((s) => s.type === "url") ? anchorRef : undefined}
                  onClick={(e) => {
                    e.stopPropagation();
                    hapticLight();
                    setActiveUrl(seg.href);
                  }}
                  className={`underline underline-offset-2 cursor-pointer active:opacity-70 ${
                    isMine ? "text-primary-foreground/90 decoration-primary-foreground/40" : "text-primary decoration-primary/40"
                  }`}
                  role="link"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setActiveUrl(seg.href); }}
                  aria-label={`Link: ${seg.value}`}
                >
                  {seg.value}
                </span>
              ) : (
                <span key={i}>{seg.value}</span>
              )
            )
          : text}
      </p>
      <AnimatePresence>
        {activeUrl && (
          <LinkSheet
            url={activeUrl}
            anchorRef={anchorRef as React.RefObject<HTMLElement>}
            onClose={() => setActiveUrl(null)}
          />
        )}
      </AnimatePresence>
    </>
  );
};

export default RichText;
