/* Loads dist-test/ into real Chromium and exercises injection across frames,
   the popup page, and the extractor on the fixture corpus served over HTTP. */
import { chromium } from "playwright";
import path from "node:path";
import http from "node:http";
import fs from "node:fs";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ext = path.join(root, "dist-test");
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split("?")[0]));
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; res.end("nf"); return; }
  res.setHeader("content-type", "text/html; charset=utf-8"); res.end(fs.readFileSync(p));
}).listen(8765);
const ctx = await chromium.launchPersistentContext("", { headless: true, executablePath: process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--headless=new"] });
// serve fixtures under their real hostnames so site handlers trigger
await ctx.route(/^https:\/\/(blog\.naver\.com|github\.com)\//, (route) => {
  const u = new URL(route.request().url());
  let file = null;
  if (u.hostname === "blog.naver.com" && u.pathname === "/yemo/223000000001") file = "tests/site/naver-shell.html";
  else if (u.hostname === "blog.naver.com" && u.pathname === "/PostView.naver") file = "tests/pages/naver-smarteditor/source.html";
  else if (u.hostname === "github.com") file = "tests/pages/github-blob/source.html";
  if (!file) return route.fulfill({ status: 404, body: "nf" });
  let body = fs.readFileSync(path.join(root, file), "utf8");
  if (file.endsWith("naver-shell.html")) body = body.replace("/tests/pages/naver-smarteditor/source.html", "https://blog.naver.com/PostView.naver?blogId=yemo&logNo=223000000001");
  return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
const extId = sw.url().split("/")[2];
console.log("extension", extId);

async function extractTab(url, opts = {}) {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(300);
  const result = await sw.evaluate(async ({ url, opts }) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => (t.url || "").split("#")[0] === url || (t.pendingUrl || "") === url);
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["defuddle.js", "extractor.js"] });
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: (o) => window.__intactExtract(o), args: [opts] });
    return results.map((r) => r.result).filter(Boolean).map((r) => ({ ok: r.ok, isTop: r.isTop, via: r.via, skipped: r.skipped, frameUrl: r.frameUrl, wordCount: r.wordCount, blockCount: r.blockCount, quality: r.quality, uploads: r.uploads, types: (r.blocks || []).map((b) => b.type) }));
  }, { url, opts });
  await page.close();
  return result;
}

let failed = 0;
const check = (cond, msg) => { console.log(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) failed++; };

// 1. Naver-style shell + iframe: the frame result must carry the article
const frames = await extractTab("https://blog.naver.com/yemo/223000000001", { fetchImages: false });
const top = frames.find((f) => f.isTop), inner = frames.find((f) => !f.isTop);
check(top && top.ok, `top frame extracted (${top && top.wordCount} words)`);
check(inner && inner.ok && inner.via === "site-handler", `iframe extracted via site handler (${inner && inner.blockCount} blocks)`);
check(inner && inner.types.includes("code") && inner.types.includes("bookmark") && inner.types.includes("table"), "iframe blocks include code/bookmark/table");

// 2. every fixture through real Chrome (computed styles, real CSS.escape, etc.)
for (const slug of fs.readdirSync(path.join(root, "tests/pages"))) {
  const meta = JSON.parse(fs.readFileSync(path.join(root, "tests/pages", slug, "meta.json"), "utf8"));
  const r = await extractTab(`http://127.0.0.1:8765/tests/pages/${slug}/source.html`, { fetchImages: false, useSelection: false });
  const t = r.find((f) => f.isTop);
  check(t && t.ok && t.blockCount > 2, `${slug}: ${t && t.via}, ${t && t.blockCount} blocks, ${t && t.wordCount} words, uploads ${t && t.uploads && t.uploads.length}`);
  void meta;
}

// 2b. GitHub blob under its real hostname
const gh = await extractTab("https://github.com/yemo/intact/blob/main/src/extractor.py", { fetchImages: false });
check(gh[0] && gh[0].via === "site-handler" && gh[0].types.includes("code"), `github blob via site handler (${gh[0] && gh[0].blockCount} blocks)`);

// 3. image upload planning fetches bytes in the page context
const img = await extractTab("http://127.0.0.1:8765/tests/pages/images-lazy-webp-picture/source.html", { fetchImages: true });
check(img.find((f) => f.isTop).ok, "fetchImages run does not crash on unreachable hosts");

// 4. popup loads without errors
const popup = await ctx.newPage();
const errors = [];
popup.on("pageerror", (e) => errors.push(String(e)));
popup.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await popup.goto(`chrome-extension://${extId}/popup.html`);
await popup.waitForTimeout(800);
const connectVisible = await popup.evaluate(() => !document.getElementById("view-connect").hidden);
check(connectVisible, "popup renders the connect view when not authenticated");
check(errors.length === 0, `popup has no console errors ${errors.length ? JSON.stringify(errors) : ""}`);

// 5. background message router: status + preview through the real message path
const status = await popup.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "status" }, r)));
check(status && status.ok && status.data.connected === false, "status message answered");
const page2 = await ctx.newPage();
await page2.goto("http://127.0.0.1:8765/tests/pages/medium-like-article/source.html");
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => (t.url || "").includes("medium-like")).id);
const preview = await popup.evaluate((tabId) => new Promise((r) => chrome.runtime.sendMessage({ type: "preview", tabId, useSelection: false }, r)), tabId);
check(preview.ok && !preview.data.quality.paywall, "no paywall false positive on a metered-but-open article");
check(preview.ok && preview.data.blockCount > 5, `preview via router: ${preview.ok ? preview.data.blockCount + " blocks, quality " + JSON.stringify(preview.data.quality) : preview.error}`);
const report = await popup.evaluate((tabId) => new Promise((r) => chrome.runtime.sendMessage({ type: "report", tabId }, r)), tabId);
check(report.ok && report.data.bundle.blocks.length > 0 && report.data.issueUrl.startsWith("https://github.com/"), "report bundle built");
const bookmark = await popup.evaluate((tabId) => new Promise((r) => chrome.runtime.sendMessage({ type: "preview", tabId, mode: "bookmark" }, r)), tabId);
check(bookmark.ok && bookmark.data.mode === "bookmark", "bookmark mode preview");

await ctx.close();
server.close();
console.log(failed ? `\n${failed} e2e checks failed` : "\nall e2e checks passed");
process.exit(failed ? 1 : 0);
