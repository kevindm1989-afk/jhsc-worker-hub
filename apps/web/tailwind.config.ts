import type { Config } from 'tailwindcss';

// Tailwind config for apps/web. Semantic color tokens map to CSS variables
// defined in src/index.css for light + dark themes. The raw Tailwind
// palette (`bg-red-50`, `text-slate-500`, etc.) is intentionally preserved
// via `extend` so the design prototypes' utility patterns transfer 1:1.
//
// In Group E this config will be replaced by an import of
// @jhsc/ui/tailwind-preset so the design system has a single source of truth.

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        status: {
          open: 'hsl(var(--status-open))',
          pending: 'hsl(var(--status-pending))',
          resolved: 'hsl(var(--status-resolved))',
          info: 'hsl(var(--status-info))',
          neutral: 'hsl(var(--status-neutral))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono Variable"', '"JetBrains Mono"', 'ui-monospace', 'monospace'],
        serif: ['"Source Serif 4 Variable"', '"Source Serif 4"', 'Georgia', 'serif'],
      },
    },
  },
  plugins: [],
};

export default config;
