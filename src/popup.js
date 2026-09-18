const $ = (id) => document.getElementById(id);

const state = {
  tabId: null,
  tabUrl: "",
  hasDestinations: false,
  destinations: { dataSources: [], pages: [] },
  schema: null,
  preview: null,
  pending: null,
};

function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response) {
        reject(new Error("The extension did not respond. Reload the page and try again."));
        return;
      }
      if (!response.ok) {
        const error = new Error(response.error);
        error.needsReauth = response.needsReauth;
        error.needsShare = response.needsShare;
        error.partial = response.partial;
        reject(error);
        return;
      }
      resolve(response.data);
    });
  });
}

function withTimeout(promise, ms, message) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}

function show(view) {
  $("view-connect").hidden = view !== "connect";
  $("view-clip").hidden = view !== "clip";
}

function setError(el, message) {
  const node = $(el);
  node.textContent = message || "";
  node.hidden = !message;
}

const mode = () => $("mode").value;

/* ---------------------------------------------------------------- *
 * Connect
 * ---------------------------------------------------------------- */

$("connect").addEventListener("click", async () => {
  setError("connect-error", "");
  $("connect").disabled = true;
  $("connect").textContent = "Waiting for Notion…";
  try {
    await send("connect");
    await start();
  } catch (error) {
    setError("connect-error", error.message);
  } finally {
    $("connect").disabled = false;
    $("connect").textContent = "Connect Notion";
  }
});

$("connect-token").addEventListener("click", async () => {
  setError("connect-error", "");
  try {
    await send("connectWithToken", { token: $("token").value });
    await start();
  } catch (error) {
    setError("connect-error", error.message);
  }
});

$("disconnect").addEventListener("click", async () => {
  await send("disconnect");
  await start();
});

/* ---------------------------------------------------------------- *
 * Destinations and properties
 * ---------------------------------------------------------------- */

function renderDestinations(last) {
  const select = $("destination");
  select.innerHTML = "";
  const add = (group, items, kind) => {
    if (!items.length) return;
    const optgroup = document.createElement("optgroup");
    optgroup.label = group;
    for (const item of items) {
      const option = document.createElement("option");
      option.value = `${kind}:${item.id}`;
      option.textContent = item.title;
      optgroup.appendChild(option);
    }
    select.appendChild(optgroup);
  };
  add("Databases", state.destinations.dataSources, "data_source");
  add("Pages", state.destinations.pages, "page");

  if (!select.options.length) {
    const option = document.createElement("option");
    option.textContent = "No Notion pages shared yet";
    option.value = "";
    select.appendChild(option);
    state.hasDestinations = false;
    setError("clip-error", "No Notion page has been shared with this integration yet. Open the page you want to save into, click the ••• menu at the top right, choose Connections, and add it. Then reopen Intact.");
    $("clip").disabled = true;
    return;
  }
  state.hasDestinations = true;
  if (last) {
    const key = `${last.kind}:${last.id}`;
    if ([...select.options].some((o) => o.value === key)) select.value = key;
  }
}

function currentDestination() {
  const value = $("destination").value;
  if (!value) return null;
  const [kind, id] = value.split(/:(.+)/);
  return { kind, id };
}

const SUPPORTED_FIELDS = new Set(["rich_text", "url", "select", "multi_select", "status", "date", "checkbox", "number"]);

