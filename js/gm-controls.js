// GM controls: the GM tab, its Controls tab, and boards for setting values by hand (Clockwork
// controls: see js/clockwork.js; panels, which hold every control, are in js/control-panels.js).
// A board is a picture (a map, a dial, anything) or a blank square, with pins to drag: each pin's
// x and y set a pair of values (e.g. shipX and shipY): Globals, or one player's or one item's
// Locals. Players' drawn icons follow.
//
// A board is a control in a panel: { type: "board", board: { image?, layers?, pins: [pin] } }, where a
// pin is { id, label, color, xVar, yVar, scope, target, xRange: [from, to], yRange: [from, to] }; xVar
// and yVar are value names, scope "party" (Globals), "character" or "item" (Locals). Layers, a pin's
// look and groups of pins: see Boards below. (Boards were controls of their own; normalizeData puts
// each in a panel.)
// A pin has no position of its own: it shows where its values are, so setting them any other way
// (the Values tab) moves it too.

const PIN_COLORS = ["#c0392b", "#2e86de", "#27ae60", "#e67e22", "#8e44ad", "#16a085", "#d4ac0d", "#34495e"];

const gmControls = () => store.state.gmControls || [];

// ------------------------------------------------------------------ who's the GM
// A device is the GM in a party when the host has made it one (party.isGm); outside a party when
// it's set to the GM role (Settings), to prepare: then values are the campaign's starting ones,
// which go to the party when the campaign is loaded into one.

const isGmDevice = () => party.active ? party.isGm() : ui.role === "gm";

// An axis maps a position across the board (0 at the left or top, 1 at the right or bottom) onto a
// range of values; a range can run backwards (from 10 down to 0).
const clamp01 = v => Math.max(0, Math.min(1, v));
const axisPos = (value, [from, to]) => to === from ? 0.5 : clamp01((value - from) / (to - from));
const axisValue = (pos, [from, to]) => Math.round((from + pos * (to - from)) * 1000) / 1000;

function scopeLabel(pin) {
  if (pin.scope === "party") return "everyone";
  const [charId, entryUid] = pin.target.split("/");
  const c = gmChars().find(x => x.id === charId);
  if (!c) return "a player who has left";
  if (pin.scope === "character") return c.name;
  const e = c.items.find(x => x.uid === entryUid);
  return e ? `${c.name}'s ${entryName(e)}` : `an item ${c.name} no longer has`;
}

// "shipX = 0.42 · shipY = 0.8"
function pinValues(pin) {
  return [pin.xVar, pin.yVar].filter(Boolean).map(n => {
    const v = valueAt(pin.scope, pin.target, valueKey(n));
    return `${n} = ${v === undefined ? "not set" : v}`;
  }).join(" · ");
}

// ------------------------------------------------------------------ the GM tab: Players · Values · Controls · Clockwork
// Controls (panels, then the Global and Local values they set, then Clockwork's connections: what
// drives what), Players (in a party: gmPlayersView), Treasure. Preparing outside a party, values
// are the campaign's starting ones.

const GM_TABS = [["controls", "Controls"], ["players", "Players"], ["treasure", "Treasure"]];

function renderGm() {
  // (Controls only while the campaign has rules, values and controls: clockworkOn.)
  const tabs = GM_TABS.filter(([k]) => (party.active || k !== "players") && (clockworkOn() || k !== "controls"));
  const tab = tabs.some(([k]) => k === ui.gmTab) ? ui.gmTab : tabs[0][0];
  return h("div", { class: "view-gm view-party" },
    subTabs("GM", tabs, tab, k => { ui.gmTab = k; render(); }),
    tab === "players" ? gmPlayersView() : tab === "treasure" ? treasureView() : gmControlsPage());
}

// ------------------------------------------------------------------ the Controls tab
// A second row of tabs: Panels, Values (the Global and Local values) and Connections (what drives
// what: Clockwork's connections).

const GM_CONTROLS_TABS = [["panels", "Panels"], ["values", "Values"], ["connections", "Connections"]];

function gmControlsPage() {
  const tab = GM_CONTROLS_TABS.some(([k]) => k === ui.gmControlsTab) ? ui.gmControlsTab : "panels";
  return [
    subTabs("Controls", GM_CONTROLS_TABS, tab, k => { ui.gmControlsTab = k; render(); }),
    tab === "values" ? valuesView() : tab === "connections" ? clockworkView() : gmControlsSection(),
  ];
}

function gmControlsSection() {
  const list = gmControls();
  return h("section", { class: "gm-controls" },
    h("div", { class: "section-head" }, h("h2", null, "Panels"),
      editing() && h("button", { class: "btn primary", onclick: () => editControlPanel(null) }, icon("plus"), "New panel")),
    h("p", { class: "muted small" }, "What you use to set values in play: panels, grids of sliders, switches, buttons, dropdowns, boards, pictures and text, arranged as you like. Each sets a Global value, or a player's or an item's Locals, and players' icons follow. Kept on this device."),
    list.length ? h("div", { class: "cp-panel-list" }, list.map(controlPanelCard))
      : emptyState("sliders", "No panels yet. Make one, then arrange sliders, switches, buttons and boards on it.",
        editing() && h("button", { class: "btn primary", onclick: () => editControlPanel(null) }, icon("plus"), "Make a panel")));
}

// ------------------------------------------------------------------ boards
// A board is a control in a panel (js/control-panels.js), ctl.board = { image?, layers?, pins: [pin] }:
// a picture (or a blank square) with pins on top, as large as fits the space it has. Expanded, it
// fills the screen to zoom (buttons, Ctrl+wheel, pinch) and scroll.
//
// Layers (top first): { id, name, kind: "pins" | "picture", hidden?, locked?, and for a picture,
// image? or a drawing (iconDoc, iconSvg, iconLib) }. A pin is on one (pin.layer: its id; none, or
// a layer that's gone: the top pin layer, else above them all). hidden and locked are how a layer
// starts: in play, the Layers button shows and hides, locks and unlocks them on this device
// (ui.boardView["panelId/ctlId/layerId"]). A locked layer's pins can't be dragged.
//
// A pin's look: a dot (its colour), or a picture (look: "picture": a drawing or a built-in icon)
// at a size ("s", "m", "l"), its anchor ([0 to 1 across, down] of the picture) on the spot, nudged
// by [x, y] pixels; spot: also a small dot on the exact spot.
// A group (members: [member]) stands for several pins: each member is { id, label, color, scope,
// target, look?, icon/drawing?, apart? } and sets the group's xVar and yVar in its own scope (a
// character's Locals, say). The group has no values of its own: it sits where its first member
// still with it is, and dragging it moves everyone with it. A member split off (apart, saved with
// the board) shows as its own pin, moved alone, with a faint line back to the group; rejoining
// puts it where the group is.

