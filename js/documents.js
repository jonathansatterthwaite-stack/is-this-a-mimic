// Documents: letters, books, maps... written in Markdown, read in a
// full-screen reader, with uploaded images (e.g. maps).
//
// Images are not stored inside items. Markdown refers to them as
// ![caption](img:ID); the pixels live in IndexedDB on each device and, in a
// party, on the host (so traded documents still show their maps).

const IMG_REF = /\(img:([a-z0-9]{6,40})\)/g;
const MAX_IMAGE_SIDE = 2048;
const KEEP_ORIGINAL_BYTES = 400 * 1024;

// ------------------------------------------------------------------ image store (IndexedDB)

const imageStore = {
  dbPromise: null,
  memory: FRESH_TEST ? new Map() : null, // the fresh-start test's pictures (see FRESH_TEST)

  db() {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open("mimic", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("images", { keyPath: "id" });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.dbPromise;
  },

  async put(id, data) {
    if (this.memory) { this.memory.set(id, data); return; }
    if (kv.remote) {
      const res = await fetch("api/local/images", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, data }) });
      if (!res.ok) throw new Error("Couldn't save the image");
      return;
    }
    const db = await this.db();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("images", "readwrite");
      tx.objectStore("images").put({ id, data });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  },

  async get(id) {
    if (this.memory) return this.memory.get(id) || null;
    if (kv.remote) {
      try {
        const res = await fetch("api/local/images/" + id);
        return res.ok ? await blobToDataUrl(await res.blob()) : null;
      } catch {
        return null;
      }
    }
    try {
      const db = await this.db();
      return await new Promise((resolve, reject) => {
        const req = db.transaction("images").objectStore("images").get(id);
        req.onsuccess = () => resolve(req.result ? req.result.data : null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  },

  // Every picture saved on this device: [{ id, bytes }].
  async list() {
    if (this.memory) return [...this.memory].map(([id, data]) => ({ id, bytes: Math.round(data.length * 0.75) }));
    if (kv.remote) {
      try {
        const res = await fetch("api/local/images", { cache: "no-store" });
        return res.ok ? (await res.json()).images || [] : [];
      } catch {
        return [];
      }
    }
    try {
      const db = await this.db();
      const all = await new Promise((resolve, reject) => {
        const req = db.transaction("images").objectStore("images").getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      return all.map(({ id, data }) => ({ id, bytes: Math.round((data || "").length * 0.75) }));
    } catch {
      return [];
    }
  },

  async remove(id) {
    imageSrcCache.delete(id);
    if (this.memory) { this.memory.delete(id); return; }
    if (kv.remote) {
      await fetch("api/local/images/" + id, { method: "DELETE" });
      return;
    }
    const db = await this.db();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("images", "readwrite");
      tx.objectStore("images").delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  },

  // A src for an image: this device's copy, else the party host's.
  async src(id) {
    const local = await this.get(id);
    if (local) return local;
    if (!party.active) return null;
    try {
      const res = await fetch(party.url("api/images/" + id));
      if (!res.ok) return null;
      const data = await blobToDataUrl(await res.blob());
      this.put(id, data).catch(() => {}); // keep a copy for next time
      return data;
    } catch {
      return null;
    }
  },
};

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Shrink big photos so maps stay quick to load and sync; small images are kept as-is.
async function processImageFile(file) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("Use a PNG, JPEG, WebP or GIF image");
  const original = await blobToDataUrl(file);
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("That image couldn't be read"));
    i.src = original;
  });
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  if (scale === 1 && file.size <= KEEP_ORIGINAL_BYTES) return original;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // JPEG has no transparency
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

function newImageId() {
  return "i" + uid().replace(/[^a-z0-9]/g, "");
}

async function addImageFile(file) {
  const data = await processImageFile(file);
  const id = newImageId();
  await imageStore.put(id, data);
  if (party.active) party.uploadImage(id, data).catch(() => {}); // retried on the next save
  return id;
}

// Image ids referenced by an item's text.
function docImageRefs(item) {
  const ids = new Set();
  for (const text of [item.body, item.description]) {
    if (typeof text === "string") for (const m of text.matchAll(IMG_REF)) ids.add(m[1]);
  }
  // An item's own picture, and a set's pieces' pictures (exports and the party host get them too).
  if (typeof item.image === "string") ids.add(item.image);
  for (const p of Array.isArray(item.deckCards) ? item.deckCards : []) if (typeof p?.image === "string") ids.add(p.image);
  return ids;
}

// Pick image files (one, or several at once); onFiles gets the File list.
function pickImageFiles(multiple, onFiles) {
  const input = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", multiple, hidden: true,
    onchange: () => { const files = [...input.files]; input.remove(); if (files.length) onFiles(files); } });
  document.body.append(input);
  input.click();
}

