// GitHub Pages serves `404.html` for unknown paths. SvelteKit prerenders the
// custom 404 route to `404/index.html`, so copy it to the expected location.
import { copyFileSync } from "node:fs";

copyFileSync("build/404/index.html", "build/404.html");
console.log("Copied build/404/index.html -> build/404.html");