const PIN_SIZES = { s: 28, m: 40, l: 56 };
const isGroup = p => Array.isArray(p?.members);
// What each pin sets: a pin, or a group's members (with the group's value names and ranges).
const pinSetters = board => (board.pins || []).flatMap(p => isGroup(p)
  ? p.members.map(m => ({ ...m, xVar: p.xVar, yVar: p.yVar, xRange: p.xRange, yRange: p.yRange, group: p }))
  : [p]);
const memberLabel = m => m.label || scopeLabel(m);
// A board's layers on this device: shown or hidden, locked or not.
function layerState(key, layer) {
  const v = key && ui.boardView[`${key}/${layer.id}`] || {};
  return { hidden: v.hidden ?? !!layer.hidden, locked: v.locked ?? !!layer.locked };
}
// The pin layer a pin is on (null: none, it goes on top).
const pinLayerOf = (board, pin) => {
  const pinLayers = (board.layers || []).filter(l => l.kind === "pins");
  return pinLayers.find(l => l.id === pin.layer) || pinLayers[0] || null;
};
// Where a pin's values put it: [x, y] from 0 to 1 (undefined: not set).
function pinPos(s) {
  const at = name => name ? valueAt(s.scope, s.target, valueKey(name)) : undefined;
  const vx = at(s.xVar), vy = at(s.yVar);
  return { x: vx === undefined ? 0.5 : axisPos(vx, s.xRange), y: vy === undefined ? 0.5 : axisPos(vy, s.yRange), unset: vx === undefined && vy === undefined };
}
// Set pins' values to a place (each in its own scope): through Clockwork, as the GM.
const sendPos = (setters, x, y) => Promise.all(setters.flatMap(s =>
  [[s.xVar, axisValue(x, s.xRange)], [s.yVar, axisValue(y, s.yRange)]].filter(([n]) => n)
    .map(([n, v]) => clockwork.change(...clockwork.at(s.scope, s.target, n), v, "gm").done)));

// A pin's face: its dot, or its picture.
function pinFace(p) {
  if (p.look === "picture" && (p.iconSvg || p.icon)) {
    const pic = controlPicture(p, "gm-pin-pic", "image");
    if (pic) { pic.style.color = p.color || PIN_COLORS[0]; return pic; }
  }
  return h("span", { class: "gm-pin-dot" });
}

// opts: zoom: () => the zoom (expanded only: then it scrolls); key: "panelId/ctlId" (its layers'
// state on this device); change(fn): change the stored board (a group's members splitting off).
function gmBoard(board, { zoom = null, key = "", change = null } = {}) {
  const el = h("div", { class: "gm-board" + (board.image ? "" : " blank") });
  const inner = h("div", { class: "gm-board-inner" }, el);
  const box = h("div", { class: "gm-board-fit" + (zoom ? " zoomable" : "") }, inner);
  let ratio = 1;
  const fit = () => {
    const w = box.clientWidth, ht = box.clientHeight;
    if (!w || !ht) return;
    const bw = Math.min(w, ht * ratio) * (zoom ? zoom() : 1);
    el.style.width = bw + "px";
    el.style.height = bw / ratio + "px";
  };
  if (board.image) {
    const img = storedImage(board.image, "gm-board-img", img => img.replaceWith(h("div", { class: "gm-board-missing muted small" }, "Picture not on this device")));
    const sized = () => { if (img.naturalWidth) { ratio = img.naturalWidth / img.naturalHeight; fit(); } };
    img.addEventListener("load", sized);
    if (img.complete) sized();
    el.append(img);
  }
  // The layers, bottom first; pins on no layer on top.
  const layers = board.layers || [];
  const lines = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  lines.setAttribute("class", "gm-board-lines");
  lines.setAttribute("viewBox", "0 0 100 100");
  lines.setAttribute("preserveAspectRatio", "none");
  const ctx = { board, key, change, lines, groups: new Map() };
  const pinsOn = layer => (board.pins || []).filter(p => pinLayerOf(board, p) === layer);
  for (const layer of [...layers].reverse()) {
    const st = layerState(key, layer);
    if (st.hidden) continue;
    if (layer.kind === "picture") {
      const pic = layer.image ? storedImage(layer.image, "gm-layer-pic") : layer.iconSvg && layer.iconDoc ? controlPicture(layer, "gm-layer-pic") : null;
      if (pic) el.append(h("div", { class: "gm-board-layer", "data-layer": layer.id }, pic));
    } else el.append(...pinsOn(layer).flatMap(p => boardPin(el, p, ctx, st.locked)));
  }
  el.append(...pinsOn(null).flatMap(p => boardPin(el, p, ctx, false)));
  el.prepend(lines); // (the lines under every pin, over the pictures: moved up once they're all placed)
  const firstPin = el.querySelector(".gm-pin");
  if (firstPin) el.insertBefore(lines, firstPin);
  new ResizeObserver(fit).observe(box);
  setTimeout(fit); // once it's on the page (the observer waits for a frame, which a hidden window doesn't draw)
  box.refit = fit;
  return box;
}

