import { startBlackBox } from "@/lib/blackBox";
import BlackBoxNotice from "@/components/BlackBoxNotice";
import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import App from "./App.tsx";
import "./App.css";
import "./index.css";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { bootFontPreset } from "@/lib/fontLoader";
import { bootTextDensity } from "@/lib/textDensity";
import { bootPerfProfile } from "@/lib/perfProfile";
import { bootTheme } from "@/lib/themeBoot";
import { errorManager } from "@/lib/errors/errorManager";
import { registerAppRecoveries } from "@/lib/errors/registerAppRecoveries";
import { isSupabaseConfigured } from "@/integrations/supabase/appClient";
import { startConnectivityMonitor } from "@/lib/connectivity";
import { reloadOnceForStaleChunk } from "@/lib/chunkReload";
import { initGlobalHaptics } from "@/lib/globalHaptics";
import { requestPersistentStorage } from "@/lib/storagePersistence";

// BLANK-SCREEN FIX (see src/integrations/supabase/client.ts for the full
// root-cause writeup): with no Supabase env vars set, the app used to just
// go blank with a console-only error — createClient() threw during module
// evaluation, before this file's own render call ever ran, so nothing
// (not even <ErrorBoundary>) got the chance to show anything. client.ts no
// longer throws in that case; this is the explicit screen that replaces the
// silent blank page. Plain DOM, no app CSS/component tree dependency, since
// this has to render even if something else in the app is misconfigured too.
const ConfigError = () => (
  <div
    style={{
      minHeight: "100dvh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "24px",
      fontFamily: "system-ui, -apple-system, sans-serif",
      background: "#121316",
      color: "#F6F6F9",
      textAlign: "center" as const,
    }}
  >
    <div style={{ maxWidth: 420 }}>
      <h1 style={{ fontSize: 20, marginBottom: 12 }}>DuoSpace isn't configured yet</h1>
      <p style={{ fontSize: 14, opacity: 0.8, lineHeight: 1.5 }}>
        Missing <code>VITE_SUPABASE_URL</code> / <code>VITE_SUPABASE_PUBLISHABLE_KEY</code>.
        Add them to <code>.env.local</code> (see <code>.env.example</code>) for local dev,
        or as build-time environment variables on your hosting provider, then rebuild.
      </p>
    </div>
  </div>
);

// Vite fires this when a preloaded chunk/CSS 404s after a new deploy.
window.addEventListener("vite:preloadError", (e) => {
  if (reloadOnceForStaleChunk()) e.preventDefault();
});

// Apply the user's saved font preset before first paint.
bootFontPreset();
bootTextDensity();
bootPerfProfile();
// Apply the persisted colour theme before the first render so boot/splash
// screens paint in the active theme (no default-colour flash).
bootTheme();

// Install global handlers (window.onerror, unhandledrejection) for the
// DuoSpace Error System. Must run before anything else can throw.
errorManager.init();
// Flight recorder: records lag/freezes/breadcrumbs and explains the PREVIOUS run if it died (see lib/blackBox.ts).
startBlackBox();
// Offline-first: start watching connectivity (and bridge native reconnects) early.
startConnectivityMonitor();
// Ask the browser/WebView not to evict the offline cache (chat history, media) under storage pressure.
void requestPersistentStorage();
initGlobalHaptics();
registerAppRecoveries();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isSupabaseConfigured ? (
      <ErrorBoundary context="App">
        <App />
        <BlackBoxNotice />
      </ErrorBoundary>
    ) : (
      <ConfigError />
    )}
  </StrictMode>
);
