import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    tailwindcss(),
    // Tauri has no Node server for SSR: adapter-static with an index.html
    // fallback puts the site in SPA mode (https://svelte.dev/docs/kit/single-page-apps).
    sveltekit({
      preprocess: vitePreprocess(),
      adapter: adapter({ fallback: "index.html" }),
      // ponytail: SvelteKit 3 dropped the built-in $lib; the (deprecated) alias keeps
      // every import as is. Move to "#lib" subpath imports when the option goes away.
      alias: { $lib: "src/lib" },
    }),
  ],

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  // Tauri v2 recommendation: WebView2 (Chromium) on Windows, WebKit
  // (WKWebView / WebKitGTK) elsewhere.
  build: {
    target:
      process.env.TAURI_ENV_PLATFORM == "windows" ? "chrome105" : "safari13",
  },
}));
