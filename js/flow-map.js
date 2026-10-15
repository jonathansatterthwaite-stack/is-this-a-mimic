// The flow map: GM → Controls → Connections (docs/clockwork-overhaul-plan.md, step 4; the mock-up
// is mockups/flow-map.html). One thing in the middle: what changes it on the left, what it changes
// on the right, joined by wires that say why in a word or two: a rule (amber), something following
// a value (blue: Shown when, Locked when, words, a picture, a shop), set directly (a control, a pin:
// grey) or by hand (grey, dashed). Tap a box to centre the map on it; tap a wire's label for what
// it is (a rule in blocks, Edit rule). A wide screen lists everything connected beside it; a phone
// stacks the three parts and lists everything until one is chosen.

// ------------------------------------------------------------------ the graph
// Nodes: { id, kind, title (what kind, where), name, sub?, big? } with kind "value", "panel",
// "control", "item", "char", "shop" or "hand"; ids "v:global:door", "v:local:heat", "p:<panel>",
// "c:<panel>/<control>", "i:<char>/<uid>", "ch:<char>", "s:<shop>", "h:gm", "h:player".
// Edges: { from, to, kind: "rule" | "follow" | "sets" | "hand" | "has", label, rule?, source?, at? }
// (at: where the rule runs: { char, e } for an item's, a control's { panel, ctl }).

const FLOW_KINDS = { value: "value", panel: "control", control: "control", item: "item", char: "char", shop: "shop", hand: "hand" };
// A condition's words, short: "1", "> 5", "not 0", "2 to 4".
const shortCond = c => ({ "=": "", "!=": "not ", "<": "< ", "<=": "≤ ", ">": "> ", ">=": "≥ " }[c.op] ?? "") + (c.op === "between" ? `${c.to} to ${c.to2}` : c.to);
// A rule's label on a wire: its name, its button or hotspot, else what it does first.
function shortRule(r) {
  const s = r.name || (r.when === "used" && r.button) || ((r.when === "signal" || r.when === "control") && r.signal)
    || (r.do || []).map(a => actionOf(a)?.words(a)).filter(Boolean)[0] || "a rule";
  return s.length > 28 ? s.slice(0, 26).trimEnd() + "…" : s;
}

