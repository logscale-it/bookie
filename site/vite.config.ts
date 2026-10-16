import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  // Pin the site's own tsconfig for production builds — Vite's automatic
  // discovery walks up to the repo root and picks up the Tauri app's
  // tsconfig.json instead.
  ...(command === "build" ? { tsconfig: "tsconfig.json" } : {}),
  plugins: [tailwindcss(), sveltekit()],
}));
