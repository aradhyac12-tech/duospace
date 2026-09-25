// Route chunk preloaders, plus the lazy-import factories App.tsx uses to
// build its lazy() components.
//
// This lives in its own leaf module (no imports from "@/App") on purpose.
// It used to be exported from App.tsx, but components inside lazily-loaded
// chunks (GridMenu, ChatHeader, DockNavRow) imported it from there too,
// which created a circular chunk dependency: App -> (dynamic) -> Chat chunk
// -> (static) -> App. Depending on chunk evaluation order, that could leave
// the Chat chunk reading `routePreload` while it was still in its temporal
// dead zone, throwing "Cannot access '<var>' before initialization".
// Keeping this map dependency-free avoids that cycle entirely.

export const ChatImport = () => import("@/pages/Chat");
export const GalleryImport = () => import("@/pages/Gallery");
export const CallsImport = () => import("@/pages/Calls");
export const PlaylistImport = () => import("@/pages/Playlist");
export const ShayariImport = () => import("@/pages/Shayari");
export const MapImport = () => import("@/pages/MapView");
export const UsImport = () => import("@/pages/Us");
export const SettingsImport = () => import("@/pages/Settings");
export const GroicImport = () => import("@/pages/Groic");
export const ProfileImport = () => import("@/pages/Profile");
export const PartnerSettingsImport = () => import("@/pages/settings/PartnerSettings");
export const DevicesSettingsImport = () => import("@/pages/settings/DevicesSettings");
export const SecuritySettingsImport = () => import("@/pages/settings/SecuritySettings");
export const AppearanceSettingsImport = () => import("@/pages/settings/AppearanceSettings");
export const DataBackupSettingsImport = () => import("@/pages/settings/DataBackupSettings");
export const ImportSettingsImport = () => import("@/pages/settings/ImportSettings");
export const NotificationsSettingsImport = () => import("@/pages/settings/NotificationsSettings");
export const LanguageSettingsImport = () => import("@/pages/settings/LanguageSettings");
export const PrivacyAISettingsImport = () => import("@/pages/settings/PrivacyAISettings");
export const ReflectionImport = () => import("@/pages/Reflection");

// Expose preloaders so FloatingDock / GridMenu / ChatHeader can warm a
// chunk on touchstart/hover without importing anything from App.tsx.
export const routePreload: Record<string, () => Promise<unknown>> = {
  "/chat": ChatImport,
  "/gallery": GalleryImport,
  "/calls": CallsImport,
  "/playlist": PlaylistImport,
  "/shayari": ShayariImport,
  "/map": MapImport,
  "/us": UsImport,
  "/settings": SettingsImport,
  "/groic": GroicImport,
  "/profile": ProfileImport,
  "/settings/partner": PartnerSettingsImport,
  "/settings/devices": DevicesSettingsImport,
  "/settings/security": SecuritySettingsImport,
  "/settings/appearance": AppearanceSettingsImport,
  "/settings/data": DataBackupSettingsImport,
  "/settings/import": ImportSettingsImport,
  "/settings/notifications": NotificationsSettingsImport,
  "/settings/language": LanguageSettingsImport,
  "/settings/privacy-ai": PrivacyAISettingsImport,
  "/reflection": ReflectionImport,
};