function flowGraph() {
  const nodes = new Map(), edges = [], specs = knownValues();
  const node = (id, def) => { if (!nodes.has(id)) nodes.set(id, { id, ...def }); return id; };
  const edge = (from, to, kind, label, extra = {}) => { if (from && to && from !== to) edges.push({ from, to, kind, label, ...extra }); };
  const valueNode = (scope, name) => {
    const spec = specs.get(`${scope}:${name}`);
    return node(`v:${scope}:${name}`, scope === "global"
      ? { kind: "value", title: "Global value", name, big: showValue(spec, globalValue(name) ?? spec?.value), sub: spec?.choices?.length ? `choices: ${spec.choices.join(", ")}` : null }
      : { kind: "value", title: "Local value", name, sub: "each item's own, else its character's" });
  };
  const gmHand = () => node("h:gm", { kind: "hand", title: "By hand", name: `The ${term("gm")}`, sub: "the Values tab, states" });
  const shops = typeof shopStore !== "undefined" && isGmDevice() ? shopStore.list() : store.state.shops || [];
  const shopNode = id => { const s = shops.find(x => x.id === id); return s ? node("s:" + s.id, { kind: "shop", title: "Shop", name: s.name, sub: s.open ? "open" : "closed" }) : null; };
  // An address read or written, where a rule runs (here: its item, character, control).
  const addrNode = (address, here) => {
    let m;
    if ((m = /^global\.([A-Za-z]\w*)$/.exec(address || ""))) return valueNode("global", m[1]);
    if ((m = /^(?:local|char\.local)\.([A-Za-z]\w*)$/.exec(address || ""))) return valueNode("local", m[1]);
    if (/^item\./.test(address)) return here.item || null;
    if (/^char\./.test(address)) return here.char || null;
    if (address === "control.value") return here.control || null;
    return null;
  };
  // A rule's wires: from what sets it off (its event's object, the values its conditions watch) to
  // what it changes (values, states, a shop; an item's own press actions change the item).
  const ruleEdges = (r, here, source, at) => {
    const from = [r.when === "control" ? here.control : ["used", "signal", "acquired", "equipped", "unequipped"].includes(r.when) ? here.item : null,
      ...(r.test || []).flatMap(c => [c.value, ...[c.to, c.to2].filter(t => typeof t === "string").flatMap(t => [...t.matchAll(/[A-Za-z_]\w*(?:\.\w+)+/g)].map(m => m[0]))])
        .map(a => addrNode(a, here))];
    const to = (r.do || []).map(a => {
      const d = actionOf(a);
      return !d ? null : d.key === "shop" ? shopNode(a.shop) : ["set", "add", "change"].includes(d.key) ? addrNode(a[d.key], here) : d.press ? here.item : null;
    });
    const label = shortRule(r);
    for (const f of new Set(from.filter(Boolean))) for (const t of new Set(to.filter(Boolean))) edge(f, t, "rule", label, { rule: r, source, at });
  };

  // Characters and their items: rules (their own, the rule book's, a set's), drawings, states.
  for (const c of gmChars()) {
    const ch = node("ch:" + c.id, { kind: "char", title: "Character", name: c.name });
    for (const x of clockwork.rulesFor({ char: c }, ruleKey)) ruleEdges(x.rule, { char: ch }, x.source, { char: c });
    for (const e of c.items) {
      const id = node(`i:${c.id}/${e.uid}`, { kind: "item", title: `Item · ${c.name}`, name: entryName(e),
        sub: statesOnFor(c, e).map(st => st.label.toLowerCase()).join(", ") || null, char: c, e });
      const here = { item: id, char: ch }, rules = clockwork.rulesFor({ char: c, entry: e }, ruleKey);
      for (const x of rules) ruleEdges(x.rule, here, x.source, { char: c, e });
      if (e.item.iconDoc) for (const r of drawingValueRefs(e.item.iconDoc).values()) edge(valueNode(r.scope === "global" ? "global" : "local", r.name), id, "follow", "its picture");
      // States someone switches by hand that change it (a layer) or that its rules watch.
      const watched = new Set(rules.flatMap(x => (x.rule.test || []).map(t => t.value)));
      for (const st of statesFor(e)) if (layerHasContent(e.item.layers?.[st.key]) || watched.has(`item.state.${st.key}`)) {
        edge(st.who === "player" ? node("h:player", { kind: "hand", title: "By hand", name: "The player", sub: "their item's states" })
          : gmHand(),
          id, "hand", `switches ${st.label}`);
      }
    }
  }
  // The world's rules (the GM's device).
  for (const x of clockwork.rulesFor({ by: "gm" }, ruleKey)) ruleEdges(x.rule, {}, x.source, {});
  // Panels and their controls: the values they set, follow and show; their rules.
  for (const panel of gmControls()) {
    if (!panel.controls) continue;
    const p = node("p:" + panel.id, { kind: "panel", title: "Panel", name: panel.name || "Panel", sub: plural(panel.controls.length, "control"), panel });
    if (panel.showIf?.value) edge(addrNode(panel.showIf.value, {}), p, "follow", `shown when ${shortCond(panel.showIf)}`);
    for (const ctl of panel.controls) {
      if (ctl.type === "tabs") continue;
      const scope = ctl.scope === "party" ? "global" : "local";
      const id = node(`c:${panel.id}/${ctl.id}`, { kind: "control", title: `Control · ${panel.name}`, name: controlName(ctl),
        sub: [CONTROL_TYPES.find(t => t[0] === ctl.type)?.[1], !controlShown(ctl) && "hidden now", controlLocked(ctl) && "locked now"].filter(Boolean).join(" · "), panel, ctl });
      edge(p, id, "has", "on it");
      const names = ctl.type === "board" ? [] : ctl.type === "polygon" ? (ctl.vertices || []).map(v => v.name) : ctl.type === "text" ? [] : [ctl.name, ctl.name2];
      for (const n of names.filter(Boolean)) edge(id, valueNode(scope, n), "sets", ctl.type === "toggle" ? "switches it" : ctl.action === "add" ? "adds to it" : "sets it");
      for (const pin of ctl.type === "board" ? pinSetters(ctl.board || {}) : []) for (const n of [pin.xVar, pin.yVar].filter(Boolean)) {
        const v = valueNode(pin.scope === "party" ? "global" : "local", n);
        edge(id, v, "sets", `its pin ${pin.label || ""}`.trim());
        edge(v, id, "follow", "moves its pin");
      }
      if (ctl.type === "text" && ctl.name) edge(valueNode(scope, ctl.name), id, "follow", "shows it");
      for (const m of String(ctl.label || "").matchAll(/\{\s*([A-Za-z_][\w.]*)\s*\}/g))
        edge(m[1].includes(".") ? addrNode(m[1], {}) : valueNode(scope, m[1]), id, "follow", "its words");
      if (ctl.showIf?.value) edge(addrNode(ctl.showIf.value, {}), id, "follow", `shown when ${shortCond(ctl.showIf)}`);
      if (ctl.lockIf?.value) edge(addrNode(ctl.lockIf.value, {}), id, "follow", `locked when ${shortCond(ctl.lockIf)}`);
      if (ctl.iconDoc) for (const r of drawingValueRefs(ctl.iconDoc).values()) edge(valueNode(r.scope === "global" ? "global" : "local", r.name), id, "follow", "its picture");
      for (const x of clockwork.rulesFor({ by: "gm", panel: panel.id, control: ctl.id }, ruleKey))
        if (x.rule.when === "control") ruleEdges(x.rule, { control: id, panel: p }, x.source, { panel, ctl });
    }
  }
  // Shops that follow values.
  for (const r of shopValueReaders()) edge(valueNode("global", r.name), shopNode(r.shop.id), "follow",
    r.what === "opens" ? `opens when ${shortCond(r.shop.openIf)}` : r.what === "prices" ? "its prices" : `sells ${r.item?.name || "an item"}`);
  // Global values: the GM sets them by hand (the Values tab).
  for (const n of [...nodes.values()]) if (n.kind === "value" && n.title === "Global value") edge(gmHand(), n.id, "hand", "sets it");

  // Only what's connected (a character or panel only through what it has isn't).
  const deg = new Map();
  for (const x of edges) if (x.kind !== "has") for (const id of [x.from, x.to]) deg.set(id, (deg.get(id) || 0) + 1);
  const keep = id => deg.has(id);
  const kept = edges.filter(x => keep(x.from) && keep(x.to) || (x.kind === "has" && keep(x.to)));
  // A character carries its connected items; a panel has its connected controls.
  for (const c of gmChars()) for (const e of c.items) if (keep(`i:${c.id}/${e.uid}`)) kept.push({ from: "ch:" + c.id, to: `i:${c.id}/${e.uid}`, kind: "has", label: "carries" });
  const used = new Set(kept.flatMap(x => [x.from, x.to]));
  for (const id of [...nodes.keys()]) if (!used.has(id)) nodes.delete(id);
  return { nodes, edges: kept };
}

