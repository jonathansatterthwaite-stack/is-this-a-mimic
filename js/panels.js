// Panels: screens a game system brings with it (D&D 5e: Character and Equipment above the inventory,
// and the summary on the GM's player cards). A system package lists them:
//
//   panels: [{ id, slot: "inventory" | "gm-player", title, html, shows }],  panelLib: "script for every panel"
//   shows: what the panel shows in place of the app's own: ["slots"] (the equipment slots line)
//
// A panel is someone else's code, so it runs in a sandboxed frame: scripts only, no access to Pack
// the app's page, storage or party, and a Content-Security-Policy that blocks the network. It talks to
// the app by messages, through the Mimic object it's given (panelHelper below):
//
//   Mimic.on("state", s => …)       the character (stats, coins, items with their features, the
//                                      equipment slots and what's in them…), sent again whenever anything changes
//   Mimic.request(action, args)     ask for a change; the app checks it first (PANEL_REQUESTS: setStat,
//                                      equip, setState, setValue, changeQty, openItem, openCoins)
//   Mimic.summary(parts)            what the panel's header shows (closed: only the parts marked closed)
//   Mimic.on("compute", s => r)     gm-player panels: the summary of one character, returned as
//                                      { stats: [{ label, value, title, sub, warn }], chips: [text], notes: [text] }
//   Mimic.h / icon / markup / render / fmtMod / glossary   helpers, and the app's styles
//
// Inventory panels stay loaded while the app redraws: they live in #panels, outside the view
// that's replaced on every render, and are shown on the Inventory tab only.

// App icons a panel can use (Mimic.icon).
const PANEL_ICONS = ["shield", "weight", "coins", "user", "sword", "minus", "plus", "check", "dice", "book", "edit", "trash", "wand"];
const PANEL_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";
const PANEL_CSS = "html, body.panel-body { margin: 0; padding: 0; background: transparent; overflow: hidden; } body.panel-body > #root { padding: 1px 0; }";

// Runs inside the panel's frame (its source is put in the page).
function panelHelper() {
  const boot = window.MimicBoot, handlers = {};
  let state = null, lastHeight = -1;
  const send = (type, data) => parent.postMessage(Object.assign({ mimic: 1, type }, data || {}), "*");
  const emit = (ev, arg) => (handlers[ev] || []).map(f => {
    try { return f(arg); } catch (e) { console.error(e); return undefined; }
  });
  addEventListener("message", e => {
    const m = e.data;
    if (e.source !== parent || !m || m.mimic !== 1) return;
    if (m.type === "state") { state = m.state; emit("state", state); resize(); }
    else if (m.type === "compute") {
      const r = emit("compute", m.state).find(x => x !== undefined);
      send("result", { id: m.id, result: r === undefined ? null : r });
    }
  });
  const append = (el, kids) => {
    for (const k of kids.flat(Infinity)) if (k != null && k !== false && k !== "") el.append(k instanceof Node ? k : String(k));
  };
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k === "value" || k === "checked") el[k] = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    append(el, kids);
    return el;
  }
  function icon(name, cls) {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("class", "icon " + (cls || ""));
    s.setAttribute("aria-hidden", "true");
    s.innerHTML = boot.icons[name] || "";
    return s;
  }
  // Markup the app sent (an item's icon), as an element.
  function markup(html, cls) {
    const box = document.createElement("span");
    box.innerHTML = html || "";
    const el = box.firstElementChild || box;
    if (cls) el.classList.add(...cls.split(" "));
    return el;
  }
  // The frame's height follows its content (measured after each change too: frames that aren't
  // on screen may not get ResizeObserver callbacks).
  const resize = () => {
    const height = Math.ceil(document.body.getBoundingClientRect().height);
    if (height !== lastHeight) { lastHeight = height; send("resize", { height }); }
  };
  window.Mimic = {
    on(ev, f) { (handlers[ev] = handlers[ev] || []).push(f); if (ev === "state" && state) f(state); },
    request(action, args) { send("request", { action, args: args || {} }); },
    summary(parts) { send("summary", { parts: (parts || []).filter(Boolean) }); },
    get state() { return state; },
    glossary: boot.glossary,
    h, icon, markup,
    render(el, ...kids) { el.replaceChildren(); append(el, kids); resize(); },
    fmtMod: n => (n >= 0 ? "+" : "") + n,
  };
  addEventListener("DOMContentLoaded", () => { new ResizeObserver(resize).observe(document.body); send("ready"); resize(); });
}

