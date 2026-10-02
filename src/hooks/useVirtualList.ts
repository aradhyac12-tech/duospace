/**
 * useVirtualList — lightweight virtual scrolling for large message lists.
 *
 * FIX AUDIT #14: Stress failure with 10k+ messages / many images on low-RAM devices.
 *
 * Instead of rendering all messages into the DOM, this hook calculates which
 * items are visible inside a scrollable container and renders only those
 * plus an overscan buffer above/below.
 *
 * Usage:
 *   const { virtualItems, totalHeight, containerRef } = useVirtualList({
 *     itemCount: messages.length,
 *     estimatedItemHeight: 72,
 *     overscan: 10,
 *   });
 *
 *   <div ref={containerRef} style={{ height: "100%", overflowY: "auto", position: "relative" }}>
 *     <div style={{ height: totalHeight, position: "relative" }}>
 *       {virtualItems.map(({ index, start }) => (
 *         <div key={index} style={{ position: "absolute", top: start, width: "100%" }}>
 *           <MessageBubble msg={messages[index]} />
 *         </div>
 *       ))}
 *     </div>
 *   </div>
 *
 * NOTE: wired into MessageTimeline.tsx, gated on the flattened timeline
 * (messages + call events + surprises + imported rows + date separators)
 * being at or above VIRTUAL_ROW_THRESHOLD there. Below that, MessageTimeline
 * renders its original, unvirtualized path unchanged — the vast majority of
 * conversations never reach the threshold, so this only engages for
 * genuinely long histories (large WhatsApp imports, long-running couples'
 * chats), where the DOM-node cost of rendering every message actually
 * becomes the bottleneck.
 */

import { useState, useEffect, useRef, useCallback, useMemo, type RefObject } from "react";

interface VirtualListOptions {
  /** Total number of items */
  itemCount: number;
  /** Estimated height per item in pixels (used until measured) */
  estimatedItemHeight: number;
  /** Extra items to render above and below the visible window */
  overscan?: number;
  /**
   * WIRING FIX: the scrollable element here needs to be the SAME node the
   * caller's own scroll-position-preservation / auto-scroll-to-bottom /
   * load-older-on-scroll-top logic already reads from (e.g. Chat.tsx's
   * messagesContainerRef) — there's exactly one scrollable message list,
   * not two independent ones. Previously this hook always created and
   * returned its own ref, which would have meant either duplicating that
   * whole scroll-management surface a second time or leaving virtualization
   * permanently disconnected from it. Passing an existing ref here makes
   * the hook attach its scroll/resize listeners to that node instead of
   * minting a new one; omit it and the hook falls back to owning its own
   * ref exactly as before (unchanged for any other caller).
   */
  containerRef?: RefObject<HTMLDivElement>;
  /**
   * PERF (this was the single biggest scroll cost): the hook used to attach its
   * scroll listener and call setScrollTop() on EVERY scroll event whether or
   * not the caller was actually windowing. MessageTimeline calls this hook
   * unconditionally (hooks can't be conditional) and only virtualizes past a
   * size threshold — so in every ordinary chat, every scroll event re-rendered
   * the whole timeline component for a value nothing read. With `enabled:
   * false` no listeners are attached and no state is ever set.
   */
  enabled?: boolean;
}

export interface VirtualItem {
  index: number;
  start: number;
  size: number;
}

interface VirtualListResult {
  virtualItems: VirtualItem[];
  totalHeight: number;
  containerRef: React.RefObject<HTMLDivElement>;
  /** Call this after each render to update measured heights */
  measureItem: (index: number, height: number) => void;
  /** Scroll to a specific item index */
  scrollToIndex: (index: number, behavior?: ScrollBehavior) => void;
}

// SCROLL_QUANTUM: scroll position is only pushed into React state in steps of
// this many pixels (and at most once per animation frame). Rendering itself
// already keeps `overscan` rows on each side of the viewport, so a window that
// is up to one quantum stale is invisible — but it turns "re-render the list on
// every single scroll event" (60-120 renders/second while flinging) into one
// render per ~48px of travel.
const SCROLL_QUANTUM = 48;

