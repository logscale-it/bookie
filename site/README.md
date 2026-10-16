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

## Production build

The site is a project page, so it is served under the `/bookie/` base path:

```bash
cd site
BASE_PATH=/bookie bun run build   # outputs static files to site/build
bun run preview                   # serves site/build locally
```

`BASE_PATH` is set by the GitHub Actions workflow; locally it can stay unset.

## Pages

- `/` — English landing page
- `/pricing/` — pricing (Cloud price is a placeholder until it is decided)
- `/de/` — German landing page
- `/de/preise/` — German pricing
- `/de/impressum/` and `/de/datenschutz/` — legal pages (placeholders to be
  replaced with real contact data before going live)
- `/404/` — styled fallback page (prerendered to `404.html`)

## Notes

- `trailingSlash: 'always'` and `paths.base` keep asset URLs working under the
  project path on GitHub Pages.
- Screenshots live in `static/screenshots/` (copied from the app docs).
