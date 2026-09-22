import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/component.ts',
      name: 'AgentStorefrontWidget',
      formats: ['iife'],
      fileName: 'agent-storefront-widget',
    },
    emptyOutDir: true,
  },
});