// ------------------------------------------------------------------ the view

// How many wires come in and go out (not counting what a character or panel has).
const flowCounts = (g, id) => ({ in: g.edges.filter(x => x.to === id && x.kind !== "has").length, out: g.edges.filter(x => x.from === id && x.kind !== "has").length });

function flowNodeBox(n, opts = {}) {
  return h(opts.focus ? "div" : "button", { type: opts.focus ? null : "button", class: `fm-node fm-k-${FLOW_KINDS[n.kind]}` + (opts.focus ? " focus" : ""),
    onclick: opts.focus ? null : () => flowGo(n.id) },
    h("span", { class: "fm-title" }, n.title), h("span", { class: "fm-name" }, n.name),
    n.big != null && opts.focus && h("span", { class: "fm-big" }, n.big),
    n.big != null && !opts.focus && h("span", { class: "fm-sub" }, `= ${n.big}`),
    n.sub && h("span", { class: "fm-sub" }, n.sub));
}

// Centre the map on a node (the one before goes on the trail, for Back).
function flowGo(id) {
  const st = ui.flow ||= { focus: null, trail: [], q: "", more: {} };
  if (st.focus && st.focus !== id) st.trail = [...st.trail, st.focus].slice(-8);
  st.focus = id;
  render();
  window.scrollTo(0, 0);
}

