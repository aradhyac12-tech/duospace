import { motion } from "framer-motion";
import { Check, Smartphone } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { hapticSelection } from "@/lib/haptics";
import { SPLASH_LANGUAGES, SYSTEM_LANGUAGE, getSplashLanguage, setLanguageCode } from "@/lib/i18n";
import { useLanguage, useT } from "@/hooks/useLanguage";

/**
 * Settings → Language. "Match device language" is the default and is shown
 * first; picking a specific language overrides the device until the user
 * switches back. The whole app re-renders on change (see useLanguage), so
 * everything routed through tr()/useT() updates immediately.
 *
 * Coverage: the app shell (nav, Settings hub, Hub menu, this page) plus the
 * relationship-AI screens. Other screens are still English and fall back
 * silently — see .ai/PENDING.md "UI translation".
 */
const LanguageSettings = () => {
  const t = useT();
  const { code, preference } = useLanguage();

  const pick = (value: string) => {
    if (value === preference) return;
    hapticSelection();
    setLanguageCode(value);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-24 bg-background"
    >
      <PageHeader title={t("settings.language")} subtitle={t("language.subtitle")} />

      <div className="px-5 pt-5 space-y-2">
        <div className="bg-card rounded-2xl border border-border/60 divide-y divide-border/40 overflow-hidden">
          <button
            onClick={() => pick(SYSTEM_LANGUAGE)}
            className="w-full flex items-center gap-3 px-4 py-3.5 active:bg-accent/5 transition-colors text-left"
          >
            <Smartphone className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-medium text-foreground">{t("language.system")}</span>
              <span className="block text-[11px] text-muted-foreground">
                {preference === SYSTEM_LANGUAGE
                  ? t("language.using", { lang: getSplashLanguage(code).label })
                  : t("language.systemDesc")}
              </span>
            </span>
            {preference === SYSTEM_LANGUAGE && <Check className="h-4 w-4 text-primary shrink-0" aria-hidden="true" />}
          </button>
          {SPLASH_LANGUAGES.map((l) => (
            <button
              key={l.code}
              onClick={() => pick(l.code)}
              lang={l.code}
              dir={l.rtl ? "rtl" : undefined}
              className="w-full flex items-center gap-3 px-4 py-3.5 active:bg-accent/5 transition-colors text-left"
            >
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium text-foreground">{l.label}</span>
                <span className="block text-[11px] text-muted-foreground truncate">{l.tagline}</span>
              </span>
              <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums">{l.short}</span>
              {preference === l.code && <Check className="h-4 w-4 text-primary shrink-0" aria-hidden="true" />}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground px-1 pt-1">{t("language.fallbackNote")}</p>
      </div>
    </motion.div>
  );
};

export default LanguageSettings;
