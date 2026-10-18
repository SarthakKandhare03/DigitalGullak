import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        // Long-lived vendor chunks: app updates don't invalidate the browser's cached React.
        manualChunks: {
          react: ['react', 'react-dom', 'react-dom/client', 'react-router', 'scheduler'],
          query: ['@tanstack/react-query'],
        },
      },
    },
  },
});
