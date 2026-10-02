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

import { withChunkRetry } from "@/lib/chunkReload";

export const ChatImport = withChunkRetry(() => import("@/pages/Chat"));
export const GalleryImport = withChunkRetry(() => import("@/pages/Gallery"));
export const CallsImport = withChunkRetry(() => import("@/pages/Calls"));
export const PlaylistImport = withChunkRetry(() => import("@/pages/Playlist"));
export const ShayariImport = withChunkRetry(() => import("@/pages/Shayari"));
export const MapImport = withChunkRetry(() => import("@/pages/MapView"));
export const UsImport = withChunkRetry(() => import("@/pages/Us"));
export const SettingsImport = withChunkRetry(() => import("@/pages/Settings"));
export const GroicImport = withChunkRetry(() => import("@/pages/Groic"));
export const ProfileImport = withChunkRetry(() => import("@/pages/Profile"));
export const PartnerSettingsImport = withChunkRetry(() => import("@/pages/settings/PartnerSettings"));
export const DevicesSettingsImport = withChunkRetry(() => import("@/pages/settings/DevicesSettings"));
export const SecuritySettingsImport = withChunkRetry(() => import("@/pages/settings/SecuritySettings"));
export const AppearanceSettingsImport = withChunkRetry(() => import("@/pages/settings/AppearanceSettings"));
export const DataBackupSettingsImport = withChunkRetry(() => import("@/pages/settings/DataBackupSettings"));
export const ImportSettingsImport = withChunkRetry(() => import("@/pages/settings/ImportSettings"));
export const NotificationsSettingsImport = withChunkRetry(() => import("@/pages/settings/NotificationsSettings"));
export const LanguageSettingsImport = withChunkRetry(() => import("@/pages/settings/LanguageSettings"));
export const PrivacyAISettingsImport = withChunkRetry(() => import("@/pages/settings/PrivacyAISettings"));
export const DuoSpacePlusSettingsImport = withChunkRetry(() => import("@/pages/settings/DuoSpacePlusSettings"));
export const AdminSettingsImport = withChunkRetry(() => import("@/pages/settings/AdminSettings"));
export const ReflectionImport = withChunkRetry(() => import("@/pages/Reflection"));

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
  "/settings/plus": DuoSpacePlusSettingsImport,
  "/settings/admin": AdminSettingsImport,
  "/reflection": ReflectionImport,
};
