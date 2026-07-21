import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import App from "./App.tsx";
import "./index.css";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { bootFontPreset } from "@/lib/fontLoader";
import { bootTextDensity } from "@/lib/textDensity";

// Apply the user's saved font preset before first paint.
bootFontPreset();
bootTextDensity();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary context="App">
      <App />
    </ErrorBoundary>
  </StrictMode>
);
