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
 * NOTE: For DuoSpace this hook is wired in when PAGE_SIZE > 500 items are loaded.
 * Below that threshold, the standard map render is used (simpler, no layout shifts).
 */

import { useState, useEffect, useRef, useCallback } from "react";

interface VirtualListOptions {
  /** Total number of items */
  itemCount: number;
  /** Estimated height per item in pixels (used until measured) */
  estimatedItemHeight: number;
  /** Extra items to render above and below the visible window */
  overscan?: number;
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
}: VirtualListOptions): VirtualListResult {
  const containerRef = useRef<HTMLDivElement>(null);
  // Cache measured heights; unmeasured items use the estimate
  const heightCache = useRef<Map<number, number>>(new Map());
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);

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