// A picture's caption from its file name ("Map of Phandalin.png" -> "Map of Phandalin").
const imageCaption = file => file.name.replace(/\.[^.]+$/, "").replace(/[\[\]]/g, "");

// Stored image srcs already looked up (so re-rendered lists show them straight away).
const imageSrcCache = new Map();

// An <img> for a stored image, filled in when it's loaded. onMissing: when this device doesn't have it.
function storedImage(id, cls = "", onMissing = null) {
  const img = h("img", { class: cls, alt: "", draggable: "false" });
  const cached = imageSrcCache.get(id);
  if (cached) img.src = cached;
  else imageStore.src(id).then(src => {
    if (src) { imageSrcCache.set(id, src); img.src = src; } else onMissing?.(img);
  });
  return img;
}

// Every image referenced anywhere in some characters / custom items (and other image ids, e.g. GM controls').
function allImageRefs(characters, customItems = [], more = []) {
  const ids = new Set(more.filter(Boolean));
  for (const c of characters) for (const e of c.items || []) for (const id of docImageRefs(e.item)) ids.add(id);
  for (const i of customItems) for (const id of docImageRefs(i)) ids.add(id);
  return ids;
}

// For exports: { id: dataUrl } of the images the data refers to.
async function bundleImages(ids) {
  const out = {};
  for (const id of ids) {
    const data = await imageStore.src(id);
    if (data) out[id] = data;
  }
  return out;
}

async function storeBundledImages(images) {
  for (const [id, data] of Object.entries(images || {})) {
    if (/^[a-z0-9]{6,40}$/.test(id) && /^data:image\//.test(data)) await imageStore.put(id, data);
  }
}

// ------------------------------------------------------------------ Markdown

function wordCount(text) {
  return (text || "").replace(IMG_REF, "").split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
}

// Markdown -> sanitized DOM. Images become placeholders that load asynchronously.
function renderMarkdown(text) {
  const renderer = new marked.Renderer();
  renderer.image = (href, title, alt) => {
    const m = /^img:([a-z0-9]{6,40})$/.exec(href || "");
    const cap = alt ? `<figcaption>${escapeHtml(alt)}</figcaption>` : "";
    if (m) return `<figure class="doc-figure"><img data-img="${m[1]}" alt="${escapeHtml(alt || "")}">${cap}</figure>`;
    return ""; // only this app's own images; no remote images
  };
  const html = marked.parse(text || "", { renderer, gfm: true, breaks: true });
  const clean = DOMPurify.sanitize(html, { ADD_ATTR: ["target"], FORBID_TAGS: ["style", "form", "input", "button"] });
  const box = document.createElement("div");
  box.className = "doc-body";
  box.innerHTML = clean;
  // Only images uploaded to the app: raw <img> tags could load (and track) from other servers.
  for (const img of box.querySelectorAll("img:not([data-img]), picture, video, audio, iframe, object, embed")) img.remove();
  for (const a of box.querySelectorAll("a[href]")) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  for (const img of box.querySelectorAll("img[data-img]")) {
    img.classList.add("loading");
    imageStore.src(img.dataset.img).then(src => {
      img.classList.remove("loading");
      if (src) {
        img.src = src;
        img.addEventListener("click", () => openImageViewer(src, img.alt));
      } else {
        img.replaceWith(h("div", { class: "img-missing" }, "Image not available on this device"));
      }
    });
  }
  return box;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ------------------------------------------------------------------ reader

// "![caption](img:id)" references in a document, in order.
function docPictures(item) {
  return [...(item.body || "").matchAll(/!\[([^\]]*)\]\(img:([a-z0-9]{6,40})\)/g)].map(m => ({ raw: m[0], caption: m[1], id: m[2] }));
}

// opts.onEdit: open the editor for this document (when the reader may edit it).
function openReader(item, opts = {}) {
  if (item.imageOnly) return openPictureReader(item, opts);
  const size = () => Math.max(14, Math.min(28, +readPref("mimic-reader-size", "19") || 19));
  const page = h("article", { class: "doc-page" });
  const draw = () => {
    page.style.fontSize = size() + "px";
    setChildren(page,
      h("header", { class: "doc-head" },
        itemIcon(item, "doc-icon"),
        h("h1", null, item.name),
        (item.category || item.author) && h("p", { class: "doc-meta" },
          [item.category, item.author && `by ${item.author}`].filter(Boolean).join(" · "))),
      item.body ? renderMarkdown(item.body) : h("p", { class: "muted" }, "This document is blank."));
  };
  const setSize = d => { writePref("mimic-reader-size", String(size() + d)); draw(); };
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); document.body.classList.toggle("modal-open", !!document.getElementById("modal-root").children.length); };
  const onKey = e => { if (e.key === "Escape" && !document.querySelector(".img-viewer")) close(); };
  const overlay = h("div", { class: "reader", role: "dialog", "aria-modal": "true", "aria-label": item.name },
    h("div", { class: "reader-bar" },
      iconBtn("x", "Close", close),
      h("span", { class: "reader-title" }, item.name),
      h("button", { class: "btn", title: "Smaller text", "aria-label": "Smaller text", onclick: () => setSize(-1) }, "A−"),
      h("button", { class: "btn", title: "Larger text", "aria-label": "Larger text", onclick: () => setSize(1) }, "A+"),
      opts.onEdit && h("button", { class: "btn", onclick: () => { close(); opts.onEdit(); } }, icon("edit"), h("span", { class: "hide-sm" }, "Edit"))),
    h("div", { class: "reader-scroll" }, page));
  draw();
  document.body.append(overlay);
  document.body.classList.add("modal-open");
  document.addEventListener("keydown", onKey);
}

