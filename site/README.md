# Bookie Website

Marketing website for Bookie, built with SvelteKit (`adapter-static`) + Tailwind.
Deployed to GitHub Pages at https://logscale-it.github.io/bookie/ by
`.github/workflows/pages.yml` whenever `site/**` changes on `master`.

## Development

```bash
cd site
bun install
bun run dev        # http://localhost:5173, no base path
```

> **Known issue:** on Windows, `bun run dev` fails during dependency
> optimization when the project sits inside this repo's path
> ("Could not resolve 'node:module' in \0rolldown/runtime.js", Vite 8).
> `bun run build && bun run preview` works and serves the identical site.

## Production build

The site is a project page, so on GitHub Pages it is served under the
`/bookie/` base path. That base path is only set in CI — locally, build
**without** it so `preview` can serve the assets:

```bash
cd site
bun run build      # outputs static files to site/build (root-relative)
bun run preview    # serves site/build at http://localhost:4173/
```

The GitHub Actions workflow builds with `BASE_PATH=/bookie`, which prefixes
all asset URLs with `/bookie/` for the Pages deployment.

## Pages

- `/` and `/de/` — landing pages including the pricing section (the Cloud
  price is a placeholder until it is decided)
- `/imprint/` + `/de/impressum/` and `/privacy/` + `/de/datenschutz/` —
  legal pages in both languages
- `/404/` — styled fallback page (prerendered to `404.html`)

## Notes

- `trailingSlash: 'always'` and `paths.base` keep asset URLs working under the
  project path on GitHub Pages.
- Screenshots live in `static/screenshots/` (copied from the app docs).
