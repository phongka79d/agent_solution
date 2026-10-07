import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}', '../../packages/ui-foundation/src/**/*.{ts,tsx}'],
  presets: [require('@agentos/ui-foundation/tailwind-preset')],
  theme: {
    extend: {
      colors: {
        canvas: 'var(--color-canvas)',
        surface: 'var(--color-surface)',
        'surface-low': 'var(--color-surface-subtle)',
        'surface-raised': 'var(--color-surface-raised)',
        ink: 'var(--color-text)',
        'ink-body': 'var(--color-text-body)',
        muted: 'var(--color-text-muted)',
        subtle: 'var(--color-text-subtle)',
        line: 'var(--color-border-subtle)',
        'line-strong': 'var(--color-border-strong)',
        brand: 'var(--color-interactive)',
        'brand-deep': 'var(--color-interactive-secondary)',
        'brand-soft': 'var(--color-info-bg)',
        primary: 'var(--color-primary)',
        success: 'var(--color-success)',
        'success-bg': 'var(--color-success-bg)',
        warning: 'var(--color-warning)',
        'warning-bg': 'var(--color-warning-bg)',
        danger: 'var(--color-danger)',
        'danger-bg': 'var(--color-danger-bg)',
        info: 'var(--color-info)',
        'info-bg': 'var(--color-info-bg)',
        ai: 'var(--color-ai)',
        'ai-bg': 'var(--color-ai-bg)',
      },
      fontFamily: {
        sans: ['var(--font-ui)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
