# Design system pointer

DO NOT REDESIGN. The visual language is dark, premium, glass-like: Tailwind 3.4
(`tailwind.config.ts`), shadcn/ui primitives in `src/components/ui/`, Radix,
framer-motion, lucide icons, CSS-variable theming through
`src/contexts/ThemeContext.tsx` + `src/lib/themeEngine.ts`.

Authoritative design documents already in the repo: `docs/design.md`,
`docs/PHASE2_DESIGN_SYSTEM.md`, `docs/DUOSPACE-REDESIGN-*.md`,
`docs/UI_REDESIGN_FORENSIC_AUDIT.md`. Read those before changing any UI.

Privacy UI rules that now apply (Phase 1.6): a consent switch must say what
will be saved and where; camera-derived values are labelled as guesses; nothing
camera-derived is shown to the partner as the user's own words until the user
confirms it.
