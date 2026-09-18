/* Intact — background service worker
 *
 * Responsibilities: Notion auth, page extraction across frames, block
 * validation + chunking, resilient append (block-level isolation), image
 * uploads via the File Upload API, resume of partially saved clips,
 * bookmark / screenshot fallbacks, and the "report a page" bundle.
 */

const NOTION_CLIENT_ID = "REPLACE_WITH_NOTION_CLIENT_ID";
const TOKEN_EXCHANGE_URL = "https://REPLACE.workers.dev/token";
const NOTION_AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";
const REPORT_ISSUE_URL = "https://github.com/yemoyang9-a11y/notion-extension/issues/new";

const LIMITS = {
  TEXT: 2000,
  URL: 2000,
  EQUATION: 1000,
  ARRAY: 100,
  CHUNK_BLOCKS: 100,
  CHUNK_ELEMENTS: 900, // Notion: ≤1000 block elements per request
  CHUNK_BYTES: 400 * 1024, // Notion: ≤500 KB per request
  NESTING: 2,
  UPLOAD_BYTES: 5 * 1024 * 1024,
};

const IMAGE_EXT_OK = /\.(bmp|gif|heic|jpe?g|png|svg|tiff?)$/i;
const VIDEO_PROVIDERS = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|loom\.com|drive\.google\.com|figma\.com|asana\.com|atlassian\.net|typeform\.com)$/i;
const NOTION_LANGUAGES = new Set(["abap", "arduino", "bash", "basic", "c", "clojure", "coffeescript", "c++", "c#", "css", "dart", "diff", "docker", "elixir", "elm", "erlang", "flow", "fortran", "f#", "gherkin", "glsl", "go", "graphql", "groovy", "haskell", "html", "java", "javascript", "json", "julia", "kotlin", "latex", "less", "lisp", "livescript", "lua", "makefile", "markdown", "markup", "matlab", "mermaid", "nix", "objective-c", "ocaml", "pascal", "perl", "php", "plain text", "powershell", "prolog", "protobuf", "python", "r", "reason", "ruby", "rust", "sass", "scala", "scheme", "scss", "shell", "sql", "swift", "typescript", "vb.net", "verilog", "vhdl", "visual basic", "webassembly", "xml", "yaml"]);

/* Hosts we may fetch from the worker (declared in host_permissions) and the
   Referer they expect. */
const REFERER_RULES = [
  { pattern: /(^|\.)pstatic\.net$/i, referer: "https://blog.naver.com/" },
  { pattern: /(^|\.)naver\.net$/i, referer: "https://blog.naver.com/" },
  { pattern: /(^|\.)kakaocdn\.net$/i, referer: "https://tistory.com/" },
  { pattern: /(^|\.)daumcdn\.net$/i, referer: "https://tistory.com/" },
];

/* ------------------------------------------------------------------ *
 * Notion client
 * ------------------------------------------------------------------ */

let lastRequestAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function throttle() {
  const wait = lastRequestAt + 350 - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

class NotionError extends Error {
  constructor(message, { status, code, needsReauth = false, needsShare = false, raw } = {}) {
    super(message);
    this.name = "NotionError";
    this.status = status;
    this.code = code;
    this.needsReauth = needsReauth;
    this.needsShare = needsShare;
    this.raw = raw;
  }
}

function mapError(status, body) {
  const code = body && body.code;
  const message = (body && body.message) || `Notion returned ${status}`;
  if (status === 401) return new NotionError("Your Notion connection expired. Connect again.", { status, code, needsReauth: true, raw: message });
  if (status === 404 || code === "object_not_found") return new NotionError("That page or database is no longer shared with Intact. Open it in Notion, choose Connections, and add Intact.", { status, code, needsShare: true, raw: message });
  if (status === 403 && code === "restricted_resource") return new NotionError("Notion refused the write. The workspace may have hit its block limit, or Intact lacks access to this page.", { status, code, needsShare: true, raw: message });
  if (code === "validation_error") return new NotionError(`Notion rejected the content: ${message}`, { status, code, raw: message });
  return new NotionError(message, { status, code, raw: message });
}

async function notion(token, path, { method = "GET", body, form } = {}) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    await throttle();
    let res;
    try {
      const headers = { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION };
      if (!form) headers["Content-Type"] = "application/json";
      res = await fetch(`${NOTION_API}${path}`, { method, headers, body: form ? form : body ? JSON.stringify(body) : undefined });
    } catch {
      if (attempt >= 6) throw new NotionError("Could not reach Notion. Check your connection and try again.");
      await sleep(Math.min(30000, 500 * 2 ** attempt));
      continue;
    }
    if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 529) {
      if (attempt >= 6) throw new NotionError("Notion is rate limiting or unavailable. Try again in a minute.", { status: res.status });
      const retryAfter = Number(res.headers.get("Retry-After"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(30000, 500 * 2 ** attempt);
      await sleep(wait + Math.random() * 250);
      continue;
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw mapError(res.status, json);
    return json;
  }
}

const plain = (arr) => (Array.isArray(arr) ? arr.map((t) => t.plain_text || "").join("").trim() : "");
function pageTitle(page) {
  const props = page.properties || {};
  for (const key of Object.keys(props)) if (props[key].type === "title") return plain(props[key].title);
  return "";
}

async function listDestinations(token) {
  const dataSources = [];
  const pages = [];
  const seen = new Set();
  const search = async (value, onItem) => {
    let cursor;
    do {
      const body = { filter: { property: "object", value }, sort: { direction: "descending", timestamp: "last_edited_time" }, page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const res = await notion(token, "/search", { method: "POST", body });
      for (const item of res.results || []) onItem(item);
      cursor = res.has_more ? res.next_cursor : null;
    } while (cursor);
  };
  const addDs = (item) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    dataSources.push({ kind: "data_source", id: item.id, title: plain(item.title) || "Untitled database" });
  };
  const errors = [];
  for (const run of [() => search("data_source", addDs), () => search("database", addDs), () => search("page", (p) => { if (!p.archived && !p.in_trash) pages.push({ kind: "page", id: p.id, title: pageTitle(p) || "Untitled page" }); })]) {
    try {
      await run();
    } catch (e) {
      errors.push(e);
    }
  }
  if (!dataSources.length && !pages.length && errors.length) throw errors[0];
  return { dataSources, pages };
}

async function dataSourceSchema(token, id) {
  let ds;
  try {
    ds = await notion(token, `/data_sources/${id}`);
  } catch {
    ds = await notion(token, `/databases/${id}`);
  }
  const props = ds.properties || {};
  const fields = Object.entries(props).map(([name, p]) => ({ name, type: p.type, options: (p.select && p.select.options) || (p.multi_select && p.multi_select.options) || (p.status && p.status.options) || [] }));
  return { id, title: plain(ds.title) || "Untitled database", titleProperty: (fields.find((f) => f.type === "title") || {}).name || "Name", fields };
}

const SUPPORTED_PROPS = new Set(["title", "rich_text", "number", "select", "multi_select", "status", "date", "checkbox", "url", "email", "phone_number"]);

function buildProperties(fields, values, title) {
  const out = {};
  for (const f of fields) {
    if (!SUPPORTED_PROPS.has(f.type)) continue;
    if (f.type === "title") {
      out[f.name] = { title: [{ type: "text", text: { content: (title || "Untitled").slice(0, LIMITS.TEXT) } }] };
      continue;
    }
    const v = values[f.name];
    if (v == null || v === "") continue;
    switch (f.type) {
      case "rich_text": out[f.name] = { rich_text: [{ type: "text", text: { content: String(v).slice(0, LIMITS.TEXT) } }] }; break;
      case "url": out[f.name] = { url: String(v).slice(0, LIMITS.URL) }; break;
      case "email": out[f.name] = { email: String(v).slice(0, 200) }; break;
      case "phone_number": out[f.name] = { phone_number: String(v).slice(0, 200) }; break;
      case "number": { const n = Number(v); if (Number.isFinite(n)) out[f.name] = { number: n }; break; }
      case "checkbox": out[f.name] = { checkbox: !!v }; break;
      case "date": out[f.name] = { date: { start: String(v) } }; break;
      case "select": out[f.name] = { select: { name: String(v).replace(/,/g, " ").slice(0, 100) } }; break;
      case "status": out[f.name] = { status: { name: String(v) } }; break;
      case "multi_select": {
        const items = (Array.isArray(v) ? v : String(v).split(",")).map((s) => String(s).trim().replace(/,/g, " ").slice(0, 100)).filter(Boolean).slice(0, 100);
        if (items.length) out[f.name] = { multi_select: items.map((name) => ({ name })) };
        break;
      }
      default: break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * File uploads (action 8)
 * ------------------------------------------------------------------ */

function base64ToBlob(base64, mime) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || "application/octet-stream" });
}

async function uploadBlob(token, blob, filename) {
  const created = await notion(token, "/file_uploads", { method: "POST", body: { mode: "single_part", filename, content_type: blob.type || "application/octet-stream" } });
  const form = new FormData();
  form.append("file", blob, filename);
  await notion(token, `/file_uploads/${created.id}/send`, { method: "POST", form });
  return created.id;
}

let refererRuleInstalled = false;
async function ensureRefererRules() {
  if (refererRuleInstalled || !chrome.declarativeNetRequest) return;
  try {
    const rules = REFERER_RULES.map((r, i) => ({
      id: 9000 + i,
      priority: 1,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "referer", operation: "set", value: r.referer }] },
      condition: {
        // only requests started by this extension
        initiatorDomains: [chrome.runtime.id],
        regexFilter: r.pattern.source.replace(/^\(\^\|\\\.\)/, "^https?://([^/]+\\.)?").replace(/\$$/, "/"),
        resourceTypes: ["xmlhttprequest", "image", "other"],
      },
    }));
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map((r) => r.id), addRules: rules });
    refererRuleInstalled = true;
  } catch (e) {
    console.warn("[Intact] referer rules not installed", e);
  }
}