let panelCss = null; // the app's stylesheet, so panels look like the rest of the app
const safeJson = v => JSON.stringify(v).replace(/</g, "\\u003c");

function panelDoc(sys, p) {
  const boot = { icons: Object.fromEntries(PANEL_ICONS.filter(n => ICONS[n]).map(n => [n, ICONS[n]])), glossary: sys.glossary || {} };
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${PANEL_CSP}">`
    + `<style>${(panelCss || "").replace(/<\/style/gi, "<\\/style")}\n${PANEL_CSS}</style>`
    + `<script>window.MimicBoot=${safeJson(boot)};(${panelHelper})();\n${sys.panelLib || ""}</` + `script>`
    + `</head><body class="panel-body">${p.html || ""}</body></html>`;
}

function panelFrame(sys, p, cls) {
  // No allow-same-origin: the panel can't reach the app's page, storage or cookies.
  return h("iframe", { class: cls, sandbox: "allow-scripts", srcdoc: panelDoc(sys, p), title: p.title || p.id, loading: "eager" });
}

const panelsOf = (sys, slot) => (sys.panels || []).filter(p => p && p.slot === slot && typeof p.html === "string");

// ------------------------------------------------------------------ what a panel is sent

// Item icons as markup (a panel can't use the app's elements): the drawing or the icon, in its colour.
function iconMarkup(item) {
  const svg = (item.iconSvg && !item.image && drawnIcon(item.iconSvg)) || iconSvg(itemIconId(item));
  svg.style.color = itemColor(item);
  return svg.outerHTML;
}

// A character's stats: a system's starting values, then what's been set.
const statsOf = (char, sys = activeSystem()) => ({ ...clone(sys.stats || {}), ...clone(char.stats || {}) });

// A set of stored values by name (without the GM's state overrides).
const ownValues = bucket => Object.fromEntries(Object.entries(bucket || {}).filter(([k]) => !k.startsWith("gm_state_")).map(([k, v]) => [keyName(k), valueNow(v)]));

