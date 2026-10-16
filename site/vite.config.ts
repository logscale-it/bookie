import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // Pin the site's own tsconfig — Vite's automatic discovery walks up to the
  // repo root and picks up the Tauri app's tsconfig.json instead.
  tsconfig: "tsconfig.json",
  plugins: [tailwindcss(), sveltekit()],
});
