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

import { useState, useEffect, useRef, useCallback, type RefObject } from "react";

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

const VIRTUAL_THRESHOLD = 300; // items — enable virtual rendering above this count

export function useVirtualList({
  itemCount,
  estimatedItemHeight,
  overscan = 8,
  containerRef: externalContainerRef,
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
  const [, forceRecompute] = useState(0);

  // Recalculate on scroll
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => setScrollTop(el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Observe container resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const h = entries[0]?.contentRect.height;
      if (h) setContainerHeight(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const getItemHeight = useCallback((i: number) => {
    return heightCache.current.get(i) ?? estimatedItemHeight;
  }, [estimatedItemHeight]);

  // Build cumulative offsets
  const offsets = useRef<number[]>([]);
  const totalHeight = (() => {
    let sum = 0;
    offsets.current = [];
    for (let i = 0; i < itemCount; i++) {
      offsets.current.push(sum);
      sum += getItemHeight(i);
    }
    return sum;
  })();

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
    virtualItems: itemCount >= VIRTUAL_THRESHOLD ? virtualItems : buildFullList(itemCount, getItemHeight),
    totalHeight,
    containerRef,
    measureItem,
    scrollToIndex,
  };
}

function buildFullList(count: number, getHeight: (i: number) => number): VirtualItem[] {
  let top = 0;
  return Array.from({ length: count }, (_, i) => {
    const item: VirtualItem = { index: i, start: top, size: getHeight(i) };
    top += getHeight(i);
    return item;
  });
}