async function fetchImageInWorker(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!REFERER_RULES.some((r) => r.pattern.test(host))) return null; // no host permission
  await ensureRefererRules();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { signal: controller.signal, credentials: "omit" });
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") || "").split(";")[0];
    if (!/^image\//.test(type)) return null;
    const blob = await res.blob();
    if (blob.size > LIMITS.UPLOAD_BYTES) return null;
    return blob;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* Resolve every image block that carries an upload plan into a
   file_upload image, or degrade it to a bookmark. Mutates in place. */
async function resolveImageUploads(token, blocks, log, onProgress = () => {}) {
  let done = 0;
  const pending = blocks.filter((b) => b.type === "image" && b._intact && b._intact.image && b._intact.image.upload);
  for (const block of pending) {
    const plan = block._intact.image;
    try {
      let blob = plan.base64 ? base64ToBlob(plan.base64, plan.mime) : null;
      if (!blob) blob = await fetchImageInWorker(plan.url);
      if (!blob && plan.fallbackUrl && plan.fallbackUrl !== plan.url) blob = await fetchImageInWorker(plan.fallbackUrl);
      if (blob) {
        const filename = plan.filename || `image.${(blob.type.split("/")[1] || "png").replace("jpeg", "jpg")}`;
        const id = await uploadBlob(token, blob, filename);
        block.image = { type: "file_upload", file_upload: { id } };
        if (plan.caption) block.image.caption = plan.caption;
        log.push({ type: "image", action: "uploaded", url: plan.url, reason: plan.reason });
      } else if (plan.reason === "referer-locked" || plan.reason === "expiring" || plan.reason === "proxy" || plan.reason === "not-https") {
        Object.assign(block, bookmarkFor(plan.url, "Image (could not be copied)"));
        log.push({ type: "image", action: "bookmark", url: plan.url, reason: plan.reason });
      } else {
        // extension-less URLs sometimes work; leave external and let recovery decide
        log.push({ type: "image", action: "external-unverified", url: plan.url, reason: plan.reason });
      }
    } catch (e) {
      Object.assign(block, bookmarkFor(plan.url, "Image (upload failed)"));
      log.push({ type: "image", action: "bookmark", url: plan.url, reason: `upload-failed: ${e && e.message}` });
    }
    delete block._intact;
    done += 1;
    onProgress(done, pending.length);
  }
}

/* ------------------------------------------------------------------ *
 * Block validation, degradation, chunking (actions 1 & 2)
 * ------------------------------------------------------------------ */

function bookmarkFor(url, caption) {
  const block = { object: "block", type: "bookmark", bookmark: { url: String(url).slice(0, LIMITS.URL) } };
  if (caption) block.bookmark.caption = [{ type: "text", text: { content: String(caption).slice(0, LIMITS.TEXT) } }];
  for (const key of Object.keys(block)) if (!["object", "type", "bookmark"].includes(key)) delete block[key];
  return block;
}

function replaceBlock(target, replacement) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, replacement);
}

function runsToText(runs) {
  return (runs || []).map((r) => (r.type === "equation" ? r.equation.expression : r.text ? r.text.content : "")).join("");
}

function textRuns(text) {
  const out = [];
  let rest = String(text);
  while (rest.length > LIMITS.TEXT) {
    let cut = rest.lastIndexOf(" ", LIMITS.TEXT);
    if (cut < LIMITS.TEXT * 0.6) cut = LIMITS.TEXT;
    out.push({ type: "text", text: { content: rest.slice(0, cut) } });
    rest = rest.slice(cut);
  }
  if (rest) out.push({ type: "text", text: { content: rest } });
  return out.slice(0, LIMITS.ARRAY);
}