// Full-size image with zoom (tap to toggle fit / actual size; pinch zoom on phones).
function openImageViewer(src, alt) {
  let fit = true;
  const img = h("img", { src, alt: alt || "", onclick: () => { fit = !fit; img.classList.toggle("actual", !fit); } });
  const close = () => { viewer.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  const viewer = h("div", { class: "img-viewer", role: "dialog", "aria-label": alt || "Image" },
    h("div", { class: "img-viewer-bar" }, h("span", null, alt || ""), h("span", { class: "muted small" }, "Tap image to zoom"), iconBtn("x", "Close", close)),
    h("div", { class: "img-viewer-scroll" }, img));
  document.body.append(viewer);
  document.addEventListener("keydown", onKey, true);
}

// Image-only documents (maps, handouts): the picture fills the screen on a dark backdrop.
// Fit to screen by default; zoom with the buttons, the mouse wheel, a double-click or a pinch;
// drag (or scroll) to look around. Several pictures page with the arrows.
function openPictureReader(item, opts = {}) {
  const pics = docPictures(item);
  let index = 0, zoom = 0; // 0 = fit to screen, otherwise a multiple of the image's own size
  const img = h("img", { class: "pic", alt: "", draggable: "false" });
  const stage = h("div", { class: "pic-stage" }, img);
  const caption = h("div", { class: "pic-caption" });
  const counter = h("span", { class: "pic-count" });
  const zoomLabel = h("span", { class: "pic-zoom" });

  const fitScale = () => img.naturalWidth ? Math.min(stage.clientWidth / img.naturalWidth, stage.clientHeight / img.naturalHeight, 1) : 1;
  const apply = (keepX = 0.5, keepY = 0.5) => {
    // Keep the point under (keepX, keepY) of the view where it is while zooming.
    const fx = (stage.scrollLeft + stage.clientWidth * keepX) / (stage.scrollWidth || 1);
    const fy = (stage.scrollTop + stage.clientHeight * keepY) / (stage.scrollHeight || 1);
    stage.classList.toggle("fit", !zoom);
    img.style.width = zoom ? Math.round(img.naturalWidth * zoom) + "px" : "";
    zoomLabel.textContent = Math.round((zoom || fitScale()) * 100) + "%";
    if (zoom) {
      stage.scrollLeft = fx * stage.scrollWidth - stage.clientWidth * keepX;
      stage.scrollTop = fy * stage.scrollHeight - stage.clientHeight * keepY;
    }
  };
  const setZoom = (z, x, y) => { zoom = z && Math.max(fitScale(), Math.min(8, z)); if (zoom && zoom <= fitScale() + 0.001) zoom = 0; apply(x, y); };
  const zoomBy = (f, x, y) => setZoom((zoom || fitScale()) * f, x, y);

  const show = i => {
    index = (i + pics.length) % pics.length;
    const p = pics[index];
    zoom = 0;
    img.removeAttribute("src");
    img.alt = p.caption;
    caption.textContent = p.caption;
    caption.hidden = !p.caption;
    counter.textContent = pics.length > 1 ? `${index + 1} / ${pics.length}` : "";
    imageStore.src(p.id).then(src => {
      if (src) { img.src = src; img.onload = () => apply(); }
      else caption.textContent = "Image not available on this device";
    });
  };

  // Mouse: drag to pan. Two fingers: pinch to zoom (one finger pans by scrolling).
  const pointers = new Map();
  let drag = null, pinch = null;
  stage.addEventListener("pointerdown", e => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: zoom || fitScale() };
      drag = null;
    } else if (e.pointerType === "mouse" && zoom) {
      drag = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
      stage.setPointerCapture(e.pointerId);
      stage.classList.add("dragging");
    }
  });
  stage.addEventListener("pointermove", e => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const r = stage.getBoundingClientRect();
      setZoom(pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.dist,
        ((a.x + b.x) / 2 - r.left) / r.width, ((a.y + b.y) / 2 - r.top) / r.height);
    } else if (drag) {
      stage.scrollLeft = drag.left - (e.clientX - drag.x);
      stage.scrollTop = drag.top - (e.clientY - drag.y);
    }
  });
  const up = e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    drag = null;
    stage.classList.remove("dragging");
  };
  stage.addEventListener("pointerup", up);
  stage.addEventListener("pointercancel", up);
  stage.addEventListener("wheel", e => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    zoomBy(e.deltaY < 0 ? 1.2 : 1 / 1.2, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  }, { passive: false });
  img.addEventListener("dblclick", e => {
    const r = stage.getBoundingClientRect();
    setZoom(zoom ? 0 : Math.max(1, fitScale() * 2), (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  });

  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); window.removeEventListener("resize", onResize); document.body.classList.toggle("modal-open", !!document.getElementById("modal-root").children.length); };
  const onKey = e => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight" && pics.length > 1) show(index + 1);
    else if (e.key === "ArrowLeft" && pics.length > 1) show(index - 1);
    else if (e.key === "+" || e.key === "=") zoomBy(1.25);
    else if (e.key === "-") zoomBy(0.8);
    else if (e.key === "0") setZoom(0);
  };
  const onResize = () => apply();
  const overlay = h("div", { class: "reader pic-reader", role: "dialog", "aria-modal": "true", "aria-label": item.name },
    h("div", { class: "reader-bar" },
      iconBtn("x", "Close", close),
      h("span", { class: "reader-title" }, item.name, counter),
      pics.length > 0 && [
        iconBtn("zoomOut", "Zoom out", () => zoomBy(0.8)),
        zoomLabel,
        iconBtn("zoomIn", "Zoom in", () => zoomBy(1.25)),
        iconBtn("expand", "Fit to screen", () => setZoom(0)),
      ],
      opts.onEdit && h("button", { class: "btn", onclick: () => { close(); opts.onEdit(); } }, icon("edit"), h("span", { class: "hide-sm" }, "Edit"))),
    pics.length ? stage : h("div", { class: "pic-empty" }, h("p", null, "This document has no picture yet."),
      opts.onEdit && h("button", { class: "btn primary", onclick: () => { close(); opts.onEdit(); } }, icon("image"), "Add one")),
    pics.length > 1 && iconBtn("left", "Previous picture", () => show(index - 1), "pic-nav prev"),
    pics.length > 1 && iconBtn("right", "Next picture", () => show(index + 1), "pic-nav next"),
    caption);
  if (pics.length) show(0);
  else caption.hidden = true;
  document.body.append(overlay);
  document.body.classList.add("modal-open");
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", onResize);
}

