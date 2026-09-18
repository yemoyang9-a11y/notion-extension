/* Assemble the loadable extension into dist/ (no bundler needed). */
import fs from "node:fs";
import path from "node:path";
const root = path.dirname(new URL(import.meta.url).pathname);
const dist = path.join(root, "dist");
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, "icons"), { recursive: true });
for (const f of ["manifest.json", "background.js", "extractor.js", "popup.html", "popup.js", "popup.css"]) fs.copyFileSync(path.join(root, "src", f), path.join(dist, f));
for (const f of fs.readdirSync(path.join(root, "src/icons"))) fs.copyFileSync(path.join(root, "src/icons", f), path.join(dist, "icons", f));
fs.copyFileSync(path.join(root, "vendor/defuddle.js"), path.join(dist, "defuddle.js"));
// the service worker must not carry the test-only export line
const bg = fs.readFileSync(path.join(dist, "background.js"), "utf8").replace(/\n\/\/ exported for tests[\s\S]*$/, "\n");
fs.writeFileSync(path.join(dist, "background.js"), bg);
console.log("dist/ ready:", fs.readdirSync(dist).join(", "));