// A pin, or a group and its members who are apart (each a pin of its own), on a board.
function boardPin(boardEl, pin, ctx, locked) {
  if (!isGroup(pin)) return [gmPin(boardEl, pin, { setters: [pin], locked })];
  const members = pinSetters({ pins: [pin] });
  const together = members.filter(m => !m.apart), apart = members.filter(m => m.apart);
  const at = pinPos(together[0] || members[0] || pin);
  const lineFor = new Map(apart.map(m => {
    const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
    l.setAttribute("stroke", m.color || PIN_COLORS[0]);
    ctx.lines.append(l);
    return [m.id, l];
  }));
  const setEnd = (l, n, x, y) => { l.setAttribute("x" + n, x * 100); l.setAttribute("y" + n, y * 100); };
  const group = gmPin(boardEl, pin, { setters: together, locked, count: together.length, at,
    onPlace: (x, y) => lineFor.forEach(l => setEnd(l, 1, x, y)),
    onTap: () => openGroupMenu(pin, ctx) });
  const loose = apart.map(m => gmPin(boardEl, m, { setters: [m], locked, member: true,
    onPlace: (x, y) => setEnd(lineFor.get(m.id), 2, x, y),
    // Dropped on its group: back with it (once its own values are sent).
    onDrop: ev => {
      const r = group.getBoundingClientRect();
      return Math.hypot(ev.clientX - (r.left + r.width / 2), ev.clientY - (r.top + r.height / 2)) < Math.max(28, r.width / 2) ? () => rejoinMember(pin, m, ctx) : null;
    } }));
  return [group, ...loose];
}

// Tap a group: who's in it, to split one off or bring one back.
function openGroupMenu(pin, ctx) {
  if (!ctx.change) return;
  let close;
  const rows = pin.members.map(m => h("div", { class: "gm-member" + (m.apart ? " apart" : "") },
    h("span", { class: "gm-member-face", style: { "--pin": m.color || PIN_COLORS[0] } }, pinFace(m)),
    h("span", { class: "grow" }, memberLabel(m), m.apart && h("span", { class: "muted small" }, " · apart")),
    m.apart
      ? h("button", { type: "button", class: "btn primary", onclick: () => { close(); rejoinMember(pin, m, ctx); } }, "Rejoin")
      : h("button", { type: "button", class: "btn", onclick: () => { close(); splitMember(pin, m, ctx); } }, "Split off")));
  close = openModal(pin.label || "Group", h("div", { class: "gm-members" },
    h("p", { class: "muted small" }, "Dragging the group moves everyone with it. One split off moves on its own; drop it back on the group, or Rejoin, to join again."), rows),
    { footer: [h("button", { class: "btn primary", onclick: () => close() }, "Done")] });
}
const setApart = (pin, m, ctx, apart) => ctx.change(b => {
  const mm = (b.pins || []).find(x => x.id === pin.id)?.members?.find(x => x.id === m.id);
  if (mm) { if (apart) mm.apart = true; else delete mm.apart; }
});
// Split off: a little way from the group, so it shows.
async function splitMember(pin, m, ctx) {
  const s = { ...m, xVar: pin.xVar, yVar: pin.yVar, xRange: pin.xRange, yRange: pin.yRange };
  const p = pinPos(s);
  await sendPos([s], clamp01(p.x + (p.x > 0.9 ? -0.06 : 0.06)), clamp01(p.y + 0.04));
  setApart(pin, m, ctx, true);
}
// Rejoin: where the group is (its first member still with it).
async function rejoinMember(pin, m, ctx) {
  const s = { ...m, xVar: pin.xVar, yVar: pin.yVar, xRange: pin.xRange, yRange: pin.yRange };
  const lead = pin.members.find(x => !x.apart && x.id !== m.id);
  if (lead) { const p = pinPos({ ...lead, xVar: pin.xVar, yVar: pin.yVar, xRange: pin.xRange, yRange: pin.yRange }); await sendPos([s], p.x, p.y); }
  setApart(pin, m, ctx, false);
}

// The pins' key: each pin's colour, label, what it sets and the values now (a group's members each).
const pinLegend = board => pinSetters(board).length > 0 && h("ul", { class: "gm-pin-legend" }, pinSetters(board).map(p => h("li", null,
  h("span", { class: "gm-pin-swatch", style: { background: p.color } }), h("b", null, p.group ? `${p.group.label || "Group"}: ${memberLabel(p)}` : p.label || "Pin"),
  h("span", { class: "muted" }, ` for ${scopeLabel(p)}: ${pinValues(p)}${p.apart ? " (apart)" : ""}`))));

// A board's layers, in play: show or hide, lock or unlock each, on this device.
function boardLayersList(board, key, onChange) {
  return h("div", { class: "gm-layer-list" }, (board.layers || []).map(layer => {
    const st = layerState(key, layer), k = `${key}/${layer.id}`;
    const set = patch => { ui.boardView[k] = { ...st, ...patch }; onChange(); };
    return h("div", { class: "gm-layer-row" + (st.hidden ? " off" : "") },
      h("span", { class: "grow" }, h("b", null, layer.name || (layer.kind === "picture" ? "Picture" : "Pins")),
        h("span", { class: "muted small" }, layer.kind === "picture" ? " · a picture" : ` · ${plural(pinsOnLayer(board, layer).length, "pin")}`)),
      h("button", { type: "button", class: "icon-btn" + (st.hidden ? "" : " on"), "aria-pressed": String(!st.hidden), title: st.hidden ? "Show it" : "Hide it",
        "aria-label": `${layer.name || "Layer"}: shown`, onclick: () => set({ hidden: !st.hidden }) }, icon(st.hidden ? "eyeOff" : "eye")),
      layer.kind === "pins" && h("button", { type: "button", class: "icon-btn" + (st.locked ? " on" : ""), "aria-pressed": String(st.locked), title: st.locked ? "Unlock: its pins can be dragged" : "Lock: its pins can't be dragged",
        "aria-label": `${layer.name || "Layer"}: locked`, onclick: () => set({ locked: !st.locked }) }, icon(st.locked ? "lock" : "unlock")));
  }));
}
const pinsOnLayer = (board, layer) => (board.pins || []).filter(p => pinLayerOf(board, p) === layer);

