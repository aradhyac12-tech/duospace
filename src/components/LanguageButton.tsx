import { Languages } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useState } from "react";
import { Check, Smartphone } from "lucide-react";
import { hapticSelection } from "@/lib/haptics";
import { SPLASH_LANGUAGES, SYSTEM_LANGUAGE, getSplashLanguage, setLanguageCode } from "@/lib/i18n";
import { useLanguage, useT } from "@/hooks/useLanguage";

/**
 * Compact language chip + bottom sheet, usable on any screen — including
 * the signed-out ones (Auth, Onboarding) where Settings isn't reachable.
 * Same source of truth as Settings → Language (lib/i18n.ts).
 */
const LanguageButton = ({ className = "" }: { className?: string }) => {
  const t = useT();
  const { code, preference } = useLanguage();
  const [open, setOpen] = useState(false);

  const pick = (value: string) => {
    hapticSelection();
    setLanguageCode(value);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("settings.language")}
        className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-full bg-card/80 border border-border/60 text-xs font-medium text-foreground/80 active:scale-95 transition-transform ${className}`}
      >
        <Languages className="h-3.5 w-3.5" aria-hidden="true" />
        {getSplashLanguage(code).short}
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="rounded-t-3xl max-h-[80dvh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t("language.pick")}</SheetTitle>
          </SheetHeader>
          <div className="mt-3 divide-y divide-border/40">
            <button onClick={() => pick(SYSTEM_LANGUAGE)} className="w-full flex items-center gap-3 py-3 text-left">
              <Smartphone className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
              <span className="flex-1 text-sm font-medium">{t("language.system")}</span>
              {preference === SYSTEM_LANGUAGE && <Check className="h-4 w-4 text-primary" aria-hidden="true" />}
            </button>
            {SPLASH_LANGUAGES.map((l) => (
              <button key={l.code} lang={l.code} onClick={() => pick(l.code)} className="w-full flex items-center gap-3 py-3 text-left">
                <span className="flex-1 text-sm font-medium">{l.label}</span>
                <span className="text-[11px] text-muted-foreground tabular-nums">{l.short}</span>
                {preference === l.code && <Check className="h-4 w-4 text-primary" aria-hidden="true" />}
              </button>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
};

export default LanguageButton;
