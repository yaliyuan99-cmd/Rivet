import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = process.env.RIVET_PORT ?? '8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${apiPort}`,
      '/oauth/token': `http://localhost:${apiPort}`,
    },
  },
  preview: { port: 5173 },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 700,
  },
});
