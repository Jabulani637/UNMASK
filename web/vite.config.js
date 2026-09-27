import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API is a separate process on 4100. Proxying /api here means the browser
// sees one origin, so the session cookie stays first-party and no CORS
// pre-flight runs on every request.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:4100',
        changeOrigin: true,
      },
      // The chat socket. Without `ws` here the browser would open a second
      // origin, and a cross-site WebSocket handshake carries no session cookie.
      '/ws': {
        target: 'ws://localhost:4100',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