export function useVirtualList({
  itemCount,
  estimatedItemHeight,
  overscan = 8,
  containerRef: externalContainerRef,
  enabled = true,
}: VirtualListOptions): VirtualListResult {
  const ownContainerRef = useRef<HTMLDivElement>(null);
  const containerRef = externalContainerRef ?? ownContainerRef;
  // Cache measured heights; unmeasured items use the estimate
  const heightCache = useRef<Map<number, number>>(new Map());
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);
  // BUG FIX: measureItem previously wrote into heightCache (a ref) with no
  // accompanying state update, so a measured height only actually affected
  // totalHeight/offsets once some UNRELATED state change (the next scroll
  // event) happened to trigger a re-render. Until then, every row's offset
  // was computed from the estimate even for rows already measured on this
  // very render pass, which could leave the container's real scrollHeight
  // out of sync with what auto-scroll-to-bottom/scroll-restore math expects.
  // This tick forces one extra render right after a measurement actually
  // changes a cached height, so offsets/totalHeight catch up immediately.
  const [heightVersion, forceRecompute] = useState(0);

  // Recalculate on scroll
  useEffect(() => {
    if (!enabled) return;
    const el = containerRef.current;
    if (!el) return;
    let raf = 0;
    const sync = () => {
      raf = 0;
      // setState with an unchanged value bails out without rendering.
      setScrollTop(Math.round(el.scrollTop / SCROLL_QUANTUM) * SCROLL_QUANTUM);
    };
    const onScroll = () => {
      if (raf) return; // already scheduled for this frame
      raf = requestAnimationFrame(sync);
    };
    // Windowing may switch on while the user is already scrolled somewhere
    // (the chat just crossed the size threshold) — pick up the real position.
    sync();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [enabled]);

  // Observe container resize
  useEffect(() => {
    if (!enabled) return;
    const el = containerRef.current;
    if (!el) return;
    if (el.clientHeight) setContainerHeight(el.clientHeight);
    const ro = new ResizeObserver(entries => {
      const h = entries[0]?.contentRect.height;
      if (h) setContainerHeight(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [enabled]);

  const getItemHeight = useCallback((i: number) => {
    return heightCache.current.get(i) ?? estimatedItemHeight;
  }, [estimatedItemHeight]);

  // Build cumulative offsets.
  // PERF: this used to run (allocating a fresh array of `itemCount` numbers) on
  // EVERY render — including every scroll-driven render — even though it can
  // only change when the item count or a measured row height changes.
  const offsets = useRef<number[]>([]);
  const totalHeight = useMemo(() => {
    let sum = 0;
    const next: number[] = new Array(itemCount);
    for (let i = 0; i < itemCount; i++) {
      next[i] = sum;
      sum += getItemHeight(i);
    }
    offsets.current = next;
    return sum;
    // heightVersion bumps whenever measureItem() changes a cached height
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemCount, heightVersion, getItemHeight]);

  // Find first visible item (binary search)
  const findStart = (top: number): number => {
    let lo = 0, hi = itemCount - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((offsets.current[mid] ?? 0) < top) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, lo - 1);
  };

  const visibleStart = findStart(scrollTop);
  let visibleEnd = visibleStart;
  while (
    visibleEnd < itemCount - 1 &&
    (offsets.current[visibleEnd] ?? 0) < scrollTop + containerHeight
  ) {
    visibleEnd++;
  }

  const from = Math.max(0, visibleStart - overscan);
  const to   = Math.min(itemCount - 1, visibleEnd + overscan);

  const virtualItems: VirtualItem[] = [];
  for (let i = from; i <= to; i++) {
    virtualItems.push({
      index: i,
      start: offsets.current[i] ?? 0,
      size: getItemHeight(i),
    });
  }

  const measureItem = useCallback((index: number, height: number) => {
    if (heightCache.current.get(index) !== height) {
      heightCache.current.set(index, height);
      forceRecompute(n => n + 1);
    }
  }, []);

  const scrollToIndex = useCallback((index: number, behavior: ScrollBehavior = "smooth") => {
    const el = containerRef.current;
    if (!el) return;
    const top = offsets.current[index] ?? 0;
    el.scrollTo({ top, behavior });
  }, []);

  return {
    // The caller (MessageTimeline) decides WHEN to virtualize, based on a
    // media-weighted cost — this hook used to second-guess that with its own
    // flat 300-item cutoff and silently render the FULL list below it, which
    // would have defeated any lower threshold chosen by the caller.
    virtualItems,
    totalHeight,
    containerRef,
    measureItem,
    scrollToIndex,
  };
}