function sanitizeRuns(runs) {
  const out = [];
  for (const run of runs || []) {
    if (!run || typeof run !== "object") continue;
    if (run.type === "equation") {
      const expr = String((run.equation && run.equation.expression) || "").trim();
      if (!expr) continue;
      if (expr.length > LIMITS.EQUATION) out.push({ type: "text", text: { content: expr.slice(0, LIMITS.TEXT) }, annotations: { ...(run.annotations || {}), code: true } });
      else out.push({ type: "equation", equation: { expression: expr }, annotations: run.annotations });
      continue;
    }
    if (run.type !== "text" || !run.text) continue;
    const content = String(run.text.content || "");
    if (!content) continue;
    let link = run.text.link && run.text.link.url;
    if (link && !(/^https?:\/\//i.test(link) && link.length <= LIMITS.URL)) link = null;
    for (const piece of textRuns(content)) {
      const r = { type: "text", text: { content: piece.text.content }, annotations: run.annotations };
      if (link) r.text.link = { url: link };
      out.push(r);
    }
  }
  return out.slice(0, LIMITS.ARRAY);
}

function isValidExternalImage(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && url.length <= LIMITS.URL && IMAGE_EXT_OK.test(u.pathname);
  } catch {
    return false;
  }
}

/* Deterministic pass over every block before anything is sent. */
function sanitizeBlocks(blocks, depth = 0, log = []) {
  const out = [];
  for (const block of blocks || []) {
    if (!block || !block.type || !block[block.type]) continue;
    const body = block[block.type];
    if (Array.isArray(body.rich_text)) body.rich_text = sanitizeRuns(body.rich_text);
    if (Array.isArray(body.caption)) body.caption = sanitizeRuns(body.caption);

    switch (block.type) {
      case "image": {
        if (body.type === "external") {
          const url = body.external && body.external.url;
          const plan = block._intact && block._intact.image;
          if (!url) continue;
          if (!isValidExternalImage(url) && !(plan && plan.upload)) {
            log.push({ type: "image", action: "bookmark", url, reason: "invalid-external" });
            replaceBlock(block, bookmarkFor(url, "Image"));
          }
        }
        break;
      }
      case "video": {
        const url = body.external && body.external.url;
        let host = "";
        try {
          host = new URL(url).hostname;
        } catch {}
        if (!url || !VIDEO_PROVIDERS.test(host)) {
          if (!url) continue;
          log.push({ type: "video", action: "bookmark", url, reason: "unsupported-provider" });
          replaceBlock(block, bookmarkFor(url, "Video"));
        }
        break;
      }
      case "embed":
      case "bookmark": {
        const url = body.url;
        if (!url || !/^https?:\/\//i.test(url) || url.length > LIMITS.URL) continue;
        break;
      }
      case "equation": {
        const expr = String(body.expression || "").trim();
        if (!expr) continue;
        if (expr.length > LIMITS.EQUATION) replaceBlock(block, { object: "block", type: "code", code: { language: "latex", rich_text: textRuns(expr) } });
        break;
      }
      case "code": {
        if (!NOTION_LANGUAGES.has(body.language)) body.language = "plain text";
        if (!body.rich_text || !body.rich_text.length) continue;
        break;
      }
      case "table": {
        const width = Number(body.table_width) || 0;
        const rows = (body.children || []).filter((r) => r && r.type === "table_row");
        if (!width || width > LIMITS.ARRAY || !rows.length) {
          const text = rows.map((r) => r.table_row.cells.map((c) => runsToText(c)).join(" | ")).join("\n");
          if (text.trim()) out.push({ object: "block", type: "paragraph", paragraph: { rich_text: textRuns(text) } });
          continue;
        }
        for (const row of rows) {
          const cells = row.table_row.cells || [];
          row.table_row.cells = Array.from({ length: width }, (_, i) => sanitizeRuns(cells[i] || []));
        }
        body.children = rows.slice(0, LIMITS.ARRAY);
        if (rows.length > LIMITS.ARRAY) {
          block._intact = block._intact || {};
          block._intact.extraRows = (block._intact.extraRows || []).concat(rows.slice(LIMITS.ARRAY));
        }
        if (block._intact && block._intact.extraRows) {
          for (const row of block._intact.extraRows) row.table_row.cells = Array.from({ length: width }, (_, i) => sanitizeRuns((row.table_row.cells || [])[i] || []));
        }
        break;
      }
      case "callout": {
        if (!body.rich_text || !body.rich_text.length) body.rich_text = [{ type: "text", text: { content: " " } }];
        break;
      }
      default:
        break;
    }

    if (Array.isArray(body.children) && block.type !== "table") {
      const kids = sanitizeBlocks(body.children, depth + 1, log);
      if (depth + 1 >= LIMITS.NESTING) {
        // too deep for one request: flatten after the parent
        delete body.children;
        if (!body.rich_text || body.rich_text.length) out.push(block);
        out.push(...kids);
        continue;
      }
      if (kids.length) body.children = kids.slice(0, LIMITS.ARRAY);
      else delete body.children;
    }
    if (Array.isArray(body.rich_text) && !body.rich_text.length && !(body.children && body.children.length)) continue;
    out.push(block);
  }
  return out;
}

function elementCount(block) {
  const body = block[block.type] || {};
  let n = 1;
  for (const child of body.children || []) n += elementCount(child);
  return n;
}

function stripPrivate(block) {
  const copy = JSON.parse(JSON.stringify(block, (k, v) => (k === "_intact" ? undefined : v)));
  return copy;
}

function packChunks(blocks) {
  const chunks = [];
  let current = [];
  let elements = 0;
  let bytes = 2;
  for (const block of blocks) {
    const wire = stripPrivate(block);
    const size = JSON.stringify(wire).length + 1;
    const count = elementCount(wire);
    if (current.length && (current.length >= LIMITS.CHUNK_BLOCKS || elements + count > LIMITS.CHUNK_ELEMENTS || bytes + size > LIMITS.CHUNK_BYTES)) {
      chunks.push(current);
      current = [];
      elements = 0;
      bytes = 2;
    }
    current.push(block);
    elements += count;
    bytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/* Turn a rejected block into something Notion will accept. Returns the
   replacement list (possibly empty). */
function degradeBlock(block, message, log) {
  const body = block[block.type] || {};
  const reason = String(message || "").slice(0, 200);
  const note = (action, extra = {}) => log.push({ type: block.type, action, reason, ...extra });
  switch (block.type) {
    case "image": {
      const url = body.external && body.external.url;
      if (url) {
        note("bookmark", { url });
        return [bookmarkFor(url, "Image")];
      }
      note("dropped");
      return [];
    }
    case "video":
    case "embed": {
      const url = (body.external && body.external.url) || body.url;
      if (url) {
        note("bookmark", { url });
        return [bookmarkFor(url)];
      }
      note("dropped");
      return [];
    }
    case "bookmark": {
      note("link");
      return [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: body.url, link: { url: body.url } } }] } }];
    }
    case "equation": {
      note("code");
      return [{ object: "block", type: "code", code: { language: "latex", rich_text: textRuns(body.expression || "") } }];
    }
    case "code": {
      if (body.language !== "plain text") {
        body.language = "plain text";
        note("plain-language");
        return [block];
      }
      note("paragraph");
      return [{ object: "block", type: "paragraph", paragraph: { rich_text: textRuns(runsToText(body.rich_text)) } }];
    }
    case "table": {
      note("paragraphs");
      const rows = (body.children || []).concat((block._intact && block._intact.extraRows) || []);
      return rows.map((r) => ({ object: "block", type: "paragraph", paragraph: { rich_text: textRuns(r.table_row.cells.map((c) => runsToText(c)).join(" | ")) } })).filter((b) => b.paragraph.rich_text.length);
    }
    case "callout":
    case "toggle":
    case "quote":
    case "bulleted_list_item":
    case "numbered_list_item":
    case "to_do": {
      if (body.children && body.children.length) {
        const kids = body.children;
        delete body.children;
        note("flatten-children");
        return [block, ...kids];
      }
      if (block.type === "callout" || block.type === "toggle" || block.type === "quote") {
        note("paragraph");
        return [{ object: "block", type: "paragraph", paragraph: { rich_text: textRuns(runsToText(body.rich_text)) } }];
      }
      note("paragraph");
      return [{ object: "block", type: "paragraph", paragraph: { rich_text: textRuns(runsToText(body.rich_text)) } }];
    }
    default: {
      if (Array.isArray(body.rich_text)) {
        const text = runsToText(body.rich_text);
        if (text.trim() && block.type !== "paragraph") {
          note("paragraph");
          return [{ object: "block", type: "paragraph", paragraph: { rich_text: textRuns(text) } }];
        }
        if (text.trim() && body.rich_text.some((r) => r.type === "equation" || (r.text && r.text.link))) {
          note("plain-text");
          return [{ object: "block", type: "paragraph", paragraph: { rich_text: textRuns(text) } }];
        }
      }
      note("dropped");
      return [];
    }
  }
}

