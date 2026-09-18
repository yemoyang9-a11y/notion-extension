/* Intact — page extractor (content script)
 *
 * Injected into every frame of the tab after vendor/defuddle.js, which
 * exposes window.__IntactDefuddle. Entry point: window.__intactExtract(opts).
 *
 * Pipeline
 *   1. site handlers (GitHub blob, raw <pre> page, Naver SmartEditor ONE)
 *   2. selection HTML → Defuddle-standardised on a synthetic document
 *   3. Defuddle on the live document (async, 8 s cap → sync fallback)
 *        → URL normalisation → restoration pass → trailing-junk prune
 *   4. HTML → Notion blocks (+ per-image upload plan, quality report)
 */
(() => {
  "use strict";

  const NOTION = {
    TEXT_MAX: 2000, // text.content
    URL_MAX: 2000, // any url
    EQUATION_MAX: 1000, // equation.expression
    ARRAY_MAX: 100, // any array (rich_text, children, cells)
  };

  const IMAGE_EXT_OK = /\.(bmp|gif|heic|jpe?g|png|svg|tiff?)$/i;
  const UPLOAD_MAX_BYTES = 5 * 1024 * 1024; // free-plan file upload cap
  const UPLOAD_MAX_TOTAL = 12 * 1024 * 1024;
  const UPLOAD_MAX_COUNT = 16;

  const EMPTY_ANNOTATIONS = Object.freeze({
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: "default",
  });

  const scratchDoc = (() => {
    const impl = typeof document !== "undefined" ? document.implementation : null;
    return impl && impl.createHTMLDocument ? impl.createHTMLDocument("intact") : document;
  })();

  /* ------------------------------------------------------------------ *
   * Languages
   * ------------------------------------------------------------------ */

  const NOTION_LANGUAGES = new Set([
    "abap", "arduino", "bash", "basic", "c", "clojure", "coffeescript", "c++", "c#", "css",
    "dart", "diff", "docker", "elixir", "elm", "erlang", "flow", "fortran", "f#", "gherkin",
    "glsl", "go", "graphql", "groovy", "haskell", "html", "java", "javascript", "json",
    "julia", "kotlin", "latex", "less", "lisp", "livescript", "lua", "makefile", "markdown",
    "markup", "matlab", "mermaid", "nix", "objective-c", "ocaml", "pascal", "perl", "php",
    "plain text", "powershell", "prolog", "protobuf", "python", "r", "reason", "ruby", "rust",
    "sass", "scala", "scheme", "scss", "shell", "sql", "swift", "typescript", "vb.net",
    "verilog", "vhdl", "visual basic", "webassembly", "xml", "yaml",
  ]);

  const LANGUAGE_ALIASES = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", node: "javascript",
    ts: "typescript", tsx: "typescript", mts: "typescript",
    py: "python", python3: "python", py3: "python", ipynb: "python",
    rb: "ruby", rs: "rust", golang: "go",
    sh: "shell", zsh: "shell", console: "shell", terminal: "shell", "shell-session": "shell", shellsession: "shell", fish: "shell",
    ps1: "powershell", pwsh: "powershell",
    yml: "yaml", htm: "html", vue: "html", svelte: "html", xhtml: "xml", svg: "xml", plist: "xml",
    cpp: "c++", cc: "c++", cxx: "c++", hpp: "c++", "c-plus-plus": "c++",
    csharp: "c#", cs: "c#", "c-sharp": "c#", "c-like": "c", h: "c", objc: "objective-c", objectivec: "objective-c",
    kt: "kotlin", kts: "kotlin", md: "markdown", tex: "latex", dockerfile: "docker",
    gradle: "groovy", proto: "protobuf", gql: "graphql", patch: "diff", pl: "perl",
    ex: "elixir", exs: "elixir", erl: "erlang", hs: "haskell", ml: "ocaml", clj: "clojure",
    vb: "visual basic", vbnet: "vb.net", text: "plain text", txt: "plain text", plaintext: "plain text",
    none: "plain text", nohighlight: "plain text", "no-highlight": "plain text", auto: "plain text",
    toml: "plain text", ini: "plain text", hcl: "plain text", tf: "plain text", angelscript: "plain text",
    wasm: "webassembly", m: "matlab", f90: "fortran", f95: "fortran", "html+django": "html",
    jinja: "html", ejs: "html", handlebars: "html", hbs: "html", "js+jsx": "javascript",
  };

  function notionLanguage(raw) {
    if (!raw) return "plain text";
    const key = String(raw).toLowerCase().replace(/^(language|lang|brush|highlight|syntax)[-_:]/, "").trim();
    const mapped = LANGUAGE_ALIASES[key] || key;
    return NOTION_LANGUAGES.has(mapped) ? mapped : "plain text";
  }

  const EXT_LANGUAGES = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript", mts: "typescript", py: "python", rb: "ruby",
    go: "go", rs: "rust", java: "java", c: "c", h: "c", cc: "c++", cpp: "c++", hpp: "c++",
    cs: "c#", php: "php", swift: "swift", kt: "kotlin", scala: "scala", dart: "dart",
    sh: "shell", bash: "shell", zsh: "shell", fish: "shell", ps1: "powershell", sql: "sql",
    r: "r", lua: "lua", pl: "perl", ex: "elixir", exs: "elixir", erl: "erlang", hs: "haskell",
    ml: "ocaml", clj: "clojure", vb: "visual basic", html: "html", htm: "html", xml: "xml",
    svg: "xml", css: "css", scss: "scss", sass: "sass", less: "less", json: "json",
    yaml: "yaml", yml: "yaml", md: "markdown", markdown: "markdown", tex: "latex",
    dockerfile: "docker", gradle: "groovy", proto: "protobuf", graphql: "graphql",
    gql: "graphql", diff: "diff", patch: "diff",
  };

  function languageFromPath(path) {
    const name = String(path || "").split("/").pop() || "";
    if (/^dockerfile$/i.test(name)) return "docker";
    if (/^makefile$/i.test(name)) return "makefile";
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    return notionLanguage(EXT_LANGUAGES[ext] || "");
  }

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  const normText = (s) => (s || "").replace(/\s+/g, " ").trim();
  const cssEscape = (v) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : String(v).replace(/["\\]/g, "\\$&"));
  const lowerNorm = (s) => normText(s).toLowerCase();

  function absoluteUrl(value) {
    try {
      return new URL(value, document.baseURI).href;
    } catch {
      return null;
    }
  }

  function safeHttpUrl(value) {
    if (!value || value.length > NOTION.URL_MAX) return null;
    return /^https?:\/\//i.test(value) ? value : null;
  }

  function chunkText(text, max = NOTION.TEXT_MAX) {
    const out = [];
    let rest = text;
    while (rest.length > max) {
      let cut = rest.lastIndexOf("\n", max);
      if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
      if (cut < max * 0.6) cut = max;
      // never split a surrogate pair
      if (cut > 0 && cut < rest.length) {
        const code = rest.charCodeAt(cut - 1);
        if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
      }
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) out.push(rest);
    return out;
  }

  function textRun(content, annotations = EMPTY_ANNOTATIONS, link = null) {
    const run = { type: "text", text: { content }, annotations: { ...annotations } };
    if (link) run.text.link = { url: link };
    return run;
  }

  /* ------------------------------------------------------------------ *
   * Rich text
   * ------------------------------------------------------------------ */

  function latexFromMath(mathEl) {
    const ann = mathEl.querySelector('annotation[encoding="application/x-tex"], annotation[encoding="TeX"]');
    if (ann && ann.textContent.trim()) return ann.textContent.trim();
    const attr = mathEl.getAttribute("data-latex") || mathEl.getAttribute("alttext");
    return attr ? attr.trim() : null;
  }

  /* Pull LaTeX out of the common renderers when an element was NOT
     standardised by Defuddle (selection / restored paths). */
  function latexFromRendered(el) {
    if (el.matches && el.matches("script[type^='math/tex']")) return el.textContent.trim() || null;
    const ann = el.querySelector('annotation[encoding="application/x-tex"], annotation[encoding="TeX"]');
    if (ann && ann.textContent.trim()) return ann.textContent.trim();
    const script = el.querySelector('script[type^="math/tex"]');
    if (script && script.textContent.trim()) return script.textContent.trim();
    if (el.matches && el.matches(".MathJax, .MathJax_Preview, .MathJax_Display, .MathJax_SVG, .MathJax_CHTML")) {
      let sib = el.nextElementSibling;
      for (let i = 0; sib && i < 2; i++, sib = sib.nextElementSibling) {
        if (sib.matches("script[type^='math/tex']") && sib.textContent.trim()) return sib.textContent.trim();
      }
    }
    for (const attr of ["data-latex", "data-tex", "data-math", "alttext"]) {
      const v = el.getAttribute(attr);
      if (v && v.trim()) return v.trim();
    }
    const math = el.querySelector("math[alttext]");
    if (math) return math.getAttribute("alttext").trim();
    const img = el.matches("img[alt]") ? el : el.querySelector("img.latex[alt], img[alt^='\\\\'], img[alt*='\\\\']");
    if (img && /\\|\^|_/.test(img.getAttribute("alt") || "")) return img.getAttribute("alt").trim();
    return null;
  }

  const MATH_INLINE_SELECTOR = "math, .katex, mjx-container, .MathJax, span.math, [data-latex], [data-tex], script[type^='math/tex']";

  function pushText(out, text, annotations, link) {
    if (!text) return;
    for (const piece of chunkText(text)) out.push(textRun(piece, annotations, link));
  }

  function pushEquation(out, latex, annotations) {
    const expr = String(latex).trim();
    if (!expr) return;
    if (expr.length > NOTION.EQUATION_MAX) {
      pushText(out, expr, { ...annotations, code: true }, null);
      return;
    }
    out.push({ type: "equation", equation: { expression: expr }, annotations: { ...annotations } });
  }

  function walkInline(node, annotations, link, out) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        pushText(out, child.nodeValue.replace(/\s+/g, " "), annotations, link);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toLowerCase();

      if (tag === "br") {
        pushText(out, "\n", annotations, link);
        continue;
      }
      if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template") continue;

      if (tag === "math") {
        const latex = latexFromMath(child);
        if (latex) pushEquation(out, latex, annotations);
        else pushText(out, child.textContent, annotations, link);
        continue;
      }
      if (child.matches && child.matches(MATH_INLINE_SELECTOR)) {
        const latex = latexFromRendered(child);
        if (latex) {
          pushEquation(out, latex, annotations);
          continue;
        }
      }
      if (tag === "img") {
        const alt = (child.getAttribute("alt") || "").trim();
        if (alt) pushText(out, alt, annotations, link);
        continue;
      }

      const next = { ...annotations };
      let nextLink = link;
      if (tag === "strong" || tag === "b") next.bold = true;
      else if (tag === "em" || tag === "i" || tag === "cite" || tag === "var") next.italic = true;
      else if (tag === "code" || tag === "kbd" || tag === "samp" || tag === "tt") next.code = true;
      else if (tag === "s" || tag === "del" || tag === "strike") next.strikethrough = true;
      else if (tag === "u" || tag === "ins") next.underline = true;
      else if (tag === "mark") next.color = "yellow_background";
      else if (tag === "a") nextLink = safeHttpUrl(child.getAttribute("href")) || link;
      else if (tag === "sup" || tag === "sub") {
        // Notion has no super/subscript; keep the text but avoid gluing it.
        pushText(out, tag === "sup" ? "^" : "_", annotations, link);
      }
      walkInline(child, next, nextLink, out);
    }
  }

  function richText(el) {
    const runs = [];
    walkInline(el, EMPTY_ANNOTATIONS, null, runs);

    // merge adjacent runs with identical styling
    const merged = [];
    for (const run of runs) {
      const last = merged[merged.length - 1];
      if (
        last && last.type === "text" && run.type === "text" &&
        JSON.stringify(last.annotations) === JSON.stringify(run.annotations) &&
        !last.text.link && !run.text.link &&
        last.text.content.length + run.text.content.length <= NOTION.TEXT_MAX
      ) {
        last.text.content += run.text.content;
      } else merged.push(run);
    }

    // trim leading / trailing whitespace runs
    while (merged.length && merged[0].type === "text") {
      merged[0].text.content = merged[0].text.content.replace(/^\s+/, "");
      if (merged[0].text.content) break;
      merged.shift();
    }
    while (merged.length && merged[merged.length - 1].type === "text") {
      const last = merged[merged.length - 1];
      last.text.content = last.text.content.replace(/\s+$/, "");
      if (last.text.content) break;
      merged.pop();
    }
    return merged;
  }

  /* Split a rich_text array into ≤100-run slices without cutting words. */
  function splitRuns(runs) {
    const out = [];
    for (let i = 0; i < runs.length; i += NOTION.ARRAY_MAX) out.push(runs.slice(i, i + NOTION.ARRAY_MAX));
    return out;
  }

  function textBlocks(type, el, extra = {}) {
    const runs = richText(el);
    if (!runs.length) return [];
    if (type === "paragraph") {
      return splitRuns(runs).map((slice) => ({ object: "block", type, [type]: { rich_text: slice, ...extra } }));
    }
    return [{ object: "block", type, [type]: { rich_text: runs.slice(0, NOTION.ARRAY_MAX), ...extra } }];
  }

  /* ------------------------------------------------------------------ *
   * Code blocks  (actions 10 & 11)
   * ------------------------------------------------------------------ */

  const GUTTER_SELECTOR = [
    ".line-number", ".line-numbers", ".linenumber", ".linenumbers", ".gutter", ".hljs-ln-numbers",
    ".hljs-ln-n", ".lnt", ".ln", ".lineno", ".linenos", ".linenodiv", ".rouge-gutter", ".rouge-line-number",
    ".react-syntax-highlighter-line-number", ".line-numbers-rows", ".code-line-number", ".cm-gutters",
    ".cm-gutter", ".cm-lineNumbers", ".margin", ".margin-view-overlays", ".line-numbers-wrapper",
    "[data-line-number]:empty", ".blob-num", "td.blob-num", ".ec-line .gutter", ".token-line .line-number",
  ].join(", ");

  const CODE_CHROME_SELECTOR = [
    "button", "[class*='copy']", "[class*='Copy']", "[class*='clipboard']", "[class*='toolbar']",
    "[class*='header']", "[class*='titlebar']", "[class*='filename']", "[class*='code-lang']",
    ".hover-info", ".colorscripter-code-footer", "a[href*='colorscripter']",
  ].join(", ");

  const LINE_WRAPPER_SELECTOR = [
    ".line", ".code-line", ".token-line", ".cm-line", ".view-line", ".ec-line", ".hljs-ln-line",
    ".react-code-line-contents", "[data-line]", "[data-line-number]", "tr", ".highlight-line", ".c-line",
  ].join(", ");

  /* Text of a code element with the line structure preserved. Handles
     <br>, per-line wrappers (Shiki, Prism line-numbers, CodeMirror, Monaco,
     hljs-ln tables), and strips gutters / copy buttons. */
  function codeText(root) {
    const el = root.cloneNode(true);
    el.querySelectorAll(CODE_CHROME_SELECTOR).forEach((n) => {
      // never strip a wrapper that holds the code itself
      if (n.querySelector("code, pre") && normText(n.textContent).length > 40) return;
      n.remove();
    });
    el.querySelectorAll(GUTTER_SELECTOR).forEach((n) => n.remove());
    // 2-cell rows/flex where the first cell is only digits → gutter
    el.querySelectorAll("div, span, td").forEach((n) => {
      if (n.children.length === 2 && /^\s*\d+\s*$/.test(n.children[0].textContent) && n.children[0].children.length === 0) {
        n.children[0].remove();
      }
    });

    const lines = [];
    let current = "";
    const flush = () => {
      lines.push(current);
      current = "";
    };

    const isLineWrapper = (n) => n.matches && n.matches(LINE_WRAPPER_SELECTOR) && !n.querySelector(LINE_WRAPPER_SELECTOR);

    const walk = (node, inWrapper) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          current += child.nodeValue;
          continue;
        }
        if (child.nodeType !== 1) continue;
        const tag = child.tagName.toLowerCase();
        if (tag === "br") {
          flush();
          continue;
        }
        if (tag === "script" || tag === "style") continue;
        if (!inWrapper && isLineWrapper(child)) {
          // text pending before the wrapper is its own line
          if (current.trim()) lines.push(current.replace(/\n$/, ""));
          current = "";
          const before = lines.length;
          walk(child, true);
          const produced = lines.length > before;
          if (current !== "" || !produced) lines.push(current.replace(/\n$/, ""));
          current = "";
          continue;
        }
        walk(child, inWrapper);
      }
    };
    walk(el, false);
    if (current) lines.push(current);

    let text = lines.join("\n");
    text = text.replace(/\u00a0/g, " ").replace(/​|﻿/g, "");
    text = text.replace(/\r\n?/g, "\n").replace(/^\n+/, "").replace(/\n+$/, "");
    // if every other line is empty (wrapper + trailing \n), drop the empties
    const arr = text.split("\n");
    if (arr.length >= 4) {
      const odd = arr.filter((_, i) => i % 2 === 1);
      if (odd.length && odd.every((l) => l.trim() === "")) text = arr.filter((_, i) => i % 2 === 0).join("\n");
    }
    return text;
  }

  function detectLanguage(el) {
    const attrs = ["data-lang", "data-language", "data-ke-language", "data-code-language", "lang", "data-codetype"];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 4; depth++, node = node.parentElement) {
      for (const a of attrs) {
        const v = node.getAttribute(a);
        if (v && notionLanguage(v) !== "plain text") return notionLanguage(v);
      }
      const inner = node.querySelector("code[class*='language-'], code[class*='lang-'], code[data-lang], [data-ke-language]");
      const cls = `${inner ? inner.className : ""} ${node.className || ""}`;
      const m = typeof cls === "string" && cls.match(/(?:language|lang|brush|syntax|highlight|code)[-_:]([\w+#.-]+)/i);
      if (m && notionLanguage(m[1]) !== "plain text") return notionLanguage(m[1]);
      // bare class name that is itself a language (Tistory: <pre class="kotlin">)
      const bare = (typeof cls === "string" ? cls : "").split(/\s+/).map((c) => notionLanguage(c)).find((l) => l !== "plain text");
      if (bare) return bare;
    }
    return "plain text";
  }

  function codeBlock(el, langHint) {
    const text = codeText(el).replace(/\n+$/, "");
    if (!text.trim()) return null;
    const language = langHint || detectLanguage(el);
    return {
      object: "block",
      type: "code",
      code: {
        language,
        rich_text: chunkText(text).slice(0, NOTION.ARRAY_MAX).map((piece) => textRun(piece)),
      },
    };
  }

  /* Non-<pre> code containers we recognise as code (action 11). */
  const CODE_CONTAINER_ALWAYS = ".se-code-source, .colorscripter-code, .colorscripter-code-table, .cm-editor, .cm-content, .monaco-editor, .view-lines, .syntaxhighlighter";
  const CODE_CONTAINER_IF_NO_PRE = ".highlight, .codehilite, div[class*='language-'], .wp-block-code, .code-block, [data-rehype-pretty-code-fragment]";
  const CODE_CONTAINER_SELECTOR = `${CODE_CONTAINER_ALWAYS}, ${CODE_CONTAINER_IF_NO_PRE}`;

  function isCodeContainer(el) {
    if (!el || el.nodeType !== 1 || !el.matches) return false;
    try {
      if (el.matches(CODE_CONTAINER_ALWAYS)) return true;
      return el.matches(CODE_CONTAINER_IF_NO_PRE) && !el.querySelector("pre") && !el.closest("pre");
    } catch {
      return false;
    }
  }

  /* ColorScripter (Tistory): <div class="colorscripter-code"><table>
       <tr><td class="colorscripter-code-gutter">1 2 3</td><td>lines…</td></tr>
     Rebuild the source from the code column only. */
  function colorScripterText(el) {
    const table = el.matches("table") ? el : el.querySelector("table");
    if (!table) return codeText(el);
    const cells = Array.from(table.querySelectorAll("td")).filter((td) => {
      const t = td.textContent.replace(/\u00a0/g, " ").trim();
      if (/^[\d\s]*$/.test(t)) return false; // gutter
      if (td.querySelector("a[href*='colorscripter']") && t.length < 60) return false; // footer
      return true;
    });
    const codeCell = cells.sort((a, b) => b.textContent.length - a.textContent.length)[0];
    if (!codeCell) return codeText(el);
    const rows = Array.from(codeCell.querySelectorAll("div")).filter((d) => !d.querySelector("div"));
    const lines = rows.length ? rows.map((r) => r.textContent.replace(/\u00a0/g, " ").replace(/\n$/, "").replace(/^\s+$/, "")) : codeText(codeCell).split("\n");
    return lines.join("\n").replace(/\n+$/, "");
  }

  /* ------------------------------------------------------------------ *
   * Images & media
   * ------------------------------------------------------------------ */

  const REFERER_LOCKED_HOSTS = /(^|\.)pstatic\.net$|(^|\.)naver\.net$|(^|\.)kakaocdn\.net$/i;
  const SIGNED_URL_RE = /[?&](X-Amz-Signature|X-Amz-Expires|Expires|expires|token|sig|signature|se=)=/i;

  function classifyImageUrl(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, reason: "unparseable" };
    }
    if (parsed.protocol !== "https:") return { ok: false, reason: "not-https", upload: true };
    if (url.length > NOTION.URL_MAX) return { ok: false, reason: "too-long", upload: true };
    if (REFERER_LOCKED_HOSTS.test(parsed.hostname)) return { ok: false, reason: "referer-locked", upload: true };
    if (SIGNED_URL_RE.test(parsed.search) || /notion\.so\/image\//.test(url)) return { ok: false, reason: "expiring", upload: true };
    if (/^\/?(image|img|proxy|thumb|fetch)\//.test(parsed.pathname) && /[?&](src|url|u)=/i.test(parsed.search)) {
      return { ok: false, reason: "proxy", upload: true };
    }
    if (!IMAGE_EXT_OK.test(parsed.pathname)) return { ok: false, reason: "extension", upload: true };
    return { ok: true };
  }

  /* Naver: ?type=w773 → w2000 (original size); dthumb proxy → its src. */
  function upgradeImageUrl(url) {
    try {
      const u = new URL(url);
      if (/dthumb-phinf\.pstatic\.net$/.test(u.hostname) && u.searchParams.get("src")) {
        return u.searchParams.get("src").replace(/^"|"$/g, "");
      }
      if (/pstatic\.net$/.test(u.hostname) && /^w\d+$/.test(u.searchParams.get("type") || "")) {
        u.searchParams.set("type", "w2000");
        return u.href;
      }
      if (/daumcdn\.net$/.test(u.hostname) && /\/thumb\//.test(u.pathname) && u.searchParams.get("fname")) {
        return u.searchParams.get("fname");
      }
      return url;
    } catch {
      return url;
    }
  }

  function imageBlock(img, ctx) {
    const raw = safeHttpUrl(img.getAttribute("src"));
    if (!raw) return null;
    const url = upgradeImageUrl(raw);
    const alt = (img.getAttribute("alt") || "").trim();
    const block = { object: "block", type: "image", image: { type: "external", external: { url } } };
    if (alt) block.image.caption = [textRun(alt.slice(0, NOTION.TEXT_MAX))];

    const verdict = classifyImageUrl(url);
    if (!verdict.ok) {
      // The background may upload the bytes instead (action 8); until then
      // the block carries a plan so the sender can degrade it if needed.
      block._intact = { image: { url, reason: verdict.reason, upload: !!verdict.upload, fallbackUrl: raw } };
      ctx.uploads.push(block);
    }
    return block;
  }

  const VIDEO_PROVIDERS = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|loom\.com|drive\.google\.com|figma\.com|asana\.com|atlassian\.net|typeform\.com|gist\.github\.com|codepen\.io|framer\.com)$/i;

  function bookmarkBlock(url, caption) {
    const safe = safeHttpUrl(url);
    if (!safe) return null;
    const block = { object: "block", type: "bookmark", bookmark: { url: safe } };
    if (caption) block.bookmark.caption = [textRun(String(caption).slice(0, NOTION.TEXT_MAX))];
    return block;
  }

  function mediaBlock(el) {
    const tag = el.tagName.toLowerCase();
    let src = el.getAttribute("src") || (el.querySelector("source") || {}).src || el.getAttribute("data-src");
    if (tag === "lite-youtube" && el.getAttribute("videoid")) src = `https://www.youtube.com/watch?v=${el.getAttribute("videoid")}`;
    src = safeHttpUrl(absoluteUrl(src));
    if (!src) return null;
    let host = "";
    try {
      host = new URL(src).hostname;
    } catch {
      return null;
    }
    if (VIDEO_PROVIDERS.test(host) && !/gist|codepen/.test(host)) {
      const url = src.replace(/youtube(-nocookie)?\.com\/embed\/([\w-]+)/, "youtube.com/watch?v=$2").replace(/player\.vimeo\.com\/video\//, "vimeo.com/");
      return { object: "block", type: "video", video: { type: "external", external: { url } } };
    }
    if (tag === "iframe" && /(twitter|x)\.com|instagram\.com|tiktok\.com|spotify\.com|soundcloud\.com|maps\.google|google\.com\/maps|slideshare|speakerdeck|docs\.google/i.test(src)) {
      return { object: "block", type: "embed", embed: { url: src } };
    }
    return bookmarkBlock(src, tag === "iframe" ? "Embedded content" : "Video");
  }

  /* ------------------------------------------------------------------ *
   * Lists, tables, toggles
   * ------------------------------------------------------------------ */

  const MAX_LIST_DEPTH = 2; // Notion allows two levels of nesting per request

  function listItems(listEl, type, depth, ctx) {
    const out = [];
    for (const li of Array.from(listEl.children)) {
      if (li.tagName.toLowerCase() !== "li") continue;
      const own = scratchDoc.createElement("div");
      const nested = [];
      const blockish = [];
      for (const child of Array.from(li.childNodes)) {
        const t = child.nodeType === 1 ? child.tagName.toLowerCase() : "";
        if (t === "ul" || t === "ol") nested.push(child);
        else if (t === "pre" || t === "table" || t === "figure" || t === "blockquote") blockish.push(child);
        else own.appendChild(child.cloneNode(true));
      }
      let itemType = type;
      const extra = {};
      const checkbox = own.querySelector('input[type="checkbox"]');
      if (checkbox) {
        itemType = "to_do";
        extra.checked = checkbox.hasAttribute("checked") || checkbox.checked === true;
        checkbox.remove();
      } else if (/^\s*\[( |x|X)\]/.test(own.textContent)) {
        itemType = "to_do";
        extra.checked = /^\s*\[(x|X)\]/.test(own.textContent);
        const first = own.firstChild;
        if (first && first.nodeType === 3) first.nodeValue = first.nodeValue.replace(/^\s*\[( |x|X)\]\s?/, "");
      }
      const runs = richText(own);
      const item = { object: "block", type: itemType, [itemType]: { rich_text: runs.slice(0, NOTION.ARRAY_MAX), ...extra } };

      const children = [];
      for (const b of blockish) children.push(...htmlNodeToBlocks(b, ctx));
      for (const n of nested) {
        const nt = n.tagName.toLowerCase() === "ol" ? "numbered_list_item" : "bulleted_list_item";
        children.push(...listItems(n, nt, depth + 1, ctx));
      }
      if (children.length && depth < MAX_LIST_DEPTH) {
        item[itemType].children = children.slice(0, NOTION.ARRAY_MAX);
        if (runs.length || item[itemType].children.length) out.push(item);
      } else {
        if (runs.length) out.push(item);
        // too deep: flatten the children after this item
        if (children.length) out.push(...children);
      }
    }
    return out;
  }

  function tableBlock(tableEl, ctx) {
    const rowEls = Array.from(tableEl.querySelectorAll(":scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr"));
    if (!rowEls.length) return null;
    const rows = rowEls.map((tr) => {
      const cells = [];
      for (const cell of Array.from(tr.children)) {
        if (!/^(td|th)$/i.test(cell.tagName)) continue;
        // images / code inside a cell become text so nothing is silently lost
        const runs = richText(cell);
        const pre = cell.querySelector("pre");
        if (pre) pushText(runs, (runs.length ? "\n" : "") + codeText(pre), { ...EMPTY_ANNOTATIONS, code: true });
        cells.push(runs.slice(0, NOTION.ARRAY_MAX));
        const span = parseInt(cell.getAttribute("colspan") || "1", 10);
        for (let i = 1; i < Math.min(span, 20); i++) cells.push([]);
      }
      return cells;
    });
    const width = Math.max(...rows.map((r) => r.length));
    if (!width || width > NOTION.ARRAY_MAX) return null;
    const hasHeader = rowEls[0].querySelector("th") !== null && rowEls[0].querySelectorAll("th").length === rowEls[0].children.length;
    const block = {
      object: "block",
      type: "table",
      table: {
        table_width: width,
        has_column_header: hasHeader,
        has_row_header: false,
        children: rows.slice(0, NOTION.ARRAY_MAX).map((cells) => ({
          object: "block",
          type: "table_row",
          table_row: { cells: Array.from({ length: width }, (_, i) => cells[i] || []) },
        })),
      },
    };
    if (rows.length > NOTION.ARRAY_MAX) {
      // Notion caps children at 100 per request; the sender appends the rest
      block._intact = { extraRows: rows.slice(NOTION.ARRAY_MAX).map((cells) => ({
        object: "block", type: "table_row", table_row: { cells: Array.from({ length: width }, (_, i) => cells[i] || []) },
      })) };
    }
    return block;
  }

  function toggleBlock(detailsEl, ctx) {
    const summary = detailsEl.querySelector(":scope > summary");
    const title = summary ? richText(summary) : [textRun("Details")];
    const body = scratchDoc.createElement("div");
    for (const child of Array.from(detailsEl.childNodes)) {
      if (child === summary) continue;
      body.appendChild(child.cloneNode(true));
    }
    const children = [];
    for (const child of Array.from(body.childNodes)) children.push(...htmlNodeToBlocks(child, ctx));
    return {
      object: "block",
      type: "toggle",
      toggle: { rich_text: (title.length ? title : [textRun("Details")]).slice(0, NOTION.ARRAY_MAX), children: children.slice(0, NOTION.ARRAY_MAX) },
    };
  }

  /* ------------------------------------------------------------------ *
   * HTML → blocks
   * ------------------------------------------------------------------ */

  const HEADINGS = { h1: "heading_1", h2: "heading_2", h3: "heading_3", h4: "heading_3", h5: "heading_3", h6: "heading_3" };
  const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "form", "button", "input", "select", "textarea", "svg", "canvas", "nav", "aside", "link", "meta"]);
  const BLOCKISH_RE = /^(p|div|section|article|ul|ol|pre|table|figure|h[1-6]|blockquote|hr|details|dl|math|iframe|video|audio|img)$/i;

  function htmlNodeToBlocks(node, ctx) {
    const out = [];
    convertNode(node, out, ctx);
    return out;
  }

  function convertNode(node, out, ctx) {
    if (node.nodeType === 3) {
      const text = node.nodeValue.replace(/\s+/g, " ").trim();
      if (text) {
        const p = scratchDoc.createElement("p");
        p.textContent = text;
        out.push(...textBlocks("paragraph", p));
      }
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) {
      if (tag === "svg" && node.closest("figure")) return;
      return;
    }
    if (node.hasAttribute && node.hasAttribute("data-intact-skip")) return;

    if (HEADINGS[tag]) {
      out.push(...textBlocks(HEADINGS[tag], node));
      return;
    }

    // code containers that are not <pre>
    if (tag !== "pre" && isCodeContainer(node)) {
      if (/colorscripter/.test(node.className || "") || node.querySelector(".colorscripter-code-table")) {
        const text = colorScripterText(node);
        if (text.trim()) {
          out.push({ object: "block", type: "code", code: { language: detectLanguage(node), rich_text: chunkText(text).slice(0, NOTION.ARRAY_MAX).map((t) => textRun(t)) } });
        }
        return;
      }
      const block = codeBlock(node);
      if (block) out.push(block);
      return;
    }

    switch (tag) {
      case "p": {
        const kids = Array.from(node.children);
        if (kids.length === 1 && kids[0].tagName.toLowerCase() === "img" && !normText(node.textContent)) {
          const img = imageBlock(kids[0], ctx);
          if (img) out.push(img);
          return;
        }
        if (kids.some((k) => /^(pre|table|figure|ul|ol|blockquote|div)$/i.test(k.tagName))) {
          for (const child of Array.from(node.childNodes)) convertNode(child, out, ctx);
          return;
        }
        out.push(...textBlocks("paragraph", node));
        return;
      }
      case "pre": {
        const block = codeBlock(node);
        if (block) out.push(block);
        return;
      }
      case "blockquote": {
        const inner = [];
        for (const child of Array.from(node.childNodes)) convertNode(child, inner, ctx);
        const paras = inner.filter((b) => b.type === "paragraph");
        const others = inner.filter((b) => b.type !== "paragraph");
        if (paras.length) {
          const runs = [];
          paras.forEach((b, i) => {
            if (i) runs.push(textRun("\n"));
            runs.push(...b.paragraph.rich_text);
          });
          const quote = { object: "block", type: "quote", quote: { rich_text: runs.slice(0, NOTION.ARRAY_MAX) } };
          if (others.length) quote.quote.children = others.slice(0, NOTION.ARRAY_MAX);
          out.push(quote);
        } else out.push(...others);
        return;
      }
      case "ul":
      case "ol":
        out.push(...listItems(node, tag === "ol" ? "numbered_list_item" : "bulleted_list_item", 0, ctx));
        return;
      case "dl": {
        for (const child of Array.from(node.children)) {
          const t = child.tagName.toLowerCase();
          if (t === "dt") {
            const runs = richText(child).map((r) => (r.type === "text" ? { ...r, annotations: { ...r.annotations, bold: true } } : r));
            if (runs.length) out.push({ object: "block", type: "paragraph", paragraph: { rich_text: runs.slice(0, NOTION.ARRAY_MAX) } });
          } else if (t === "dd") {
            for (const c of Array.from(child.childNodes)) convertNode(c, out, ctx);
          }
        }
        return;
      }
      case "img": {
        const block = imageBlock(node, ctx);
        if (block) out.push(block);
        return;
      }
      case "picture": {
        const img = node.querySelector("img");
        if (img) {
          const block = imageBlock(img, ctx);
          if (block) out.push(block);
        }
        return;
      }
      case "figure": {
        const img = node.querySelector("img");
        const caption = node.querySelector("figcaption");
        const pre = node.querySelector("pre");
        if (img && !pre) {
          const block = imageBlock(img, ctx);
          if (block) {
            if (caption && normText(caption.textContent)) block.image.caption = richText(caption).slice(0, NOTION.ARRAY_MAX);
            out.push(block);
            return;
          }
        }
        for (const child of Array.from(node.childNodes)) convertNode(child, out, ctx);
        return;
      }
      case "table": {
        if (node.matches(".colorscripter-code-table") || node.closest(".colorscripter-code")) {
          const text = colorScripterText(node);
          if (text.trim()) out.push({ object: "block", type: "code", code: { language: detectLanguage(node), rich_text: chunkText(text).slice(0, NOTION.ARRAY_MAX).map((t) => textRun(t)) } });
          return;
        }
        // hljs / Chroma line-number tables are code, not data
        if (node.querySelector("pre, code") && node.querySelectorAll("tr").length <= 2) {
          const block = codeBlock(node);
          if (block) out.push(block);
          return;
        }
        const block = tableBlock(node, ctx);
        if (block) out.push(block);
        else for (const child of Array.from(node.childNodes)) convertNode(child, out, ctx);
        return;
      }
      case "hr":
        out.push({ object: "block", type: "divider", divider: {} });
        return;
      case "math": {
        const latex = latexFromMath(node);
        if (!latex) return;
        if (latex.length > NOTION.EQUATION_MAX) {
          out.push({ object: "block", type: "code", code: { language: "latex", rich_text: chunkText(latex).slice(0, NOTION.ARRAY_MAX).map((t) => textRun(t)) } });
        } else out.push({ object: "block", type: "equation", equation: { expression: latex } });
        return;
      }
      case "details": {
        out.push(toggleBlock(node, ctx));
        return;
      }
      case "video":
      case "audio":
      case "iframe":
      case "lite-youtube": {
        const block = mediaBlock(node);
        if (block) out.push(block);
        return;
      }
      case "a": {
        if (node.hasAttribute("data-intact-bookmark")) {
          const block = bookmarkBlock(node.getAttribute("href"), node.getAttribute("data-intact-bookmark") || node.textContent);
          if (block) out.push(block);
          return;
        }
        break;
      }
      default:
        break;
    }

    // block-level math wrappers (KaTeX display, MathJax) that Defuddle did not touch
    if (node.matches && (node.matches(".katex-display, mjx-container[display='true'], .MathJax_Display, .math-display, [data-math-display]") || (node.matches(MATH_INLINE_SELECTOR) && !node.closest("p, li, td, h1, h2, h3")))) {
      const latex = latexFromRendered(node);
      if (latex) {
        if (latex.length > NOTION.EQUATION_MAX) out.push({ object: "block", type: "code", code: { language: "latex", rich_text: chunkText(latex).slice(0, NOTION.ARRAY_MAX).map((t) => textRun(t)) } });
        else out.push({ object: "block", type: "equation", equation: { expression: latex } });
        return;
      }
    }

    // callouts / admonitions → callout block
    if (node.matches && node.matches(".admonition, .callout, [data-callout], .alert, .note, .warning, .tip, .markdown-alert")) {
      const inner = [];
      for (const child of Array.from(node.childNodes)) convertNode(child, inner, ctx);
      if (inner.length) {
        const first = inner[0];
        const runs = first.type === "paragraph" ? first.paragraph.rich_text : [textRun(normText(node.textContent).slice(0, 200))];
        const callout = { object: "block", type: "callout", callout: { rich_text: runs.slice(0, NOTION.ARRAY_MAX), icon: { type: "emoji", emoji: "💡" } } };
        const rest = first.type === "paragraph" ? inner.slice(1) : inner;
        if (rest.length) callout.callout.children = rest.slice(0, NOTION.ARRAY_MAX);
        out.push(callout);
        return;
      }
    }

    if (Array.from(node.children).some((c) => BLOCKISH_RE.test(c.tagName))) {
      for (const child of Array.from(node.childNodes)) convertNode(child, out, ctx);
    } else {
      out.push(...textBlocks("paragraph", node));
    }
  }

  function htmlToBlocks(html, ctx) {
    const holder = scratchDoc.createElement("div");
    holder.innerHTML = html;
    const out = [];
    for (const child of Array.from(holder.childNodes)) convertNode(child, out, ctx);
    const kept = out.filter((block) => {
      const body = block[block.type];
      if (!body) return true;
      if (Array.isArray(body.rich_text) && !body.rich_text.length) return !!(body.children && body.children.length);
      return true;
    });
    // drop consecutive duplicates (renderers that emit a fallback copy)
    const result = [];
    let prevKey = null;
    for (const block of kept) {
      const key = block.type === "divider" ? null : JSON.stringify(stripPrivate(block));
      if (key && key === prevKey) continue;
      result.push(block);
      prevKey = key;
    }
    return result;
  }

  const stripPrivate = (block) => JSON.parse(JSON.stringify(block, (k, v) => (k === "_intact" ? undefined : v)));

  function sourceHeader(meta) {
    const bits = [];
    if (meta.author) bits.push(meta.author);
    if (meta.site) bits.push(meta.site);
    if (meta.published) bits.push(meta.published);
    const gray = { ...EMPTY_ANNOTATIONS, color: "gray" };
    const runs = [textRun("Source: ", gray), textRun(meta.url.slice(0, NOTION.URL_MAX), gray, meta.url)];
    if (bits.length) runs.push(textRun(`  ·  ${bits.join("  ·  ")}`, gray));
    return [
      { object: "block", type: "paragraph", paragraph: { rich_text: runs } },
      { object: "block", type: "divider", divider: {} },
    ];
  }

  /* ------------------------------------------------------------------ *
   * Main-content heuristics, restoration, pruning
   * ------------------------------------------------------------------ */

  const NOISE_CONTAINER = 'nav, aside, footer, header, form, dialog, template, [aria-hidden="true"], [hidden]';
  const NOISE_CLASS = /(^|[\s_-])(ad|ads|advert|advertisement|promo|sponsor|subscribe|subscription|newsletter|signup|social|share|sharing|comment|comments|disqus|related|recommend|recirc|sidebar|breadcrumb|pagination|pager|cookie|consent|banner|popup|modal|menu|toolbar|byline|author-bio|tags|metadata|paywall|upsell|masthead|reply|replies)([\s_-]|$)/i;
  const CONTENT_SELECTORS = [
    "article", '[itemprop="articleBody"]', '[role="main"] article', "main article", ".post-content",
    ".entry-content", ".article-content", ".article-body", ".post-body", ".story-body", ".markdown-body",
    ".se-main-container", "#article-view-content-div", ".tt_article_useless_p_margin", ".contents_style",
    ".atom-one", "#dic_area", "#newsct_article", "#harmonyContainer", ".wrap_body", "main", '[role="main"]',
  ];
  const BLOCK_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "table", "pre", "figure", "blockquote", "dl", "math", "details"]);
  const BLOCK_MATH_SELECTOR = "script[type^='math/tex'], .MathJax_Display, .katex-display, mjx-container[display='true'], .math-display, div.math";

  function findMainContainer(doc) {
    for (const selector of CONTENT_SELECTORS) {
      let best = null;
      for (const el of Array.from(doc.querySelectorAll(selector))) {
        const len = lowerNorm(el.textContent).length;
        if (!best || len > best.len) best = { el, len };
      }
      if (best && best.len > 200) return best.el;
    }
    return doc.body;
  }

  function isNoise(el) {
    if (el.closest && el.closest(NOISE_CONTAINER)) return true;
    let node = el;
    for (let i = 0; node && node.nodeType === 1 && i < 4; i++, node = node.parentElement) {
      const cls = `${node.className || ""} ${node.id || ""}`;
      if (typeof cls === "string" && NOISE_CLASS.test(cls)) return true;
    }
    return false;
  }

  function isVisible(el) {
    if (typeof getComputedStyle !== "function") return true;
    let node = el;
    for (let i = 0; node && node.nodeType === 1 && i < 12; i++, node = node.parentElement) {
      const style = getComputedStyle(node);
      if (!style) return true;
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  }

  function isWorthRestoring(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "figure" || tag === "table" || tag === "pre" || tag === "math" || el.querySelector("img, table, pre, math")) return true;
    if ((tag === "ul" || tag === "ol") && el.querySelectorAll("li").length >= 2) return true;
    if (tag === "dl" || tag === "details" || isCodeContainer(el)) return true;
    if (tag === "script" || (el.matches && el.matches(BLOCK_MATH_SELECTOR))) return !!latexFromRendered(el);
    return lowerNorm(el.textContent).length >= 25;
  }

  function collectBlocks(root) {
    const out = [];
    const walk = (node) => {
      for (const child of Array.from(node.children || [])) {
        const tag = child.tagName.toLowerCase();
        if (tag === "script" || tag === "style" || tag === "noscript") continue;
        if (BLOCK_TAGS.has(tag) || isCodeContainer(child) || (child.matches && child.matches(BLOCK_MATH_SELECTOR))) {
          if (tag === "script") {
            const prev = child.previousElementSibling;
            const consumed = prev && prev.matches(".MathJax, .MathJax_Display, .MathJax_Preview");
            if (!consumed && !child.closest("p, li, td, h1, h2, h3, h4")) out.push(child);
          }
          else if (tag !== "script") out.push(child);
          continue;
        }
        walk(child);
      }
    };
    walk(root);
    return out;
  }

  const squash = (s) => (s || "").replace(/\s+/g, "").toLowerCase();
  /* text length plus the LaTeX / alt text that textContent does not see */
  function weight(el) {
    let n = squash(el.textContent).length;
    for (const m of Array.from(el.querySelectorAll("[alttext], annotation, script[type^='math/tex'], img[alt], [data-latex]"))) {
      n += squash(m.getAttribute("alttext") || m.getAttribute("data-latex") || m.getAttribute("alt") || m.textContent).length;
    }
    if (el.matches && el.matches("script[type^='math/tex']")) n += squash(el.textContent).length;
    return n;
  }
  const codeKey = (text) => squash(text).replace(/\d/g, "").slice(0, 80);
  const fingerprint = (el) => squash(el.textContent).slice(0, 60);
  const shortKey = (el) => squash(el.textContent).slice(0, 24);

  /* Normalise code + math inside a raw DOM clone so the raw paths get the
     same treatment Defuddle gives the main path (action 4 / 10). */
  function normalizeRawFragment(root) {
    const isBody = root.tagName && root.tagName.toLowerCase() === "body";
    let box = root;
    if (!isBody) {
      box = scratchDoc.createElement("div");
      box.appendChild(root);
    }
    // code: containers → <pre><code data-lang>
    for (const el of Array.from(box.querySelectorAll("pre, " + CODE_CONTAINER_SELECTOR))) {
      if (!box.contains(el)) continue;
      const isPre = el.tagName.toLowerCase() === "pre";
      if (!isPre && !isCodeContainer(el)) continue;
      if (isPre && el.parentElement && el.parentElement.closest("pre")) continue;
      if (isPre && el.closest(CODE_CONTAINER_ALWAYS) && el.closest(CODE_CONTAINER_ALWAYS) !== el) continue; // handled by the container
      const isCs = /colorscripter/.test(el.className || "") || el.querySelector(".colorscripter-code-table");
      const text = isCs ? colorScripterText(el) : codeText(el);
      if (!text.trim()) continue;
      const lang = detectLanguage(el);
      const pre = scratchDoc.createElement("pre");
      const code = scratchDoc.createElement("code");
      code.setAttribute("data-lang", lang);
      code.className = `language-${lang.replace(/\s+/g, "-")}`;
      code.textContent = text;
      pre.appendChild(code);
      pre.setAttribute("data-lang", lang);
      el.replaceWith(pre);
    }
    // math renderers → <math data-latex>
    box.querySelectorAll(".MathJax_Preview").forEach((n) => n.remove());
    for (const el of Array.from(box.querySelectorAll(".katex, .katex-display, mjx-container, .MathJax, .MathJax_Display, .mwe-math-element, script[type^='math/tex'], span.math, div.math, .math-display, [data-latex]:not(math), [data-tex]:not(math)"))) {
      if (!box.contains(el)) continue;
      if (el.closest("math")) continue;
      if (el.matches(".katex") && el.closest(".katex-display")) continue;
      const latex = latexFromRendered(el);
      if (!latex) continue;
      const display = el.matches(".katex-display, mjx-container[display='true'], .MathJax_Display, div.math, .math-display, .mwe-math-fallback-image-display, script[type='math/tex; mode=display']");
      const math = scratchDoc.createElement("math");
      math.setAttribute("data-latex", latex);
      math.setAttribute("display", display ? "block" : "inline");
      math.textContent = latex;
      // a MathJax span consumes its following <script> source
      if (el.matches(".MathJax, .MathJax_Display")) {
        let sib = el.nextElementSibling;
        for (let i = 0; sib && i < 2; i++) {
          const next = sib.nextElementSibling;
          if (sib.matches("script[type^='math/tex']")) {
            sib.remove();
            break;
          }
          sib = next;
        }
      }
      el.replaceWith(math);
    }
    if (isBody) return root;
    return box.firstElementChild || box;
  }

  /* Compare Defuddle's version of a block with the original DOM and keep
     the better one: restore blocks Defuddle dropped, and "upgrade" blocks it
     truncated (nested lists, inline math, code line breaks). */
  function restoreDropped(output, original) {
    const candidates = collectBlocks(original);
    if (candidates.length > 2500) return { restored: 0, images: 0, upgraded: 0, skipped: true };
    const outputSquashed = squash(output.textContent);
    const known = new Map();
    const byShort = new Map();
    const knownCode = new Map();
    for (const el of collectBlocks(output)) {
      const fp = fingerprint(el);
      if (fp && !known.has(fp)) known.set(fp, el);
      const sk = shortKey(el);
      if (sk && !byShort.has(sk)) byShort.set(sk, el);
      if (el.tagName.toLowerCase() === "pre") {
        const ck = codeKey(el.textContent);
        if (ck && !knownCode.has(ck)) knownCode.set(ck, el);
      }
    }
    let anchor = null;
    let restored = 0;
    let upgraded = 0;
    const prepared = (el) => {
      let clone;
      const sib = el.nextElementSibling;
      if (el.matches && el.matches(".MathJax, .MathJax_Display, .MathJax_Preview") && sib && sib.matches("script[type^='math/tex']")) {
        const box = scratchDoc.createElement("div");
        box.appendChild(el.cloneNode(true));
        box.appendChild(sib.cloneNode(true));
        const done = normalizeRawFragment(box);
        clone = done.querySelector("math") || done;
      } else clone = normalizeRawFragment(el.cloneNode(true));
      normalizeUrls(clone);
      return clone;
    };
    const swap = (target, el) => {
      const clone = prepared(el);
      target.replaceWith(clone);
      upgraded += 1;
      return clone;
    };
    const usable = (el) => !isNoise(el) && isVisible(el);

    for (const el of candidates) {
      const fp = fingerprint(el);
      const tag = el.tagName.toLowerCase();
      const isCode = tag === "pre" || isCodeContainer(el);
      if (!fp && !isCode && !latexFromRendered(el)) continue;

      if (isCode) {
        const isCs = /colorscripter/.test(el.className || "") || !!el.querySelector(".colorscripter-code-table");
        const mineText = isCs ? colorScripterText(el) : codeText(el);
        if (!mineText.trim()) continue;
        const match = known.get(fp) || knownCode.get(codeKey(mineText)) || byShort.get(shortKey(el));
        if (match) {
          const theirs = match.textContent;
          const mineS = squash(mineText);
          const theirsS = squash(theirs);
          let better;
          if (match.tagName.toLowerCase() !== "pre") better = true; // Defuddle kept code as table/paragraphs
          else if (mineS === theirsS) better = mineText !== theirs; // same chars, better line structure
          else if (theirsS.replace(/\d/g, "") === mineS.replace(/\d/g, "") && mineS.length < theirsS.length) better = true; // theirs keeps gutter digits
          else better = mineS.length > theirsS.length * 1.15; // theirs lost content
          if (better && usable(el)) {
            anchor = swap(match, el);
            known.set(fp, anchor);
          } else anchor = match;
          continue;
        }
      } else {
        const exact = known.get(fp);
        if (exact) {
          if (weight(el) > weight(exact) * 1.15 + 10 && usable(el)) {
            anchor = swap(exact, el);
            known.set(fp, anchor);
          } else anchor = exact;
          continue;
        }
        const near = byShort.get(shortKey(el));
        if (near) {
          const ratio = weight(near) / Math.max(1, weight(el));
          if (ratio >= 0.35 && ratio < 0.87 && usable(el)) {
            anchor = swap(near, el);
            known.set(fp, anchor);
            continue;
          }
          if (ratio >= 0.87 && ratio <= 1.15) {
            anchor = near;
            continue;
          }
        }
        if (fp.length >= 12 && outputSquashed.includes(fp)) {
          anchor = known.get(fp) || anchor;
          continue;
        }
      }

      if (!usable(el) || !isWorthRestoring(el)) continue;
      const clone = prepared(el);
      if (anchor && anchor.parentNode) anchor.insertAdjacentElement("afterend", clone);
      else output.appendChild(clone);
      anchor = clone;
      if (fp) known.set(fp, clone);
      restored += 1;
    }
    const images = restoreImages(output, original);
    return { restored, images, upgraded };
  }

  function restoreImages(output, original) {
    const seen = new Set(Array.from(output.querySelectorAll("img")).map((i) => i.getAttribute("src")).filter(Boolean));
    let count = 0;
    for (const fig of Array.from(output.querySelectorAll("figure"))) {
      if (fig.querySelector("img")) continue;
      const cap = lowerNorm((fig.querySelector("figcaption") || {}).textContent || "");
      if (!cap) continue;
      const match = Array.from(original.querySelectorAll("figure")).find((f) => {
        const c = f.querySelector("figcaption");
        return c && lowerNorm(c.textContent).startsWith(cap.slice(0, 40));
      });
      const img = match && match.querySelector("img");
      if (!img) continue;
      const clone = img.cloneNode(true);
      normalizeUrls(clone.parentNode ? clone : (() => { const d = scratchDoc.createElement("div"); d.appendChild(clone); return d; })());
      const src = clone.getAttribute("src");
      if (!src || seen.has(src) || !isVisible(img)) continue;
      fig.insertBefore(clone, fig.firstChild);
      seen.add(src);
      count += 1;
    }
    for (const img of Array.from(original.querySelectorAll("img"))) {
      const holder = scratchDoc.createElement("div");
      const clone = img.cloneNode(true);
      holder.appendChild(clone);
      normalizeUrls(holder);
      const src = clone.getAttribute("src");
      if (!src || seen.has(src) || isNoise(img) || !isVisible(img)) continue;
      if (img.closest("figure") && output.querySelector(`img[src="${cssEscape(src)}"]`)) continue;
      const w = img.naturalWidth || parseInt(img.getAttribute("width") || "0", 10);
      const h = img.naturalHeight || parseInt(img.getAttribute("height") || "0", 10);
      if ((w && w < 80) || (h && h < 80)) continue; // icons, tracking pixels
      let target = null;
      let probe = img.closest("figure") || img;
      while ((probe = probe.previousElementSibling)) {
        const fp = fingerprint(probe);
        if (!fp) continue;
        target = Array.from(output.querySelectorAll("p, h1, h2, h3, h4, li, figure, pre")).find((o) => fingerprint(o) === fp);
        if (target) break;
      }
      if (target) target.insertAdjacentElement("afterend", clone);
      else output.appendChild(clone);
      seen.add(src);
      count += 1;
    }
    return count;
  }

  const TRAILING_JUNK = new RegExp(
    [
      "저작권자", "무단\\s*전재", "재배포", "AI\\s*학습", "관련\\s*기사", "다른\\s*기사", "기자의?\\s*프로필",
      "프로필\\s*이미지", "구독하기", "공유하기", "댓글", "이전\\s*기사", "다음\\s*기사", "많이\\s*본",
      "추천\\s*기사", "인기\\s*기사", "함께\\s*보면", "이전\\s*글", "다음\\s*글", "좋아요", "태그", "관련\\s*글",
      "all rights reserved", "related (articles|posts|stories)", "read (more|next)", "share this", "subscribe",
      "follow us", "sign up", "more from", "previous article", "next article", "you may also like",
      "recommended for you", "view comments", "leave a comment", "was this (page|article) helpful",
    ].join("|"),
    "i",
  );

  function linkDensity(el) {
    const total = lowerNorm(el.textContent).length || 1;
    let linked = 0;
    for (const a of Array.from(el.querySelectorAll("a"))) linked += lowerNorm(a.textContent).length;
    return linked / total;
  }

  function isTrailingJunk(el) {
    const text = lowerNorm(el.textContent);
    const tag = el.tagName.toLowerCase();
    if (tag === "pre" || tag === "table" || tag === "figure" || el.querySelector("pre, table, img")) return !text && !el.querySelector("img");
    return !!(
      !text ||
      (text.length < 400 && TRAILING_JUNK.test(text)) ||
      (el.querySelectorAll("a").length >= 2 && text.length < 600 && linkDensity(el) > 0.6) ||
      (/^h[1-6]$/.test(tag) && text.length < 40 && TRAILING_JUNK.test(text))
    );
  }

  function pruneTrailing(root) {
    let node = root;
    for (let i = 0; i < 6 && node.children.length === 1 && /^(div|article|section|main)$/i.test(node.children[0].tagName) && node.children[0].children.length > 1; i++) node = node.children[0];
    let removed = 0;
    while (node.lastElementChild) {
      const last = node.lastElementChild;
      if (!isTrailingJunk(last)) break;
      last.remove();
      removed += 1;
      if (removed > 30) break;
    }
    return removed;
  }

  function normalizeUrls(root) {
    root.querySelectorAll("img").forEach((img) => {
      const candidates = [
        img.getAttribute("src"), img.getAttribute("data-src"), img.getAttribute("data-original"),
        img.getAttribute("data-lazy-src"), img.getAttribute("data-lazy"), img.getAttribute("data-actualsrc"),
        img.getAttribute("data-hi-res-src"), img.getAttribute("data-url"), img.getAttribute("data-image"),
      ].filter(Boolean);
      const srcset = img.getAttribute("srcset") || img.getAttribute("data-srcset");
      if (srcset) {
        const best = srcset.split(",").map((s) => s.trim().split(/\s+/)).filter((s) => s[0])
          .sort((a, b) => (parseFloat(b[1]) || 0) - (parseFloat(a[1]) || 0))[0];
        if (best) candidates.unshift(best[0]);
      }
      // Tistory: original lives on the wrapping <span data-url>
      const wrap = img.closest("[data-url]");
      if (wrap && wrap.getAttribute("data-url")) candidates.unshift(wrap.getAttribute("data-url"));
      // a real src beats a placeholder src
      const isPlaceholder = (u) => /^data:|blank\.|placeholder|spacer|1x1|pixel|loading|lazy\.(gif|png|svg)/i.test(u || "");
      const ordered = candidates.filter((u) => !isPlaceholder(u)).concat(candidates.filter(isPlaceholder));
      const chosen = ordered.map(absoluteUrl).find((u) => u && /^https?:/i.test(u));
      if (chosen) img.setAttribute("src", chosen);
      else img.remove();
    });
    root.querySelectorAll("a[href]").forEach((a) => {
      const href = absoluteUrl(a.getAttribute("href"));
      if (href && /^https?:/i.test(href)) a.setAttribute("href", href);
      else a.removeAttribute("href");
    });
  }

  /* ------------------------------------------------------------------ *
   * Site handlers
   * ------------------------------------------------------------------ */

  const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function codePage({ title, subtitle, code, language, url }) {
    const parts = [];
    if (subtitle) parts.push(`<p>${escapeHtml(subtitle)}</p>`);
    parts.push(`<pre><code class="language-${language}">${escapeHtml(code)}</code></pre>`);
    return { title, content: parts.join(""), url, isCode: true };
  }

  function githubBlobInfo() {
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|blame)\/[^/]+\/(.+)$/);
    return m ? { owner: m[1], repo: m[2], path: decodeURIComponent(m[3]) } : null;
  }

  function githubBlobCode(doc) {
    const ta = doc.querySelector('#read-only-cursor-text-area, textarea[data-testid="read-only-cursor-text-area"]');
    if (ta && typeof ta.value === "string" && ta.value.trim()) return { code: ta.value, via: "textarea" };
    for (const s of Array.from(doc.querySelectorAll('script[type="application/json"]'))) {
      if (!/rawLines/.test(s.textContent || "")) continue;
      try {
        const data = JSON.parse(s.textContent);
        const lines = data && data.payload && data.payload.blob && data.payload.blob.rawLines;
        if (Array.isArray(lines) && lines.length) return { code: lines.join("\n"), via: "embedded-json" };
      } catch {}
    }
    const tableLines = Array.from(doc.querySelectorAll("table.highlight tr td.blob-code, table .js-file-line"));
    if (tableLines.length) return { code: tableLines.map((td) => td.textContent.replace(/\n$/, "")).join("\n"), via: "table" };
    const rendered = Array.from(doc.querySelectorAll(".react-code-line-contents, .react-file-line"));
    return rendered.length ? { code: rendered.map((l) => l.textContent).join("\n"), via: "rendered-lines", partial: true } : null;
  }

  function handleGithub(doc) {
    const info = githubBlobInfo();
    if (!info) return null;
    const found = githubBlobCode(doc);
    if (!found || !found.code.trim()) return null;
    const name = info.path.split("/").pop();
    const subtitle = found.partial ? `${info.owner}/${info.repo} · ${info.path} (only the lines GitHub had loaded)` : `${info.owner}/${info.repo} · ${info.path}`;
    return codePage({ title: `${name} · ${info.owner}/${info.repo}`, subtitle, code: found.code, language: languageFromPath(info.path), url: location.href });
  }

  function handleRawPre(doc) {
    const body = doc.body;
    if (!body) return null;
    const kids = Array.from(body.children).filter((c) => !/^(script|style|link)$/i.test(c.tagName));
    if (kids.length !== 1 || kids[0].tagName.toLowerCase() !== "pre") return null;
    const code = kids[0].textContent;
    if (!code.trim()) return null;
    const name = decodeURIComponent(location.pathname.split("/").pop() || location.hostname);
    return codePage({ title: name, subtitle: "", code, language: languageFromPath(location.pathname), url: location.href });
  }

  /* Naver SmartEditor ONE (blog / cafe / post) — runs inside the PostView
     frame when the tab is a Naver page (action 7). */
  function handleNaverSmartEditor(doc) {
    const container = doc.querySelector(".se-main-container");
    if (!container) return null;
    const parts = [];
    const imgHtml = (img, caption) => {
      const h = scratchDoc.createElement("div");
      const c = img.cloneNode(true);
      h.appendChild(c);
      normalizeUrls(h);
      const src = c.getAttribute("src");
      if (!src) return "";
      const alt = escapeHtml(c.getAttribute("alt") || "");
      return caption
        ? `<figure><img src="${escapeHtml(src)}" alt="${alt}"><figcaption>${escapeHtml(caption)}</figcaption></figure>`
        : `<p><img src="${escapeHtml(src)}" alt="${alt}"></p>`;
    };
    const inlineHtml = (el) => {
      const clone = el.cloneNode(true);
      clone.querySelectorAll("script, style").forEach((n) => n.remove());
      // SE ONE bold/italic live in inline styles on spans
      clone.querySelectorAll("span[style]").forEach((s) => {
        const st = s.getAttribute("style") || "";
        if (/font-weight:\s*(bold|[6-9]00)/i.test(st)) s.innerHTML = `<b>${s.innerHTML}</b>`;
        if (/font-style:\s*italic/i.test(st)) s.innerHTML = `<i>${s.innerHTML}</i>`;
        if (/text-decoration[^;]*underline/i.test(st)) s.innerHTML = `<u>${s.innerHTML}</u>`;
      });
      clone.querySelectorAll("b.se-fs-bold, strong").forEach(() => {});
      return clone.innerHTML;
    };

    for (const comp of Array.from(container.querySelectorAll(":scope .se-component"))) {
      const cls = comp.className || "";
      if (/\bse-text\b/.test(cls)) {
        for (const p of Array.from(comp.querySelectorAll(".se-text-paragraph"))) {
          const html = inlineHtml(p);
          if (normText(p.textContent)) parts.push(`<p>${html}</p>`);
        }
      } else if (/\bse-sectionTitle\b/.test(cls)) {
        const t = comp.querySelector(".se-section-title-text, .se-text-paragraph") || comp;
        if (normText(t.textContent)) parts.push(`<h2>${inlineHtml(t)}</h2>`);
      } else if (/\bse-quotation\b/.test(cls)) {
        const q = comp.querySelector(".se-quote") || comp;
        const cite = comp.querySelector(".se-cite");
        parts.push(`<blockquote><p>${inlineHtml(q)}</p>${cite && normText(cite.textContent) ? `<p>— ${inlineHtml(cite)}</p>` : ""}</blockquote>`);
      } else if (/\bse-horizontalLine\b/.test(cls)) {
        parts.push("<hr>");
      } else if (/\bse-code\b/.test(cls)) {
        const src = comp.querySelector(".se-code-source") || comp;
        const text = codeText(src);
        if (text.trim()) parts.push(`<pre><code class="language-${detectLanguage(src)}">${escapeHtml(text)}</code></pre>`);
      } else if (/\bse-imageGroup\b|\bse-imageStrip\b|\bse-image\b/.test(cls)) {
        const items = Array.from(comp.querySelectorAll(".se-imageGroup-item, .se-imageStrip-item, .se-module-image"));
        const scope = items.length ? items : [comp];
        for (const item of scope) {
          const img = item.querySelector("img");
          if (!img) continue;
          const cap = item.querySelector(".se-caption") || comp.querySelector(".se-caption");
          parts.push(imgHtml(img, cap && scope.length === 1 ? normText(cap.textContent) : ""));
        }
      } else if (/\bse-oglink\b/.test(cls)) {
        const a = comp.querySelector("a[href]");
        const title = comp.querySelector(".se-oglink-title");
        const summary = comp.querySelector(".se-oglink-summary");
        if (a) {
          const href = absoluteUrl(a.getAttribute("href"));
          parts.push(`<a data-intact-bookmark="${escapeHtml(normText(title ? title.textContent : a.textContent))}" href="${escapeHtml(href || "")}">${escapeHtml(normText(summary ? summary.textContent : ""))}</a>`);
        }
      } else if (/\bse-table\b/.test(cls)) {
        const table = comp.querySelector("table");
        if (table) {
          const clone = table.cloneNode(true);
          clone.querySelectorAll("[style]").forEach((n) => n.removeAttribute("style"));
          parts.push(clone.outerHTML);
        }
      } else if (/\bse-oembed\b|\bse-video\b/.test(cls)) {
        const iframe = comp.querySelector("iframe[src]");
        const link = comp.querySelector("a[href*='youtu'], a[href*='vimeo'], a[href*='tv.naver'], a[href]");
        const href = iframe ? iframe.getAttribute("src") : link ? link.getAttribute("href") : null;
        if (href) parts.push(`<iframe src="${escapeHtml(absoluteUrl(href) || "")}"></iframe>`);
      } else if (/\bse-file\b/.test(cls)) {
        const a = comp.querySelector("a[href]");
        if (a) parts.push(`<p><a href="${escapeHtml(absoluteUrl(a.getAttribute("href")) || "")}">${escapeHtml(normText(a.textContent) || "첨부파일")}</a></p>`);
      } else if (/\bse-placesMap\b/.test(cls)) {
        const t = comp.querySelector(".se-map-title");
        const addr = comp.querySelector(".se-map-address");
        if (t) parts.push(`<p>📍 ${escapeHtml(normText(t.textContent))}${addr ? ` — ${escapeHtml(normText(addr.textContent))}` : ""}</p>`);
      } else if (/\bse-formula\b/.test(cls)) {
        const img = comp.querySelector("img[alt]");
        const latex = img && img.getAttribute("alt");
        if (latex) parts.push(`<math data-latex="${escapeHtml(latex)}" display="block">${escapeHtml(latex)}</math>`);
      } else if (/\bse-sticker\b|\bse-material\b/.test(cls)) {
        // decorative
      } else if (normText(comp.textContent)) {
        parts.push(`<p>${inlineHtml(comp)}</p>`);
      }
    }
    if (!parts.length) return null;
    const titleEl = doc.querySelector(".se-title-text, .pcol1 .se-title-text, .htitle, .tit_h3");
    const authorEl = doc.querySelector(".nick, .blog_author .nick, .writer, .se-author");
    const dateEl = doc.querySelector(".se_publishDate, .date, .blog_date");
    return {
      title: titleEl ? normText(titleEl.textContent) : doc.title,
      content: parts.join(""),
      url: location.href,
      author: authorEl ? normText(authorEl.textContent) : "",
      published: dateEl ? normText(dateEl.textContent) : "",
      site: "Naver",
      image: (() => {
        const first = container.querySelector(".se-image img, .se-imageGroup img");
        return first ? first.getAttribute("data-lazy-src") || first.getAttribute("src") : "";
      })(),
    };
  }

  const SITE_HANDLERS = [
    { match: () => location.hostname === "github.com", run: handleGithub },
    { match: () => /naver\.com$/.test(location.hostname), run: handleNaverSmartEditor },
    { match: () => true, run: handleRawPre },
  ];

  function runSiteHandlers(doc) {
    for (const h of SITE_HANDLERS) {
      try {
        if (!h.match()) continue;
        const result = h.run(doc);
        if (result) return result;
      } catch {}
    }
    return null;
  }

  /* Tistory & co: make the live DOM tell Defuddle the language and turn
     ColorScripter tables into <pre> on a clone (action 9). */
  function preNormalizeDocument() {
    document.querySelectorAll("pre[data-ke-language]:not([data-lang])").forEach((pre) => {
      pre.setAttribute("data-lang", pre.getAttribute("data-ke-language"));
    });
    const needsClone = Array.from(document.querySelectorAll(".colorscripter-code, .se-code-source, .monaco-editor, .cm-editor")).some((el) => isCodeContainer(el) && !el.querySelector("pre"));
    if (!needsClone) return document;
    const clone = document.cloneNode(true);
    normalizeRawFragment(clone.body);
    return clone;
  }

  /* ------------------------------------------------------------------ *
   * Selection → Defuddle-standardised (action 4)
   * ------------------------------------------------------------------ */

  function selectionHtml() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const holder = document.createElement("div");
    for (let i = 0; i < sel.rangeCount; i++) holder.appendChild(sel.getRangeAt(i).cloneContents());
    return holder.innerHTML.trim() ? holder.innerHTML : null;
  }

  function standardizeFragment(html) {
    const Defuddle = window.__IntactDefuddle;
    const raw = scratchDoc.createElement("div");
    raw.innerHTML = html;
    normalizeRawFragment(raw);
    normalizeUrls(raw);
    const rawText = lowerNorm(raw.textContent);
    if (!Defuddle) return raw.innerHTML;
    try {
      const doc = document.implementation.createHTMLDocument("intact-selection");
      const base = doc.createElement("base");
      base.href = document.baseURI;
      doc.head.appendChild(base);
      const article = doc.createElement("article");
      article.innerHTML = raw.innerHTML;
      doc.body.appendChild(article);
      const result = new Defuddle(doc, { url: location.href, debug: false, separateMarkdown: false }).parse();
      const outText = lowerNorm((result && result.contentText) || "");
      const holder = scratchDoc.createElement("div");
      holder.innerHTML = (result && result.content) || "";
      const kept = lowerNorm(holder.textContent);
      // Defuddle can be over-eager on short selections: keep its output only
      // when it preserved most of the text and every code block.
      const rawCode = raw.querySelectorAll("pre").length;
      const outCode = holder.querySelectorAll("pre").length;
      if (kept.length >= rawText.length * 0.7 && outCode >= rawCode) return holder.innerHTML;
      void outText;
    } catch {}
    return raw.innerHTML;
  }

  /* ------------------------------------------------------------------ *
   * Quality & paywall (action 5)
   * ------------------------------------------------------------------ */

  const PAYWALL_TEXT = /(subscribe|sign in|log ?in|register|become a member)\s+(to|and)\s+(continue|read|keep reading|unlock)|continue reading with|members?[- ]only|for subscribers|this (article|story|content) is (reserved|available) (for|to)|premium content|로그인\s*(후|하시면|이\s*필요)|구독(자|\s*후|\s*하시면|\s*회원)|유료\s*(회원|구독|콘텐츠|기사)|멤버십\s*(전용|가입)|계속\s*읽으려면|전문\s*보기는|남은\s*내용|이어서\s*보시려면/i;
  const PAYWALL_SELECTOR = "[class*='paywall'], [id*='paywall'], [class*='subscribe-wall'], [class*='meter-wall'], [class*='metered-gate'], #gateway-content, [data-testid*='paywall'], .article-locked, .premium-lock, [class*='login-wall'], [class*='regwall'], [class*='piano-'], [id*='piano-']";

  function assessQuality({ extractedText, mainContainer, blocks, usedSelection }) {
    const mainText = mainContainer ? lowerNorm(mainContainer.textContent) : "";
    const ratio = mainText.length ? Math.min(1, extractedText.length / mainText.length) : 1;
    const words = extractedText.split(/\s+/).filter(Boolean).length;
    const hints = [];
    let paywall = false;
    try {
      const bodyText = lowerNorm(document.body ? document.body.innerText || document.body.textContent : "");
      const gate = document.querySelector(PAYWALL_SELECTOR);
      if (gate && isVisible(gate) && lowerNorm(gate.textContent).length > 20 && (PAYWALL_TEXT.test(lowerNorm(gate.textContent)) || words < 400)) paywall = true;
      if (PAYWALL_TEXT.test(bodyText.slice(0, 20000)) && (words < 400 || ratio < 0.5)) paywall = true;
    } catch {}
    const contentBlocks = blocks.filter((b) => b.type !== "divider").length - 1; // minus source header
    const lowContent = !usedSelection && (words < 100 || contentBlocks <= 2);
    const partial = !usedSelection && ratio < 0.35 && mainText.length > 800;
    if (paywall) hints.push("paywall");
    if (lowContent) hints.push("low-content");
    if (partial) hints.push("partial");
    return { words, chars: extractedText.length, ratio: Number(ratio.toFixed(2)), paywall, lowContent, partial, hints };
  }

  /* ------------------------------------------------------------------ *
   * Image bytes for upload (action 8)
   * ------------------------------------------------------------------ */

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async function fetchImageForUpload(url) {
    // Inside the page the request carries the page's Referer, which is what
    // referer-locked CDNs (Naver) require. Cross-origin hosts without CORS
    // still fail here; the background then tries with host permissions.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, { credentials: "omit", signal: controller.signal });
      if (!res.ok) return null;
      const type = res.headers.get("content-type") || "";
      if (!/^image\//i.test(type)) return null;
      const blob = await res.blob();
      if (blob.size > UPLOAD_MAX_BYTES) return { tooLarge: true, bytes: blob.size };
      return { base64: await blobToBase64(blob), mime: type.split(";")[0], bytes: blob.size };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function planUploads(ctx, { fetchImages }) {
    const uploads = [];
    let total = 0;
    let n = 0;
    for (const block of ctx.uploads) {
      const plan = block._intact.image;
      if (!plan.upload) continue;
      if (!fetchImages || n >= UPLOAD_MAX_COUNT || total >= UPLOAD_MAX_TOTAL) {
        plan.deferred = true; // background may still fetch it
        continue;
      }
      const got = await fetchImageForUpload(plan.url);
      if (!got && plan.fallbackUrl !== plan.url) {
        const alt = await fetchImageForUpload(plan.fallbackUrl);
        if (alt && alt.base64) Object.assign(plan, { fetchedFrom: plan.fallbackUrl });
        if (alt) Object.assign(plan, alt);
      } else if (got) Object.assign(plan, got);
      if (plan.base64) {
        n += 1;
        total += plan.bytes;
        const name = (() => {
          try {
            return decodeURIComponent(new URL(plan.url).pathname.split("/").pop() || "image");
          } catch {
            return "image";
          }
        })();
        plan.filename = /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${name}.${(plan.mime.split("/")[1] || "png").replace("jpeg", "jpg")}`;
        uploads.push({ url: plan.url, bytes: plan.bytes });
      } else plan.deferred = true;
    }
    return uploads;
  }

  /* ------------------------------------------------------------------ *
   * Main
   * ------------------------------------------------------------------ */

  function frameInfo() {
    let isTop = true;
    try {
      isTop = window.top === window;
    } catch {
      isTop = false;
    }
    return { isTop, frameUrl: location.href, hostname: location.hostname };
  }

  async function extract(opts = {}) {
    const info = frameInfo();
    const bodyLen = document.body ? document.body.textContent.length : 0;
    const widgetHost = /(^|\.)(disqus\.com|facebook\.com|twitter\.com|x\.com|youtube\.com|google\.com|doubleclick\.net|googlesyndication\.com|adnxs\.com|criteo\.com|taboola\.com|outbrain\.com|recaptcha\.net|kakao\.com|instagram\.com)$/i.test(location.hostname);
    const wantsFrame = !info.isTop && !widgetHost && (document.querySelector(".se-main-container, #postViewArea, .post-view, .ArticleContentBox") || bodyLen > 800);
    if (!info.isTop && !wantsFrame) return { ok: false, skipped: true, ...info };

    const mode = opts.mode || "article";
    const ctx = { uploads: [] };
    const Defuddle = window.__IntactDefuddle;

    if (mode === "bookmark") {
      const meta = pageMeta();
      const blocks = [...sourceHeader({ url: location.href, site: meta.site, author: meta.author, published: meta.published })];
      const bm = bookmarkBlock(location.href, meta.title);
      if (bm) blocks.push(bm);
      if (meta.description) blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: [textRun(meta.description.slice(0, NOTION.TEXT_MAX))] } });
      return { ok: true, ...info, mode, blocks, blockCount: blocks.length, ...meta, url: location.href, usedSelection: false, quality: { hints: [] }, uploads: [] };
    }

    let result;
    let repairs = { restored: 0, images: 0, pruned: 0 };
    let usedSelection = false;
    let via = "defuddle";
    const holder = document.createElement("div");
    let mainContainer = null;

    const selection = opts.useSelection ? selectionHtml() : null;
    const site = selection ? null : runSiteHandlers(document);

    if (site) {
      via = "site-handler";
      result = { content: site.content, title: site.title, description: "", author: site.author || "", published: site.published || "", site: site.site || location.hostname, image: site.image || "", favicon: "" };
      holder.innerHTML = site.content;
      normalizeUrls(holder);
    } else if (selection) {
      via = "selection";
      usedSelection = true;
      result = { content: selection, title: document.title, description: "", author: "", published: "", site: location.hostname, image: "", favicon: "" };
      holder.innerHTML = standardizeFragment(selection);
    } else {
      mainContainer = findMainContainer(document);
      const original = mainContainer.cloneNode(true);
      const doc = preNormalizeDocument();
      const options = { url: location.href, debug: false, separateMarkdown: false };
      if (Defuddle) {
        result = await Promise.race([
          new Defuddle(doc, options).parseAsync(),
          new Promise((r) => setTimeout(() => r(null), 8000)),
        ]).catch(() => null);
        if (!result || !result.content) {
          try {
            result = new Defuddle(doc, options).parse();
          } catch {
            result = null;
          }
        }
      }
      if (!result || !result.content) {
        via = "fallback-main";
        result = { content: normalizeRawFragment(original.cloneNode(true)).innerHTML, title: document.title, description: "", author: "", published: "", site: location.hostname, image: "", favicon: "" };
      }
      holder.innerHTML = result.content || "";
      normalizeUrls(holder);
      try {
        repairs = restoreDropped(holder, original);
      } catch (e) {
        repairs = { restored: 0, images: 0, error: String(e && e.message) };
      }
      try {
        repairs.pruned = pruneTrailing(holder);
      } catch {
        repairs.pruned = 0;
      }
    }

    const extractedText = normText(holder.textContent);
    const meta = {
      url: location.href,
      site: result.site || location.hostname,
      author: result.author || "",
      published: result.published || "",
    };
    const blocks = [...sourceHeader(meta), ...htmlToBlocks(holder.innerHTML, ctx)];
    const uploads = await planUploads(ctx, { fetchImages: opts.fetchImages !== false });
    const quality = assessQuality({ extractedText, mainContainer, blocks, usedSelection });

    return {
      ok: true,
      ...info,
      mode,
      via,
      ...(opts.debug ? { debugHtml: holder.innerHTML.slice(0, 400000), repairs } : {}),
      blocks,
      blockCount: blocks.length,
      restoredBlocks: (repairs.restored || 0) + (repairs.images || 0),
      url: location.href,
      title: (result.title || document.title || location.href).slice(0, 1800),
      description: result.description || "",
      author: meta.author,
      published: meta.published,
      site: meta.site,
      favicon: result.favicon ? absoluteUrl(result.favicon) : pageMeta().favicon,
      image: result.image ? absoluteUrl(result.image) : pageMeta().image,
      wordCount: quality.words,
      charCount: quality.chars,
      usedSelection,
      quality,
      uploads,
    };
  }

  function pageMeta() {
    const q = (sel) => {
      const el = document.querySelector(sel);
      return el ? (el.getAttribute("content") || el.getAttribute("href") || "").trim() : "";
    };
    return {
      title: (q('meta[property="og:title"]') || document.title || location.href).slice(0, 1800),
      description: q('meta[property="og:description"]') || q('meta[name="description"]'),
      site: q('meta[property="og:site_name"]') || location.hostname,
      author: q('meta[name="author"]') || q('meta[property="article:author"]'),
      published: q('meta[property="article:published_time"]'),
      image: absoluteUrl(q('meta[property="og:image"]') || q('meta[name="twitter:image"]')) || null,
      favicon: absoluteUrl(q('link[rel~="icon"]') || "/favicon.ico"),
    };
  }

  window.__intactExtract = async (opts) => {
    try {
      return await extract(opts || {});
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error), ...frameInfo() };
    }
  };

  // exposed for the test runner
  window.__intactInternals = { htmlToBlocks, codeText, detectLanguage, notionLanguage, classifyImageUrl, normalizeRawFragment, standardizeFragment, colorScripterText, pruneTrailing, assessQuality, handleNaverSmartEditor };
})();
