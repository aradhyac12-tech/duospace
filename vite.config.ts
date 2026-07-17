import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// Correct project credentials (matches .env / Supabase project povhwwcswvfihmcdqgyv).
// Previous fallback had a corrupted JWT (wrong ref + "Hsupabase" issuer) which
// caused "Invalid API key" errors whenever VITE_ env vars weren't injected.
const LOVABLE_CLOUD_URL = "https://povhwwcswvfihmcdqgyv.supabase.co";
const LOVABLE_CLOUD_PUBLISHABLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBvdmh3d2Nzd3ZmaWhtY2RxZ3l2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg0NzgwMTQsImV4cCI6MjA5NDA1NDAxNH0.UzPse5kgQBH3lDcDFj97qX4nc483wUnKBCu7J6-oz18";

export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: { overlay: false },
  },
  define: {
    "process.env.SUPABASE_URL": JSON.stringify(process.env.SUPABASE_URL ?? LOVABLE_CLOUD_URL),
    "process.env.SUPABASE_PUBLISHABLE_KEY": JSON.stringify(process.env.SUPABASE_PUBLISHABLE_KEY ?? LOVABLE_CLOUD_PUBLISHABLE_KEY),
  },
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
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
    sourcemap: false,
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
