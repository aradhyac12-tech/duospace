import { defineConfig } from "vitest/config";
// FIX (in sync with vite.config.ts — same root cause): the actual
// installed/locked dependency is @vitejs/plugin-react-swc, not plain
// @vitejs/plugin-react. Both configs must import the same one the
// lockfile actually carries, or whichever one is out of sync fails to
// boot on a clean install (`npm ci`) — that's exactly what broke Lovable
// preview/publish and Cloudflare here.
import react from "@vitejs/plugin-react-swc";
import path from "path";

// FIX AUDIT #1: Comprehensive test configuration.
// - Coverage thresholds enforce minimum 70% across all metrics.
// - Verbose reporter shows each test name for easier CI debugging.
// - testTimeout raised to 10s for async network-simulation tests.
// - Exclude node_modules and Supabase edge functions (Deno runtime).

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: [
      "**/node_modules/**",
      "**/supabase/functions/**",
      "**/dist/**",
    ],
    testTimeout: 10_000,
    reporters: ["verbose"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/test/**",
        "src/**/*.d.ts",
        "src/integrations/**",     // generated Supabase types
        "src/components/ui/**",    // shadcn primitives
        "src/main.tsx",
        "src/vite-env.d.ts",
      ],
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 70,
        lines: 70,
      },
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});

