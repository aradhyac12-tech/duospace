import storage from "@/lib/storage";

// A "white-label app" is one buildable variant of this codebase — its own
// name, Android application ID, iOS bundle ID, and (via appIconConfig.ts)
// its own icon. Icon Studio edits whichever one is "current"; the native
// build pipeline (scripts/apply-whitelabel.mjs) reads the same shape of
// record from whitelabel/apps.json to patch the actual native projects.
export interface WhiteLabelApp {
  id: string;
  name: string;
  /** Android applicationId / namespace, e.g. com.duospace.app */
  packageId: string;
  /** iOS bundle identifier, e.g. com.duospace.app (often identical to packageId) */
  bundleId: string;
  createdAt: number;
}

const APPS_KEY = "whitelabel-apps";
const CURRENT_KEY = "whitelabel-current-app";

// Seeded to match the values already committed in capacitor.config.ts, so a
// fresh install always has a valid "current app" pointing at the real
// default build, not an empty list.
export const DEFAULT_APP: WhiteLabelApp = {
  id: "duospace",
  name: "DuoSpace",
  packageId: "com.duospace.app",
  bundleId: "com.duospace.app",
  createdAt: 0,
};

const PACKAGE_ID_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i;

export const isValidPackageId = (id: string): boolean => PACKAGE_ID_RE.test(id.trim());

export const listApps = (): WhiteLabelApp[] => {
  const apps = storage.getJSON<WhiteLabelApp[]>(APPS_KEY, []);
  return apps.length ? apps : [DEFAULT_APP];
};

const saveApps = (apps: WhiteLabelApp[]): void => storage.setJSON(APPS_KEY, apps);

export const getApp = (id: string): WhiteLabelApp | undefined =>
  listApps().find(a => a.id === id);

export const createApp = (input: { name: string; packageId: string; bundleId: string }): WhiteLabelApp => {
  const apps = listApps();
  const app: WhiteLabelApp = {
    id: `app_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: input.name.trim() || "Untitled app",
    packageId: input.packageId.trim(),
    bundleId: input.bundleId.trim() || input.packageId.trim(),
    createdAt: Date.now(),
  };
  saveApps([...apps, app]);
  return app;
};

export const updateApp = (id: string, patch: Partial<Omit<WhiteLabelApp, "id" | "createdAt">>): void => {
  const apps = listApps().map(a => (a.id === id ? { ...a, ...patch } : a));
  saveApps(apps);
};

export const deleteApp = (id: string): void => {
  if (id === DEFAULT_APP.id) return; // never delete the default build's config
  const apps = listApps().filter(a => a.id !== id);
  saveApps(apps.length ? apps : [DEFAULT_APP]);
  if (getCurrentAppId() === id) setCurrentAppId(DEFAULT_APP.id);
};

export const getCurrentAppId = (): string => storage.get(CURRENT_KEY) || DEFAULT_APP.id;

export const setCurrentAppId = (id: string): void => storage.set(CURRENT_KEY, id);

export const getCurrentApp = (): WhiteLabelApp =>
  getApp(getCurrentAppId()) || DEFAULT_APP;

/** Serializes the registry to the same JSON shape scripts/apply-whitelabel.mjs reads. */
export const exportAppsJson = (): string => JSON.stringify(listApps(), null, 2);

export const importAppsJson = (json: string): number => {
  try {
    const parsed = JSON.parse(json) as WhiteLabelApp[];
    if (!Array.isArray(parsed)) return 0;
    const valid = parsed.filter(a => a && typeof a.id === "string" && typeof a.name === "string" && typeof a.packageId === "string");
    if (!valid.length) return 0;
    saveApps(valid);
    return valid.length;
  } catch { return 0; }
};