// A board full screen, to zoom and scroll. opts: key and change, as gmBoard's.
function openBoardZoom(board, title, { key = "", change = null } = {}) {
  let zoom = 1;
  const holder = h("div", { class: "board-zoom-holder" });
  let view;
  // A group's member split off or back: changed here at once, and where it's kept.
  const changeHere = change && (fn => { fn(board); change(fn); setTimeout(redraw, 50); });
  const redraw = () => {
    const keep = view && { l: view.scrollLeft, t: view.scrollTop };
    view = gmBoard(board, { zoom: () => zoom, key, change: changeHere });
    holder.replaceChildren(view);
    wire(view);
    if (keep) setTimeout(() => { view.scrollLeft = keep.l; view.scrollTop = keep.t; });
    setChildren(legend, pinLegend(board));
    if (layersBox.isConnected) setChildren(layersBox, boardLayersList(board, key, redraw));
  };
  const pct = h("span", { class: "board-zoom-pct" }, "100%");
  const setZoom = (z, cx = 0.5, cy = 0.5) => {
    // Keep the point under (cx, cy) of the view where it is.
    const ax = view.scrollLeft + view.clientWidth * cx, ay = view.scrollTop + view.clientHeight * cy;
    const fx = ax / Math.max(1, view.scrollWidth), fy = ay / Math.max(1, view.scrollHeight);
    zoom = Math.max(1, Math.min(8, z));
    view.refit();
    view.scrollLeft = fx * view.scrollWidth - view.clientWidth * cx;
    view.scrollTop = fy * view.scrollHeight - view.clientHeight * cy;
    pct.textContent = Math.round(zoom * 100) + "%";
  };
  const wire = view => {
    const at = ev => { const r = view.getBoundingClientRect(); return [(ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height]; };
    view.addEventListener("wheel", ev => {
      if (!ev.ctrlKey) return; // plain wheel scrolls
      ev.preventDefault();
      setZoom(zoom * (ev.deltaY < 0 ? 1.15 : 1 / 1.15), ...at(ev));
    }, { passive: false });
    // Pinch (two fingers on the board, not on a pin).
    const touches = new Map();
    let pinch = null;
    view.addEventListener("pointerdown", ev => {
      if (ev.pointerType !== "touch" || ev.target.closest(".gm-pin")) return;
      touches.set(ev.pointerId, ev);
      if (touches.size === 2) {
        const [a, b] = [...touches.values()];
        pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z: zoom };
      }
    });
    view.addEventListener("pointermove", ev => {
      if (!touches.has(ev.pointerId)) return;
      touches.set(ev.pointerId, ev);
      if (!pinch || touches.size !== 2) return;
      const [a, b] = [...touches.values()];
      const mid = { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 };
      setZoom(pinch.z * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.d, ...at(mid));
    });
    const lift = ev => { touches.delete(ev.pointerId); if (touches.size < 2) pinch = null; };
    view.addEventListener("pointerup", lift);
    view.addEventListener("pointercancel", lift);
    // The key shows the values as they are: refreshed when a pin is let go (or moved by keys).
    view.addEventListener("pointerup", refresh);
    view.addEventListener("keyup", refresh);
  };
  const legend = h("div", { class: "board-zoom-legend" }, pinLegend(board));
  const refresh = () => setTimeout(() => setChildren(legend, pinLegend(board)), 300);
  // The Layers button: the sheet of layers above the key.
  const layersBox = h("div", { class: "board-zoom-layers" });
  const layersBtn = (board.layers || []).length > 0 && h("button", { type: "button", class: "icon-btn", title: "Layers: show, hide, lock", "aria-label": "Layers", "aria-expanded": "false",
    onclick: ev => {
      const open = !layersBox.isConnected;
      ev.currentTarget.classList.toggle("on", open);
      ev.currentTarget.setAttribute("aria-expanded", String(open));
      if (open) { legend.before(layersBox); setChildren(layersBox, h("h3", null, icon("layers"), "Layers"), boardLayersList(board, key, redraw)); }
      else layersBox.remove();
    } }, icon("layers"));
  redraw();

  const root = document.getElementById("modal-root");
  const close = () => { overlay.remove(); document.body.classList.toggle("modal-open", root.children.length > 0); };
  const overlay = h("div", { class: "reader board-zoom", role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "reader-bar" },
      h("div", { class: "reader-title" }, title),
      layersBtn,
      iconBtn("zoomOut", "Zoom out", () => setZoom(zoom / 1.25)), pct, iconBtn("zoomIn", "Zoom in", () => setZoom(zoom * 1.25)),
      h("button", { class: "btn", onclick: () => setZoom(1) }, "Fit"),
      h("button", { class: "btn primary", onclick: close }, "Done")),
    holder, legend);
  root.append(overlay);
  document.body.classList.add("modal-open");
}

