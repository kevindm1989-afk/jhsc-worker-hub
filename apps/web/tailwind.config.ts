import type { Config } from 'tailwindcss';
import preset from '@jhsc/ui/tailwind-preset';

// Token definitions (colors, radii, fonts, dark-mode trigger) live in
// @jhsc/ui/tailwind-preset. The CSS variable values those tokens reference
// live in src/index.css. This file owns only the app-specific `content`
// glob.

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  presets: [preset],
};

export default config;