async function renderProperties() {
  const holder = $("properties");
  holder.innerHTML = "";
  state.schema = null;
  const destination = currentDestination();
  if (!destination || destination.kind !== "data_source") return;
  let schema;
  try {
    schema = await send("schema", { id: destination.id });
  } catch (error) {
    setError("clip-error", error.message);
    return;
  }
  state.schema = schema;
  for (const field of schema.fields) {
    if (!SUPPORTED_FIELDS.has(field.type)) continue;
    const label = document.createElement("label");
    label.className = field.type === "checkbox" ? "checkbox" : "field";
    const name = document.createElement("span");
    name.textContent = field.name;
    let input;
    if (field.type === "select" || field.type === "status") {
      input = document.createElement("select");
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "—";
      input.appendChild(blank);
      for (const option of field.options) {
        const el = document.createElement("option");
        el.value = option.name;
        el.textContent = option.name;
        input.appendChild(el);
      }
    } else if (field.type === "checkbox") {
      input = document.createElement("input");
      input.type = "checkbox";
    } else if (field.type === "number") {
      input = document.createElement("input");
      input.type = "number";
    } else if (field.type === "date") {
      input = document.createElement("input");
      input.type = "date";
    } else {
      input = document.createElement("input");
      input.type = "text";
      if (field.type === "multi_select") input.placeholder = "comma separated";
    }
    input.id = `prop-${field.name.replace(/\W+/g, "-")}`;
    input.dataset.field = field.name;
    input.dataset.type = field.type;
    if (state.preview) {
      if (field.type === "url" && /url|link|source/i.test(field.name)) input.value = state.preview.url;
      if (field.type === "date" && /date|saved|clipped|created/i.test(field.name)) input.value = new Date().toISOString().slice(0, 10);
      if (field.type === "rich_text" && /author|by/i.test(field.name) && state.preview.author) input.value = state.preview.author;
      if (field.type === "rich_text" && /site|source|domain/i.test(field.name) && state.preview.site) input.value = state.preview.site;
    }
    if (field.type === "checkbox") label.append(input, name);
    else label.append(name, input);
    holder.appendChild(label);
  }
}

function collectValues() {
  const values = {};
  for (const input of $("properties").querySelectorAll("[data-field]")) {
    const field = input.dataset.field;
    if (input.type === "checkbox") values[field] = input.checked;
    else if (input.value !== "") values[field] = input.value;
  }
  return values;
}

/* ---------------------------------------------------------------- *
 * Preview, quality hints (action 5)
 * ---------------------------------------------------------------- */

function renderQuality(preview) {
  const box = $("quality");
  const q = preview.quality || {};
  const hints = q.hints || [];
  if (!hints.length || preview.mode === "bookmark") {
    box.hidden = true;
    return;
  }
  const lines = [];
  if (hints.includes("paywall")) lines.push("This page looks paywalled or login-gated, so the saved article may be cut short.");
  if (hints.includes("low-content")) lines.push(`Only ${preview.wordCount || 0} words were found. The article may not have been detected.`);
  if (hints.includes("partial")) lines.push(`Only about ${Math.round((q.ratio || 0) * 100)}% of the page text was captured.`);
  lines.push("Try selecting the text you want and choosing \"Only the text I selected\", or fall back to a bookmark or screenshot.");
  $("quality-text").textContent = lines.join(" ");
  box.hidden = false;
}

async function loadPreview() {
  const m = mode();
  $("summary").textContent = m === "screenshot" ? "A screenshot of the visible part of the page will be saved." : "Reading page…";
  $("clip").disabled = true;
  $("quality").hidden = true;
  if (m === "screenshot") {
    $("clip").disabled = !state.hasDestinations;
    return;
  }
  try {
    const preview = await withTimeout(
      send("preview", { tabId: state.tabId, useSelection: m === "selection", mode: m === "bookmark" ? "bookmark" : "article" }),
      25000,
      "This page took too long to read. Reload the tab and try again.",
    );
    state.preview = preview;
    if (!$("title").value || !$("title").dataset.edited) $("title").value = preview.title;
    const words = preview.wordCount ? `${preview.wordCount.toLocaleString()} words` : "no text found";
    const via = preview.usedSelection ? "selection" : preview.via === "site-handler" ? "site rules" : m === "bookmark" ? "bookmark" : "article";
    const frame = preview.frameUrl && preview.frameUrl !== preview.url ? " · from embedded frame" : "";
    const uploads = preview.uploadsPlanned ? ` · ${preview.uploadsPlanned} image${preview.uploadsPlanned > 1 ? "s" : ""} to copy` : "";
    $("summary").textContent = m === "bookmark" ? `bookmark · ${preview.blockCount} blocks` : `${words} · ${preview.blockCount} blocks · ${via}${frame}${uploads}`;
    $("clip").disabled = preview.blockCount === 0 || !state.hasDestinations;
    if (state.hasDestinations) setError("clip-error", "");
    if (m === "selection" && !preview.usedSelection) {
      setError("clip-error", "Nothing is selected on the page. Select some text first, then reopen Intact.");
      $("clip").disabled = true;
    }
    renderQuality(preview);
  } catch (error) {
    state.preview = null;
    $("summary").textContent = "";
    setError("clip-error", error.message);
  }
}

