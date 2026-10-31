/**
 * Pure maths for the queue's drag handle (the pointer path next to the move up/down buttons).
 * The list moves ONE slot at a time: once the finger has travelled 60% of a row's height the track swaps with its
 * neighbour and the accumulated travel is reduced by one row, so the row stays under the finger and a small
 * wobble back does not flip it straight back (the reverse needs another ~20% of a row of travel).
 */
export const DRAG_STEP_FRACTION = 0.6;

export function nextDragStep(accPx: number, rowHeightPx: number): { step: -1 | 0 | 1; rest: number } {
  const h = rowHeightPx > 0 ? rowHeightPx : 56;
  if (accPx >= h * DRAG_STEP_FRACTION) return { step: 1, rest: accPx - h };
  if (accPx <= -h * DRAG_STEP_FRACTION) return { step: -1, rest: accPx + h };
  return { step: 0, rest: accPx };
}
