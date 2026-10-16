import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        sans: ['var(--font-body)', 'system-ui', 'sans-serif'],
        serif: ['var(--font-heading)', 'Georgia', 'serif'],
        heading: ['var(--font-heading)', 'Georgia', 'serif'],
        body: ['var(--font-body)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      colors: {
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
        },
        offline: {
          DEFAULT: "hsl(var(--offline))",
          foreground: "hsl(var(--offline-foreground))",
        },
        surface: {
          0: "hsl(var(--surface-0))",
          1: "hsl(var(--surface-1))",
          2: "hsl(var(--surface-2))",
          3: "hsl(var(--surface-3))",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: {
          DEFAULT: "hsl(var(--foreground))",
          // Phase 1: additive text tiers. `secondary` mirrors the existing
          // --muted-foreground value (no visual change to anything already
          // using muted-foreground); `tertiary` is a new, quieter tier.
          // Usable as text-foreground-secondary / text-foreground-tertiary.
          secondary: "hsl(var(--text-secondary))",
          tertiary: "hsl(var(--text-tertiary))",
        },
        // Phase 1: semantic alias for hairline dividers (date separators,
        // list rules) distinct from --border's input/component usage,
        // same underlying value today. Usable as border-divider.
        divider: "hsl(var(--divider))",
        // Phase 1: overlay backdrop for contextual (non-modal) dimming —
        // lighter than the existing bg-overlay-scrim used by dialogs.
        overlay: "hsl(var(--overlay))",
        warm: "hsl(var(--warm))",
        taupe: "hsl(var(--taupe))",
        sand: "hsl(var(--sand))",
        // Phase 2: fixed, theme-invariant colors for the cinematic call
        // surface — see index.css's --call-stage comment for why this
        // can't just be `foreground`/`background`.
        "call-stage": {
          DEFAULT: "hsl(var(--call-stage))",
          foreground: "hsl(var(--call-stage-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
          // Phase 1: soft violet wash for selected/active chip fills.
          // Usable as bg-accent-muted.
          muted: "hsl(var(--accent-muted))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        // Design System 2.0 §3 radius scale — floating/pill are new names
        // for shapes already used ad-hoc (composer/attach-tray ~26px,
        // fully-round buttons). Additive: existing rounded-{sm,md,lg,full}
        // usages are untouched.
        floating: "var(--radius-floating)",
        pill: "var(--radius-pill)",
        panel: "var(--radius-panel)",
      },
      spacing: {
        touch: "var(--touch-target-min)",
        "dock-reserve": "var(--dock-reserve)",
      },
      height: {
        touch: "var(--touch-target-min)",
      },
      minHeight: {
        touch: "var(--touch-target-min)",
      },
      minWidth: {
        touch: "var(--touch-target-min)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "pulse-soft": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.6" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "pulse-soft": "pulse-soft 2s ease-in-out infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;
