import { useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Capacitor } from "@capacitor/core";
import { hapticSoft, hapticSelection } from "@/lib/haptics";
import {
  SPLASH_LANGUAGES,
  getLanguageCode,
  setLanguageCode,
  subscribeLanguage,
  getSplashLanguage,
} from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface SplashScreenProps {
  appName?: string;
  onComplete: () => void;
  /**
   * FIX: previously the splash's exit was purely timer-driven — it always
   * handed off after TOTAL_MS regardless of whether auth state had actually
   * resolved yet. useAuth's onAuthStateChange("INITIAL_SESSION") is meant to
   * fire "synchronously from cache" but that's optimistic: on a cold native
   * launch it has to wait on the underlying storage adapter's own read
   * (Preferences/secure storage), which is not guaranteed to beat ~1.1s.
   * When it didn't, the splash would hand off right on schedule into
   * AuthRoute/ProtectedRoutes, both of which render nothing at all while
   * their own `loading` is still true — a blank screen for however much
   * longer auth took to resolve. Defaults to true so every other caller
   * (there are none today, but future ones) keeps the old fixed-timing
   * behavior unless it opts in.
   */
  ready?: boolean;
}

/**
 * Timing. The previous version cycled six translated taglines at 1.15s each
 * and took ~6.6s before the app appeared — that is what made launch feel
 * slow. A launch splash should read as a *handoff*, not a intro sequence:
 * everything below is tuned so the whole thing is on screen for well under
 * two seconds while still feeling deliberate and expensive. Language is
 * back (see src/lib/i18n.ts) but as a secondary, optional pill — it never
 * gates or extends this timing on its own, except to avoid closing the
 * language sheet on someone mid-tap (see the exit-timer effects below).
 */
const ENTRANCE_MS = 520;   // logo + wordmark settle
const HOLD_MS = 620;       // the still, confident beat
const EXIT_MS = 380;       // hand off to the app
const TOTAL_MS = ENTRANCE_MS + HOLD_MS;

// One easing curve everywhere (iOS sheet curve). Reusing a single curve is
// what makes a set of small motions read as one coherent piece.
const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

/**
 * Premium boot splash — a single continuous composition:
 *  - deep graphite field with a soft, slowly breathing glow
 *  - two faint ambient light fields converge toward the center as the logo
 *    settles — a near-subliminal "two people, one space" cue
 *  - the app icon lifts into a glass container with an inner highlight and
 *    a single specular sweep across its surface
 *  - a fine specular sweep also travels once across the wordmark
 *  - the tagline rises beneath it, localized, with a small optional
 *    language pill near the bottom that never blocks or delays handoff
 *  - everything leaves together, scaling up very slightly, so the app
 *    underneath feels like it was there all along
 *
 * Performance: only opacity and transform animate (the glow's breathing is a
 * transform-only loop, the sweeps are translated gradients behind a mask).
 * No animated blur, color, or box-shadow — it stays smooth on low-end
 * Android. The app-wide `<MotionConfig reducedMotion="user">` (see App.tsx)
 * means every transform-driven animation on this screen (scale, x, y,
 * scaleX) collapses to its resting value automatically when the OS prefers
 * reduced motion — opacity is the only thing that still animates, which is
 * exactly the simplified-transition behavior this needs; no local
 * useReducedMotion() check is required here as a result.
 */