// ------------------------------------------------------------------ editor field

// For "just a picture" documents: add, caption and remove pictures (kept in the body as image references).
function pictureEditor(f, draft) {
  const list = h("div", { class: "pic-edit-list" });
  const draw = () => {
    const pics = docPictures({ body: draft[f.key] });
    setChildren(list, pics.map(p => {
      return h("div", { class: "pic-edit" }, storedImage(p.id, "pic-thumb"),
        h("input", { type: "text", value: p.caption, placeholder: "Caption (optional)", "aria-label": "Caption",
          onchange: e => { draft[f.key] = draft[f.key].replace(p.raw, `![${e.target.value.replace(/[\[\]]/g, "")}](img:${p.id})`); draw(); } }),
        iconBtn("trash", "Remove picture", () => { draft[f.key] = draft[f.key].replace(p.raw, "").replace(/\n{3,}/g, "\n\n").trim(); draw(); }));
    }), !pics.length && h("p", { class: "muted small" }, "No picture yet."));
  };
  const add = () => pickImageFiles(false, async ([file]) => {
    try {
      toast("Adding picture…");
      const id = await addImageFile(file);
      draft[f.key] = ((draft[f.key] || "").trim() + `\n\n![${imageCaption(file)}](img:${id})`).trim();
      draw();
      toast("Picture added");
    } catch (e) {
      toast(e.message);
    }
  });
  draw();
  return h("div", { class: "pic-editor" }, list,
    h("button", { type: "button", class: "btn", onclick: add }, icon("upload"), "Add picture"),
    h("p", { class: "muted small" }, "Opens full screen on a dark background, fitted to the screen, with zoom. Good for maps and handouts. Several pictures page left and right."));
}