function panelState(char, withIcons = true) {
  const settings = store.state.settings;
  const value = char.items.filter(e => !isCoinEntry(e)).reduce((s, e) => s + entryValue(e), 0); // (coins: their own worth)
  const sysFeatures = new Set((activeSystem().features || []).map(f => f.key));
  const items = char.items.filter(e => !inDeck(char, e)).map(e => {
    const it = currentItem(e, char); // as it is now: its active layers applied
    const tpl = itemTemplate(it), features = allFeatures().filter(f => hasFeature(it, f.key, e.srcId)).map(f => f.key);
    const holder = e.parent && char.items.find(x => x.uid === e.parent);
    return {
      uid: e.uid, srcId: e.srcId || null, name: entryName(e), qty: e.qty, equipped: !!e.equipped, states: entryStates(char, e),
      values: ownValues(valueSet().items?.[`${char.id}/${e.uid}`]), // its own Local values (js/clockwork.js)
      parent: e.parent || null, compartment: entryComp(e), location: locationLabel(char, e) || "", inHolder: !!(holder && holderSpec(holder)),
      template: tpl.id, root: rootTemplate(tpl)?.id || tpl.id, main: mainFeatures(tpl), features, item: it,
      // Icons for what panels show: equippable things, and anything with a feature of the system's own.
      icon: withIcons && features.some(k => k === "equippable" || sysFeatures.has(k)) ? iconMarkup(it) : undefined,
    };
  });
  // Each limited state: how many are on, and the limit (5e: attunement slots).
  const limits = Object.fromEntries(systemStates().filter(st => st.limit).map(st => [st.key,
    { count: items.filter(x => x.states[st.key]).length, limit: stateLimit(char, st) }]));
  // The equipment slots: how many places, how many taken, and by what (item uids, and how many places each).
  const slots = systemSlots().map(s => {
    const holders = slotHolders(char, s.key);
    return { key: s.key, label: s.label, count: s.count, used: holders.reduce((n, x) => n + x.slot.size, 0),
      items: holders.map(x => ({ uid: x.e.uid, size: x.slot.size })) };
  });
  const g = valueSet();
  return {
    system: activeSystem().id, settings: clone(settings), limits, slots,
    // Global values, and the character's Locals (an item's own are on the item).
    values: { global: ownValues(g.party), local: ownValues(g.characters?.[char.id]) },
    character: { id: char.id, name: char.name, stats: statsOf(char), coins: { ...(char.coins || {}) } },
    items,
    totals: {
      carried: carriedWeight(char, settings), coinsWorth: fmtCost(coinTotalCp(char.coins || {})), gearWorth: fmtCost(Math.round(value)),
      coins: coinOrder().map(k => ({ key: k, count: (char.coins || {})[k] || 0 })),
    },
  };
}

// ------------------------------------------------------------------ what a panel can ask for

const STAT_KEY = /^[A-Za-z][\w-]{0,40}$/;
const okStat = v => typeof v === "number" ? Number.isFinite(v)
  : typeof v === "string" ? v.length <= 500
  : typeof v === "boolean" || v === null
  || (Array.isArray(v) && v.length <= 100 && v.every(x => typeof x === "string" && x.length <= 100 || typeof x === "number" && Number.isFinite(x)));

const PANEL_REQUESTS = {
  setStat(char, { key, value }) {
    if (typeof key !== "string" || !STAT_KEY.test(key) || !okStat(value)) return;
    commit((s, c) => { c.stats = { ...statsOf(c), [key]: value }; });
  },
  equip(char, { uid, on }) {
    const e = char.items.find(x => x.uid === uid);
    if (e && isEquipable(e) && (on === undefined || !!on !== !!e.equipped)) toggleEquip(uid);
  },
  changeQty(char, { uid, delta }) {
    const e = char.items.find(x => x.uid === uid);
    if (e && !canCount(e)) return toast("In Play mode only things like ammunition, rations and potions are counted");
    if (e && Number.isInteger(delta) && Math.abs(delta) <= 10000) setEntryQty(e, e.qty + delta);
  },
  // An item's state, as the player would switch it (limits and locks apply).
  setState(char, { uid, key, on }) { if (typeof key === "string") playerSetState(uid, key, !!on); },
  // A Local value: the character's, or one item's own (uid). value null clears it.
  setValue(char, { name, uid, value }) {
    if (!clockworkOn()) return;
    const entry = uid !== undefined ? char.items.find(x => x.uid === uid) : null;
    if (typeof name !== "string" || (uid !== undefined && !entry)) return;
    clockwork.change(entry ? { char, entry } : { char }, `${entry ? "local" : "char.local"}.${name}`, value, isGmDevice() ? "gm" : "player");
  },
  openItem(char, { uid }) { if (char.items.some(x => x.uid === uid)) openEntry(uid); },
  openCoins() { openCoins(); },
};

// ------------------------------------------------------------------ inventory panels

const panelHosts = new Map(); // panel id -> { panel, frame, section, head, ready, sent, parts }
let panelHostsFor = null;      // the system they belong to

function panelOpenPref(sys, p) { return "mimic-panel-" + sys.id + "-" + p.id; }

