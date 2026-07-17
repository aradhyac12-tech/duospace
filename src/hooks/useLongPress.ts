import { useCallback, useRef } from "react";
import { hapticMedium } from "@/lib/haptics";

export const useLongPress = (
  onLongPress: () => void,
  delay = 500
) => {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLongPressRef = useRef(false);

  const start = useCallback(
    (e: React.TouchEvent | React.MouseEvent) => {
      isLongPressRef.current = false;
      timerRef.current = setTimeout(() => {
        isLongPressRef.current = true;
        hapticMedium();
        onLongPress();
      }, delay);
    },
    [onLongPress, delay]
  );

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    stop();
  }, [stop]);

  return {
    onTouchStart: start,
    onTouchEnd: stop,
    onTouchMove: cancel,
    onMouseDown: start,
    onMouseUp: stop,
    onMouseLeave: stop,
  };
};
