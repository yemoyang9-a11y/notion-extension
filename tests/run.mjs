/* Regression corpus runner.
 *
 *   node tests/run.mjs            run every fixture in tests/pages
 *   node tests/run.mjs slug       run one
 *   node tests/run.mjs --update   rewrite expected.json from the current output (review the diff!)
 *
 * Each fixture directory holds:
 *   source.html     page snapshot (save with tests/snapshot.mjs or "Save as → Webpage, Complete")
 *   meta.json       { "url": "https://…", "selection": "<optional css selector to clip as a selection>" }
 *   expected.json   { "blocks": [ {type, language?, includes?, excludes?} … ],   // in-order subsequence
 *                     "excludesText": ["…"], "minWords": 0, "quality": {…} }
 */
import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const vendor = fs.readFileSync(path.join(root, "vendor/defuddle.js"), "utf8");
const extractor = fs.readFileSync(path.join(root, "src/extractor.js"), "utf8");

const args = process.argv.slice(2);
const update = args.includes("--update");
const only = args.filter((a) => !a.startsWith("--"));

export async function extractFixture(dir, { useSelection = false, mode = "article" } = {}) {
  const html = fs.readFileSync(path.join(dir, "source.html"), "utf8");
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => {});
  const dom = new JSDOM(html, { url: meta.url, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  window.eval(vendor);
  window.eval(extractor);
  if (meta.selection) {
    const el = window.document.querySelector(meta.selection);
    if (!el) throw new Error(`selection "${meta.selection}" not found`);
    const range = window.document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    useSelection = true;
  }
  const result = await window.__intactExtract({ useSelection, mode, fetchImages: false, debug: true });
  window.close();
  return result;
}

function blockText(block) {
  const body = block[block.type] || {};
  const runs = body.rich_text || body.caption || [];
  let text = runs.map((r) => (r.type === "equation" ? r.equation.expression : r.text ? r.text.content : "")).join("");
  if (block.type === "equation") text = body.expression;
  if (block.type === "image") text = (body.external && body.external.url) || "";
  if (block.type === "bookmark" || block.type === "embed") text = body.url;
  if (block.type === "video") text = body.external && body.external.url;
  if (block.type === "table") text = (body.children || []).map((r) => r.table_row.cells.map((c) => c.map((x) => (x.text ? x.text.content : "")).join("")).join(" | ")).join("\n");
  return text || "";
}

function flatten(blocks) {
  const out = [];
  for (const b of blocks) {
    out.push(b);
    const body = b[b.type] || {};
    if (Array.isArray(body.children) && b.type !== "table") out.push(...flatten(body.children));
  }
  return out;
}

function matches(actual, exp) {
  if (actual.type !== exp.type) return false;
  const text = blockText(actual);
  if (exp.language && (actual.code || {}).language !== exp.language) return false;
  if (exp.includes && !(Array.isArray(exp.includes) ? exp.includes : [exp.includes]).every((s) => text.includes(s))) return false;
  if (exp.excludes && (Array.isArray(exp.excludes) ? exp.excludes : [exp.excludes]).some((s) => text.includes(s))) return false;
  if (exp.equals != null && text !== exp.equals) return false;
  if (exp.width && (actual.table || {}).table_width !== exp.width) return false;
  if (exp.rows && ((actual.table || {}).children || []).length !== exp.rows) return false;
  if (exp.lines && text.split("\n").length !== exp.lines) return false;
  return true;
}

function check(result, expected) {
  const failures = [];
  const flat = flatten(result.blocks);
  let cursor = 0;
  for (const exp of expected.blocks || []) {
    let found = -1;
    for (let i = cursor; i < flat.length; i++) {
      if (matches(flat[i], exp)) {
        found = i;
        break;
      }
    }
    if (found < 0) failures.push(`missing block ${JSON.stringify(exp)}`);
    else cursor = found + 1;
  }
  const allText = flat.map(blockText).join("\n");
  for (const s of expected.excludesText || []) if (allText.includes(s)) failures.push(`text should not appear: ${JSON.stringify(s)}`);
  for (const s of expected.includesText || []) if (!allText.includes(s)) failures.push(`text missing: ${JSON.stringify(s)}`);
  if (expected.minWords && result.wordCount < expected.minWords) failures.push(`wordCount ${result.wordCount} < ${expected.minWords}`);
  if (expected.maxBlocks && flat.length > expected.maxBlocks) failures.push(`${flat.length} blocks > ${expected.maxBlocks}`);
  if (expected.title && !result.title.includes(expected.title)) failures.push(`title ${JSON.stringify(result.title)} lacks ${JSON.stringify(expected.title)}`);
  if (expected.quality) for (const [k, v] of Object.entries(expected.quality)) if (JSON.stringify(result.quality[k]) !== JSON.stringify(v)) failures.push(`quality.${k} = ${JSON.stringify(result.quality[k])}, expected ${JSON.stringify(v)}`);
  if (expected.via && result.via !== expected.via) failures.push(`via ${result.via} != ${expected.via}`);
  return failures;
}

function summarize(result) {
  return flatten(result.blocks).map((b) => {
    const entry = { type: b.type };
    const text = blockText(b);
    if (b.type === "code") entry.language = b.code.language;
    if (text) entry.text = text.length > 160 ? `${text.slice(0, 160)}…` : text;
    return entry;
  });
}

const pagesDir = path.join(here, "pages");
const slugs = fs.readdirSync(pagesDir).filter((s) => fs.existsSync(path.join(pagesDir, s, "source.html"))).filter((s) => !only.length || only.includes(s));
let failed = 0;
for (const slug of slugs) {
  const dir = path.join(pagesDir, slug);
  const started = Date.now();
  let result;
  try {
    result = await extractFixture(dir);
  } catch (e) {
    failed += 1;
    console.log(`✗ ${slug}: crashed — ${e && e.stack}`);
    continue;
  }
  fs.writeFileSync(path.join(dir, "actual.json"), JSON.stringify({ via: result.via, title: result.title, wordCount: result.wordCount, quality: result.quality, blocks: summarize(result) }, null, 2));
  const expectedPath = path.join(dir, "expected.json");
  if (update || !fs.existsSync(expectedPath)) {
    const expected = { via: result.via, blocks: summarize(result).map((b) => ({ type: b.type, ...(b.language ? { language: b.language } : {}) })) };
    fs.writeFileSync(expectedPath, JSON.stringify(expected, null, 2));
    console.log(`• ${slug}: expected.json ${update ? "updated" : "created"} (${result.blocks.length} blocks, ${Date.now() - started} ms)`);
    continue;
  }
  const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
  const failures = check(result, expected);
  if (failures.length) {
    failed += 1;
    console.log(`✗ ${slug} (${result.via}, ${result.blocks.length} blocks)`);
    for (const f of failures) console.log(`    ${f}`);
  } else console.log(`✓ ${slug} (${result.via}, ${result.blocks.length} blocks, ${result.wordCount} words, ${Date.now() - started} ms)`);
}
console.log(`\n${slugs.length - failed}/${slugs.length} fixtures passed`);
process.exit(failed ? 1 : 0);