function indexFromValidationMessage(message) {
  const m = String(message || "").match(/children\[(\d+)\]/);
  return m ? Number(m[1]) : null;
}

/* Append `blocks` (in order) to `parentId`; on validation errors isolate the
   offending block, degrade it and continue. Returns created block results. */
async function appendResilient(token, parentId, blocks, state, guard = { attempts: 0 }) {
  if (!blocks.length) return [];
  const wire = blocks.map(stripPrivate);
  try {
    const res = await notion(token, `/blocks/${parentId}/children`, { method: "PATCH", body: { children: wire } });
    state.written += blocks.length;
    state.onProgress(state.written, state.total);
    await appendExtraRows(token, res, blocks, state);
    return res.results || [];
  } catch (error) {
    if (!(error instanceof NotionError) || error.code !== "validation_error" && error.status !== 400) throw error;
    guard.attempts += 1;
    if (guard.attempts > 60) throw error;
    const index = indexFromValidationMessage(error.raw || error.message);
    if (index != null && index < blocks.length) {
      const bad = blocks[index];
      const replacement = degradeBlock(bad, error.raw || error.message, state.log);
      const next = [...blocks.slice(0, index), ...replacement, ...blocks.slice(index + 1)];
      state.degraded += 1;
      state.total += replacement.length - 1;
      return appendResilient(token, parentId, next, state, guard);
    }
    if (blocks.length === 1) {
      const replacement = degradeBlock(blocks[0], error.raw || error.message, state.log);
      state.degraded += 1;
      state.total += replacement.length - 1;
      if (!replacement.length) return [];
      if (replacement.length === 1 && JSON.stringify(stripPrivate(replacement[0])) === JSON.stringify(wire[0])) {
        state.log.push({ type: blocks[0].type, action: "dropped", reason: "unrecoverable" });
        state.total -= 1;
        return [];
      }
      return appendResilient(token, parentId, replacement, state, guard);
    }
    // no index in the message: bisect, keeping order
    const mid = Math.ceil(blocks.length / 2);
    const first = await appendResilient(token, parentId, blocks.slice(0, mid), state, guard);
    const second = await appendResilient(token, parentId, blocks.slice(mid), state, guard);
    return first.concat(second);
  }
}

async function appendExtraRows(token, res, blocks, state) {
  const results = (res && res.results) || [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const extra = block._intact && block._intact.extraRows;
    if (!extra || !extra.length) continue;
    const created = results[i];
    if (!created || created.type !== "table") continue;
    for (let j = 0; j < extra.length; j += LIMITS.ARRAY) {
      try {
        await notion(token, `/blocks/${created.id}/children`, { method: "PATCH", body: { children: extra.slice(j, j + LIMITS.ARRAY) } });
      } catch (e) {
        state.log.push({ type: "table", action: "rows-dropped", reason: String(e && e.message).slice(0, 200), count: extra.length - j });
        break;
      }
    }
  }
}

function summarize(blocks, log) {
  const counts = { total: 0, image: 0, code: 0, table: 0, equation: 0, bookmark: 0, video: 0, list: 0, heading: 0 };
  const walk = (list) => {
    for (const b of list) {
      counts.total += 1;
      if (b.type === "image") counts.image += 1;
      else if (b.type === "code") counts.code += 1;
      else if (b.type === "table") counts.table += 1;
      else if (b.type === "equation") counts.equation += 1;
      else if (b.type === "bookmark" || b.type === "embed") counts.bookmark += 1;
      else if (b.type === "video") counts.video += 1;
      else if (/list_item|to_do/.test(b.type)) counts.list += 1;
      else if (/heading/.test(b.type)) counts.heading += 1;
      const body = b[b.type] || {};
      if (Array.isArray(body.children) && b.type !== "table") walk(body.children);
    }
  };
  walk(blocks);
  counts.degraded = log.filter((l) => l.action !== "uploaded" && l.action !== "external-unverified").length;
  counts.uploaded = log.filter((l) => l.action === "uploaded").length;
  counts.dropped = log.filter((l) => l.action === "dropped" || l.action === "rows-dropped").length;
  return counts;
}

/* ------------------------------------------------------------------ *
 * Storage & auth
 * ------------------------------------------------------------------ */

const KEYS = { auth: "intact.auth", lastDestination: "intact.lastDestination", destinations: "intact.destinations", stats: "intact.stats", pending: "intact.pending", lastError: "intact.lastError" };
const DESTINATION_TTL = 600 * 1000;

async function getKey(key) {
  return (await chrome.storage.local.get(key))[key];
}
async function setKey(key, value) {
  await chrome.storage.local.set({ [key]: value });
}
async function token() {
  const auth = await getKey(KEYS.auth);
  return auth && auth.access_token ? auth.access_token : null;
}
function redirectUrl() {
  return chrome.identity.getRedirectURL("notion");
}

