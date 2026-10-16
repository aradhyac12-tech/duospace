import { useCallback, useSyncExternalStore } from "react";
import { getLanguageCode, getLanguagePreference, subscribeLanguage, tr } from "@/lib/i18n";

/** Re-renders the calling component when the app language (or the device
 *  language, while following the system) changes. */
export const useLanguage = () => {
  const code = useSyncExternalStore(subscribeLanguage, getLanguageCode, () => "en");
  const preference = useSyncExternalStore(subscribeLanguage, getLanguagePreference, () => "system");
  return { code, preference };
};

/** `const t = useT(); t("settings.title")` — reactive translate function. */
export const useT = () => {
  const { code } = useLanguage();
  return useCallback(
    (key: string, vars: Record<string, string | number> = {}) => tr(key, vars, code),
    [code],
  );
};