// A wire's label, tapped: what it is, and where to go.
function openFlowEdge(g, x) {
  const other = id => g.nodes.get(id);
  const from = other(x.from), to = other(x.to);
  let close;
  const go = id => () => { close(); flowGo(id); };
  const r = x.rule;
  const body = h("div", { class: "form" },
    r ? (() => {
      const words = ruleWords(r), i = words.indexOf(": ");
      return h("div", { class: "fm-rule" },
        h("div", { class: "rblk rblk-when" }, h("span", { class: "rblk-label" }, "When"), i > 0 ? words.slice(0, i) : words),
        i > 0 && h("div", { class: "rblk rblk-do" }, h("span", { class: "rblk-label" }, "Do"), words.slice(i + 2)),
        h("div", { class: "rblk rblk-scope" }, h("span", { class: "rblk-label" }, "Applies to"),
          x.source === "item" ? `the item that carries it${x.at?.e ? `: ${entryName(x.at.e)}` : ""}` : x.source === "set" ? "a set (its own, until it has actions)" : scopeWords(r.appliesTo).replace(/^For /, "").replace(/\.$/, "")));
    })()
    : h("p", null, x.kind === "follow" ? `${to?.name} follows ${from?.name}: ${x.label}.` : x.kind === "sets" ? `${from?.name} ${x.label === "sets it" ? "sets" : x.label.replace(/ it$/, "")} ${to?.name}.`
      : x.kind === "hand" ? `${from?.name} ${x.label.replace(/ it$/, "")}${x.label.endsWith(" it") ? "" : " on"} ${to?.name}.` : `${from?.name} ${x.label} ${to?.name}.`),
    h("div", { class: "inline wrap" },
      from && h("button", { class: "btn", onclick: go(from.id) }, "← ", from.name),
      to && h("button", { class: "btn", onclick: go(to.id) }, to.name, " →")));
  const edit = r && (x.source === "book" ? () => { close(); openRuleEditor(r); }
    : x.source === "item" && x.at?.e && store.state.characters.some(c => c.id === x.at.char.id) ? () => { close(); openItemForm(x.at.e.item, { entryUid: x.at.e.uid, tab: "triggers" }); } : null);
  const ctlEdit = !r && [from, to].find(n => n?.kind === "control");
  close = openModal(r ? (r.name || "Rule") : x.label.charAt(0).toUpperCase() + x.label.slice(1), body, { footer: [
    edit && editing() && h("button", { class: "btn", onclick: edit }, icon("edit"), "Edit rule"),
    ctlEdit && editing() && h("button", { class: "btn", onclick: () => { close(); editPanelControl(ctlEdit.panel, ctlEdit.ctl); } }, icon("edit"), "Edit control"),
    h("button", { class: "btn primary", onclick: () => close() }, "Done")] });
}