async function connect() {
  if (NOTION_CLIENT_ID.startsWith("REPLACE")) throw new Error("This build has no Notion client ID yet. See README.md.");
  const state = crypto.randomUUID();
  const url = `${NOTION_AUTHORIZE_URL}?${new URLSearchParams({ client_id: NOTION_CLIENT_ID, response_type: "code", owner: "user", redirect_uri: redirectUrl(), state })}`;
  const redirected = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  if (!redirected) throw new Error("Notion did not return an authorization code.");
  const params = new URL(redirected).searchParams;
  if (params.get("error")) throw new Error(`Notion declined the connection: ${params.get("error")}`);
  if (params.get("state") !== state) throw new Error("Authorization response did not match the request.");
  const code = params.get("code");
  if (!code) throw new Error("Notion did not return an authorization code.");
  const res = await fetch(TOKEN_EXCHANGE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, redirect_uri: redirectUrl() }) });
  if (!res.ok) throw new Error(`Could not finish connecting to Notion (${res.status}).`);
  const auth = await res.json();
  if (!auth.access_token) throw new Error("Could not finish connecting to Notion.");
  await setKey(KEYS.auth, auth);
  await chrome.storage.local.remove(KEYS.destinations);
  return { workspace: auth.workspace_name || "Notion" };
}

async function connectWithToken(raw) {
  const value = String(raw || "").trim();
  if (!value) throw new Error("Paste an integration token first.");
  const me = await notion(value, "/users/me");
  const workspace = (me && me.bot && me.bot.workspace_name) || "Notion";
  await setKey(KEYS.auth, { access_token: value, workspace_name: workspace, manual: true });
  await chrome.storage.local.remove(KEYS.destinations);
  return { workspace };
}

async function disconnect() {
  await chrome.storage.local.remove([KEYS.auth, KEYS.destinations, KEYS.lastDestination, KEYS.pending]);
}

async function destinations({ refresh = false } = {}) {
  const t = await token();
  if (!t) throw new NotionError("Not connected to Notion.", { needsReauth: true });
  if (!refresh) {
    const cached = await getKey(KEYS.destinations);
    if (cached && Date.now() - cached.at < DESTINATION_TTL) return cached.value;
  }
  const value = await listDestinations(t);
  await setKey(KEYS.destinations, { at: Date.now(), value });
  return value;
}

/* ------------------------------------------------------------------ *
 * Extraction across frames (action 7)
 * ------------------------------------------------------------------ */

async function inject(tabId, allFrames) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames }, files: ["defuddle.js", "extractor.js"] });
}

async function runExtract(tabId, options) {
  let results;
  try {
    await inject(tabId, true);
    results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: (o) => window.__intactExtract(o), args: [options || {}] });
  } catch (e) {
    try {
      await inject(tabId, false);
      results = await chrome.scripting.executeScript({ target: { tabId }, func: (o) => window.__intactExtract(o), args: [options || {}] });
    } catch {
      throw new Error("Chrome will not let Intact read this page. It works on ordinary web pages, but not on chrome:// pages, the Web Store, or PDF files.");
    }
  }
  const frames = (results || []).map((r) => r && r.result).filter(Boolean);
  const okFrames = frames.filter((f) => f.ok);
  if (!okFrames.length) {
    const err = frames.find((f) => f && f.error);
    throw new Error((err && err.error) || "Could not read this page.");
  }
  const top = okFrames.find((f) => f.isTop);
  const best = okFrames
    .filter((f) => !f.isTop)
    .sort((a, b) => (b.wordCount || 0) - (a.wordCount || 0))[0];
  if (!top) return best;
  if (!best) return top;
  const topWords = top.wordCount || 0;
  const bestWords = best.wordCount || 0;
  if (best.via === "site-handler" && top.via !== "site-handler") return best;
  // only fall through to an embedded frame when the top frame is a shell
  if (topWords < 100 && bestWords > 200) return best;
  return top;
}

async function preview({ tabId, useSelection, mode }) {
  const r = await runExtract(tabId, { useSelection, mode, fetchImages: false });
  return { title: r.title, url: r.url, site: r.site, author: r.author, published: r.published, wordCount: r.wordCount, blockCount: r.blockCount, usedSelection: r.usedSelection, quality: r.quality, via: r.via, frameUrl: r.frameUrl, uploadsPlanned: (r.uploads || []).length, mode: r.mode };
}

/* ------------------------------------------------------------------ *
 * Clip, resume, screenshot (actions 1, 3, 6)
 * ------------------------------------------------------------------ */

function progress(written, total, extra = {}) {
  chrome.runtime.sendMessage({ type: "clip:progress", written, total, ...extra }).catch(() => {});
}

async function createPage(t, { parent, properties, icon, cover }) {
  const base = { parent, properties, children: [] };
  const candidates = [];
  const withMedia = { ...base };
  if (icon) withMedia.icon = { type: "external", external: { url: icon } };
  if (cover) withMedia.cover = { type: "external", external: { url: cover } };
  candidates.push(withMedia);
  if (icon || cover) candidates.push({ ...base });
  if (parent.data_source_id) candidates.push({ parent: { database_id: parent.data_source_id }, properties, children: [] });
  let lastError;
  for (const body of candidates) {
    try {
      return await notion(t, "/pages", { method: "POST", body });
    } catch (e) {
      lastError = e;
      if (!(e instanceof NotionError && (e.code === "validation_error" || e.status === 400))) throw e;
    }
  }
  throw lastError;
}

