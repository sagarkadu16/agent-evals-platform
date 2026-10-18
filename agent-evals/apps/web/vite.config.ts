import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    // The page calls /api/... on its own origin; Vite forwards it to Nest, so no CORS is needed.
    proxy: { '/api': process.env.API_URL ?? 'http://localhost:3000' },
  },
})