// Everything connected, by kind (the side list on a wide screen; the whole view on a phone until
// one is chosen), with what changes it · what it changes.
function flowList(g, st) {
  const q = (st.q || "").trim().toLowerCase();
  const all = [...g.nodes.values()].filter(n => n.kind !== "hand" && (!q || `${n.name} ${n.title}`.toLowerCase().includes(q)));
  const row = (n, indent = false) => {
    const k = flowCounts(g, n.id);
    return h("button", { type: "button", class: "fm-row" + (n.id === st.focus ? " on" : "") + (indent ? " indent" : ""), onclick: () => flowGo(n.id) },
      h("span", { class: `fm-dot fm-k-${FLOW_KINDS[n.kind]}` }), h("span", { class: "grow" }, n.name), h("small", { class: "muted" }, `${k.in} · ${k.out}`));
  };
  const byKind = kind => all.filter(n => n.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
  const kids = (parent, kind) => all.filter(n => n.kind === kind && g.edges.some(x => x.kind === "has" && x.from === parent.id && x.to === n.id));
  const nested = (top, kind) => [...byKind(top).flatMap(p => [row(p), ...kids(p, kind).map(n => row(n, true))]),
    ...byKind(kind).filter(n => !g.edges.some(x => x.kind === "has" && x.to === n.id && all.some(p => p.id === x.from))).map(n => row(n))];
  const groups = [["Values", byKind("value").map(n => row(n))], ["Panels", nested("panel", "control")],
    ["Characters and items", nested("char", "item")], ["Shops", byKind("shop").map(n => row(n))]];
  return h("div", { class: "fm-list" },
    groups.filter(([, rows]) => rows.length).map(([t, rows]) => [h("h4", null, t), rows]),
    !all.length && h("p", { class: "muted small" }, q ? "Nothing by that name." : "Nothing is connected yet."),
    all.length > 0 && h("p", { class: "muted small" }, "The numbers: what changes it · what it changes."));
}

function flowMapView() {
  const st = ui.flow ||= { focus: null, trail: [], q: "", more: {} };
  // Opened from an item's cog: centred on it.
  if (ui.cwFocus) { if (st.focus) st.trail = [...st.trail, st.focus].slice(-8); st.focus = "i:" + ui.cwFocus; ui.cwFocus = null; }
  const g = flowGraph();
  if (st.focus && !g.nodes.has(st.focus)) st.focus = null;
  st.trail = st.trail.filter(id => g.nodes.has(id));
  while (st.trail.length && st.trail.at(-1) === st.focus) st.trail.pop(); // (no "door › door")
  const focus = st.focus && g.nodes.get(st.focus);
  const box = h("section", { class: "fm" + (focus ? " has-focus" : "") });
  const search = h("input", { type: "search", class: "fm-search", placeholder: "Find a value, control, item or character…", value: st.q || "", "aria-label": "Find",
    oninput: e => { st.q = e.target.value; const list = box.querySelector(".fm-list"); if (list) list.replaceWith(flowList(g, st)); } });
  const bar = h("div", { class: "fm-bar" }, search,
    st.trail.length > 0 && h("button", { class: "btn", onclick: () => { st.focus = st.trail.at(-1); st.trail = st.trail.slice(0, -1); render(); } }, icon("undo"), "Back"),
    focus && h("button", { class: "btn", onclick: () => { st.focus = null; st.trail = []; render(); } }, icon("list"), "Everything"));
  const crumbs = st.trail.length > 0 && focus && h("div", { class: "fm-crumbs muted small" }, "Came from: ",
    [...st.trail.slice(-3).map(id => g.nodes.get(id)), focus].map((n, i, a) => [h("span", { class: "fm-crumb" }, n.name), i < a.length - 1 && " › "]));
  setChildren(box,
    h("p", { class: "muted small" }, "What's connected to what. Choose something to see what changes it (left) and what it changes (right); tap a box to move to it, a wire's words for what it is."),
    bar, crumbs,
    h("div", { class: "fm-main" }, h("div", { class: "fm-side" }, flowList(g, st)), focus && flowMap(g, focus, st)));
  // Wide or not: the side list beside the map, wires drawn between the columns. (Wide from the
  // start where the page is, so it isn't drawn narrow first; one watcher, for the box on screen.)
  box.classList.toggle("fm-wide", (document.getElementById("view")?.clientWidth || innerWidth) >= FM_WIDE);
  flowWatch?.disconnect();
  // (in the next frame: changing the layout inside the observer's own call would loop)
  flowWatch = window.ResizeObserver ? new ResizeObserver(() => requestAnimationFrame(() => {
    if (!box.isConnected) return;
    box.classList.toggle("fm-wide", box.clientWidth >= FM_WIDE);
    box.querySelector(".fm-map")?.redraw?.();
  })) : null;
  flowWatch?.observe(box);
  return box;
}
const FM_WIDE = 860;
let flowWatch = null;

// The map itself: what changes the focus, the focus, what it changes.
function flowMap(g, focus, st) {
  const LIMIT = 12;
  const side = dir => {
    const map = new Map();
    for (const x of g.edges) {
      const other = dir === "in" ? (x.to === focus.id && x.from) : (x.from === focus.id && x.to);
      if (!other || !g.nodes.has(other)) continue;
      (map.get(other) || map.set(other, []).get(other)).push(x);
    }
    const list = [...map.entries()].map(([id, xs]) => ({ n: g.nodes.get(id), xs }))
      .sort((a, b) => (a.xs[0].kind === "has") - (b.xs[0].kind === "has") || a.n.kind.localeCompare(b.n.kind) || a.n.name.localeCompare(b.n.name));
    const key = `${focus.id}:${dir}`, all = st.more[key];
    const shown = all ? list : list.slice(0, LIMIT);
    return [shown.map(({ n, xs }) => {
      const labels = h("div", { class: "fm-labels" }, xs.map(x => h("button", { type: "button", class: `fm-wire fm-w-${x.kind}`, onclick: () => openFlowEdge(g, x) }, x.label)));
      const nodeEl = flowNodeBox(n);
      return h("div", { class: "fm-entry", "data-kind": xs[0].kind }, dir === "in" ? [nodeEl, labels] : [labels, nodeEl]);
    }), list.length > shown.length && h("button", { class: "btn fm-more", onclick: () => { st.more[key] = true; render(); } }, `+ ${list.length - shown.length} more`),
      !list.length && h("p", { class: "muted small fm-none" }, dir === "in" ? "Nothing here changes it." : "It doesn't change anything here.")];
  };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "fm-wires");
  const focusEl = flowNodeBox(focus, { focus: true });
  const map = h("div", { class: "fm-map" }, svg,
    h("div", { class: "fm-col fm-in" }, h("h4", null, "Changed by"), side("in")),
    h("div", { class: "fm-col fm-mid" }, h("h4", null, "This"), focusEl),
    h("div", { class: "fm-col fm-out" }, h("h4", null, "Changes"), side("out")));
  // Wide: a curve from each box to the focus, its labels on it.
  map.redraw = () => {
    svg.replaceChildren();
    const wide = map.closest(".fm")?.classList.contains("fm-wide");
    for (const l of map.querySelectorAll(".fm-labels")) Object.assign(l.style, { left: "", top: "" });
    if (!wide || !map.isConnected) return;
    const m = map.getBoundingClientRect(), f = focusEl.getBoundingClientRect();
    for (const entry of map.querySelectorAll(".fm-entry")) {
      const nodeEl = entry.querySelector(".fm-node"), labels = entry.querySelector(".fm-labels"), r = nodeEl.getBoundingClientRect();
      const out = !!entry.closest(".fm-out");
      const x1 = (out ? f.right : r.right) - m.left, y1 = (out ? f.top + f.height / 2 : r.top + r.height / 2) - m.top;
      const x2 = (out ? r.left : f.left) - m.left, y2 = (out ? r.top + r.height / 2 : f.top + f.height / 2) - m.top;
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path"), dx = (x2 - x1) / 2;
      p.setAttribute("d", `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`);
      p.setAttribute("class", "fm-path fm-p-" + entry.dataset.kind);
      svg.append(p);
      // Its labels at the middle of the curve.
      Object.assign(labels.style, { left: (x1 + x2) / 2 + "px", top: (y1 + y2) / 2 + "px" });
    }
    // Labels on one side that would overlap: moved apart, top to bottom (they stay beside their wires).
    for (const col of map.querySelectorAll(".fm-in, .fm-out")) {
      const list = [...col.querySelectorAll(".fm-labels")].map(l => ({ l, top: parseFloat(l.style.top), h: l.offsetHeight })).sort((a, b) => a.top - b.top);
      let below = -Infinity;
      for (const x of list) { const top = Math.max(x.top, below + x.h / 2 + 4); x.l.style.top = top + "px"; below = top + x.h / 2; }
    }
  };
  requestAnimationFrame(() => map.redraw());
  return map;
}
