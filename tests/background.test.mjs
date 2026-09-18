/* Unit tests for the sender: validation, chunking, block-level recovery.
   node tests/background.test.mjs */
import assert from "node:assert/strict";

const store = {};
globalThis.chrome = {
  runtime: { id: "test-ext", onMessage: { addListener() {} }, onInstalled: { addListener() {} }, sendMessage: async () => {}, getManifest: () => ({ version: "test" }) },
  storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o), remove: async () => {} } },
  contextMenus: { onClicked: { addListener() {} }, removeAll() {}, create() {} },
  scripting: {}, tabs: {}, action: {}, identity: {}, declarativeNetRequest: null,
};

const calls = [];
globalThis.fetch = async (url, init) => {
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ url, method: init.method, body });
  const json = (status, data) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(data) });
  if (/\/blocks\/.+\/children$/.test(url) && init.method === "PATCH") {
    const children = body.children;
    for (let i = 0; i < children.length; i++) {
      const b = children[i];
      if (b.type === "image" && b.image.type === "external" && !/\.(png|jpg|jpeg|gif|svg)$/i.test(new URL(b.image.external.url).pathname)) {
        return json(400, { object: "error", status: 400, code: "validation_error", message: `body.children[${i}].image.external.url should be a valid image url.` });
      }
      if (b.type === "code" && b.code.language === "hcl") {
        return json(400, { object: "error", status: 400, code: "validation_error", message: `body.children[${i}].code.language should be one of the enum values.` });
      }
      if (b.type === "bookmark" && /poison/.test(b.bookmark.url)) {
        return json(400, { object: "error", status: 400, code: "validation_error", message: "Invalid request URL." }); // no index
      }
      if (b.type === "table" && b.table.children.length > 3) {
        return json(400, { object: "error", status: 400, code: "validation_error", message: `body.children[${i}].table.children.length should be ≤ 3 (test)` });
      }
    }
    return json(200, { results: children.map((c, i) => ({ id: `blk-${calls.length}-${i}`, type: c.type })) });
  }
  return json(200, {});
};

const bg = await import("../src/background.js");
const text = (t) => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: t } }] } });
const img = (u) => ({ object: "block", type: "image", image: { type: "external", external: { url: u } } });

// --- sanitizeBlocks ---
{
  const log = [];
  const out = bg.sanitizeBlocks([
    img("https://cdn.example.com/a.webp"),
    img("https://cdn.example.com/a.png"),
    { object: "block", type: "video", video: { type: "external", external: { url: "https://cdn.example.com/x.mp4" } } },
    { object: "block", type: "video", video: { type: "external", external: { url: "https://www.youtube.com/watch?v=abc" } } },
    { object: "block", type: "equation", equation: { expression: "x".repeat(1200) } },
    { object: "block", type: "code", code: { language: "hcl", rich_text: [{ type: "text", text: { content: "a" } }] } },
    { object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "y".repeat(4500), link: { url: "javascript:alert(1)" } } }] } },
    { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: "l1" } }], children: [
      { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: "l2" } }], children: [
        { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: "l3" } }] } },
      ] } },
    ] } },
    { object: "block", type: "table", table: { table_width: 2, has_column_header: false, has_row_header: false, children: Array.from({ length: 150 }, (_, i) => ({ object: "block", type: "table_row", table_row: { cells: [[{ type: "text", text: { content: String(i) } }]] } })) } },
  ], 0, log);
  assert.equal(out[0].type, "bookmark", "webp image → bookmark");
  assert.equal(out[1].type, "image");
  assert.equal(out[2].type, "bookmark", "mp4 video → bookmark");
  assert.equal(out[3].type, "video");
  assert.equal(out[4].type, "code", "long equation → latex code");
  assert.equal(out[5].code.language, "plain text");
  const runs = out[6].paragraph.rich_text;
  assert.ok(runs.every((r) => r.text.content.length <= 2000) && !runs[0].text.link, "runs chunked, bad link dropped");
  const l1 = out[7];
  assert.equal(l1.bulleted_list_item.children[0].bulleted_list_item.rich_text[0].text.content, "l2");
  assert.ok(!l1.bulleted_list_item.children[0].bulleted_list_item.children, "3rd level flattened");
  assert.equal(l1.bulleted_list_item.children[1].bulleted_list_item.rich_text[0].text.content, "l3", "3rd level lifted to 2nd");
  const table = out[8];
  assert.equal(table.table.children.length, 100);
  assert.equal(table._intact.extraRows.length, 50);
  assert.ok(table.table.children.every((r) => r.table_row.cells.length === 2), "cells padded to width");
  console.log("✓ sanitizeBlocks");
}

