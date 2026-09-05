import { defineConfig } from "vite";
// FIX (preview/publish ERR_MODULE_NOT_FOUND): this imported plain
// @vitejs/plugin-react while package.json/the lockfile only ever carried
// @vitejs/plugin-react-swc — a mismatch that's invisible in an environment
// that already has stale node_modules, but breaks any truly clean install
// (Lovable preview, Lovable publish, Cloudflare Pages all run `npm ci`),
// at which point Vite can't resolve the import and dies before it even
// boots. plugin-react-swc is the actual installed dependency (see
// package.json), so that's what this now imports.
import react from "@vitejs/plugin-react-swc";
// componentTagger() powers Lovable's in-preview click-to-edit — it tags
// each JSX element with its source location during dev builds only (see
// the `mode === "development"` gate below). It's a build-time transform,
// not something that touches the app's own runtime behavior, so it's
// safe to leave wired in unconditionally at the plugins-array level.
import { componentTagger } from "lovable-tagger";
import path from "path";

// Supabase credentials (project jzlpelxwzjjpddqcrtpu) are supplied via
// VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY and read directly with
// import.meta.env in src/integrations/supabase/client.ts — Vite exposes
// VITE_-prefixed env vars to client code natively, so no custom `define` or
// hardcoded fallback is needed here. Set these in .env.local for local dev
// (see .env.example) and as Cloudflare Pages build environment variables
// for production.

export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: false,
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Local Capacitor plugins are TS-only sources (no prebuilt dist) — point
      // both the bundler and tsc at their entry files.
      "duospace-audio-route": path.resolve(__dirname, "./native-plugins/audio-route/src/index.ts"),
      "duospace-device-status": path.resolve(__dirname, "./native-plugins/device-status/src/index.ts"),
      "duospace-callkit-bridge": path.resolve(__dirname, "./native-plugins/callkit-bridge/src/index.ts"),
      "duospace-background-geolocation": path.resolve(__dirname, "./native-plugins/background-geolocation/src/index.ts"),
      "duospace-audio-engine": path.resolve(__dirname, "./native-plugins/audio-engine/src/index.ts"),
    },
    // Force a single React copy — prevents "Cannot read properties of null (reading 'useState')"
    // when a dep (e.g. framer-motion / next-themes) gets pre-bundled with its own React resolution.
    dedupe: ["react", "react-dom", "react/jsx-runtime"],
  },
  optimizeDeps: {
    include: ["react", "react-dom", "react/jsx-runtime", "react-router-dom", "leaflet"],
  },
  build: {
    target: "es2020",
    assetsInlineLimit: 4096,
    // Was `false`. A production crash's componentStack/stack only ever
    // contained minified positions like "index-kjB1qYws.js:341:104398" —
    // undecodable without the sourcemap for that exact build, and prior
    // builds never kept one. "hidden" emits the .map file (so a real crash
    // can be decoded after the fact) without adding the sourceMappingURL
    // comment that would make browsers auto-fetch it for every visitor.
    sourcemap: "hidden",
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-supabase": ["@supabase/supabase-js"],
          "vendor-motion": ["framer-motion"],
          "vendor-ui": [
            "@radix-ui/react-dialog",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-tabs",
            "@radix-ui/react-toast",
            "@radix-ui/react-switch",
          ],
        },
      },
    },
  },
}));