// A pin: drag it (or select it and use the arrow keys) to set its values (each of `setters`: the
// pin, or a group's members with it). opts: locked (can't be dragged), count (a group's badge),
// at (where it shows, when not from setters), onTap, onDrop(ev) (let go after a drag: tested at
// once, while the board is on screen, it may return what to do once the values are sent),
// onPlace(x, y) (each time it moves), member (a group's member, apart).
function gmPin(board, pin, { setters = [pin], locked = false, count = null, at = null, onTap = null, onDrop = null, onPlace = null, member = false } = {}) {
  const p0 = at || pinPos(setters[0] || pin);
  let { x, y } = p0;
  const picture = pin.look === "picture" && (pin.iconSvg || pin.icon);
  const size = PIN_SIZES[pin.size] || PIN_SIZES.m;
  const [ax, ay] = pin.anchor || [0.5, 0.5], [dx, dy] = pin.nudge || [0, 0];
  const label = member ? memberLabel(pin) : pin.label;
  const el = h("button", { type: "button", class: ["gm-pin", p0.unset && "unset", picture && "pictured", locked && "locked", isGroup(pin) && "group", member && "member"].filter(Boolean).join(" "),
    "aria-label": `${label || "Pin"}: ${locked ? "locked" : "drag, or use the arrow keys"}${onTap ? "; press for its members" : ""}` },
    pinFace(pin),
    picture && pin.spot && h("span", { class: "gm-pin-spot", style: { left: `calc(${ax * 100}% - ${dx}px)`, top: `calc(${ay * 100}% - ${dy}px)` } }),
    count != null && h("span", { class: "gm-pin-count" }, String(count)),
    locked && h("span", { class: "gm-pin-lock" }, icon("lock")),
    label && h("span", { class: "gm-pin-label" }, label));
  el.style.setProperty("--pin", pin.color || PIN_COLORS[0]);
  if (picture) {
    // Its anchor on the spot, nudged.
    el.style.width = el.style.height = size + "px";
    el.style.marginLeft = (0.5 - ax) * size + dx + "px";
    el.style.marginTop = (0.5 - ay) * size + dy + "px";
  }
  const place = () => {
    el.style.left = x * 100 + "%";
    el.style.top = y * 100 + "%";
    el.title = `${label || "Pin"}${isGroup(pin) ? "" : ` (${scopeLabel(pin)})`}: ${[pin.xVar && `${pin.xVar} = ${axisValue(x, pin.xRange)}`, pin.yVar && `${pin.yVar} = ${axisValue(y, pin.yRange)}`].filter(Boolean).join(", ")}`;
    onPlace?.(x, y);
  };
  place();
  const canMove = !locked && setters.length > 0;

  // Through Clockwork (js/clockwork.js), as the GM: shown on this device's live icons at once while
  // it moves, sent at most every 150 ms, and always once when it stops.
  let timer = null, last = 0;
  const values = () => setters.flatMap(s => [[s, s.xVar, axisValue(x, s.xRange)], [s, s.yVar, axisValue(y, s.yRange)]].filter(([, n]) => n));
  const send = () => {
    clearTimeout(timer);
    timer = null;
    last = Date.now();
    return sendPos(setters, x, y);
  };
  const soon = () => { if (!timer) timer = setTimeout(send, Math.max(0, 150 - (Date.now() - last))); };

  let pressed = null, moved = false;
  const moveTo = ev => {
    if (!moved && Math.hypot(ev.clientX - pressed.x, ev.clientY - pressed.y) < 5) return; // (a tap, so far)
    moved = true;
    el.classList.add("dragging");
    const r = board.getBoundingClientRect();
    // A pin that sets only one value slides along that axis.
    if (pin.xVar) x = clamp01((ev.clientX - pressed.ox - r.left) / r.width);
    if (pin.yVar) y = clamp01((ev.clientY - pressed.oy - r.top) / r.height);
    el.classList.remove("unset");
    place();
    for (const [s, n, v] of values()) clockwork.preview(...clockwork.at(s.scope, s.target, n), v);
    soon();
  };
  el.addEventListener("pointerdown", ev => {
    if (!canMove && !onTap) return;
    ev.preventDefault();
    el.focus();
    try { el.setPointerCapture(ev.pointerId); } catch {} // keeps the drag when the pointer leaves the pin
    // (where on the pin it was pressed: the spot doesn't jump to the pointer)
    const r = board.getBoundingClientRect();
    pressed = { x: ev.clientX, y: ev.clientY, ox: ev.clientX - (r.left + x * r.width), oy: ev.clientY - (r.top + y * r.height) };
    moved = false;
    if (canMove) holdRender(true); // party updates mustn't redraw the board mid-drag
  });
  el.addEventListener("pointermove", ev => { if (pressed && canMove) moveTo(ev); });
  const stop = async ev => {
    if (!pressed) return;
    pressed = null;
    el.classList.remove("dragging");
    if (!canMove) { if (ev.type === "pointerup") onTap?.(); return; }
    const then = moved && ev.type === "pointerup" ? onDrop?.(ev) : null;
    try {
      if (moved) { await send(); clockwork.endPreview(); }
    } finally { holdRender(false); }
    if (!moved && ev.type === "pointerup") onTap?.();
    then?.();
  };
  el.addEventListener("pointerup", stop);
  el.addEventListener("pointercancel", stop);
  el.addEventListener("keydown", ev => {
    if ((ev.key === "Enter" || ev.key === " ") && onTap) { ev.preventDefault(); onTap(); return; }
    if (!canMove) return;
    const step = ev.shiftKey ? 0.1 : 0.01;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[ev.key];
    if (!d) return;
    ev.preventDefault();
    if (pin.xVar) x = clamp01(x + d[0]);
    if (pin.yVar) y = clamp01(y + d[1]);
    el.classList.remove("unset");
    place();
    soon();
  });
  return el;
}

// ------------------------------------------------------------------ making and editing a control

// Where a pin can apply: Globals (everyone), a player's Locals, or one of a player's items with a drawn icon.
function pinScopeOptions(current) {
  const opts = [h("option", { value: "party:" }, "Everyone (Global values)")];
  for (const c of gmChars()) {
    const items = c.items.filter(e => e.item.iconDoc);
    opts.push(h("optgroup", { label: c.name },
      h("option", { value: "character:" + c.id }, `${c.name} (their Local values)`),
      items.map(e => h("option", { value: `item:${c.id}/${e.uid}` }, entryName(e)))));
  }
  if (current !== "party:" && !opts.some(o => o.value === current || [...(o.children || [])].some(x => x.value === current))) {
    opts.push(h("option", { value: current }, "(no longer in the party)"));
  }
  return opts;
}

// A value name from a control's name: "Ship's position" -> "ships_position".
const valueSlug = text => {
  const s = (text || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);
  return isValueName(s) ? s : "pin" + (s ? "_" + s : "");
};

