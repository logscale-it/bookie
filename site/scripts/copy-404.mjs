// GitHub Pages serves the root `404.html` for unknown paths (it does not
// support per-directory 404 files). SvelteKit prerenders the 404 routes to
// `404/index.html` (English) and `de/404/index.html` (German), so write a
// small redirector that sends visitors to the 404 page matching the language
// of the URL they tried to open.
import { writeFileSync } from "node:fs";

const base = process.env.BASE_PATH ?? "";

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>404</title>
    <script>
      (function () {
        var base = ${JSON.stringify(base)};
        var path = location.pathname;
        var isDe = path === base + "/de" || path.startsWith(base + "/de/");
        location.replace(base + (isDe ? "/de/404/" : "/404/"));
      })();
    </script>
  </head>
  <body></body>
</html>
`;

writeFileSync("build/404.html", html);
console.log("Wrote build/404.html (language-aware redirector)");
