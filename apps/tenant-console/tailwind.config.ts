import type { Config } from 'tailwindcss';
import foundationPreset from '@agentos/ui-foundation/tailwind-preset';

const config: Config = {
  presets: [foundationPreset],
  content: [
    './src/**/*.{ts,tsx}',
    '../../packages/ui-foundation/src/**/*.{ts,tsx}',
    '../../packages/ui-foundation/dist/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        canvas: 'var(--ag-canvas)',
        surface: 'var(--ag-surface)',
        'surface-low': 'var(--ag-surface-low)',
        'surface-raised': 'var(--ag-surface-raised)',
        ink: 'var(--ag-text-strong)',
        'ink-body': 'var(--ag-text)',
        muted: 'var(--ag-text-muted)',
        brand: 'var(--ag-brand)',
        'brand-deep': 'var(--ag-brand-deep)',
        'brand-soft': 'var(--ag-brand-soft)',
        line: 'var(--ag-border)',
      },
      fontFamily: {
        sans: ['var(--font-ui)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
