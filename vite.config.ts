import { defineConfig } from 'vite'
import pkg from './package.json' with { type: 'json' }

// Cue dev server. Port 5176 to avoid colliding with Pulse (5174),
// Glance (5175), and any default Vite (5173) when running side by side.
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    host: '0.0.0.0',
    port: 5176,
    allowedHosts: ['.trycloudflare.com'],
  },
})
