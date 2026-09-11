import { defineConfig } from 'vite';

// GitHub Pages serves the site from a subpath (/EvlyMC2/); Cloudflare Pages
// serves it from the domain root ("/") - Cloudflare's own build pipeline sets
// CF_PAGES=1 automatically, so the base flips on its own with no separate
// build config to keep in sync. Keyed on `mode`, not `command`: `vite preview`
// runs with command === 'serve' but mode === 'production', and it has to serve
// the same base the built index.html was written with. The dev server (mode
// 'development') stays at "/" so local URLs keep working unchanged.
export default defineConfig(({ mode }) => ({
  base: mode === 'production' ? (process.env.CF_PAGES ? '/' : '/EvlyMC2/') : '/',
  server: {
    host: 'localhost',
  },
}));