import type { SyntheticEvent } from "react";
import { fallbackArt } from "@/lib/music/fallbackArt";

/** <img onError>: swap a broken/blocked cover for the generated fallback, once (no error loop). */
export const onArtError = (title: string, artist: string) => (e: SyntheticEvent<HTMLImageElement>) => {
  const el = e.currentTarget;
  if (el.dataset.artFallback) return;
  el.dataset.artFallback = "1";
  el.src = fallbackArt(title, artist);
};