// --- packChunks ---
{
  const many = Array.from({ length: 250 }, (_, i) => text(`p${i}`));
  const chunks = bg.packChunks(many);
  assert.deepEqual(chunks.map((c) => c.length), [100, 100, 50]);
  const big = Array.from({ length: 20 }, () => ({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: "x" } }], children: Array.from({ length: 99 }, () => text("c")) } }));
  const chunks2 = bg.packChunks(big);
  assert.ok(chunks2.every((c) => c.reduce((n, b) => n + bg.elementCount(b), 0) <= 900), "element cap respected");
  const huge = Array.from({ length: 300 }, () => text("z".repeat(1900)));
  const chunks3 = bg.packChunks(huge);
  assert.ok(chunks3.every((c) => JSON.stringify(c).length <= 400 * 1024), "byte cap respected");
  console.log("✓ packChunks", chunks2.length, chunks3.length);
}

// --- appendResilient: indexed error, no-index error (bisect), order ---
{
  calls.length = 0;
  const blocks = [text("a"), img("https://cdn.example.com/no-ext"), text("b"), { object: "block", type: "bookmark", bookmark: { url: "https://x.example/poison" } }, text("c"), { object: "block", type: "code", code: { language: "hcl", rich_text: [{ type: "text", text: { content: "x" } }] } }, text("d")];
  const state = { written: 0, total: blocks.length, degraded: 0, log: [], onProgress() {} };
  await bg.appendResilient("tok", "page-1", blocks, state);
  const sent = calls.filter((c) => c.method === "PATCH").flatMap((c) => c.body.children);
  // the last successful sequence of sends must reproduce the order a..d
  const okTexts = [];
  for (const c of calls.filter((x) => x.method === "PATCH")) {
    // replay: a call succeeded if none of its children trip the mock
    const trips = c.body.children.some((b, i) => (b.type === "image" && !/\.(png|jpg)$/i.test(b.image.external.url)) || (b.type === "code" && b.code.language === "hcl") || (b.type === "bookmark" && /poison/.test(b.bookmark.url)));
    if (!trips) okTexts.push(...c.body.children.map((b) => (b.type === "paragraph" ? b.paragraph.rich_text[0].text.content : b.type)));
  }
  assert.deepEqual(okTexts, ["a", "bookmark", "b", "https://x.example/poison", "c", "code", "d"], `order/degradation: ${okTexts.join(",")}`);
  assert.ok(state.degraded >= 3, "three blocks degraded");
  assert.ok(state.log.some((l) => l.type === "image" && l.action === "bookmark"));
  assert.ok(state.log.some((l) => l.type === "code" && l.action === "plain-language"));
  assert.ok(state.log.some((l) => l.type === "bookmark" && l.action === "link"));
  console.log("✓ appendResilient", calls.length, "requests", JSON.stringify(state.log.map((l) => `${l.type}→${l.action}`)));
  void sent;
}

// --- appendResilient: table too big → degraded rows appended as paragraphs, extraRows appended ---
{
  calls.length = 0;
  const table = { object: "block", type: "table", table: { table_width: 1, has_column_header: false, has_row_header: false, children: Array.from({ length: 3 }, (_, i) => ({ object: "block", type: "table_row", table_row: { cells: [[{ type: "text", text: { content: `r${i}` } }]] } })) }, _intact: { extraRows: [{ object: "block", type: "table_row", table_row: { cells: [[{ type: "text", text: { content: "r3" } }]] } }] } };
  const state = { written: 0, total: 1, degraded: 0, log: [], onProgress() {} };
  await bg.appendResilient("tok", "page-2", [table], state);
  const patches = calls.filter((c) => c.method === "PATCH");
  assert.equal(patches.length, 2, "table then its extra rows");
  assert.ok(/blk-/.test(patches[1].url), "extra rows go to the created table id");
  console.log("✓ extraRows");
}

// --- summarize ---
{
  const s = bg.summarize([text("a"), img("https://a/b.png"), { object: "block", type: "code", code: { language: "python", rich_text: [] } }], [{ type: "image", action: "bookmark" }, { type: "image", action: "uploaded" }]);
  assert.equal(s.image, 1); assert.equal(s.code, 1); assert.equal(s.degraded, 1); assert.equal(s.uploaded, 1);
  console.log("✓ summarize");
}
console.log("all background tests passed");
