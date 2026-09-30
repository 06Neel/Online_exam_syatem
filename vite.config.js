import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  publicDir: 'public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: {
      '/api': 'http://localhost:3001',
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
      },
    },
  },
});