$("mode").addEventListener("change", loadPreview);
$("title").addEventListener("input", () => {
  $("title").dataset.edited = "1";
});
$("destination").addEventListener("change", renderProperties);
$("quality-selection").addEventListener("click", () => {
  $("mode").value = "selection";
  loadPreview();
});
$("quality-bookmark").addEventListener("click", () => {
  $("mode").value = "bookmark";
  loadPreview();
});
$("quality-screenshot").addEventListener("click", () => {
  $("mode").value = "screenshot";
  loadPreview();
});

/* ---------------------------------------------------------------- *
 * Clip, resume, summary badge (actions 1, 3, 14)
 * ---------------------------------------------------------------- */

function renderResult(result) {
  $("open-page").href = result.url;
  $("clip-done").hidden = false;
  $("summary").textContent = `${result.blocksWritten} of ${result.blockCount} blocks saved`;
  const s = result.summary;
  if (s) {
    const bits = [`${s.total} blocks`];
    if (s.image) bits.push(`${s.image} image${s.image > 1 ? "s" : ""}`);
    if (s.code) bits.push(`${s.code} code`);
    if (s.table) bits.push(`${s.table} table${s.table > 1 ? "s" : ""}`);
    if (s.equation) bits.push(`${s.equation} equation${s.equation > 1 ? "s" : ""}`);
    if (s.uploaded) bits.push(`${s.uploaded} copied`);
    if (s.degraded) bits.push(`${s.degraded} simplified`);
    if (s.dropped) bits.push(`${s.dropped} dropped`);
    $("clip-badge").textContent = bits.join(" · ");
    $("clip-badge").hidden = false;
  }
  const log = (result.log || []).filter((l) => l.action !== "uploaded" && l.action !== "external-unverified");
  if (log.length) {
    $("degraded-list").innerHTML = "";
    for (const entry of log.slice(0, 20)) {
      const li = document.createElement("li");
      li.textContent = `${entry.type} → ${entry.action}${entry.url ? ` (${entry.url.slice(0, 60)}…)` : ""}${entry.reason ? ` — ${String(entry.reason).slice(0, 90)}` : ""}`;
      $("degraded-list").appendChild(li);
    }
    $("degraded-summary").textContent = `${log.length} block${log.length > 1 ? "s" : ""} simplified or dropped`;
    $("degraded").hidden = false;
  } else $("degraded").hidden = true;
}

function showPartial(partial) {
  if (!partial) return;
  $("partial-open").href = partial.pageUrl;
  $("clip-partial").hidden = false;
}

$("clip").addEventListener("click", async () => {
  const destination = currentDestination();
  if (!destination) {
    setError("clip-error", "Pick a database or page first.");
    return;
  }
  setError("clip-error", "");
  $("clip-done").hidden = true;
  $("clip-badge").hidden = true;
  $("clip-partial").hidden = true;
  $("degraded").hidden = true;
  $("clip").disabled = true;
  $("clip").textContent = "Saving…";
  try {
    const m = mode();
    const payload = { tabId: state.tabId, destination, values: collectValues(), title: $("title").value };
    const result = m === "screenshot"
      ? await send("screenshot", payload)
      : await send("clip", { ...payload, useSelection: m === "selection", includeCover: $("include-cover").checked, mode: m === "bookmark" ? "bookmark" : "article" });
    renderResult(result);
    await refreshPending();
  } catch (error) {
    setError("clip-error", error.message);
    showPartial(error.partial);
    await refreshPending();
    if (error.needsReauth) await start();
  } finally {
    $("clip").disabled = false;
    $("clip").textContent = "Save to Notion";
  }
});

