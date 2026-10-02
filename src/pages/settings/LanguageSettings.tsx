import { useState } from "react";
import { motion } from "framer-motion";
import { Check } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { hapticSelection } from "@/lib/haptics";
import { SPLASH_LANGUAGES, getLanguageCode, setLanguageCode } from "@/lib/i18n";

/**
 * PHASE 3 FIX (splash continuity): the real home for language preference.
 * A language picker used to live on the splash screen itself — removed
 * per the redesign brief ("language belongs in Settings → Language, not
 * the hand-off frame"), since a splash that waits on a decision isn't a
 * splash. lib/i18n.ts already had everything this needed
 * (SPLASH_LANGUAGES / getLanguageCode / setLanguageCode / subscribeLanguage)
 * — its own comment names this exact page as the intended consumer — so
 * this is wiring, not new architecture.
 *
 * As documented in lib/i18n.ts: there's no app-wide translation system
 * behind this yet (no i18next, no translated strings) — this stores the
 * preference and updates the splash's own tagline (getSplashLanguage) for
 * the next cold launch. It's the single source of truth a real i18n layer
 * would read from later, not a claim that the whole app is translated
 * today.
 */
const LanguageSettings = () => {
  const [selected, setSelected] = useState(getLanguageCode());

  const pick = (code: string) => {
    if (code === selected) return;
    hapticSelection();
    setLanguageCode(code);
    setSelected(code);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-24 bg-background"
    >
      <PageHeader title="Language" subtitle="Used for the launch screen for now" />

      <div className="px-5 pt-5 space-y-2">
        <div className="bg-card rounded-2xl border border-border/60 divide-y divide-border/40 overflow-hidden">
          {SPLASH_LANGUAGES.map((l) => (
            <button
              key={l.code}
              onClick={() => pick(l.code)}
              dir={l.rtl ? "rtl" : undefined}
              className="w-full flex items-center gap-3 px-4 py-3.5 active:bg-accent/5 transition-colors text-left"
            >
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium text-foreground">{l.label}</span>
                <span className="block text-[11px] text-muted-foreground truncate">{l.tagline}</span>
              </span>
              <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums">{l.short}</span>
              {selected === l.code && (
                <Check className="h-4 w-4 text-primary shrink-0" aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
      </div>
    </motion.div>
  );
};

export default LanguageSettings;
