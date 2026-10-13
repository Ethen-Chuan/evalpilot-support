import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4287',
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          radix: ['@radix-ui/themes', '@radix-ui/react-dialog'],
        },
      },
    },
  },
});