// Edit a board's picture, layers and pins: onSave(board) with the changed copy. name: its control's
// label (new pins' value names start from it). Pins are a row each; ✎ opens one's own sheet.
function editBoard(board, onSave, name = "") {
  const draft = clone(board || { pins: [] });
  draft.layers ||= [];
  draft.name = name;
  let close;

  const bgBox = h("div", { class: "inline wrap gm-bg" });
  const drawBg = () => setChildren(bgBox,
    draft.image ? storedImage(draft.image, "pic-thumb") : h("span", { class: "gm-bg-blank", title: "Blank square" }),
    h("button", { type: "button", class: "btn", onclick: () => pickImageFiles(false, async ([file]) => {
      try { draft.image = await addImageFile(file); drawBg(); } catch (e) { toast(e.message); }
    }) }, icon("image"), draft.image ? "Change picture…" : "Choose a picture…"),
    draft.image && h("button", { type: "button", class: "btn", onclick: () => { delete draft.image; drawBg(); } }, "Blank square instead"));
  drawBg();

  // Layers, top first: name, (a picture layer's picture), how it starts (shown, locked), order.
  const layersBox = h("div", { class: "gm-layer-list" });
  const layerPicture = layer => h("div", { class: "inline wrap" },
    layer.image ? storedImage(layer.image, "pic-thumb") : layer.iconSvg ? controlPicture(layer, "gm-layer-thumb") : h("span", { class: "gm-bg-blank" }),
    h("button", { type: "button", class: "btn", onclick: () => pickImageFiles(false, async ([file]) => {
      try { layer.image = await addImageFile(file); setItemDrawing(layer, null); drawLayers(); } catch (e) { toast(e.message); }
    }) }, icon("image"), "Image…"),
    h("button", { type: "button", class: "btn", title: "One of your drawings: it moves with the Global values it reads (fog that lifts, a tide)",
      onclick: () => openIconPicker(null, () => {}, null, { drawings: drawingLibrary(), onDrawing: d => { setItemDrawing(layer, d); delete layer.image; drawLayers(); } }) }, icon("edit"), "Drawing…"));
  const drawLayers = () => setChildren(layersBox, draft.layers.length ? draft.layers.map((layer, i) => h("div", { class: "gm-layer-row edit" + (layer.hidden ? " off" : "") },
    h("div", { class: "gm-layer-row-head" },
      h("input", { type: "text", value: layer.name || "", maxlength: 30, placeholder: layer.kind === "picture" ? "Picture layer" : "Pin layer", "aria-label": `Layer ${i + 1}: name`, class: "grow",
        oninput: e => { layer.name = e.target.value; } }),
      h("span", { class: "muted small" }, layer.kind === "picture" ? "picture" : "pins"),
      h("button", { type: "button", class: "icon-btn" + (layer.hidden ? "" : " on"), "aria-pressed": String(!layer.hidden), title: layer.hidden ? "Starts hidden" : "Starts shown",
        "aria-label": `${layer.name || "Layer"}: starts shown`, onclick: () => { layer.hidden = !layer.hidden; drawLayers(); } }, icon(layer.hidden ? "eyeOff" : "eye")),
      layer.kind === "pins" && h("button", { type: "button", class: "icon-btn" + (layer.locked ? " on" : ""), "aria-pressed": String(!!layer.locked), title: layer.locked ? "Starts locked" : "Starts unlocked",
        "aria-label": `${layer.name || "Layer"}: starts locked`, onclick: () => { layer.locked = !layer.locked; drawLayers(); } }, icon(layer.locked ? "lock" : "unlock")),
      iconBtn("up", "Higher", () => { if (i > 0) { [draft.layers[i - 1], draft.layers[i]] = [draft.layers[i], draft.layers[i - 1]]; drawLayers(); } }),
      iconBtn("down", "Lower", () => { if (i < draft.layers.length - 1) { [draft.layers[i + 1], draft.layers[i]] = [draft.layers[i], draft.layers[i + 1]]; drawLayers(); } }),
      iconBtn("trash", layer.kind === "pins" ? "Remove this layer (its pins go to the next pin layer)" : "Remove this layer", () => {
        draft.layers.splice(i, 1);
        for (const p of draft.pins) if (p.layer === layer.id) delete p.layer;
        drawLayers(); drawPins();
      }, "danger-hover")),
    layer.kind === "picture" && layerPicture(layer)))
    : h("p", { class: "muted small" }, "None: the pins are on the picture. Add layers to hide some (a fog, a second map) or lock them (enemies who mustn't be moved by accident)."));
  const addLayer = kind => {
    const n = draft.layers.filter(l => l.kind === kind).length + 1;
    draft.layers.unshift({ id: "l" + uid(), name: kind === "pins" ? (n === 1 ? "Pins" : `Pins ${n}`) : (n === 1 ? "Picture" : `Picture ${n}`), kind });
    drawLayers(); drawPins();
  };
  drawLayers();

  // Pins: a row each (its look, label, what it is), ✎ for its sheet.
  const pinsBox = h("div", { class: "gm-pin-rows" });
  const pinSummary = p => [
    isGroup(p) ? `group of ${p.members.length}` : null,
    draft.layers.some(l => l.kind === "pins") ? `${pinLayerOf(draft, p)?.name || "Pins"} layer` : null,
    [p.xVar, p.yVar].filter(Boolean).join(", ") + (isGroup(p) ? " for each" : ` (${scopeLabel(p)})`),
  ].filter(Boolean).join(" · ");
  const drawPins = () => setChildren(pinsBox, draft.pins.length ? draft.pins.map((p, i) => h("div", { class: "gm-pin-row compact" },
    h("span", { class: "gm-member-face", style: { "--pin": p.color || PIN_COLORS[0] } }, pinFace(p)),
    h("span", { class: "grow" }, h("b", null, p.label || "Pin"), h("small", { class: "muted" }, pinSummary(p))),
    iconBtn("up", "Earlier", () => { if (i > 0) { [draft.pins[i - 1], draft.pins[i]] = [draft.pins[i], draft.pins[i - 1]]; drawPins(); } }),
    iconBtn("edit", `Edit ${p.label || "the pin"}`, () => editPin(draft, p, changed => { draft.pins[i] = changed; drawPins(); }, () => { draft.pins.splice(i, 1); drawPins(); })),
    iconBtn("trash", "Remove pin", () => { draft.pins.splice(i, 1); drawPins(); }, "danger-hover")))
    : h("p", { class: "muted small" }, "No pins yet."));
  const newPin = group => {
    const n = draft.pins.length + 1, base = valueSlug(draft.name) + (n > 1 ? n : "");
    const pin = { id: "p" + uid(), label: group ? "Group" : `Pin ${n}`, color: PIN_COLORS[(n - 1) % PIN_COLORS.length],
      xVar: base + "_x", yVar: base + "_y", scope: "party", target: "", xRange: [0, 1], yRange: [0, 1] };
    if (group) {
      // Everyone in the party to start: a member each, setting their own Locals.
      pin.label = "The party";
      pin.members = gmChars().map((c, j) => ({ id: "m" + uid(), color: PIN_COLORS[(n + j) % PIN_COLORS.length], scope: "character", target: c.id }));
    }
    editPin(draft, pin, changed => { draft.pins.push(changed); drawPins(); });
  };
  drawPins();

  const save = () => {
    const bad = draft.pins.flatMap(p => [p.xVar, p.yVar]).filter(n => n && !isValueName(n));
    if (bad.length) return toast(`Not a value name: ${bad.join(", ")} (a letter, then letters, digits or _; not starting gm_, global_, local_ or state_)`);
    if (draft.pins.some(p => !p.xVar && !p.yVar)) return toast("Each pin needs a value to set, across or down");
    close();
    const { name: _, ...out } = draft;
    if (!out.layers.length) delete out.layers;
    onSave(out);
  };

  close = openModal(name ? `Board: ${name}` : "Board", h("div", { class: "form" },
    h("div", { class: "field" }, h("span", null, "Background"), bgBox),
    h("div", { class: "section-head" }, h("h4", null, "Layers"),
      h("div", { class: "inline" },
        h("button", { type: "button", class: "btn", title: "A layer of pins", onclick: () => addLayer("pins") }, icon("plus"), "Pins"),
        h("button", { type: "button", class: "btn", title: "A picture over the background: a fog, a grid, a second map", onclick: () => addLayer("picture") }, icon("plus"), "Picture"))),
    h("p", { class: "muted small" }, "Top first. How each starts: shown or hidden, locked or not. In play, the board's Layers button changes them on your device."),
    layersBox,
    h("div", { class: "section-head" }, h("h4", null, "Pins"),
      h("div", { class: "inline" },
        h("button", { type: "button", class: "btn", onclick: () => newPin(false) }, icon("plus"), "Add pin"),
        h("button", { type: "button", class: "btn", title: "A pin standing for several (the party): moved together, one can split off", onclick: () => newPin(true) }, icon("users"), "Add group"))),
    h("p", { class: "muted small" }, "Each pin sets up to two values: one from its position across the board, one from its position down it. Drawings read them as global_name or local_name."),
    pinsBox),
  { wide: true, footer: [
    h("button", { class: "btn", onclick: () => close() }, "Cancel"),
    h("button", { class: "btn primary", onclick: save }, icon("check"), "Save"),
  ] });
}