async function writeBlocks(t, pageId, blocks, state) {
  const chunks = packChunks(blocks);
  const remaining = blocks.slice();
  for (const chunk of chunks) {
    await appendResilient(t, pageId, chunk, state);
    remaining.splice(0, chunk.length);
    await setKey(KEYS.pending, { ...state.pending, written: state.written, total: state.total, remaining, log: state.log, degraded: state.degraded });
  }
}

async function clip({ tabId, destination, values, title, useSelection, includeCover, mode }) {
  const t = await token();
  if (!t) throw new NotionError("Not connected to Notion.", { needsReauth: true });

  progress(0, 0, { phase: "reading" });
  const extracted = await runExtract(tabId, { useSelection, mode, fetchImages: true });
  if (!extracted.blocks.length) throw new Error("Nothing readable was found on this page. Try selecting the text you want first.");

  const log = [];
  let blocks = sanitizeBlocks(extracted.blocks, 0, log);
  const pageTitleText = (title || extracted.title || extracted.url).slice(0, LIMITS.TEXT);

  let parent;
  let properties;
  if (destination.kind === "data_source") {
    const schema = await dataSourceSchema(t, destination.id);
    parent = { data_source_id: destination.id };
    properties = buildProperties(schema.fields, values || {}, pageTitleText);
  } else {
    parent = { page_id: destination.id };
    properties = { title: { title: [{ type: "text", text: { content: pageTitleText } }] } };
  }

  progress(0, blocks.length, { phase: "uploading" });
  await resolveImageUploads(t, blocks, log, (done, n) => progress(0, blocks.length, { phase: "uploading", uploaded: done, uploads: n }));
  blocks = sanitizeBlocks(blocks, 0, log);

  const icon = extracted.favicon && isValidExternalImage(extracted.favicon) ? extracted.favicon : null;
  const cover = includeCover && extracted.image && isValidExternalImage(extracted.image) ? extracted.image : null;
  const page = await createPage(t, { parent, properties, icon, cover });

  const state = {
    written: 0,
    total: blocks.length,
    degraded: 0,
    log,
    onProgress: (w, total) => progress(w, total, { phase: "writing", degraded: state.degraded }),
    pending: { key: `${extracted.url}|${destination.kind}:${destination.id}`, pageId: page.id, pageUrl: page.url, title: pageTitleText, url: extracted.url, startedAt: Date.now() },
  };
  await setKey(KEYS.pending, { ...state.pending, written: 0, total: blocks.length, remaining: blocks, log, degraded: 0 });

  try {
    await writeBlocks(t, page.id, blocks, state);
  } catch (error) {
    const err = new Error(`${error.message} — ${state.written} of ${state.total} blocks were saved. You can resume from the popup.`);
    err.partial = { written: state.written, total: state.total, pageUrl: page.url, pageId: page.id };
    err.needsReauth = !!error.needsReauth;
    await setKey(KEYS.lastError, { at: Date.now(), message: error.raw || error.message, url: extracted.url });
    throw err;
  }
  await chrome.storage.local.remove(KEYS.pending);
  await setKey(KEYS.lastDestination, destination);
  const stats = (await getKey(KEYS.stats)) || { clips: 0, blocks: 0 };
  stats.clips += 1;
  stats.blocks += state.written;
  await setKey(KEYS.stats, stats);
  return { id: page.id, url: page.url, blocksWritten: state.written, title: pageTitleText, blockCount: state.total, summary: summarize(blocks, log), log: log.slice(0, 50), quality: extracted.quality, via: extracted.via };
}

async function resume() {
  const t = await token();
  if (!t) throw new NotionError("Not connected to Notion.", { needsReauth: true });
  const pending = await getKey(KEYS.pending);
  if (!pending || !pending.pageId) throw new Error("Nothing to resume.");
  const blocks = pending.remaining || [];
  const log = pending.log || [];
  await resolveImageUploads(t, blocks, log);
  const state = { written: pending.written || 0, total: pending.total || blocks.length, degraded: pending.degraded || 0, log, onProgress: (w, total) => progress(w, total, { phase: "writing" }), pending };
  try {
    await writeBlocks(t, pending.pageId, blocks, state);
  } catch (error) {
    const err = new Error(`${error.message} — ${state.written} of ${state.total} blocks were saved.`);
    err.partial = { written: state.written, total: state.total, pageUrl: pending.pageUrl, pageId: pending.pageId };
    throw err;
  }
  await chrome.storage.local.remove(KEYS.pending);
  return { id: pending.pageId, url: pending.pageUrl, blocksWritten: state.written, blockCount: state.total, title: pending.title, summary: summarize(blocks, log), log: log.slice(0, 50) };
}

async function pendingInfo() {
  const p = await getKey(KEYS.pending);
  if (!p || !p.pageId) return null;
  return { url: p.url, pageUrl: p.pageUrl, title: p.title, written: p.written, total: p.total, remaining: (p.remaining || []).length, startedAt: p.startedAt };
}

async function discardPending() {
  await chrome.storage.local.remove(KEYS.pending);
}