const SplashScreen = ({ appName = "DuoSpace", onComplete, ready = true }: SplashScreenProps) => {
  const [exiting, setExiting] = useState(false);
  const [langCode, setLangCode] = useState(getLanguageCode);
  const [sheetOpen, setSheetOpen] = useState(false);

  const cancelled = useRef(false);
  const hapticFired = useRef(false);      // logo-settle haptic: at most once
  const readyToExit = useRef(false);      // TOTAL_MS has elapsed
  const sheetOpenRef = useRef(false);
  const readyRef = useRef(ready);         // auth (or other gate) has resolved
  const taglineEntered = useRef(false);   // first tagline entrance already played
  sheetOpenRef.current = sheetOpen;
  readyRef.current = ready;

  const language = getSplashLanguage(langCode);

  // Stay in sync if the language changes from anywhere else (e.g. a future
  // Settings > Language screen) while this is still mounted.
  useEffect(() => subscribeLanguage(() => setLangCode(getLanguageCode())), []);

  const beginExit = useCallback(() => {
    if (cancelled.current) return;
    setExiting(true);
  }, []);

  useEffect(() => {
    cancelled.current = false;

    const t1 = window.setTimeout(() => {
      if (cancelled.current) return;
      readyToExit.current = true;
      // Never yank the splash away mid-tap: if the language sheet is open,
      // hold the final state and exit as soon as it closes instead. Same
      // idea for `ready` — if whatever's gating readiness (auth state,
      // typically) hasn't resolved yet, keep holding; the effect below
      // fires the exit the moment it does.
      if (!sheetOpenRef.current && readyRef.current) beginExit();
    }, TOTAL_MS);

    return () => {
      cancelled.current = true;
      window.clearTimeout(t1);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fires onComplete exactly once, only after the exit animation plays.
  useEffect(() => {
    if (!exiting) return;
    const t = window.setTimeout(() => {
      if (!cancelled.current) onComplete();
    }, EXIT_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exiting]);

  // If the hold window already elapsed while the sheet was open or `ready`
  // was still false, exit the moment both conditions clear rather than
  // waiting for a timer that already fired.
  useEffect(() => {
    if (!sheetOpen && ready && readyToExit.current) beginExit();
  }, [sheetOpen, ready, beginExit]);

  const handleLogoSettle = useCallback(() => {
    if (hapticFired.current) return;
    hapticFired.current = true;
    // Restrained on purpose: native only, and hapticSoft() itself already
    // no-ops when the person has haptics turned off.
    if (Capacitor.isNativePlatform()) hapticSoft();
  }, []);

  const handleSelectLanguage = (code: string) => {
    if (code !== langCode) {
      hapticSelection();
      setLanguageCode(code);
    }
    window.setTimeout(() => setSheetOpen(false), 90);
  };

  return (
    <motion.div
      className="fixed inset-0 z-[999] flex flex-col items-center justify-center overflow-hidden px-8"
      style={{ background: "radial-gradient(120% 90% at 50% 34%, #18181d 0%, #0a0a0c 58%, #050506 100%)" }}
      animate={{ opacity: exiting ? 0 : 1, scale: exiting ? 1.03 : 1 }}
      transition={{ duration: EXIT_MS / 1000, ease: EASE }}
    >
      {/* Ambient glow — transform-only breathing loop. */}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute h-80 w-80 rounded-full bg-white/[0.055] blur-3xl"
        style={{ top: "24%" }}
        initial={{ scale: 0.85, opacity: 0 }}
        animate={{ scale: [0.94, 1.05, 0.98], opacity: 1 }}
        transition={{ duration: 3.2, ease: "easeInOut", repeat: Infinity, repeatType: "mirror" }}
      />

      {/* Two-person cue: a pair of faint light fields converge toward the
          logo once, during entrance only — no continuous loop, kept almost
          subliminal. Symmetric so it never reads as "pointing" anywhere. */}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute h-40 w-40 rounded-full bg-white/[0.05] blur-2xl"
        style={{ top: "22%" }}
        initial={{ x: -46, opacity: 0 }}
        animate={{ x: 0, opacity: 0.7 }}
        transition={{ duration: 0.7, ease: EASE }}
      />
      <motion.div
        aria-hidden
        className="pointer-events-none absolute h-40 w-40 rounded-full bg-white/[0.05] blur-2xl"
        style={{ top: "22%" }}
        initial={{ x: 46, opacity: 0 }}
        animate={{ x: 0, opacity: 0.7 }}
        transition={{ duration: 0.7, ease: EASE }}
      />

      <div className="relative flex flex-col items-center">
        {/* Icon — premium glass container: translucent fill, fine edge
            highlight, soft ambient shadow, one internal specular sweep. */}
        <motion.div
          className="relative h-[92px] w-[92px] overflow-hidden rounded-[26px] border border-white/[0.14] bg-white/[0.055] backdrop-blur-xl"
          style={{
            boxShadow:
              "0 24px 64px -18px rgba(0,0,0,0.85), inset 0 1px 0 rgba(255,255,255,0.10), inset 0 0 0 1px rgba(255,255,255,0.03)",
          }}
          initial={{ opacity: 0, scale: 0.86, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: ENTRANCE_MS / 1000, ease: EASE }}
          onAnimationComplete={handleLogoSettle}
        >
          {/* Soft internal reflection, top-left — static, no cost. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(120% 90% at 18% 12%, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0) 55%)",
            }}
          />
          <img
            src="/icon-1024.png"
            alt={appName}
            className="relative h-full w-full object-cover p-[3px]"
            draggable={false}
          />
          {/* Specular sweep — travels once across the glass surface. */}
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "linear-gradient(115deg, transparent 40%, rgba(255,255,255,0.35) 50%, transparent 60%)",
            }}
            initial={{ x: "-130%" }}
            animate={{ x: "130%" }}
            transition={{ duration: 0.85, delay: 0.36, ease: [0.4, 0, 0.2, 1] }}
          />
        </motion.div>

        {/* Wordmark with a single specular sweep. The sweep is a translated
            gradient clipped to the text via background-clip, so nothing
            expensive (blur/filter) animates. */}
        <motion.div
          className="relative mt-6 overflow-hidden"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.44, delay: 0.12, ease: EASE }}
        >
          <span className="text-[23px] font-semibold tracking-[-0.02em] text-white/95">
            {appName}
          </span>
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "linear-gradient(100deg, transparent 35%, rgba(255,255,255,0.85) 50%, transparent 65%)",
              mixBlendMode: "overlay",
            }}
            initial={{ x: "-120%" }}
            animate={{ x: "120%" }}
            transition={{ duration: 0.9, delay: 0.3, ease: [0.4, 0, 0.2, 1] }}
          />
        </motion.div>

        {/* Tagline — localized. First appearance rises + fades in on the
            entrance timeline; a later language switch just crossfades in
            place, immediately, without replaying the entrance. */}
        <div className="mt-2.5 max-w-[300px] text-center">
          <AnimatePresence mode="wait">
            <motion.p
              key={language.code}
              dir={language.rtl ? "rtl" : "ltr"}
              lang={language.code}
              className="text-[13.5px] font-light leading-[1.45] tracking-wide text-white/45"
              initial={taglineEntered.current ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={
                taglineEntered.current
                  ? { duration: 0.18, ease: EASE }
                  : { duration: 0.42, delay: 0.24, ease: EASE }
              }
              onAnimationComplete={() => {
                taglineEntered.current = true;
              }}
            >
              {language.tagline}
            </motion.p>
          </AnimatePresence>
        </div>

        {/* Hairline progress cue — a thin line that fills once, giving the
            hold beat a reason to exist instead of feeling like a pause. */}
        <motion.div
          className="mt-7 h-px w-24 overflow-hidden rounded-full bg-white/10"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, delay: 0.3 }}
        >
          <motion.div
            className="h-full w-full origin-left bg-white/50"
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: (TOTAL_MS - 300) / 1000, delay: 0.3, ease: [0.4, 0, 0.2, 1] }}
          />
        </motion.div>
      </div>

      {/* Language — a tiny, secondary glass pill. Optional, never reads as
          a settings screen: a short code + name, tap opens a compact glass
          sheet, tap a language to switch and close. */}
      <motion.div
        className="safe-bottom pointer-events-auto absolute bottom-10 left-0 right-0 flex justify-center"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.42, ease: EASE }}
      >
        <PopoverPrimitive.Root
          open={sheetOpen}
          onOpenChange={(open) => {
            setSheetOpen(open);
            if (open) hapticSelection();
          }}
        >
          <PopoverPrimitive.Trigger asChild>
            <button
              type="button"
              className="inline-flex min-h-touch items-center gap-2 rounded-full border border-white/[0.12] bg-white/[0.05] px-4 backdrop-blur-md transition-transform active:scale-95"
              aria-label={`Splash language: ${language.label}. Tap to change.`}
              aria-haspopup="menu"
              aria-expanded={sheetOpen}
            >
              <span className="text-[11px] font-medium tracking-[0.08em] text-white/70">
                {language.short}
              </span>
              <span aria-hidden className="text-[11px] text-white/30">·</span>
              <span className="text-[11px] text-white/50">{language.label}</span>
            </button>
          </PopoverPrimitive.Trigger>

          <AnimatePresence>
            {sheetOpen && (
              <PopoverPrimitive.Portal forceMount>
                <PopoverPrimitive.Content
                  forceMount
                  side="top"
                  align="center"
                  sideOffset={12}
                  collisionPadding={16}
                  className="z-[1000] outline-none"
                  onCloseAutoFocus={(e) => e.preventDefault()}
                >
                  <motion.div
                    role="menu"
                    aria-label="Choose a language"
                    initial={{ opacity: 0, y: 8, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 6, scale: 0.98 }}
                    transition={{ duration: 0.2, ease: EASE }}
                    className="w-56 overflow-hidden rounded-2xl border border-white/[0.12] bg-[#0c0c0f]/95 p-1.5 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.75)] backdrop-blur-xl"
                  >
                    {SPLASH_LANGUAGES.map((l) => (
                      <button
                        key={l.code}
                        type="button"
                        role="menuitemradio"
                        aria-checked={l.code === langCode}
                        onClick={() => handleSelectLanguage(l.code)}
                        className={cn(
                          "flex min-h-touch w-full items-center justify-between rounded-xl px-3 text-left text-[13px] transition-colors",
                          l.code === langCode
                            ? "bg-white/[0.09] text-white/90"
                            : "text-white/55 hover:bg-white/[0.045]"
                        )}
                      >
                        <span>{l.label}</span>
                        <span aria-hidden className="text-[10px] tracking-wide text-white/35">
                          {l.short}
                        </span>
                      </button>
                    ))}
                  </motion.div>
                </PopoverPrimitive.Content>
              </PopoverPrimitive.Portal>
            )}
          </AnimatePresence>
        </PopoverPrimitive.Root>
      </motion.div>
    </motion.div>
  );
};

export default SplashScreen;
