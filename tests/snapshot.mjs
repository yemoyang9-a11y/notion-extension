/* Save a live page as a regression fixture (needs playwright: npm i -D playwright).
     node tests/snapshot.mjs <slug> <url> [--selection <css>]
   Opens the URL in Chromium, waits for network idle, scrolls to trigger lazy
   loading, and writes tests/pages/<slug>/{source.html, meta.json}. Then run
   `node tests/run.mjs <slug>` — the first run writes expected.json from the
   current output; review actual.json and edit expected.json to encode what
   SHOULD be there (see README). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const [slug, url, ...rest] = process.argv.slice(2);
if (!slug || !url) {
  console.error("usage: node tests/snapshot.mjs <slug> <url> [--selection <css>]");
  process.exit(1);
}
const selection = rest.includes("--selection") ? rest[rest.indexOf("--selection") + 1] : null;
const { chromium } = await import("playwright");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "ko-KR" });
await page.goto(url, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
for (let i = 0; i < 12; i++) {
  await page.mouse.wheel(0, 1200);
  await page.waitForTimeout(250);
}
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(500);
const html = await page.evaluate(() => "<!doctype html>" + document.documentElement.outerHTML);
await browser.close();
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "pages", slug);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "source.html"), html);
fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ url, ...(selection ? { selection } : {}), capturedAt: new Date().toISOString() }, null, 2));
console.log(`saved ${dir} (${(html.length / 1024).toFixed(0)} KB)`);