function makePanelHost(sys, p) {
  const frame = panelFrame(sys, p, "panel-frame");
  const head = h("div", { class: "group-head" });
  const body = h("div", { class: "panel-body-box" }, frame);
  // Open unless closed before; on a phone, closed until opened (so the items come first).
  const host = { panel: p, frame, head, body, ready: false, sent: null, parts: [],
    open: readPref(panelOpenPref(sys, p), matchMedia("(max-width: 720px)").matches ? "0" : "1") === "1" };
  host.section = h("section", { class: `group sys-panel panel-${p.id.replace(/[^\w-]/g, "")}` }, head, body);
  return host;
}

// Show the system's inventory panels (on the Inventory tab, for this character) and send them its state.
function syncPanels(char, show) {
  const box = document.getElementById("panels");
  if (!box) return;
  const sys = activeSystem();
  box.hidden = !show || !char;
  if (box.hidden) return;
  if (panelCss === null) {
    panelCss = "";
    fetch("css/app.css").then(r => r.text()).catch(() => "").then(t => { panelCss = t; panelHostsFor = null; render(); });
    return;
  }
  if (panelHostsFor !== sys) {
    panelHostsFor = sys;
    panelHosts.clear();
    for (const p of panelsOf(sys, "inventory")) panelHosts.set(p.id, makePanelHost(sys, p));
    box.replaceChildren(...[...panelHosts.values()].map(x => x.section));
  }
  // A system without panels (or none): the coins and the weight carried, so they're still at hand.
  if (!panelHosts.size) return setChildren(box, basicPanel(char));
  const state = panelState(char), json = JSON.stringify(state);
  for (const host of panelHosts.values()) {
    host.state = state; host.json = json;
    drawPanelHead(host, char);
    if (host.ready && host.sent !== json) { host.sent = json; host.frame.contentWindow.postMessage({ mimic: 1, type: "state", state }, "*"); }
  }
}

function basicPanel(char) {
  const weight = carriedWeight(char, store.state.settings);
  return h("section", { class: "group sys-panel closed" },
    h("div", { class: "group-head" }, h("h3", null, "Coins & load"),
      summaryPart({ coins: true }, char),
      summaryPart({ icon: "weight", text: fmtWeight(weight) }, char)));
}

function drawPanelHead(host, char) {
  const sys = activeSystem(), open = host.open;
  host.section.classList.toggle("closed", !open);
  host.body.hidden = !open;
  const toggle = () => { host.open = !open; writePref(panelOpenPref(sys, host.panel), host.open ? "1" : "0"); drawPanelHead(host, store.char()); };
  setChildren(host.head,
    h("button", { class: "collapse" + (open ? "" : " closed"), type: "button", onclick: toggle, "aria-expanded": String(open) }, icon("chevron"),
      h("h3", null, host.panel.title || "")),
    host.parts.filter(p => open ? !p.closed : true).map(p => summaryPart(p, char)));
}

// A part of a panel's header: text (with one of the app's icons), or the coin purse.
function summaryPart(p, char) {
  if (p.coins) return h("button", { class: "purse-btn", type: "button", title: "Open the coin purse", "aria-label": "Coins: open the coin purse", onclick: openCoins },
    icon("coins"), h("span", { class: "coins" }, coinChips(char.coins)));
  return h("span", { class: "muted panel-summary" + (p.warn ? " warn-text" : ""), title: String(p.title || "") },
    PANEL_ICONS.includes(p.icon) && icon(p.icon), String(p.text ?? "").slice(0, 300));
}

// ------------------------------------------------------------------ gm-player panels
// Worked out in hidden frames, a character at a time; the GM's cards show the last results and
// redraw when new ones come.

const computeFrames = new Map(); // panel id -> { panel, frame, ready, queue }
let computeFor = null;
const computeResults = new Map(); // character id -> { json, results: { panelId: result } }
const computeWaiting = new Map(); // request id -> { charId, panelId, json }
let computeSeq = 0;

