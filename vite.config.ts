import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    host: true,
    port: 3001,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
      },
    },
  },
});