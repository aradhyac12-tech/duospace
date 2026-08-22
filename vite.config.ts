import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
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
    hmr: { overlay: false },
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Local Capacitor plugins are TS-only sources (no prebuilt dist) — point
      // both the bundler and tsc at their entry files.
      "duospace-audio-route": path.resolve(__dirname, "./native-plugins/audio-route/src/index.ts"),
      "duospace-device-status": path.resolve(__dirname, "./native-plugins/device-status/src/index.ts"),
      "duospace-callkit-bridge": path.resolve(__dirname, "./native-plugins/callkit-bridge/src/index.ts"),
    },
    // Force a single React copy — prevents "Cannot read properties of null (reading 'useState')"
    // when a dep (e.g. framer-motion / next-themes) gets pre-bundled with its own React resolution.
    dedupe: ["react", "react-dom", "react/jsx-runtime"],
  },
  optimizeDeps: {
    include: ["react", "react-dom", "react/jsx-runtime", "react-router-dom"],
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