// Text (Markdown, with pictures). Just-a-picture items use pictureEditor (the Picture feature).
function markdownField(f, draft) {
  const ta = h("textarea", { class: "md-input", rows: 14, value: draft[f.key] || "", placeholder: "Write here. **Bold**, *italic*, # Heading, - list, > quote, [link](https://…)",
    oninput: e => { draft[f.key] = e.target.value; if (!preview.hidden) drawPreview(); } });
  const preview = h("div", { class: "md-preview", hidden: true });
  const drawPreview = () => setChildren(preview, draft[f.key] ? renderMarkdown(draft[f.key]) : h("p", { class: "muted" }, "Nothing to preview yet."));
  const wrap = (before, after = before, placeholder = "text") => {
    const s = ta.selectionStart, e = ta.selectionEnd;
    const sel = ta.value.slice(s, e) || placeholder;
    ta.setRangeText(before + sel + after, s, e, "end");
    ta.focus();
    ta.dispatchEvent(new Event("input"));
  };
  const linePrefix = prefix => {
    const s = ta.value.lastIndexOf("\n", ta.selectionStart - 1) + 1;
    ta.setRangeText(prefix, s, s, "end");
    ta.focus();
    ta.dispatchEvent(new Event("input"));
  };
  const insertImage = () => pickImageFiles(false, async ([file]) => {
    try {
      toast("Adding image…");
      const id = await addImageFile(file);
      ta.setRangeText(`\n![${imageCaption(file)}](img:${id})\n`, ta.selectionStart, ta.selectionEnd, "end");
      ta.dispatchEvent(new Event("input"));
      toast("Image added");
    } catch (e) {
      toast(e.message);
    }
  });
  const tabs = slideSwitch("Write or preview", [["write", "Write"], ["preview", "Preview"]], "write", v => show(v === "preview"), { tabs: true, even: true, cls: "md-tabs" });
  const show = previewing => {
    ta.hidden = previewing;
    toolbar.hidden = previewing;
    preview.hidden = !previewing;
    if (previewing) drawPreview();
  };
  const tool = (label, title, fn) => h("button", { type: "button", class: "btn md-tool", title, "aria-label": title, onclick: fn }, label);
  const toolbar = h("div", { class: "md-toolbar" },
    tool("B", "Bold", () => wrap("**")), tool("I", "Italic", () => wrap("*")), tool("H", "Heading", () => linePrefix("## ")),
    tool("•", "List", () => linePrefix("- ")), tool("❝", "Quote", () => linePrefix("> ")),
    tool("🔗", "Link", () => wrap("[", "](https://)", "link text")), tool("―", "Divider", () => wrap("\n\n---\n\n", "", "")),
    h("button", { type: "button", class: "btn md-tool", onclick: insertImage }, icon("upload"), "Add image"));
  return h("div", { class: "field full md-field" },
    h("div", { class: "md-head" }, h("span", null, f.label), tabs),
    toolbar, ta, preview,
    h("p", { class: "muted small" }, "Markdown: **bold**, *italic*, # headings, - lists, > quotes, | tables |, [links](https://…). Images are shrunk to fit and kept on this device (and on the party host when you're in a party)."));
}
