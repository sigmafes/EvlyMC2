import { defineConfig } from 'vite';

// GitHub Pages serves the site from a subpath (/EvlyMC2/), so the production
// build needs a matching `base`. Keyed on `mode`, not `command`: `vite preview`
// runs with command === 'serve' but mode === 'production', and it has to serve
// the same base the built index.html was written with. The dev server (mode
// 'development') stays at "/" so local URLs keep working unchanged.
export default defineConfig(({ mode }) => ({
  base: mode === 'production' ? '/EvlyMC2/' : '/',
  server: {
    host: 'localhost',
  },
}));
