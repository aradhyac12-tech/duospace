# Handoff — RI/theme convergence (offline)
Not run (no network/node_modules): npm ci, lint, vitest, tsc, build, check:*, Android verify. No device testing.
First thing on a networked machine: `npm ci && npx tsc -p tsconfig.app.json --noEmit && npm test && npm run lint`.
Likeliest breakages: presentI18n.test.ts (language switching via setLanguageCode; "fine" fallback case), themeVisualSystem glow/CSS-contract tests, any snapshot that quoted old accusation/control/Today strings.
See CHANGELOG "RI/theme convergence pass" for scope and the list of surfaces still English in hi/mr.