async function resume() {
  setError("clip-error", "");
  $("clip-partial").hidden = true;
  $("resume").disabled = true;
  $("summary").textContent = "Resuming…";
  try {
    const result = await send("resume");
    renderResult(result);
  } catch (error) {
    setError("clip-error", error.message);
    showPartial(error.partial);
  } finally {
    $("resume").disabled = false;
    await refreshPending();
  }
}
$("resume").addEventListener("click", resume);
$("partial-resume").addEventListener("click", resume);
$("discard").addEventListener("click", async () => {
  await send("discardPending");
  await refreshPending();
});

async function refreshPending() {
  const status = await send("status");
  state.pending = status.pending;
  const p = status.pending;
  if (!p) {
    $("pending").hidden = true;
    return;
  }
  $("pending-text").textContent = `${p.written} of ${p.total} blocks of “${(p.title || "").slice(0, 40)}” were saved.`;
  $("pending-open").href = p.pageUrl;
  $("pending").hidden = false;
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "clip:progress") return;
  if (message.phase === "reading") $("summary").textContent = "Reading page…";
  else if (message.phase === "uploading") $("summary").textContent = message.uploads ? `Copying images ${message.uploaded || 0} of ${message.uploads}…` : "Preparing…";
  else $("summary").textContent = `Saving ${message.written} of ${message.total} blocks…${message.degraded ? ` (${message.degraded} simplified)` : ""}`;
});

/* ---------------------------------------------------------------- *
 * Report (action 13)
 * ---------------------------------------------------------------- */

$("report").addEventListener("click", async () => {
  $("report-panel").hidden = false;
  $("report-json").value = "Collecting diagnostics…";
  try {
    const { bundle, issueUrl } = await send("report", { tabId: state.tabId, useSelection: mode() === "selection" });
    $("report-json").value = JSON.stringify(bundle, null, 2);
    $("report-issue").href = issueUrl;
  } catch (error) {
    $("report-json").value = `Could not collect diagnostics: ${error.message}`;
  }
});
$("report-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("report-json").value);
    $("report-copy").textContent = "Copied";
    setTimeout(() => ($("report-copy").textContent = "Copy"), 1500);
  } catch {
    $("report-json").select();
  }
});
$("report-close").addEventListener("click", () => {
  $("report-panel").hidden = true;
});

/* ---------------------------------------------------------------- *
 * Boot
 * ---------------------------------------------------------------- */

async function start() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab ? tab.id : null;
  state.tabUrl = tab ? tab.url || "" : "";

  const status = await send("status");
  if (!status.connected) {
    show("connect");
    if (!status.oauthReady) {
      $("connect").hidden = true;
      $("oauth-note").hidden = true;
      $("dev-auth").open = true;
      $("dev-note").hidden = false;
    }
    return;
  }

  show("clip");
  $("workspace").textContent = status.workspace || "Notion";
  state.pending = status.pending;
  if (status.pending) {
    $("pending-text").textContent = `${status.pending.written} of ${status.pending.total} blocks of “${(status.pending.title || "").slice(0, 40)}” were saved.`;
    $("pending-open").href = status.pending.pageUrl;
    $("pending").hidden = false;
  } else $("pending").hidden = true;

  try {
    state.destinations = await send("destinations");
    renderDestinations(status.lastDestination);
    await renderProperties();
  } catch (error) {
    setError("clip-error", error.message);
  }

  if (!state.tabId || !/^https?:/i.test(state.tabUrl)) {
    $("summary").textContent = "Open a normal web page to clip it.";
    $("clip").disabled = true;
    return;
  }
  loadPreview();
}

start().catch((error) => {
  show("connect");
  setError("connect-error", error.message);
});
