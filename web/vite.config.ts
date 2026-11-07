import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000', '/internal': 'http://localhost:3000', '/healthz': 'http://localhost:3000', '/readyz': 'http://localhost:3000' },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
});
