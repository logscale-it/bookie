import adapter from "@sveltejs/adapter-static";

// BASE_PATH is set to /bookie in CI so asset URLs work under the project
// site path on GitHub Pages. Locally it stays empty (root).
const base = process.env.BASE_PATH ?? "";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter({
      pages: "build",
      assets: "build",
      fallback: "404.html",
    }),
    paths: {
      base,
      relative: false,
    },
    prerender: {
      entries: ["*"],
    },
  },
};

export default config;