// One pin's sheet: label and colour, layer, look (dot or picture: size, anchor, nudge, the exact
// spot), its values, and who it's for (or, a group, its members). onSave(pin) with the changed
// copy; onRemove (an existing pin).
function editPin(board, pin, onSave, onRemove = null) {
  const draft = clone(pin);
  const known = [...new Set([...knownValues().values()].map(v => v.name))].sort();
  const listId = "gm-names-" + uid();
  let close;
  const body = h("div", { class: "form" });
  const num = (value, label, onSet, cls = "gm-range") => h("input", { type: "number", step: "any", value, "aria-label": label, class: cls,
    onchange: e => { if (e.target.value !== "") onSet(+e.target.value); } });
  const varInput = (key, label) => h("input", { type: "text", list: listId, value: draft[key] || "", placeholder: "value name", "aria-label": label,
    class: draft[key] && !isValueName(draft[key]) ? "invalid" : "", spellcheck: "false", autocomplete: "off",
    onchange: e => { draft[key] = e.target.value.trim(); e.target.classList.toggle("invalid", !!draft[key] && !isValueName(draft[key])); } });
  const scopeSelect = (obj, label, onSet = () => {}) => {
    const sel = h("select", { "aria-label": label, onchange: e => { const [scope, target] = e.target.value.split(/:(.*)/); obj.scope = scope; obj.target = target || ""; onSet(); } },
      pinScopeOptions(`${obj.scope}:${obj.target}`));
    setTimeout(() => { sel.value = `${obj.scope}:${obj.target}`; });
    return sel;
  };
  // A picture: one of your drawings (or a new one, drawn here), or a built-in icon.
  const pictureButtons = (obj, redraw, nameOf) => [
    h("button", { type: "button", class: "btn", onclick: () => openIconPicker(obj.icon, id => {
      setItemDrawing(obj, null); if (id) obj.icon = id; else delete obj.icon; redraw();
    }, null, { drawings: drawingLibrary(), onDrawing: d => { setItemDrawing(obj, d); delete obj.icon; redraw(); } }) }, icon("image"), "Choose…"),
    h("button", { type: "button", class: "btn", onclick: () => {
      if (obj.iconDoc) return editItemDrawing(obj, redraw, { name: nameOf() });
      openIconDrawer({ name: nameOf(), color: obj.color, templates: true }, (doc, svg) => {
        if (doc) { setItemDrawing(obj, addDrawing(nameOf(), doc, svg)); delete obj.icon; }
        redraw();
      });
    } }, icon("edit"), obj.iconDoc ? "Edit drawing…" : "Draw…")];
  const pinLayers = board.layers?.filter(l => l.kind === "pins") || [];

  const draw = () => setChildren(body,
    h("div", { class: "gm-pin-row-head" },
      h("input", { type: "color", value: draft.color || PIN_COLORS[0], "aria-label": "Colour", onchange: e => { draft.color = e.target.value; } }),
      h("input", { type: "text", value: draft.label || "", placeholder: "Label", maxlength: 40, "aria-label": "Label", class: "grow", oninput: e => { draft.label = e.target.value; } })),
    pinLayers.length > 0 && h("label", { class: "field" }, h("span", null, "Layer"),
      h("select", { onchange: e => { draft.layer = e.target.value; } },
        pinLayers.map(l => h("option", { value: l.id, selected: pinLayerOf(board, draft) === l }, l.name || "Pins")))),
    // Its look.
    h("div", { class: "field" }, h("span", null, "Look"),
      slideSwitch("Look", [["dot", "Dot"], ["picture", "Picture"]], draft.look === "picture" ? "picture" : "dot",
        v => { if (v === "picture") draft.look = "picture"; else delete draft.look; draw(); }, { even: true, cls: "seg-field" })),
    draft.look === "picture" && [
      h("div", { class: "inline wrap gm-pin-look" },
        h("span", { class: "gm-member-face big", style: { "--pin": draft.color || PIN_COLORS[0] } }, pinFace(draft)),
        pictureButtons(draft, draw, () => draft.label || "Pin")),
      h("div", { class: "field" }, h("span", null, "Size"),
        slideSwitch("Size", [["s", "Small"], ["m", "Medium"], ["l", "Large"]], draft.size || "m", v => { draft.size = v; }, { even: true, cls: "seg-field" })),
      h("div", { class: "field" }, h("span", null, "Sits on its spot"),
        h("div", { class: "gm-anchor-row" },
          h("div", { class: "gm-anchor", role: "group", "aria-label": "The point of the picture on the spot" },
            [0, 0.5, 1].flatMap(ay => [0, 0.5, 1].map(ax => {
              const [cx, cy] = draft.anchor || [0.5, 0.5], on = cx === ax && cy === ay;
              const word = `${["top", "middle", "bottom"][ay * 2]} ${["left", "centre", "right"][ax * 2]}`.replace("middle centre", "centre");
              return h("button", { type: "button", class: on ? "on" : "", "aria-pressed": String(on), title: word, "aria-label": word,
                onclick: () => { if (ax === 0.5 && ay === 0.5) delete draft.anchor; else draft.anchor = [ax, ay]; draw(); } });
            }))),
          h("div", { class: "grow muted small" }, "Which point of the picture is on the spot: the centre, or the foot of a flagpole or a figure.",
            h("div", { class: "inline gm-nudge" }, "Nudge",
              num((draft.nudge || [0, 0])[0], "Nudge across (pixels)", v => { draft.nudge = [v, (draft.nudge || [0, 0])[1]]; }, "gm-nudge-in"),
              num((draft.nudge || [0, 0])[1], "Nudge down (pixels)", v => { draft.nudge = [(draft.nudge || [0, 0])[0], v]; }, "gm-nudge-in"))))),
      h("label", { class: "check field" }, h("input", { type: "checkbox", checked: !!draft.spot, onchange: e => { if (e.target.checked) draft.spot = true; else delete draft.spot; } }),
        " Show the exact spot: a small dot where its values put it")],
    // Its values.
    h("div", { class: "field" }, h("span", null, "Values"),
      h("div", { class: "gm-pin-grid" },
        h("span", { class: "muted small" }, "Across (x)"), varInput("xVar", "Across sets"),
        h("span", { class: "gm-range-pair" }, num(draft.xRange[0], "Left edge", v => { draft.xRange[0] = v; }), "to", num(draft.xRange[1], "Right edge", v => { draft.xRange[1] = v; })),
        h("span", { class: "muted small" }, "Down (y)"), varInput("yVar", "Down sets"),
        h("span", { class: "gm-range-pair" }, num(draft.yRange[0], "Top edge", v => { draft.yRange[0] = v; }), "to", num(draft.yRange[1], "Bottom edge", v => { draft.yRange[1] = v; }))),
      h("small", { class: "muted" }, "Choose what each edge is worth (a range can run backwards). Leave one empty to use only the other.")),
    // One pin, or a group.
    h("div", { class: "field" }, h("span", null, "Pin or group"),
      slideSwitch("Pin or group", [["one", "One pin"], ["group", "A group"]], isGroup(draft) ? "group" : "one", v => {
        if (v === "group") draft.members = draft.scope !== "party" ? [{ id: "m" + uid(), color: draft.color, scope: draft.scope, target: draft.target }] : [];
        else { const m = draft.members?.[0]; delete draft.members; if (m) { draft.scope = m.scope; draft.target = m.target; } }
        draw();
      }, { even: true, cls: "seg-field" })),
    isGroup(draft)
      ? h("div", { class: "field" }, h("span", null, "Members"),
        h("div", { class: "gm-pin-rows" }, draft.members.map((m, i) => h("div", { class: "gm-member edit" },
          h("input", { type: "color", value: m.color || PIN_COLORS[0], "aria-label": `Member ${i + 1}: colour`, onchange: e => { m.color = e.target.value; } }),
          h("div", { class: "grow gm-member-fields" },
            h("input", { type: "text", value: m.label || "", placeholder: scopeLabel(m), maxlength: 40, "aria-label": `Member ${i + 1}: label`, oninput: e => { m.label = e.target.value; } }),
            scopeSelect(m, `Member ${i + 1}: sets the values for`, () => draw())),
          h("button", { type: "button", class: "btn gm-member-pic", title: "Its own picture, for when it's apart (else a dot)",
            onclick: () => openIconPicker(m.icon, id => { setItemDrawing(m, null); if (id) { m.icon = id; m.look = "picture"; } else { delete m.icon; delete m.look; } draw(); }, null,
              { drawings: drawingLibrary(), onDrawing: d => { setItemDrawing(m, d); delete m.icon; m.look = "picture"; draw(); } }) },
            h("span", { class: "gm-member-face", style: { "--pin": m.color || PIN_COLORS[0] } }, pinFace(m))),
          iconBtn("trash", "Remove member", () => { draft.members.splice(i, 1); draw(); }, "danger-hover")))),
        h("button", { type: "button", class: "btn", onclick: () => {
          const used = new Set(draft.members.map(m => m.target)), c = gmChars().find(x => !used.has(x.id));
          draft.members.push({ id: "m" + uid(), color: PIN_COLORS[draft.members.length % PIN_COLORS.length], scope: c ? "character" : "party", target: c ? c.id : "" });
          draw();
        } }, icon("plus"), "Add member"),
        h("small", { class: "muted" }, "Each sets the values above for its own player (or item). Moving the group moves all who are with it; tap it in play to split one off."))
      : h("label", { class: "field" }, h("span", null, "Sets the values for"), scopeSelect(draft, "Sets the values for")),
    h("datalist", { id: listId }, known.map(n => h("option", { value: n }))));
  draw();

  const save = () => {
    if ([draft.xVar, draft.yVar].some(n => n && !isValueName(n))) return toast("Not a value name: a letter, then letters, digits or _");
    if (!draft.xVar && !draft.yVar) return toast("The pin needs a value to set, across or down");
    if (isGroup(draft) && !draft.members.length) return toast("A group needs a member: add one, or make it one pin");
    if (draft.look !== "picture") { delete draft.size; delete draft.anchor; delete draft.nudge; delete draft.spot; }
    if (draft.nudge && !draft.nudge[0] && !draft.nudge[1]) delete draft.nudge;
    close();
    onSave(draft);
  };
  close = openModal(`Pin: ${pin.label || "Pin"}`, body, { footer: [
    onRemove && h("button", { class: "btn danger", onclick: () => { close(); onRemove(); } }, icon("trash"), "Remove"),
    h("button", { class: "btn", onclick: () => close() }, "Cancel"),
    h("button", { class: "btn primary", onclick: save }, icon("check"), "Save"),
  ] });
}
