import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  // Pin the site's own tsconfig for production builds — Vite's automatic
  // discovery walks up to the repo root and picks up the Tauri app's
  // tsconfig.json instead.
  ...(command === "build" ? { tsconfig: "tsconfig.json" } : {}),
  plugins: [
    tailwindcss(),
    sveltekit(),
    // Never let the browser cache preview responses: asset filenames are
    // content-hashed, so a cached HTML page would reference assets that no
    // longer exist after a rebuild.
    {
      name: "no-store-preview-headers",
      configurePreviewServer(server) {
        server.middlewares.use((req, res, next) => {
          res.setHeader("Cache-Control", "no-store");
          next();
        });
      },
    },
  ],
}));