async function screenshot({ tabId, destination, title, values }) {
  const t = await token();
  if (!t) throw new NotionError("Not connected to Notion.", { needsReauth: true });
  const tab = await chrome.tabs.get(tabId);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const blob = base64ToBlob(dataUrl.split(",")[1], "image/png");
  if (blob.size > LIMITS.UPLOAD_BYTES) throw new Error("The screenshot is larger than Notion's 5 MB upload limit. Zoom out or make the window smaller.");
  const id = await uploadBlob(t, blob, "screenshot.png");
  const meta = await runExtract(tabId, { mode: "bookmark", fetchImages: false }).catch(() => null);
  const pageTitleText = (title || (meta && meta.title) || tab.title || tab.url).slice(0, LIMITS.TEXT);
  let parent;
  let properties;
  if (destination.kind === "data_source") {
    const schema = await dataSourceSchema(t, destination.id);
    parent = { data_source_id: destination.id };
    properties = buildProperties(schema.fields, values || {}, pageTitleText);
  } else {
    parent = { page_id: destination.id };
    properties = { title: { title: [{ type: "text", text: { content: pageTitleText } }] } };
  }
  const page = await createPage(t, { parent, properties });
  const blocks = [...((meta && meta.blocks) || []), { object: "block", type: "image", image: { type: "file_upload", file_upload: { id } } }];
  const state = { written: 0, total: blocks.length, degraded: 0, log: [], onProgress: (w, total) => progress(w, total, { phase: "writing" }), pending: {} };
  await appendResilient(t, page.id, blocks, state);
  await setKey(KEYS.lastDestination, destination);
  return { id: page.id, url: page.url, blocksWritten: state.written, blockCount: blocks.length, title: pageTitleText, summary: summarize(blocks, state.log) };
}

/* ------------------------------------------------------------------ *
 * Report bundle (action 13)
 * ------------------------------------------------------------------ */

async function report({ tabId, useSelection }) {
  const r = await runExtract(tabId, { useSelection, debug: true, fetchImages: false });
  const manifest = chrome.runtime.getManifest();
  const lastError = await getKey(KEYS.lastError);
  const typeCounts = {};
  for (const b of r.blocks) typeCounts[b.type] = (typeCounts[b.type] || 0) + 1;
  const bundle = {
    intact: manifest.version,
    userAgent: navigator.userAgent,
    url: r.url,
    frameUrl: r.frameUrl,
    title: r.title,
    site: r.site,
    via: r.via,
    quality: r.quality,
    repairs: r.repairs,
    blockCount: r.blockCount,
    typeCounts,
    uploadsPlanned: (r.uploads || []).length,
    lastError: lastError && lastError.url === r.url ? lastError.message : null,
    blocks: r.blocks.slice(0, 400),
    extractedHtml: (r.debugHtml || "").slice(0, 200000),
  };
  const issueTitle = `Extraction issue: ${r.site} — ${r.title.slice(0, 60)}`;
  const issueBody = [
    `URL: ${r.url}`,
    `Intact ${manifest.version} · ${r.via} · ${r.blockCount} blocks · quality ${JSON.stringify(r.quality)}`,
    lastError && lastError.url === r.url ? `Last Notion error: ${lastError.message}` : "",
    "",
    "What looked wrong:",
    "",
    "(Paste the copied diagnostic JSON below, after removing anything private.)",
  ].join("\n");
  return { bundle, issueUrl: `${REPORT_ISSUE_URL}?${new URLSearchParams({ title: issueTitle, body: issueBody })}` };
}

/* ------------------------------------------------------------------ *
 * Message router
 * ------------------------------------------------------------------ */

const handlers = {
  status: async () => {
    const auth = await getKey(KEYS.auth);
    return {
      connected: !!(auth && auth.access_token),
      oauthReady: !NOTION_CLIENT_ID.startsWith("REPLACE") && !TOKEN_EXCHANGE_URL.includes("REPLACE"),
      workspace: auth ? auth.workspace_name : null,
      manual: !!(auth && auth.manual),
      lastDestination: await getKey(KEYS.lastDestination),
      stats: (await getKey(KEYS.stats)) || { clips: 0, blocks: 0 },
      pending: await pendingInfo(),
    };
  },
  connect,
  connectWithToken: ({ token: value }) => connectWithToken(value),
  disconnect,
  destinations,
  schema: ({ id }) => {
    return token().then((t) => {
      if (!t) throw new NotionError("Not connected to Notion.", { needsReauth: true });
      return dataSourceSchema(t, id);
    });
  },
  preview,
  clip,
  resume,
  discardPending,
  screenshot,
  report,
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message && message.type];
  if (!handler) return false;
  Promise.resolve(handler(message))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: (error && error.message) || String(error), needsReauth: !!(error && error.needsReauth), needsShare: !!(error && error.needsShare), partial: error && error.partial ? error.partial : null }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "intact-clip-selection", title: "Clip selection to Notion", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "intact-clip-page", title: "Clip this page to Notion", contexts: ["page"] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;
  const last = await getKey(KEYS.lastDestination);
  if (!last) {
    await chrome.action.openPopup().catch(() => {});
    return;
  }
  try {
    const result = await clip({ tabId: tab.id, destination: last, values: {}, useSelection: info.menuItemId === "intact-clip-selection" });
    await badge("Saved to Notion", result.title);
  } catch (error) {
    await badge("Could not save", (error && error.message) || "Unknown error");
  }
});

async function badge(status, detail) {
  try {
    const ok = status.startsWith("Saved");
    await chrome.action.setBadgeText({ text: ok ? "OK" : "!" });
    await chrome.action.setBadgeBackgroundColor({ color: ok ? "#2F7A5B" : "#B3453C" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 4000);
  } catch {}
  console.info(`[Intact] ${status}: ${detail}`);
}

// exported for tests/background.test.mjs (ignored by the service worker)
export { sanitizeBlocks, packChunks, degradeBlock, appendResilient, summarize, resolveImageUploads, elementCount, indexFromValidationMessage };