function computePanels() {
  const sys = activeSystem();
  if (computeFor !== sys) {
    for (const c of computeFrames.values()) c.frame.remove();
    computeFrames.clear();
    computeResults.clear();
    computeFor = sys;
    for (const p of panelsOf(sys, "gm-player")) {
      const frame = panelFrame(sys, p, "panel-compute");
      frame.hidden = true;
      document.body.append(frame);
      computeFrames.set(p.id, { panel: p, frame, ready: false, queue: [] });
    }
  }
  return computeFrames;
}

// The gm-player summaries for a character: [{ panel, result }] (empty until they've been worked out).
function panelSummaries(char) {
  const frames = computePanels();
  if (!frames.size) return [];
  const state = panelState(char, false), json = JSON.stringify(state);
  let known = computeResults.get(char.id);
  if (!known) computeResults.set(char.id, known = { json: null, results: {} });
  if (known.json !== json) {
    known.json = json;
    for (const [panelId, c] of frames) {
      const id = ++computeSeq;
      computeWaiting.set(id, { charId: char.id, panelId, json });
      const msg = { mimic: 1, type: "compute", id, state };
      if (c.ready) c.frame.contentWindow.postMessage(msg, "*"); else c.queue.push(msg);
    }
  }
  return [...frames.values()].map(c => ({ panel: c.panel, result: known.results[c.panel.id] })).filter(x => x.result);
}

// A summary's parts, checked: only text goes into the GM's cards.
function cleanSummary(r) {
  if (!r || typeof r !== "object") return null;
  const str = (v, n = 200) => v == null ? "" : String(v).slice(0, n);
  const list = (v, n) => Array.isArray(v) ? v.slice(0, n) : [];
  return {
    stats: list(r.stats, 12).filter(s => s && typeof s === "object").map(s => ({ label: str(s.label, 40), value: str(s.value, 60), title: str(s.title), sub: str(s.sub), warn: !!s.warn })),
    chips: list(r.chips, 30).map(c => str(c)),
    notes: list(r.notes, 10).map(n => str(n, 300)),
  };
}

// ------------------------------------------------------------------ messages from panels

window.addEventListener("message", e => {
  const m = e.data;
  if (!m || m.mimic !== 1 || typeof m.type !== "string") return;
  const host = [...panelHosts.values()].find(x => x.frame.contentWindow === e.source);
  if (host) return panelMessage(host, m);
  const comp = [...computeFrames.values()].find(x => x.frame.contentWindow === e.source);
  if (comp) return computeMessage(comp, m);
});

function panelMessage(host, m) {
  const char = store.char();
  if (m.type === "ready") {
    host.ready = true;
    if (host.state) { host.sent = host.json; host.frame.contentWindow.postMessage({ mimic: 1, type: "state", state: host.state }, "*"); }
  } else if (m.type === "resize") {
    const hgt = Math.max(0, Math.min(5000, +m.height || 0));
    host.frame.style.height = hgt + "px";
  } else if (m.type === "summary") {
    host.parts = (Array.isArray(m.parts) ? m.parts : []).slice(0, 8).filter(p => p && typeof p === "object");
    if (char) drawPanelHead(host, char);
  } else if (m.type === "request") {
    const fn = Object.hasOwn(PANEL_REQUESTS, m.action) && PANEL_REQUESTS[m.action];
    if (fn && char) fn(char, m.args && typeof m.args === "object" ? m.args : {});
  }
}

function computeMessage(c, m) {
  if (m.type === "ready") {
    c.ready = true;
    for (const msg of c.queue.splice(0)) c.frame.contentWindow.postMessage(msg, "*");
  } else if (m.type === "result") {
    const w = computeWaiting.get(m.id);
    if (!w) return;
    computeWaiting.delete(m.id);
    const known = computeResults.get(w.charId);
    if (!known || known.json !== w.json) return; // superseded
    const result = cleanSummary(m.result);
    if (JSON.stringify(known.results[w.panelId]) === JSON.stringify(result)) return;
    known.results[w.panelId] = result;
    render();
  }
}
