import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import App from "./App.tsx";
import "./App.css";
import "./index.css";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { bootFontPreset } from "@/lib/fontLoader";
import { bootTextDensity } from "@/lib/textDensity";
import { errorManager } from "@/lib/errors/errorManager";
import { registerAppRecoveries } from "@/lib/errors/registerAppRecoveries";

// Apply the user's saved font preset before first paint.
bootFontPreset();
bootTextDensity();

// Install global handlers (window.onerror, unhandledrejection) for the
// DuoSpace Error System. Must run before anything else can throw.
errorManager.init();
registerAppRecoveries();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary context="App">
      <App />
    </ErrorBoundary>
  </StrictMode>
);
