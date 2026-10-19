// Control panels: the GM's own panels of controls, laid out on a grid (boards with pins are in
// js/gm-controls.js; both are Clockwork controls, see js/clockwork.js). Each control sets a
// Global or Local value, or is just a picture or text.
//
// Kept with the boards in store.state.gmControls (the GM's device):
//   { id, kind: "panel", name, cols, rows, controls: [ctl] }
//   ctl: { id, type, x, y, w, h,           its place on the grid (square cells, from 0 at the top left)
//          label?, color?, icon?,          icon: a built-in icon; or a drawing, kept as items keep
//          iconDoc?, iconSvg?, iconLib?    theirs (a copy, and the library drawing it came from):
//                                          the Picture control (type "icon") and buttons show it,
//                                          live with the Global values it reads
//          tab?                            the tab it shows on (see Tabs controls below); none: always
//          reverse?                        slider and switch: more (on) is left or down, not right
//                                          or up (taller than wide, they stand upright)
//          scope, target, name,            the value it sets: scope "party" (a Global), "character"
//                                          or "item" (Locals), as boards' pins do
//          min, max, step                  slider and range slider (default: the value's own range)
//          name2                           range slider: the upper value (name is the lower)
//          vertices: [{ label, name, amount }], at: { x, y }
//                                          polygon: a corner per value; the handle (at, 0 to 1 across
//                                          and down) gives each corner's value amount × closeness
//          off, on                         switch (default 0 and 1)
//          action: "set" | "add", amount   button
//          options: [{ label, value }]     dropdown (default: the value's choices, else Off and On)
//          choose: "players"               dropdown: the party's characters instead, setting no value:
//                                          whose Local values its pictures show (see Players dropdowns)
//          from                            a Players dropdown on the panel: a picture shows the Local
//                                          values of whoever is chosen in it, a control that sets values
//                                          sets theirs (scope "character"; else scope/target as above)
//          board: { image?, layers?, pins } board: a picture with pins (see gmBoard, js/gm-controls.js)
//          showIf?, lockIf?                a condition ({ value, op, to }, as a rule's): shown only
//                                          while it holds; locked (can't be used) while it holds.
//                                          Rules show, hide and lock controls by setting the values
//                                          these read (see Following values below). A panel can have
//                                          a showIf too. A label or Text can show values: "{door}".
//          action "rules"                  button: sets nothing, just runs its rules
//          held?: [entry]                  socket: what it starts holding (an item and what's in it),
//                                          when the panel is shown to players (see Sockets)
//          bg?                             a background (a panel can have one too): { image } (a
//                                          stored picture) or a drawing (iconDoc, iconSvg, iconLib:
//                                          live with the values it reads), fit "cover" (fill, the
//                                          default) | "contain" | "stretch", fade 0 | 1 | 2 (a veil
//                                          over it, so controls stay readable). See Backgrounds.
//          levels, items: [tab]            tabs: a tree of tabs, levels deep (see Tabs controls below);
//                                          a tab's picture: icon, or a drawing (iconDoc, iconSvg, iconLib) }

const CONTROL_TYPES = [["slider", "Slider"], ["range", "Range slider"], ["toggle", "Switch"], ["button", "Button"], ["dropdown", "Dropdown"],
  ["polygon", "Polygon"], ["board", "Board"], ["socket", "Socket"], ["tabs", "Tabs"], ["icon", "Picture"], ["text", "Text"]];
// The kinds offered when making one, in groups: a range slider is a slider with two handles (Handles).
const CONTROL_KINDS = CONTROL_TYPES.filter(([k]) => k !== "range");
const CONTROL_GROUPS = [["Layout", ["tabs"]], ["Display", ["text", "icon"]], ["Interactive", ["slider", "toggle", "button", "dropdown", "polygon", "board", "socket"]]];
const SETS_VALUE = new Set(["slider", "toggle", "button", "dropdown"]); // one value, `name`
const isUpright = ctl => ctl.h > ctl.w;

// ------------------------------------------------------------------ following values
// Controls follow values, as a board's pins already do: shown while a condition holds (showIf),
// locked while one holds (lockIf), and words with values in them ("The door is {door}"). So a rule
// hides, shows or locks a control, or changes its words, by setting a value. Their rules: "A
// control is used" (js/triggers.js: controlUsed).
const controlCondHolds = c => !!c && typeof conditionHolds === "function" && conditionHolds({ by: "gm" }, c);
const controlShown = c => !c?.showIf || controlCondHolds(c.showIf);
const controlLocked = c => !!c?.lockIf && controlCondHolds(c.lockIf);
// Words with values filled in. {name}: the value in the control's own scope (the one it sets);
// {global.storm}, {char.local.luck}…: any by its address. A value with choices shows the choice.
function fillWords(ctl, text, specs) {
  if (!text || !text.includes("{")) return text;
  return text.replace(/\{\s*([A-Za-z_][\w.]*)\s*\}/g, (m, key) => {
    if (!key.includes(".")) return showValue(namedSpec(ctl, key, specs), namedValue(ctl, key, specs));
    const v = typeof ruleRead === "function" ? ruleRead({ by: "gm" }, key) : undefined, g = /^global\.(.+)$/.exec(key);
    return showValue(g ? specs.get("global:" + g[1]) : null, v);
  });
}
// Who a panel's controls act as. The GM's own panels: the GM (values set through Clockwork, the
// control's rules run here). A panel shown to a player (panel.sharedId: js/shared.js): each change
// and use goes through the host to the GM's device that showed it, which makes it (as the GM) and
// runs the control's rules; the player's screen moves at once (a preview, kept until it's made).
const isSharedPanel = panel => !!panel?.sharedId;
// As players see it: shown to them, or the GM's preview of that (panel.preview: see openPanelPreview).
const isPreviewPanel = panel => !!panel?.preview;
const isPlayerView = panel => isSharedPanel(panel) || isPreviewPanel(panel);
// ------------------------------------------------------------------ how it looks to players
// A panel's look (panel.display) and any control's own (ctl.display: only what it changes from the
// panel's): what players see follows it, as do the preview and the GM's card switched to As players
// see it (ui.panelAsPlayers); the GM's card otherwise shows everything, to work with. One set of
// choices at both levels; a few are the panel's alone (panel: true). The panel's own CSS
// (panel.css) goes on top, kept to the panel (scopedPanelCss).
const LOOK = [
  { key: "labels", label: "Labels", help: "a control's name or words" },
  { key: "values", label: "Values", help: "a slider's number, a Text control's value" },
  { key: "notes", label: "Notes and hints", help: "the lock badge, a socket's hints and who put something in, the note under a shown panel" },
  { key: "border", label: "Borders", help: "the line around each control" },
  { key: "tint", label: "Colour edge and tint", help: "a control's colour: its edge and the tint behind it" },
  { key: "card", label: "Card behind each control", help: "off: controls sit straight on the panel" },
  { key: "corners", label: "Corners", choices: [["round", "Rounded"], ["square", "Square"]] },
  { key: "size", label: "Text size", choices: [["s", "Small"], ["m", "Normal"], ["l", "Large"], ["xl", "Larger"]] },
  { key: "font", label: "Font", choices: [["app", "The app's"], ["serif", "Serif"], ["plain", "Plain"], ["mono", "Typewriter"], ["hand", "Handwritten"]] },
  { key: "gap", label: "Gaps between controls", panel: true, choices: [["none", "None"], ["s", "Small"], ["m", "Normal"], ["l", "Large"]] },
  { key: "frame", label: "Space around the panel", panel: true, help: "the padding around its grid" },
  { key: "title", label: "Its name on players' screens", panel: true, help: "the title of the window it opens in" },
];
const LOOK_DEFAULT = { labels: true, values: true, notes: true, border: true, tint: true, card: true, corners: "round", size: "m", font: "app", gap: "m", frame: true, title: true };
const panelLook = panel => ({ ...LOOK_DEFAULT, ...(panel?.display || {}) });
const controlLook = (panel, ctl) => ({ ...panelLook(panel), ...(ctl?.display || {}) });
// Styled as players see it: shown to them, the preview, or the GM's card switched to it.
const lookStyled = panel => isPlayerView(panel) || !!ui.panelAsPlayers?.has(panel.id);
// A look as classes: what differs from the default (lk-no<key>, lk-<key>-<choice>).
const lookClasses = (look, panelLevel) => LOOK.filter(d => !!d.panel === panelLevel && look[d.key] !== LOOK_DEFAULT[d.key])
  .map(d => d.choices ? `lk-${d.key}-${look[d.key]}` : `lk-no${d.key}`);
// A look's choices in an editor: the panel's (set), or a control's (each "As the panel", or its own).
function lookField(draft, panel = null) {
  const own = draft.display || {}, base = panel ? panelLook(panel) : LOOK_DEFAULT;
  const set = (key, v) => { draft.display = { ...(draft.display || {}) }; if (v === undefined) delete draft.display[key]; else draft.display[key] = v; if (!Object.keys(draft.display).length) delete draft.display; };
  const row = d => {
    const opts = d.choices || [[true, "Show"], [false, "Hide"]];
    const word = v => opts.find(o => o[0] === v)?.[1] || "";
    const choices = panel ? [["", `As the panel (${word(base[d.key]).toLowerCase()})`], ...opts] : opts;
    const now = panel ? (d.key in own ? own[d.key] : "") : (d.key in own ? own[d.key] : LOOK_DEFAULT[d.key]);
    return h("label", { class: "field look-row" }, h("span", null, d.label, d.help && h("small", { class: "muted" }, ` (${d.help})`)),
      h("select", { onchange: e => { const i = e.target.selectedIndex, v = choices[i][0]; set(d.key, v === "" || (!panel && v === LOOK_DEFAULT[d.key]) ? undefined : v); } },
        choices.map(([v, l]) => h("option", { selected: v === now }, l))));
  };
  return h("details", { class: "field look-field" }, h("summary", null, "How players see it"),
    h("p", { class: "muted small" }, panel ? "This control's own look; anything left As the panel follows the panel's."
      : "Players, and the preview, see the panel this way. Your own card shows everything to work with, unless you switch it to As players see it (the eye on its card)."),
    LOOK.filter(d => !panel || !d.panel).map(row));
}

// A panel's own CSS, kept to it: each rule moved inside the panel ([data-panel-css="<id>"] …; & or
// :scope at the start means the panel itself), and what could reach outside it taken out: @import
// and @font-face, links to other places (url() other than data:), fixed or sticky positioning
// (the panel's box also contains what's left: .cp-wrap[data-panel-css]). Returns { css, dropped }.
const panelCssCache = new Map();
function scopedPanelCss(id, text) {
  const key = id + "\n" + text;
  if (panelCssCache.has(key)) return panelCssCache.get(key);
  const root = `[data-panel-css="${id}"]`, dropped = [];
  let sheet;
  try { sheet = new CSSStyleSheet(); sheet.replaceSync(text || ""); } catch { return { css: "", dropped: ["the whole thing: it couldn't be read"] }; }
  if (/@import/i.test(text)) dropped.push("@import");
  // Selectors split at their own commas (not those inside :is(…), [ … ] or quotes).
  const split = s => { const out = []; let depth = 0, q = null, cur = "";
    for (const ch of s) { if (q) { if (ch === q) q = null; } else if (ch === '"' || ch === "'") q = ch; else if ("([".includes(ch)) depth++; else if (")]".includes(ch)) depth--; else if (ch === "," && !depth) { out.push(cur); cur = ""; continue; } cur += ch; }
    return [...out, cur].map(x => x.trim()).filter(Boolean); };
  const scope = s => split(s).map(x => /^(&|:scope)/.test(x) ? root + x.replace(/^(&|:scope)/, "") : `${root} ${x}`).join(", ");
  const safeUrls = v => [...v.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)].every(m => /^data:/i.test(m[2]));
  const decls = style => { const out = [];
    for (let i = 0; i < style.length; i++) {
      const p = style[i], v = style.getPropertyValue(p), imp = style.getPropertyPriority(p);
      if (p === "position" && /fixed|sticky/i.test(v)) { dropped.push(`position: ${v}`); continue; }
      if (/url\(/i.test(v) && !safeUrls(v)) { dropped.push(`a link to elsewhere (${p})`); continue; }
      if (/expression\(|javascript:/i.test(v) || /^(behavior|-moz-binding)$/.test(p)) { dropped.push(p); continue; }
      out.push(`${p}: ${v}${imp ? " !important" : ""}`);
    }
    return out.join("; "); };
  const walk = (rules, top) => [...rules].map(r => {
    if (r instanceof CSSStyleRule) return `${top ? scope(r.selectorText) : r.selectorText} { ${decls(r.style)}${r.cssRules?.length ? " " + walk(r.cssRules, false) : ""} }`;
    if (r instanceof CSSMediaRule) return `@media ${r.conditionText} { ${walk(r.cssRules, top)} }`;
    if (r instanceof CSSSupportsRule) return `@supports ${r.conditionText} { ${walk(r.cssRules, top)} }`;
    if (r instanceof CSSKeyframesRule) { if (/url\(/i.test(r.cssText) && !safeUrls(r.cssText)) { dropped.push(`@keyframes ${r.name}`); return ""; } return r.cssText; }
    dropped.push("@" + (/^@([\w-]+)/.exec(r.cssText)?.[1] || "rule"));
    return "";
  }).filter(Boolean).join("\n");
  const out = { css: walk(sheet.cssRules, true), dropped: [...new Set(dropped)] };
  if (panelCssCache.size > 50) panelCssCache.clear();
  panelCssCache.set(key, out);
  return out;
}
// Its CSS on the page (once per panel, replaced as it changes).
function usePanelCss(panel) {
  const id = "panel-css-" + panel.id, css = panel.css ? scopedPanelCss(panel.id, panel.css).css : "";
  let el = document.getElementById(id);
  if (!css) { el?.remove(); return; }
  if (!el) { el = h("style", { id }); document.head.append(el); }
  if (el.textContent !== css) el.textContent = css;
}
function cssField(draft, id) {
  const out = h("p", { class: "muted small" });
  const show = () => { const r = scopedPanelCss(id || "new", draft.css || ""); out.textContent = !draft.css ? "" : r.dropped.length ? `Taken out (it could reach outside the panel): ${r.dropped.join(", ")}.` : "All kept: it applies inside this panel only."; };
  const box = h("textarea", { class: "css-field", rows: 6, spellcheck: "false", placeholder: ".cp-cell { border-radius: 0; }\n[data-label=\"Ring the bell\"] .cp-btn { font-size: 1.4em; }",
    value: draft.css || "", oninput: e => { draft.css = e.target.value; show(); } });
  show();
  return h("details", { class: "field look-field" }, h("summary", null, "Style (CSS)"),
    h("p", { class: "muted small" }, "Your own CSS for how players see it (and the preview). It only reaches this panel. Its parts: ",
      h("code", null, ".cp-cell"), " (each control; ", h("code", null, "[data-label=\"…\"]"), " picks one by its label, ", h("code", null, ".cp-type-slider"), " a kind), ",
      h("code", null, ".cp-label"), ", ", h("code", null, ".cp-out"), " / ", h("code", null, ".cp-readout"), " (values), ", h("code", null, ".cp-btn"), ", ",
      h("code", null, ".cp-switch"), ", ", h("code", null, ".cp-socket"), ", ", h("code", null, ".cp-grid"), "; ", h("code", null, "&"), " is the panel itself."),
    box, out);
}

// A control used (its rules: "A control is used").
function panelUsed(panel, ctlId, value, signal = "") {
  if (isSharedPanel(panel)) return sharedPanelUse(panel, { type: "used", control: ctlId, ...(typeof value === "number" ? { value } : {}), ...(signal ? { signal } : {}) });
  controlUsed(panel.id, ctlId, value, signal);
}
// One of a control's values set: name (as the control names it), in scope/target (where it's kept).
function panelSet(panel, ctl, name, value, scope = ctl.scope, target = ctl.target) {
  if (isSharedPanel(panel)) return sharedPanelSet(panel, ctl.id, name, value, scope, target);
  return clockwork.change(...clockwork.at(scope, target, name), value, "gm").done;
}
// Once a control's change is sent: its rules ("A control is used").
const usedAfter = (sending, panel, ctl, value) => Promise.resolve(sending).then(() => panelUsed(panel, ctl.id, value), () => {});
// A control's picture: its drawing (live with the Global values it reads, and the Local values of
// `whose`: [charId, entryUid]), else its built-in icon.
function controlPicture(ctl, cls, fallback = null, whose = ["", ""]) {
  if (ctl.iconSvg && ctl.iconDoc) return isLiveDrawing(ctl.iconDoc)
    ? liveDrawnIcon(ctl.iconDoc, ctl.iconSvg, cls, () => iconValueVars(...whose))
    : drawnIcon(ctl.iconSvg, cls) || iconSvg("image", cls);
  const id = ctl.icon || fallback;
  return id ? iconSvg(id, cls) : null;
}
// ------------------------------------------------------------------ Players dropdowns
// A dropdown can list the party's characters (choose: "players") instead of setting a value: the
// Picture controls linked to it (from: its id) show the Local values of whoever is chosen. What's
// chosen is this device's, as tabs are: ui.panelPick["panelId/dropdownId"] (else the first).
const isPlayersDropdown = c => c?.type === "dropdown" && c.choose === "players";
function chosenPlayer(panel, dd) {
  const chars = gmChars(), saved = ui.panelPick[`${panel.id}/${dd.id}`];
  return (chars.find(c => c.id === saved) || chars[0])?.id || "";
}
// A control that sets values for whoever is chosen in a Players dropdown: as one for that player.
function forChosen(panel, ctl) {
  if (!ctl.from || ctl.type === "icon" || isPlayersDropdown(ctl)) return ctl;
  const dd = panel.controls.find(c => c.id === ctl.from);
  return isPlayersDropdown(dd) ? { ...ctl, scope: "character", target: chosenPlayer(panel, dd) } : ctl;
}
// Whose Local values a picture shows: [charId, entryUid] (none: Global values only).
function pictureWhose(panel, ctl) {
  if (ctl.from) { const dd = panel.controls.find(c => c.id === ctl.from); return [isPlayersDropdown(dd) ? chosenPlayer(panel, dd) : "", ""]; }
  if (ctl.scope === "character") return [ctl.target || "", ""];
  if (ctl.scope === "item") { const [c, u] = String(ctl.target || "").split("/"); return [c || "", u || ""]; }
  return ["", ""];
}

// The pictures a panel's boards use (so exports carry them).
const panelImages = panel => [panel.bg?.image, ...(panel.controls || []).flatMap(c => [c.bg?.image, c.board?.image, ...(c.board?.layers || []).map(l => l.image)])].filter(Boolean);

// ------------------------------------------------------------------ backgrounds
// A panel's or a control's background: a picture, or a drawing (live with the values it reads),
// filling it, fitted in or stretched, with a veil over it (fade) to keep controls readable.
const BG_KINDS = new Set(["slider", "range", "toggle", "button", "dropdown", "polygon", "text", "socket"]); // (a board and a Picture have pictures of their own)
const hasBg = bg => !!bg && (!!bg.image || !!(bg.iconSvg && bg.iconDoc));
function bgLayer(bg) {
  if (!hasBg(bg)) return null;
  const fit = bg.fit === "contain" || bg.fit === "stretch" ? bg.fit : "cover";
  let pic;
  if (bg.image) {
    pic = storedImage(bg.image, "cp-bg-pic");
    pic.style.objectFit = fit === "stretch" ? "fill" : fit;
  } else {
    pic = controlPicture(bg, "cp-bg-pic");
    pic?.setAttribute("preserveAspectRatio", fit === "cover" ? "xMidYMid slice" : fit === "stretch" ? "none" : "xMidYMid meet");
  }
  return h("div", { class: "cp-bg" + (bg.fade ? ` fade-${bg.fade}` : ""), "aria-hidden": "true" }, pic);
}
// Its editor: Picture… / Drawing… / None; then Fit and Fade.
function bgField(draft, label = "Background") {
  const box = h("div", { class: "cp-bg-field" });
  const bg = () => draft.bg ||= {};
  const draw = () => {
    const b = draft.bg, on = hasBg(b);
    setChildren(box,
      h("div", { class: "inline wrap" },
        on ? (b.image ? storedImage(b.image, "pic-thumb") : controlPicture(b, "gm-layer-thumb")) : h("span", { class: "gm-bg-blank", title: "None" }),
        h("button", { type: "button", class: "btn", onclick: () => pickImageFiles(false, async ([file]) => {
          try { const id = await addImageFile(file); setItemDrawing(bg(), null); bg().image = id; draw(); } catch (e) { toast(e.message); }
        }) }, icon("image"), "Picture…"),
        h("button", { type: "button", class: "btn", title: "One of your drawings: it moves with the values it reads (clouds, a tide, a glow)",
          onclick: () => openIconPicker(null, () => {}, null, { drawings: drawingLibrary(), onDrawing: d => { setItemDrawing(bg(), d); delete bg().image; draw(); } }) },
          icon("edit"), "Drawing…"),
        on && h("button", { type: "button", class: "btn", onclick: () => { delete draft.bg; draw(); } }, "None")),
      on && h("div", { class: "form grid" },
        h("label", { class: "field" }, h("span", null, "Fit"), h("select", { onchange: e => { if (e.target.value === "cover") delete b.fit; else b.fit = e.target.value; } },
          [["cover", "Fill it (may crop)"], ["contain", "Fit it all in"], ["stretch", "Stretch to its shape"]].map(([v, t]) => h("option", { value: v, selected: (b.fit || "cover") === v }, t)))),
        h("label", { class: "field" }, h("span", null, "Fade"), h("select", { onchange: e => { if (+e.target.value) b.fade = +e.target.value; else delete b.fade; } },
          [[0, "None"], [1, "A little (controls stand out)"], [2, "A lot"]].map(([v, t]) => h("option", { value: v, selected: (b.fade || 0) === v }, t))))));
  };
  draw();
  return h("div", { class: "field" }, h("span", null, label), box);
}
// A background as saved: just what it uses.
function cleanBg(b) {
  if (!hasBg(b)) return undefined;
  return { ...(b.image ? { image: b.image } : { iconDoc: b.iconDoc, iconSvg: b.iconSvg, ...(b.iconLib ? { iconLib: b.iconLib } : {}) }),
    ...(b.fit === "contain" || b.fit === "stretch" ? { fit: b.fit } : {}), ...(b.fade === 1 || b.fade === 2 ? { fade: b.fade } : {}) };
}

// The value a control shows: as it's set where the control applies, else the value's default.
const specOfControl = (ctl, specs) => specs.get(`${ctl.scope === "party" ? "global" : "local"}:${ctl.name}`);
function controlValue(ctl, specs) {
  const v = ctl.name ? valueAt(ctl.scope, ctl.target, valueKey(ctl.name)) : undefined;
  return v ?? specOfControl(ctl, specs)?.value ?? 0;
}
const sendControl = (ctl, value, panel) => sendNamed(ctl, ctl.name, value, panel);
// Through Clockwork (js/clockwork.js), as the GM: set (resolves when the party has it), or shown on
// this device's live icons at once while it's dragged (preview), until it's let go (settle).
const sendNamed = (ctl, name, value, panel) => panelSet(panel, ctl, name, value);
const previewNamed = (ctl, name, value) => clockwork.preview(...clockwork.at(ctl.scope, ctl.target, name), value);
const settle = sending => Promise.resolve(sending).finally(() => clockwork.endPreview());
// Another of a control's values (a range slider's upper, a polygon's corners): as set, else its default.
const namedSpec = (ctl, name, specs) => specs.get(`${ctl.scope === "party" ? "global" : "local"}:${name}`);
const namedValue = (ctl, name, specs, fallback) => (name ? valueAt(ctl.scope, ctl.target, valueKey(name)) : undefined) ?? namedSpec(ctl, name, specs)?.value ?? fallback;

// A drag on a control of the app's own (the range slider, the polygon): party updates wait until
// it's let go. start(ev) when pressed, move(ev) for the press and each move, end() when let go.
function dragOn(el, start, move, end) {
  el.addEventListener("pointerdown", ev => {
    if (ev.button > 0) return;
    ev.preventDefault();
    try { el.setPointerCapture(ev.pointerId); } catch {}
    holdRender(true);
    // Whatever happens, letting go ends it (and lets party updates through again).
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      try { end(); } finally { holdRender(false); }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    start?.(ev);
    move(ev);
  });
}
// Sending while something moves: at most every 150 ms (soon), and at once when it stops (now).
function throttled(send) {
  let timer = null, last = 0;
  const now = () => { clearTimeout(timer); timer = null; last = Date.now(); return send(); };
  return { now, soon: () => { if (!timer) timer = setTimeout(now, Math.max(0, 150 - (Date.now() - last))); } };
}
// Keep a square as large as its box allows (a polygon's).
function fitSquare(box, sq) {
  const fit = () => { const s = Math.min(box.clientWidth, box.clientHeight); if (s) { sq.style.width = s + "px"; sq.style.height = s + "px"; } };
  new ResizeObserver(fit).observe(box);
  setTimeout(fit); // the observer waits for a frame, which a hidden window doesn't draw
}

// ------------------------------------------------------------------ the range slider

function rangeControl(ctl, specs, label, panel) {
  const spec = namedSpec(ctl, ctl.name, specs);
  const a0 = ctl.min ?? spec?.min ?? 0, b0 = ctl.max ?? spec?.max ?? 1, step = ctl.step ?? spec?.step;
  const from = Math.min(a0, b0), to = Math.max(a0, b0), span = to - from || 1;
  const snap = v => {
    v = Math.max(from, Math.min(to, v));
    if (typeof step === "number" && step > 0) v = from + Math.round((v - from) / step) * step;
    return Math.round(v * 1000) / 1000;
  };
  let lo = snap(namedValue(ctl, ctl.name, specs, from)), hi = snap(namedValue(ctl, ctl.name2, specs, to));
  if (lo > hi) [lo, hi] = [hi, lo];
  const up = isUpright(ctl), rev = !!ctl.reverse;
  const thumbLo = h("button", { type: "button", class: "cp-thumb", "aria-label": `${label || "Range"}: from` });
  const thumbHi = h("button", { type: "button", class: "cp-thumb", "aria-label": `${label || "Range"}: to` });
  const fill = h("div", { class: "cp-fill" });
  const track = h("div", { class: "cp-track" + (up ? " upright" : "") }, fill, thumbLo, thumbHi);
  const out = h("output", { class: "cp-out" });
  // Where a value sits along the track: 0 at the left (or bottom), 1 at the right (or top).
  const posOf = v => { const t = (v - from) / span; return rev ? 1 - t : t; };
  const place = () => {
    const a = posOf(lo), b = posOf(hi), s = Math.min(a, b), e = Math.max(a, b);
    for (const [el, p] of [[thumbLo, a], [thumbHi, b]]) el.style[up ? "bottom" : "left"] = p * 100 + "%";
    fill.style[up ? "bottom" : "left"] = s * 100 + "%";
    fill.style[up ? "height" : "width"] = (e - s) * 100 + "%";
    out.textContent = `${fmtNum(lo)} – ${fmtNum(hi)}`;
  };
  place();
  const sender = throttled(() => Promise.all([sendNamed(ctl, ctl.name, lo, panel), sendNamed(ctl, ctl.name2, hi, panel)]));
  const valueAtPointer = ev => {
    const r = track.getBoundingClientRect();
    if (!r.width || !r.height) return up ? hi : lo; // not on screen
    let t = up ? 1 - (ev.clientY - r.top) / r.height : (ev.clientX - r.left) / r.width;
    t = Math.max(0, Math.min(1, t));
    return snap(from + (rev ? 1 - t : t) * span);
  };
  // Which handle a press takes: the one pressed, else the nearer; with both in one place, the
  // way it's then dragged decides.
  let which = null;
  dragOn(track, ev => {
    const v = valueAtPointer(ev);
    which = lo === hi && (v === lo || ev.target.classList.contains("cp-thumb")) ? null
      : ev.target === thumbLo ? "lo" : ev.target === thumbHi ? "hi" : v > hi ? "hi" : v < lo ? "lo" : v - lo <= hi - v ? "lo" : "hi";
  }, ev => {
    const v = valueAtPointer(ev);
    if (!which) { if (v === lo) return; which = v > lo ? "hi" : "lo"; }
    if (which === "lo") lo = Math.min(v, hi); else hi = Math.max(v, lo);
    place();
    previewNamed(ctl, ctl.name, lo);
    previewNamed(ctl, ctl.name2, hi);
    sender.soon();
  }, () => usedAfter(settle(sender.now()), panel, ctl, lo));
  // Arrow keys move a handle the way the arrow points.
  const keys = end => ev => {
    const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[ev.key];
    if (!d) return;
    ev.preventDefault();
    const by = (rev ? -d : d) * (typeof step === "number" && step > 0 ? step : span / 100);
    if (end === "lo") lo = Math.min(snap(lo + by), hi); else hi = Math.max(snap(hi + by), lo);
    place();
    usedAfter(sender.now(), panel, ctl, lo);
  };
  thumbLo.addEventListener("keydown", keys("lo"));
  thumbHi.addEventListener("keydown", keys("hi"));
  return h("div", { class: "cp-dual" + (up ? " upright" : "") }, track, out);
}

// ------------------------------------------------------------------ the polygon
// A corner per value. The handle moves anywhere inside; each corner's value is its amount times
// how close the handle is: all of it at the corner, shared with the next corner along an edge,
// shared by all at the middle (Wachspress coordinates: they always add up to 1).

// A regular polygon's corners, from the top, clockwise, in a 1 × 1 square.
const polyPoints = n => Array.from({ length: n }, (_, i) => {
  const a = -Math.PI / 2 + i * 2 * Math.PI / n;
  return [0.5 + 0.42 * Math.cos(a), 0.5 + 0.42 * Math.sin(a)];
});
const triArea = (a, b, c) => ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
const pdist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function polyWeights(pts, p) {
  const n = pts.length, w = new Array(n).fill(0);
  const corner = pts.findIndex(q => pdist(p, q) < 1e-6);
  if (corner >= 0) { w[corner] = 1; return w; }
  for (let i = 0; i < n; i++) { // on an edge: shared by its two corners
    const j = (i + 1) % n;
    if (Math.abs(triArea(pts[i], pts[j], p)) < 1e-7) {
      const t = pdist(p, pts[i]) / pdist(pts[i], pts[j]);
      if (t >= 0 && t <= 1) { w[i] = 1 - t; w[j] = t; return w; }
    }
  }
  for (let i = 0; i < n; i++) {
    const a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n];
    w[i] = triArea(a, b, c) / (triArea(p, a, b) * triArea(p, b, c));
  }
  const sum = w.reduce((x, y) => x + y, 0);
  return w.map(x => x / sum);
}

// The nearest point inside the polygon (it's convex: inside is the same side of every edge).
function clampToPoly(pts, p) {
  const n = pts.length, o = Math.sign(triArea(pts[0], pts[1], pts[2]));
  if (pts.every((q, i) => triArea(q, pts[(i + 1) % n], p) * o >= 0)) return p;
  let best = [0.5, 0.5], bd = Infinity;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    const q = [a[0] + t * dx, a[1] + t * dy], d = pdist(p, q);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}

function polygonControl(ctl, specs, label, panel) {
  const verts = (ctl.vertices || []).slice(0, 8);
  if (verts.length < 3) return h("p", { class: "muted small" }, "A polygon needs 3 corners or more");
  const pts = polyPoints(verts.length);
  let at = clampToPoly(pts, ctl.at ? [ctl.at.x, ctl.at.y] : [0.5, 0.5]);
  const values = () => polyWeights(pts, at).map((w, i) => Math.round(w * (verts[i].amount ?? 1) * 1000) / 1000);
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("aria-hidden", "true");
  for (const q of pts) {
    const spoke = document.createElementNS(NS, "line");
    Object.entries({ x1: 50, y1: 50, x2: q[0] * 100, y2: q[1] * 100, class: "cp-poly-spoke" }).forEach(([k, v]) => spoke.setAttribute(k, v));
    svg.append(spoke);
  }
  const shape = document.createElementNS(NS, "polygon");
  shape.setAttribute("points", pts.map(q => `${q[0] * 100},${q[1] * 100}`).join(" "));
  shape.setAttribute("class", "cp-poly-shape");
  svg.append(shape);
  const knob = h("span", { class: "cp-poly-knob" });
  // Each corner's name and value, just inside it.
  const labels = verts.map((v, i) => {
    const el = h("span", { class: "cp-poly-label" });
    el.style.left = (0.5 + (pts[i][0] - 0.5) * 0.78) * 100 + "%";
    el.style.top = (0.5 + (pts[i][1] - 0.5) * 0.78) * 100 + "%";
    return el;
  });
  const sq = h("div", { class: "cp-poly-sq", tabindex: 0, role: "group",
    "aria-label": `${label || "Polygon"}: drag inside, or use the arrow keys` }, svg, ...labels, knob);
  const box = h("div", { class: "cp-poly" }, sq);
  fitSquare(box, sq);
  const place = () => {
    const vals = values();
    knob.style.left = at[0] * 100 + "%";
    knob.style.top = at[1] * 100 + "%";
    labels.forEach((el, i) => setChildren(el, verts[i].label || verts[i].name, " ", h("b", null, fmtNum(vals[i]))));
  };
  place();
  const sender = throttled(() => { const vals = values(); return Promise.all(verts.map((v, i) => sendNamed(ctl, v.name, vals[i], panel))); });
  // Where the handle is, kept with the control (on this device).
  const keep = () => updatePanel(panel.id, p => { const c = p.controls.find(c => c.id === ctl.id); if (c) c.at = { x: Math.round(at[0] * 1e4) / 1e4, y: Math.round(at[1] * 1e4) / 1e4 }; });
  dragOn(sq, null, ev => {
    const r = sq.getBoundingClientRect();
    if (!r.width || !r.height) return; // not on screen
    at = clampToPoly(pts, [(ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height]);
    place();
    const vals = values();
    verts.forEach((v, i) => previewNamed(ctl, v.name, vals[i]));
    sender.soon();
  }, () => { usedAfter(settle(sender.now()), panel, ctl); keep(); });
  sq.addEventListener("keydown", ev => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
    if (!d) return;
    ev.preventDefault();
    const by = ev.shiftKey ? 0.1 : 0.02;
    at = clampToPoly(pts, [at[0] + d[0] * by, at[1] + d[1] * by]);
    place();
    usedAfter(sender.now(), panel, ctl);
    keep();
  });
  return box;
}
const fmtNum = v => String(Math.round(v * 1000) / 1000);
const dropdownOptions = (ctl, spec) => ctl.options?.length ? ctl.options
  : spec?.choices?.length ? spec.choices.map((label, value) => ({ label, value })) : [{ label: "Off", value: 0 }, { label: "On", value: 1 }];

// ------------------------------------------------------------------ a control, working

function controlLive(ctl, specs, panel) {
  ctl = forChosen(panel, ctl);
  const spec = specOfControl(ctl, specs), v = controlValue(ctl, specs);
  const label = fillWords(ctl, ctl.label, specs) || ctl.name || "";
  // (for whoever is chosen in a Players dropdown: their name after its label)
  const who = ctl.from && ctl.type !== "icon" && ctl.target && gmChars().find(c => c.id === ctl.target)?.name;
  const caption = label && h("span", { class: "cp-label" }, label, who && h("span", { class: "cp-who cp-note" }, ` · ${who}`));
  switch (ctl.type) {
    case "slider": {
      const min = ctl.min ?? spec?.min ?? 0, max = ctl.max ?? spec?.max ?? 1, step = ctl.step ?? spec?.step ?? "any";
      const out = h("output", { class: "cp-out" }, fmtNum(v));
      // Shown here at once while it moves, sent at most every 150 ms (players' icons follow), and
      // once when let go.
      let timer = null, last = 0, latest = v;
      const send = () => { clearTimeout(timer); timer = null; last = Date.now(); return sendControl(ctl, latest, panel); };
      // Party updates mustn't redraw it mid-drag: held from pressing to letting go (a press that
      // doesn't move it fires no change).
      const release = () => { window.removeEventListener("pointerup", release); window.removeEventListener("pointercancel", release); setTimeout(() => holdRender(false)); };
      const range = h("input", { type: "range", class: "cp-range" + (isUpright(ctl) ? " upright" : "") + (ctl.reverse ? " reverse" : ""),
        min: Math.min(min, max), max: Math.max(min, max), step, value: v, "aria-label": label || "Value",
        ...(isUpright(ctl) ? { "aria-orientation": "vertical" } : {}),
        onpointerdown: () => { holdRender(true); window.addEventListener("pointerup", release); window.addEventListener("pointercancel", release); },
        oninput: ev => {
          latest = +ev.target.value;
          out.textContent = fmtNum(latest);
          previewNamed(ctl, ctl.name, latest);
          if (!timer) timer = setTimeout(send, Math.max(0, 150 - (Date.now() - last)));
        },
        onchange: ev => { latest = +ev.target.value; usedAfter(settle(send()), panel, ctl, latest); } });
      return [caption, h("div", { class: "cp-slider" + (isUpright(ctl) ? " upright" : "") }, range, out)];
    }
    case "range":
      return [caption, rangeControl(ctl, specs, label, panel)];
    case "polygon":
      return [caption, polygonControl(ctl, specs, label, panel)];
    case "toggle": {
      const on = ctl.on ?? 1, off = ctl.off ?? 0, isOn = v === on;
      return h("button", { type: "button", class: "cp-switch" + (isOn ? " on" : "") + (isUpright(ctl) ? " upright" : "") + (ctl.reverse ? " reverse" : ""),
        role: "switch", "aria-checked": String(isOn),
        onclick: () => usedAfter(sendControl(ctl, isOn ? off : on, panel), panel, ctl, isOn ? off : on) }, h("span", { class: "cp-knob" }), label && h("span", { class: "cp-text" }, label));
    }
    case "button": {
      // (Just its rules: it sets nothing)
      const next = ctl.action === "rules" || !ctl.name ? undefined : ctl.action === "add" ? Math.round((v + (ctl.amount ?? 1)) * 1000) / 1000 : ctl.amount ?? 1;
      return h("button", { type: "button", class: "btn cp-btn",
        title: next === undefined ? "Runs its rules" : `${ctl.action === "add" ? `Adds ${ctl.amount ?? 1} to` : `Sets`} ${ctl.name}${ctl.action === "add" ? "" : ` to ${ctl.amount ?? 1}`}`,
        onclick: () => usedAfter(next === undefined ? null : sendControl(ctl, next, panel), panel, ctl, next) },
        controlPicture(ctl, "cp-btn-icon"), label && h("span", { class: "cp-text" }, label));
    }
    case "dropdown":
      if (isPlayersDropdown(ctl)) {
        const chars = gmChars(), at = chosenPlayer(panel, ctl);
        return [caption || h("span", { class: "cp-label" }, "Player"), h("select", { class: "cp-select", "aria-label": label || "Player",
          onchange: ev => { ui.panelPick[`${panel.id}/${ctl.id}`] = ev.target.value; render(); panelUsed(panel, ctl.id); } },
          chars.length ? chars.map(c => h("option", { value: c.id, selected: c.id === at }, c.name)) : h("option", { value: "" }, "No players yet"))];
      }
      return [caption, h("select", { class: "cp-select", "aria-label": label || "Value", onchange: ev => usedAfter(sendControl(ctl, +ev.target.value, panel), panel, ctl, +ev.target.value) },
        dropdownOptions(ctl, spec).map(o => h("option", { value: o.value, selected: o.value === v }, o.label)))];
    case "socket":
      return socketLive(panel, ctl, label);
    case "icon":
      return [ctl.iconDoc && ctl.iconSvg && drawingIsInteractive(ctl.iconDoc) && (isGmDevice() || isSharedPanel(panel)) ? touchablePicture(panel, ctl)
        : controlPicture(ctl, "cp-icon", "question", pictureWhose(panel, ctl)), caption];
    case "board": {
      // Its layers' state on this device, and its groups' members splitting off (kept with it).
      const opts = { key: `${panel.id}/${ctl.id}`, change: fn => updatePanel(panel.id, p => { const c = findItem(p, ctl.id); if (c?.board) fn(c.board); }),
        used: () => panelUsed(panel, ctl.id), // (a pin dropped)
        // (a pin's values, set as the panel acts: see panelSet)
        sendPos: (setters, x, y) => Promise.all(setters.flatMap(s => [[s.xVar, axisValue(x, s.xRange)], [s.yVar, axisValue(y, s.yRange)]].filter(([n]) => n)
          .map(([n, v]) => panelSet(panel, ctl, n, v, s.scope, s.target)))) };
      return [caption, gmBoard(ctl.board || { pins: [] }, opts),
        iconBtn("expand", "Expand: zoom, scroll and layers", () => openBoardZoom(ctl.board || { pins: [] }, ctl.label || "Board", opts), "cp-expand")];
    }
    default: // text: words, and the value it shows (if any)
      return [caption, ctl.name && h("b", { class: "cp-readout" }, showValue(spec, v))];
  }
}

// A Picture control whose drawing has hotspots, used on the panel (the GM's device, as an item's
// drawing is in its details: makeIconInteractive). Its gestures set its variables: global_… the
// Global values, local_… the Local values it shows (Local values of), others while it's on screen;
// "Run the rules" fires "A control is used" for the hotspot (controlUsed).
function touchablePicture(panel, ctl) {
  const whose = pictureWhose(panel, ctl), touch = {};
  const vars = () => ({ ...iconValueVars(...whose), ...touch });
  const node = liveDrawnIcon(ctl.iconDoc, ctl.iconSvg, "cp-icon cp-touch", vars);
  const where = whose[1] ? ["item", `${whose[0]}/${whose[1]}`] : whose[0] ? ["character", whose[0]] : null;
  let ix = null, sent = 0;
  const toDoc = (x, y) => { const m = node.getScreenCTM?.(); if (!m) return null; const p = new DOMPoint(x, y).matrixTransform(m.inverse()); return { x: p.x, y: p.y }; };
  const scale = () => Math.abs(node.getScreenCTM?.()?.a || 1);
  const changed = (values, done) => {
    const setNow = done || Date.now() - sent > 300; // (others follow a drag a few times a second)
    for (const [name, v] of Object.entries(values)) {
      const g = /^global_([A-Za-z][A-Za-z0-9_]*)$/.exec(name), l = /^(?:local|gm)_([A-Za-z][A-Za-z0-9_]*)$/.exec(name);
      const at = g ? clockwork.at("party", "", g[1]) : l && where ? clockwork.at(...where, l[1]) : null;
      if (!at) { touch[name] = v; continue; }
      if (!done) clockwork.preview(...at, v);
      if (setNow) isSharedPanel(panel) ? sharedPanelSet(panel, ctl.id, name, v, ...(g ? ["party", ""] : where)) : clockwork.change(...at, v, "gm");
    }
    if (setNow) sent = done ? 0 : Date.now();
    if (done) clockwork.endPreview();
    refreshLiveIcons();
  };
  node.addEventListener("pointerdown", ev => {
    if (!ix || !ev.isPrimary) return;
    const p = toDoc(ev.clientX, ev.clientY);
    if (!p || !ix.down(p)) return;
    ev.preventDefault();
    holdRender(true); // (the panel isn't redrawn under the finger)
    const id = ev.pointerId;
    const move = m => { if (m.pointerId !== id) return; const q = toDoc(m.clientX, m.clientY); if (q) ix.move(q); };
    const up = u => { if (u.pointerId !== id) return; stop(); const q = toDoc(u.clientX, u.clientY); if (q) ix.up(q); else ix.cancel(); };
    const cancel = c => { if (c.pointerId === id) { stop(); ix.cancel(); } };
    const stop = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); removeEventListener("pointercancel", cancel); setTimeout(() => holdRender(false)); };
    addEventListener("pointermove", move); addEventListener("pointerup", up); addEventListener("pointercancel", cancel);
  });
  loadSvgLay().then(() => {
    const T = window.SvgLayTool, n = normalizedDrawing(ctl.iconDoc, T.normalizeDocument);
    const env = () => T.documentEnv(n, { ...iconVariableDefaults(n), ...readVars(vars) });
    ix = T.createInteraction({ document: () => T.resolveDocument(n, env()), env, onChange: changed,
      onSound: (sound, volume) => { const f = soundVolume(); if (f > 0) T.playSound(n, sound, volume * f); },
      onVibrate: ms => { try { navigator.vibrate?.(ms); } catch {} },
      // (the key is the hotspot's name as svg-lay-tool keeps it: actionKey)
      onApp: (app, key) => { if (app === "signal") panelUsed(panel, ctl.id, undefined, hotspotNames(ctl.iconDoc).find(x => actionKey(x) === key) || key); },
      slop: () => 8 / scale(), tolerance: () => 14 / scale() });
  }).catch(() => {});
  return node;
}

// ------------------------------------------------------------------ Sockets
// A socket takes one item. In a panel shown to players (js/shared.js), a player drops one in from
// the inventory (or picks it: Put something in…) and it leaves the inventory, held by the host in
// the share (server.py: socket_call); Take it puts it back in theirs. Either is "A control is used"
// on the GM's device (its rules read control.has, control.item.…). A socket can start holding an
// item (held: the GM's, each time the panel is shown); ended, what players put in goes back to them.

// What a socket holds now: in a shown panel, the share's; the GM's own panel, shown: the same;
// not shown: what it starts with. { items, by, byName } or null.
function socketHeld(panel, ctl) {
  if (isPreviewPanel(panel)) return panelPreview?.sockets[ctl.id] || null;
  const share = isSharedPanel(panel) ? (party.shares || []).find(s => s.id === panel.sharedId) : shownPanel(panel);
  if (share) return share.sockets?.[ctl.id] || null;
  return ctl.held?.length ? { items: ctl.held, by: "", byName: `The ${term("gm")}` } : null;
}
function socketLive(panel, ctl, label) {
  if (isPreviewPanel(panel)) return socketPreview(panel, ctl, label);
  const held = socketHeld(panel, ctl), top = held?.items?.find(e => !e.parent);
  const player = isSharedPanel(panel), shared = player ? panel.sharedId : shownPanel(panel)?.id;
  const me = player && store.state.characters.find(c => c.id === panel.sharedChar);
  const call = async body => { try { if (me) await party.put(me.id); await party.api("POST", `api/share/${shared}/socket`, { control: ctl.id, ...body }); } catch (e) { toast(e.message); } };
  const put = uid => call({ character: me.id, uid });
  // What it holds: a tile, as in an inventory: tapped, its details, with what can be done with it here
  // (Take it, Give it back); pressed and held, those as its menu.
  const acts = top ? [player && me && { icon: "move", label: "Take it", run: () => call({ character: me.id, take: true }) },
    !player && shared && held.by && { icon: "undo", label: "Give it back", run: () => call({ take: true }) }].filter(Boolean) : [];
  const box = h("div", { class: "cp-socket" + (top ? " full" : "") },
    label && h("span", { class: "cp-label" }, label),
    top ? [socketTile(held, top, acts, player && me ? acts[0].run : null),
        held.by && h("small", { class: "muted cp-note" }, player && held.by === me?.id ? "you put it in" : `put in by ${held.byName}`)]
      : [h("span", { class: "muted small cp-note" }, player ? "Drop an item here" : shared ? "Empty" : "Empty (players put things in once it's shown to them)"),
        player && me && h("button", { type: "button", class: "btn", onclick: () => pickEntries(`Put something in ${label || "it"}`, me, [], map => { const uid = [...map.keys()][0]; if (uid) put(uid); }) },
          icon("plus"), "Put something in…")]);
  if (player && me && !top) {
    box.addEventListener("dragover", ev => { if (ev.dataTransfer.types.includes("text/entry")) { ev.preventDefault(); box.classList.add("over"); } });
    box.addEventListener("dragleave", () => box.classList.remove("over"));
    box.addEventListener("drop", ev => { ev.preventDefault(); box.classList.remove("over"); const [from, uid] = ev.dataTransfer.getData("text/entry").split("|");
      if (from === "inv" && me.items.some(e => e.uid === uid)) put(uid); });
  }
  return box;
}

// ------------------------------------------------------------------ Tabs controls
// A Tabs control (type "tabs") is a tree of tabs, `levels` deep (1 to 4): a row of tabs for each
// level, each row the tabs under the one chosen in the row before. Wider than it's tall, the rows
// are stacked; taller, they stand side by side.
//   { type: "tabs", levels, style?, turn?, items: [{ id, label, icon? | iconDoc?, iconSvg?, iconLib?, items?: [tab] }] }
// style: "horizontal" (rows of tabs), "vertical" (columns), or none (as its shape: rows when wider
// than tall, else columns). turn: in columns, the labels turned (on the panel's left half reading
// up, on its right half reading down, the first level outermost). Each level is a sliding
// switch (slideSwitch), the chosen tab in the control's colour.
// Any control, another Tabs control too, shows on one tab (`tab`: its id) or always (none). On a
// tab, it shows while that tab is chosen, and while any tab under it is. Tabs controls that show on
// a tab nest (a page's own tabs down the side). Controls that can't show together (under different
// tabs) can use the same cells. The tabs chosen are this device's: ui.panelTabs["panelId/tabsId"].

const MAX_TAB_LEVELS = 4;
const isTabs = c => c?.type === "tabs";
const panelItems = panel => panel.controls;
// ------------------------------------------------------------------ sizes
// A panel is one of two sizes (panel.size): Phone, 8 columns, for showing to players (drawn at a
// phone's width everywhere, the GM's card too); or Desktop, 24 columns, the GM's own controls, as
// wide as the screen. Rows: as many as it needs. Only a Phone panel can be shown to players.
const PANEL_SIZES = { phone: { cols: 8, label: "Phone", words: "8 across: for showing to players" }, desktop: { cols: 24, label: "Desktop", words: "24 across: your own controls" } };
const panelSize = p => p?.size === "desktop" ? "desktop" : "phone";
const PANEL_ROWS_MAX = 96;
// Fit a panel's controls to a size: each where it is if it fits; else narrowed to the width and
// moved in from the right; else to the first free place, reading from the top (more rows if need be).
function fitPanelTo(p, size) {
  const cols = PANEL_SIZES[size].cols, placed = [], index = tabIndex(p);
  p.size = size; p.cols = cols;
  const free = (it, r) => r.x >= 0 && r.x + r.w <= cols && !placed.some(o => overlaps(o.r, r) && canShowTogether(p, o.it, it, index));
  for (const it of [...panelItems(p)].sort((a, b) => a.y - b.y || a.x - b.x)) {
    let r = { x: it.x, y: it.y, w: Math.min(it.w, cols), h: it.h };
    if (r.x + r.w > cols) r.x = cols - r.w;
    for (let y = 0; !free(it, r) && y < PANEL_ROWS_MAX * 4; y++) for (let x = 0; x + r.w <= cols; x++) { if (free(it, { ...r, x, y })) { r = { ...r, x, y }; break; } }
    Object.assign(it, r);
    placed.push({ it, r });
  }
  p.rows = Math.min(PANEL_ROWS_MAX, Math.max(1, p.rows || 1, ...placed.map(o => o.r.y + o.r.h)));
}
// Panels from before sizes (any number of columns): the nearer size (6 columns or fewer: Phone). A
// sized panel from when its size had fewer columns (Phone 4, Desktop 12): every control's place
// and size scaled up with the grid, so it looks just as it did.
const panelNeedsSize = p => !PANEL_SIZES[p.size] || p.cols !== PANEL_SIZES[p.size].cols;
function standardizePanels(s) {
  let changed = false;
  for (const p of s.gmControls || []) {
    if (!panelNeedsSize(p)) continue;
    const cols = PANEL_SIZES[p.size]?.cols, k = cols && p.cols ? cols / p.cols : 0;
    if (Number.isInteger(k) && k > 1) {
      for (const c of panelItems(p)) for (const key of ["x", "y", "w", "h"]) c[key] *= k;
      p.cols = cols; p.rows = Math.min(PANEL_ROWS_MAX, (p.rows || 1) * k);
    } else fitPanelTo(p, PANEL_SIZES[p.size] ? p.size : p.cols <= 6 ? "phone" : "desktop");
    changed = true;
  }
  return changed;
}

const overlaps = (a, r) => a.x < r.x + r.w && r.x < a.x + a.w && a.y < r.y + r.h && r.y < a.y + a.h;
const prefixOf = (a, b) => a.length <= b.length && a.every((x, i) => b[i] === x);

// Every tab: id -> { tab, owner (its Tabs control), path (ids from the top level), depth }.
function tabIndex(panel) {
  const out = new Map();
  for (const t of panel.controls.filter(isTabs)) {
    const walk = (items, path) => {
      if (path.length >= (t.levels || 1)) return;
      for (const it of items || []) { const p = [...path, it.id]; out.set(it.id, { tab: it, owner: t, path: p }); walk(it.items, p); }
    };
    walk(t.items, []);
  }
  return out;
}
// The tabs an item is under, outermost first: [{ owner (id), path }].
function tabChain(panel, item, index = tabIndex(panel), seen = new Set()) {
  const at = item?.tab && index.get(item.tab);
  if (!at || seen.has(at.owner.id)) return [];
  seen.add(at.owner.id);
  return [...tabChain(panel, at.owner, index, seen), { owner: at.owner.id, path: at.path }];
}
// Can two items be on screen at once? Not if they're under different tabs of one Tabs control.
function canShowTogether(panel, a, b, index = tabIndex(panel)) {
  const ca = tabChain(panel, a, index), cb = tabChain(panel, b, index);
  return ca.every(x => { const y = cb.find(c => c.owner === x.owner); return !y || prefixOf(x.path, y.path) || prefixOf(y.path, x.path); });
}
// The tabs chosen in a Tabs control (an id per level), on this device: as chosen, else the first.
function chosenTabs(panel, t) {
  const saved = ui.panelTabs[`${panel.id}/${t.id}`] || [], out = [];
  let items = t.items || [];
  for (let l = 0; l < (t.levels || 1) && items.length; l++) {
    const it = items.find(x => x.id === saved[l]) || items[0];
    out.push(it.id);
    items = it.items || [];
  }
  return out;
}
// Is an item showing: are the tabs it's under (and theirs) chosen?
function showing(panel, item, index = tabIndex(panel)) {
  return tabChain(panel, item, index).every(x => { const t = panel.controls.find(c => c.id === x.owner); return t && prefixOf(x.path, chosenTabs(panel, t)); });
}
// The tab a new control goes on: the innermost tab chosen on screen (none without tabs).
function tabHere(panel, index = tabIndex(panel)) {
  const shown = panel.controls.filter(c => isTabs(c) && showing(panel, c, index) && chosenTabs(panel, c).length);
  const deepest = shown.sort((a, b) => tabChain(panel, b, index).length - tabChain(panel, a, index).length)[0];
  return deepest ? chosenTabs(panel, deepest).at(-1) : undefined;
}
// "Weather › Rain", what's chosen on screen (for the arrange bar).
function tabsHereWords(panel, index = tabIndex(panel)) {
  const t = tabHere(panel, index);
  if (!t) return "";
  const at = index.get(t);
  return [...tabChain(panel, at.owner, index).flatMap(x => x.path), ...at.path].map(id => index.get(id)?.tab.label || "?").join(" › ");
}

// Are a Tabs control's labels turned when it's in columns? (Set, else as its Vertical style first had them.)
const tabsTurned = t => t.turn ?? t.style === "vertical";

// A Tabs control, working: a sliding switch of tabs per level, the chosen ones on its thumb.
function tabsLive(panel, t) {
  const chosen = chosenTabs(panel, t), rows = [];
  const down = t.style === "vertical" || (t.style !== "horizontal" && t.w < t.h), turned = down && tabsTurned(t);
  const side = t.x + t.w / 2 <= panel.cols / 2 ? "left" : "right"; // which way turned labels read
  let items = t.items || [];
  for (let l = 0; l < (t.levels || 1) && items.length; l++) {
    const level = l, here = items;
    rows.push(slideSwitch(`${t.label || "Tabs"}, level ${l + 1}`,
      here.map((it, i) => [it.id, [controlPicture(it, "cp-tab-icon"), h("span", null, it.label || `Tab ${i + 1}`)], it.label || `Tab ${i + 1}`]),
      chosen[level], id => { ui.panelTabs[`${panel.id}/${t.id}`] = [...chosen.slice(0, level), id]; render(); },
      { tabs: true, even: true, cls: ["cp-tabs", down ? "down" : "across", turned && `turned ${side}`].filter(Boolean).join(" ") }));
    items = here.find(x => x.id === chosen[l])?.items || [];
  }
  return h("div", { class: ["cp-tab-levels", down ? "down" : "across", turned && side === "right" && "from-right"].filter(Boolean).join(" ") }, rows);
}

// ------------------------------------------------------------------ the grid

const placeCell = (el, r) => { el.style.gridColumn = `${r.x + 1} / span ${r.w}`; el.style.gridRow = `${r.y + 1} / span ${r.h}`; };
// Would `item` at r overlap something it can show with?
const clashes = (panel, item, r) => { const index = tabIndex(panel); return panelItems(panel).some(o => o.id !== item.id && canShowTogether(panel, o, item, index) && overlaps(o, r)); };
const fitsPanel = (panel, r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= panel.cols && r.y + r.h <= panel.rows;

// Change one of this campaign's panels (found again by id: the data may have been replaced).
function updatePanel(panelId, fn, msg) {
  commit(s => { const p = (s.gmControls || []).find(c => c.id === panelId); if (p) fn(p); }, msg);
}
const findItem = (p, id) => panelItems(p).find(c => c.id === id);

function panelGrid(panel, editing) {
  const specs = knownValues(), index = tabIndex(panel);
  const styled = !editing && lookStyled(panel);
  const grid = h("div", { class: ["cp-grid", editing && "editing", styled && "cp-styled", ...(styled ? lookClasses(panelLook(panel), true) : [])].filter(Boolean).join(" ") });
  grid.style.setProperty("--cols", panel.cols);
  grid.style.setProperty("--rows", panel.rows);
  if (editing) grid.append(placingLayer(panel, grid, index));
  for (const item of panelItems(panel)) if (showing(panel, item, index)) { const cell = controlCell(panel, item, specs, editing, grid); if (cell) grid.append(cell); }
  // Its background: behind the grid's cells, the size of the grid.
  const bg = bgLayer(panel.bg);
  if (bg) { grid.classList.add("has-bg"); grid.prepend(bg); }
  if (styled && panel.css) usePanelCss(panel);
  return h("div", { class: `cp-wrap size-${panelSize(panel)}` + (styled && !panelLook(panel).frame ? " lk-noframe" : ""), ...(styled && panel.css ? { "data-panel-css": panel.id } : {}) }, grid);
}

// Arranging: the grid as lines (no gaps), and its empty space where a new control is placed: drag
// a box over free cells (it turns red over another control or off the grid) and the new control
// is that size; a click makes it as big as suits its kind (editPanelControl). On a touch screen a
// tap places one (a swipe scrolls, as anywhere). The arrange bar's Add a control does the same from
// the keyboard.
function placingLayer(panel, grid, index = tabIndex(panel)) {
  const tab = tabHere(panel, index), here = { id: null, tab };
  const layer = h("div", { class: "cp-place", title: "Drag a box to place a control (or click a cell)" });
  layer.style.gridColumn = "1 / -1"; layer.style.gridRow = "1 / -1";
  const ghost = h("div", { class: "cp-ghost", hidden: true });
  const cellAt = ev => { const r = grid.getBoundingClientRect();
    return { x: Math.max(0, Math.min(panel.cols - 1, Math.floor((ev.clientX - r.left) / (r.width / panel.cols)))), y: Math.max(0, Math.min(panel.rows - 1, Math.floor((ev.clientY - r.top) / (r.height / panel.rows)))) }; };
  const boxOf = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x) + 1, h: Math.abs(a.y - b.y) + 1 });
  const bad = r => clashes(panel, here, r) || !fitsPanel(panel, r);
  let start = null, box = null, moved = false, touch = false;
  layer.addEventListener("pointerdown", ev => {
    if (ev.button !== 0) return;
    start = cellAt(ev);
    if (clashes(panel, here, { ...start, w: 1, h: 1 })) { start = null; return; }
    // (a touch: a tap, unless it turns into a scroll, which cancels it)
    touch = ev.pointerType === "touch";
    if (touch) { box = { ...start, w: 1, h: 1 }; moved = false; return; }
    ev.preventDefault();
    try { layer.setPointerCapture(ev.pointerId); } catch {}
    holdRender(true);
    box = { ...start, w: 1, h: 1 }; moved = false;
    placeCell(ghost, box); ghost.hidden = false; ghost.classList.remove("clash");
    grid.append(ghost);
  });
  layer.addEventListener("pointermove", ev => {
    if (!start || touch) return;
    const b = boxOf(start, cellAt(ev));
    if (b.w === box.w && b.h === box.h && b.x === box.x && b.y === box.y) return;
    box = b; moved = true;
    placeCell(ghost, box); ghost.classList.toggle("clash", bad(box));
  });
  const end = () => {
    if (!start) return;
    const r = box, wasDrag = moved;
    start = null;
    if (!touch) { ghost.hidden = true; ghost.remove(); holdRender(false); }
    if (wasDrag && bad(r)) return toast("That box covers another control (or goes off the panel): try again");
    editPanelControl(panel, null, wasDrag ? { ...r, tab } : { x: r.x, y: r.y, tab });
  };
  layer.addEventListener("pointerup", end);
  layer.addEventListener("pointercancel", () => { if (start) { start = null; if (!touch) { ghost.hidden = true; ghost.remove(); holdRender(false); } } });
  return layer;
}
// The first free place for a new control, reading from the top (the arrange bar's Add a control).
function firstFreeCell(panel) {
  const here = { id: null, tab: tabHere(panel) };
  for (let y = 0; y < panel.rows; y++) for (let x = 0; x < panel.cols; x++) if (!clashes(panel, here, { x, y, w: 1, h: 1 })) return { x, y, tab: here.tab };
  return null;
}

function controlCell(panel, ctl, specs, editing, grid) {
  const tabs = isTabs(ctl);
  const bg = BG_KINDS.has(ctl.type) ? bgLayer(ctl.bg) : null;
  const styled = !editing && lookStyled(panel);
  const el = h("div", { class: [`cp-cell cp-type-${ctl.type}`, ctl.color && "coloured", bg && "has-bg", ...(styled ? lookClasses(controlLook(panel, ctl), false) : [])].filter(Boolean).join(" "),
    ...(ctl.label ? { "data-label": ctl.label } : {}) }, bg);
  placeCell(el, ctl);
  if (ctl.color) el.style.setProperty("--cp", ctl.color);
  const live = () => tabs ? tabsLive(panel, ctl) : controlLive(ctl, specs, panel);
  // Hidden (showIf) or locked (lockIf): gone in Play mode; faded and marked in Edit mode, to arrange.
  const hidden = !controlShown(ctl), locked = controlLocked(ctl);
  if (hidden && !editing && (playMode() || isPlayerView(panel))) return null;
  el.classList.toggle("cp-hidden", hidden);
  el.classList.toggle("cp-locked", locked);
  const flag = (hidden || locked) && h("span", { class: "cp-flag cp-note", title: hidden ? "Hidden now: its Shown when doesn't hold (only Edit mode shows it)" : "Locked now: its Locked when holds" },
    icon(hidden ? "eye-off" : "lock"));
  if (!editing) { el.append(...[locked ? h("div", { class: "cp-inert", inert: true }, live()) : live()].flat().filter(Boolean), flag || []); return el; }

  // Arranging: drag it to move, drag its corner to resize (or arrow keys; Shift+arrows resize).
  // A Tabs control's tabs still work, to arrange each tab in turn.
  const body = tabs ? live() : h("div", { class: "cp-inert", inert: true }, live());
  let draft = { x: ctl.x, y: ctl.y, w: ctl.w, h: ctl.h }, mode = null, start = null;
  const cellAt = ev => {
    const r = grid.getBoundingClientRect();
    return { x: Math.floor((ev.clientX - r.left) / (r.width / panel.cols)), y: Math.floor((ev.clientY - r.top) / (r.height / panel.rows)) };
  };
  const bad = r => clashes(panel, ctl, r) || !fitsPanel(panel, r);
  const show = () => { placeCell(el, draft); el.classList.toggle("clash", bad(draft)); };
  const finish = () => {
    const ok = !bad(draft);
    const moved = ["x", "y", "w", "h"].some(k => draft[k] !== ctl[k]);
    if (!ok) { draft = { x: ctl.x, y: ctl.y, w: ctl.w, h: ctl.h }; show(); }
    holdRender(false);
    if (ok && moved) updatePanel(panel.id, p => { const c = findItem(p, ctl.id); if (c) Object.assign(c, draft); });
  };
  const name = ctl.label || CONTROL_TYPES.find(t => t[0] === ctl.type)[1];
  const handle = h("button", { type: "button", class: "cp-handle" + (tabs ? " cp-handle-corner" : ""), "aria-label": `${name}: drag to move, or arrow keys (Shift to resize)`,
    title: tabs ? "Drag to move the tabs" : "",
    onkeydown: ev => {
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
      if (!d) return;
      ev.preventDefault();
      draft = ev.shiftKey ? { ...draft, w: Math.max(1, draft.w + d[0]), h: Math.max(1, draft.h + d[1]) } : { ...draft, x: draft.x + d[0], y: draft.y + d[1] };
      if (bad(draft)) { draft = { x: ctl.x, y: ctl.y, w: ctl.w, h: ctl.h }; return; }
      finish();
    } }, tabs && icon("move"));
  const grip = h("span", { class: "cp-grip", "aria-hidden": "true" });
  const down = (ev, m) => {
    ev.preventDefault();
    ev.stopPropagation();
    mode = m;
    start = cellAt(ev);
    try { ev.target.setPointerCapture(ev.pointerId); } catch {}
    holdRender(true);
    el.classList.add("dragging");
  };
  const move = ev => {
    if (!mode) return;
    const c = cellAt(ev), dx = c.x - start.x, dy = c.y - start.y;
    draft = mode === "move" ? { ...draft, x: Math.max(0, Math.min(panel.cols - ctl.w, ctl.x + dx)), y: Math.max(0, Math.min(panel.rows - ctl.h, ctl.y + dy)) }
      : { ...draft, w: Math.max(1, Math.min(panel.cols - ctl.x, ctl.w + dx)), h: Math.max(1, Math.min(panel.rows - ctl.y, ctl.h + dy)) };
    show();
  };
  const up = () => { if (!mode) return; mode = null; el.classList.remove("dragging"); finish(); };
  handle.addEventListener("pointerdown", ev => down(ev, "move"));
  grip.addEventListener("pointerdown", ev => down(ev, "size"));
  for (const t of [handle, grip]) {
    t.addEventListener("pointermove", move);
    t.addEventListener("pointerup", up);
    t.addEventListener("pointercancel", up);
  }
  el.classList.add("arranging");
  el.classList.toggle("clash", bad(ctl)); // e.g. moved here when a tab was removed
  el.append(body, handle, grip, flag || [],
    iconBtn("edit", tabs ? "Edit these tabs" : "Edit this control", () => editPanelControl(panel, ctl), "cp-edit"));
  return el;
}

// ------------------------------------------------------------------ a panel's card

function controlPanelCard(panel) {
  // (Edit mode arranges its controls; Play mode uses them: the top bar's Play / Edit)
  const key = "gmc:" + panel.id, closed = ui.collapsed.has(key), editing = canEditNow();
  const hidden = !controlShown(panel);
  if (hidden && playMode()) return null;
  const toggle = () => { closed ? ui.collapsed.delete(key) : ui.collapsed.add(key); render(); };
  const where = tabsHereWords(panel);
  return h("div", { class: "group gm-control-card cp-card size-" + panelSize(panel) + (hidden ? " cp-hidden" : "") },
    h("div", { class: "group-head" },
      h("button", { class: "collapse" + (closed ? " closed" : ""), "aria-expanded": String(!closed), onclick: toggle }, icon("chevron"), h("h3", null, panel.name)),
      hidden && h("span", { class: "tag", title: "Its Shown when doesn't hold: Play mode hides it" }, "hidden now"),
      clockwork.practice.on && h("span", { class: "tag on", title: "A panel's preview is open: values show as they are in its practice run, until it's closed" }, "practice run"),
      h("span", { class: "muted small" }, `${PANEL_SIZES[panelSize(panel)].label} · ${plural(panel.controls.length, "control")}`),
      !editing && panelItems(panel).length > 0 && iconBtn("eye", ui.panelAsPlayers?.has(panel.id) ? "Show it to work with (everything)" : "Show it as players see it (its look)", () => {
        ui.panelAsPlayers = new Set(ui.panelAsPlayers || []); ui.panelAsPlayers.has(panel.id) ? ui.panelAsPlayers.delete(panel.id) : ui.panelAsPlayers.add(panel.id); render(); },
        "look-toggle" + (ui.panelAsPlayers?.has(panel.id) ? " on" : "")),
      panelItems(panel).length > 0 && h("button", { class: "btn", title: "See it as players would, and try it out", onclick: () => openPanelPreview(panel) }, icon("play"), "Preview"),
      party.active && isGmDevice() && !shownPanel(panel) && panelSize(panel) === "phone" && h("button", { class: "btn", onclick: () => openShowPanel(panel) }, icon("eye"), "Show to players…"),
      canEditNow() && iconBtn("edit", `Edit ${panel.name}`, () => editControlPanel(panel)),
      iconBtn("trash", `Delete ${panel.name}`, () => {
        const rules = rulesForGone(r => r.appliesTo?.panel === panel.id);
        confirmDialog(`Delete the panel “${panel.name}”? The values it set keep their values.${rules ? ` Its ${plural(rules, "rule")} (A control is used) go too.` : ""}`, "Delete", () => {
          commit(s => { s.gmControls = s.gmControls.filter(c => c.id !== panel.id); }, `Deleted ${panel.name}`, true);
          if (rules) saveRuleBook(list => list.filter(r => r.appliesTo?.panel !== panel.id), null);
        });
      }, "danger-hover")),
    shownPanelBar(panel),
    !closed && [
      editing && h("div", { class: "cp-arrange-bar" },
        h("button", { type: "button", class: "btn", onclick: () => { const at = firstFreeCell(panel); at ? editPanelControl(panel, null, at) : toast("No room left: add rows (the pencil above) or move something"); } }, icon("plus"), "Add a control"),
        h("p", { class: "muted small" }, "Drag a box over the grid to place a control (or click a cell; Tabs splits the panel into tabs). Drag a control to move it, or its corner to resize it; or select it and use the arrow keys (Shift to resize). The pencil edits it.",
          where && [" Arranging ", h("b", null, where), ": choose another tab to arrange it."])),
      !panelItems(panel).length && !editing ? h("p", { class: "muted pad" }, "No controls yet: switch to Edit (the top bar) to add some.") : panelGrid(panel, editing),
    ]);
}

// ------------------------------------------------------------------ making and editing

// ------------------------------------------------------------------ previewing a panel
// What players would see, to try out before showing it: the panel as it goes to them
// (panelForPlayers: hidden controls gone, locked ones greyed), working as it would for them, as a
// practice run (clockwork.practice): what its controls set, and their rules, take effect while the
// preview's open, and it all goes back when it's closed (or Start again). Its sockets take test
// items from the catalog. It follows the panel as it's changed (arranged beside it, in Edit mode).
let panelPreview = null; // { id, box, close, sockets: { controlId: { items, by, byName } } }
const previewSockets = panel => Object.fromEntries((panel.controls || []).filter(c => c.type === "socket" && c.held?.length)
  .map(c => [c.id, { items: clone(c.held), by: "", byName: `The ${term("gm")}` }]));
function openPanelPreview(panel) {
  panelPreview?.close();
  const box = h("div", { class: "panel-preview" });
  // (a pointer down in it: not redrawn under it, mid-drag)
  box.addEventListener("pointerdown", () => { box.dataset.held = "1"; addEventListener("pointerup", () => { delete box.dataset.held; setTimeout(drawPanelPreview); }, { once: true }); });
  clockwork.practice.start();
  const again = () => { clockwork.practice.start(); panelPreview.sockets = previewSockets(gmControls().find(p => p.id === panel.id) || panel); render(); toast("Back to how it was"); };
  let close;
  close = openModal(`Preview: ${panel.name}`, box, { wide: true, dock: true,
    footer: [h("button", { class: "btn", onclick: again }, icon("undo"), "Start again"), h("button", { class: "btn primary", onclick: () => close() }, "Done")],
    onClose: () => { if (panelPreview?.close === close) { panelPreview = null; clockwork.practice.end(); } } });
  panelPreview = { id: panel.id, box, close, sockets: previewSockets(panel) };
  drawPanelPreview();
  return close;
}
// Drawn again on every render (render: the values changed, or the panel did).
function drawPanelPreview() {
  const pv = panelPreview;
  if (!pv || !pv.close.panel?.isConnected) return;
  const src = gmControls().find(p => p.id === pv.id);
  if (!src) return pv.close();
  if (pv.box.dataset.held || pv.box.contains(document.activeElement?.matches?.("input, textarea, select") ? document.activeElement : null)) return;
  const panel = { ...panelForPlayers(src), preview: true };
  setChildren(pv.box,
    h("p", { class: "banner small preview-banner" }, icon("play"), h("span", null, h("b", null, "As players see it. "),
      "A practice run: what you do here works as it would for them (values change, its rules run), and it all goes back when you close this.")),
    controlShown(panel) ? panelGrid(panel, false) : h("p", { class: "muted pad" }, "Players would see: Not here right now (its Shown when doesn't hold)."),
    h("p", { class: "muted small" }, "Only this panel's rules run here. Items' rules and the world's wait until you close it, since they'd change real things."));
}
// What a socket holds, as a tile (the inventory's): tapped, its details with what can be done with it
// here (acts: [{ icon, label, run }]); pressed and held, those as its menu. take: a player's, it drags
// out onto their inventory (a wide screen), as one dropped in puts it there.
function socketTile(held, e, acts, take = null) {
  const holder = { id: "socket", items: held.items, coins: {} };
  const open = () => { let close; close = openModal(entryName(e), itemDetails(currentItem(e, holder), null, e.srcId),
    { footer: [...acts.map(a => h("button", { class: "btn", onclick: () => { close(); a.run(); } }, icon(a.icon), a.label)), h("button", { class: "btn primary", onclick: () => close() }, "Done")] }); };
  const st = { char: holder, id: "socket", prefs: { show: { tiles: { details: false, tags: false, worth: false, weight: false } } }, open, menu: () => acts };
  const tile = entryTile(st, e);
  if (take) {
    tile.draggable = true;
    tile.addEventListener("dragstart", ev => { ev.dataTransfer.setData("text/socket", e.uid); ev.dataTransfer.effectAllowed = "move"; socketDrag = take; document.body.classList.add("socket-dragging"); });
    tile.addEventListener("dragend", () => { socketDrag = null; document.body.classList.remove("socket-dragging"); });
  }
  return h("div", { class: "cp-socket-tile tiles detail-minimal" }, tile);
}
// A socket's item being dragged out (its Take it): dropped anywhere on the inventory, taken. (In
// the capture phase: the inventory's own drop zones would keep the drop to themselves.)
let socketDrag = null;
const onInventory = ev => !!ev.target.closest?.(".view-inventory, #panels");
document.addEventListener("dragover", ev => { if (socketDrag && onInventory(ev)) { ev.preventDefault(); ev.dataTransfer.dropEffect = "move"; } }, true);
document.addEventListener("drop", ev => {
  if (!socketDrag || !onInventory(ev)) return;
  ev.preventDefault(); ev.stopPropagation();
  const take = socketDrag; socketDrag = null; document.body.classList.remove("socket-dragging");
  take();
}, true);
// A socket in a preview: a test item from the catalog in, or out; either is "A control is used".
function socketPreview(panel, ctl, label) {
  const held = socketHeld(panel, ctl), top = held?.items?.find(e => !e.parent);
  const used = (items, has) => { const e = items.find(x => !x.parent); controlUsed(panel.id, ctl.id, undefined, "", { item: socketItemFacts(e, items.filter(x => x.parent)), has }); render(); };
  const put = () => openStockPicker({ title: `Put a test item in ${label || "it"}`, has: () => false,
    add: (id, snapshot) => { const tmp = { items: [] }; addToInventory(tmp, { ...snapshot, id }, 1); panelPreview.sockets[ctl.id] = { items: tmp.items, by: "preview", byName: "you" }; used(tmp.items, true); } });
  const take = () => { const items = held.items; delete panelPreview.sockets[ctl.id]; used(items, false); };
  return h("div", { class: "cp-socket" + (top ? " full" : "") },
    label && h("span", { class: "cp-label" }, label),
    top ? [socketTile(held, top, [{ icon: "move", label: "Take it", run: take }]),
        h("small", { class: "muted cp-note" }, held.by === "preview" ? "a test item" : `put in by ${held.byName}`)]
      : [h("span", { class: "muted small cp-note" }, "Empty"),
        h("button", { type: "button", class: "btn", title: "Put a test item in (from the catalog)", onclick: put }, icon("plus"), "Test item…")]);
}

// ------------------------------------------------------------------ showing a panel to players
// A shared screen (js/shared.js: kind "panel"): the GM chooses who; the panel goes as it is (its
// pictures to the host), and again when it's changed; players' uses come back to this device
// (takePanelUses).

// The share showing this panel (from this device), if it's shown.
const shownPanel = panel => (party.active ? party.shares || [] : []).find(s => s.kind === "panel" && s.fromMine && s.panelId === panel.id) || null;
// A panel as it goes to players: as it is (its controls, drawings and pictures' ids).
const panelForPlayers = panel => clone({ id: panel.id, kind: "panel", name: panel.name, size: panelSize(panel), cols: panel.cols, rows: panel.rows, controls: panel.controls,
  ...(panel.showIf ? { showIf: panel.showIf } : {}), ...(panel.bg ? { bg: panel.bg } : {}), ...(panel.display ? { display: panel.display } : {}), ...(panel.css ? { css: panel.css } : {}) });
// Its pictures, so the players' devices can fetch them from the host.
async function uploadPanelImages(panel) {
  for (const id of panelImages(panel)) { const data = await imageStore.get(id); if (data) await party.uploadImage(id, data).catch(() => {}); }
}
function openShowPanel(panel) {
  const chosen = new Set(party.chars.filter(c => c.online && !c.mine).map(c => c.id));
  let close;
  const go = async () => {
    if (!chosen.size) return toast("Choose who to show it to");
    close();
    try {
      await uploadPanelImages(panel);
      await party.api("POST", "api/share", { kind: "panel", panelId: panel.id, title: panel.name, panel: panelForPlayers(panel), to: [...chosen] });
      toast(`Showing ${panel.name}: what they do with it comes here`);
    } catch (e) { toast(e.message); }
  };
  close = openModal(`Show ${panel.name}`, h("div", { class: "form" },
    h("p", { class: "muted small" }, "It opens for them to use: what they press, flip or drop comes to this device, which sets the values and runs the controls' rules, as if you'd done it. Hidden controls stay hidden; locked ones can't be used. It stays until you end it."),
    h("div", { class: "group" }, party.chars.map(c => h("label", { class: "row check-row" },
      h("input", { type: "checkbox", checked: chosen.has(c.id), onchange: e => { e.target.checked ? chosen.add(c.id) : chosen.delete(c.id); } }),
      onlineDot(c.online), h("span", { class: "grow" }, c.name), c.mine && h("span", { class: "tag" }, "yours"))))),
  { footer: [h("button", { class: "btn", onclick: () => close() }, "Cancel"), h("button", { class: "btn primary", onclick: go }, icon("eye"), "Show it")] });
}
// On the GM's card while it's shown: to whom, End, and what players did last.
function shownPanelBar(panel) {
  const s = shownPanel(panel);
  if (!s) return null;
  const log = (panelUseLog.get(panel.id) || []).slice(-3).reverse();
  return h("div", { class: "cp-shown" },
    h("div", { class: "inline" }, icon("eye"), h("span", { class: "grow" }, "Shown to ", h("b", null, s.to.map(id => party.chars.find(c => c.id === id)?.name || "someone").join(", "))),
      h("button", { class: "btn", onclick: () => endShare(s) }, "End")),
    log.length > 0 && h("ul", { class: "cp-uses muted small" }, log.map(x => h("li", null, x))));
}

// How many of the rule book's rules a removed panel or control takes with it.
const rulesForGone = fn => (store.campaign()?.rules || []).filter(r => r && fn(r)).length;

// A socket's Starts holding: an item from the catalog (it's there each time the panel is shown).
function socketStartField(draft) {
  const box = h("div", { class: "inline wrap" });
  const draw = () => {
    const top = draft.held?.find(e => !e.parent);
    setChildren(box, top ? [itemIcon(top.item, "row-icon"), h("b", null, entryName(top))] : h("span", { class: "muted" }, "Nothing"),
      h("button", { type: "button", class: "btn", onclick: () => openStockPicker({ title: "What it starts holding",
        has: id => draft.held?.some(e => !e.parent && e.srcId === id),
        add: (id, snapshot) => { const tmp = { items: [] }; addToInventory(tmp, { ...snapshot, id }, 1); draft.held = tmp.items; draw(); } }) }, icon("plus"), top ? "Change…" : "Choose…"),
      top && h("button", { type: "button", class: "btn", onclick: () => { delete draft.held; draw(); } }, "Nothing"));
  };
  draw();
  return h("div", { class: "field" }, h("span", null, "Starts holding"), box,
    h("small", { class: "muted" }, "It's there each time the panel is shown to players (the golden idol on its altar). Players drop things in and take them out; its rules see what (A control is used: the item is…, the item weighs…)."));
}

// A condition field (Shown when, Locked when): none, or one condition as a rule's pills.
function condField(draft, key, label, none, add, help) {
  const box = h("div", { class: "rule-blocks cp-cond" });
  const firstGlobal = () => [...knownValues().values()].find(v => v.scope === "global")?.name || "door";
  const draw = () => setChildren(box, draft[key]
    ? h("div", { class: "rblk rblk-if" }, h("div", { class: "rblk-line" }, condPills(draft[key], draw, label),
        h("button", { type: "button", class: "rblk-x", "aria-label": `${label}: none`, onclick: () => { delete draft[key]; draw(); } }, "×")))
    : h("div", { class: "inline" }, h("span", { class: "muted" }, none),
        h("button", { type: "button", class: "btn", onclick: () => { draft[key] = { value: "global." + firstGlobal(), op: "=", to: 1 }; draw(); } }, icon("plus"), add)));
  draw();
  return h("div", { class: "field" }, h("span", null, label), box, h("small", { class: "muted" }, help));
}

// A control's rules (kept in the rule book: "A control is used", applying to it or its panel).
function controlRules(panel, ctl) {
  const box = h("div", { class: "field cp-rules" });
  const mine = () => (store.campaign()?.rules || []).map(ruleOf).filter(Boolean)
    .filter(r => r.appliesTo?.panel === panel.id && (!r.appliesTo.control || r.appliesTo.control === ctl.id));
  const draw = () => setChildren(box, h("span", null, "Rules"),
    !clockworkOn() && h("p", { class: "muted small" }, "Rules, values and controls are off for this campaign."),
    mine().map(r => h("button", { type: "button", class: "rule-card", onclick: () => openRuleEditor(r, null, draw) },
      h("span", { class: "rule-card-words" }, r.name && h("b", null, r.name + ": "), ruleWords(r)),
      h("span", { class: "chips" }, h("span", { class: "chip scope" }, r.appliesTo.control ? "This control" : `Every control on ${panel.name}`)))),
    h("button", { type: "button", class: "rule-add-block", onclick: () => openRuleEditor(null,
      { when: "control", appliesTo: { panel: panel.id, control: ctl.id }, do: [{ message: "" }] }, draw) }, "+ New rule for this control"),
    h("small", { class: "muted" }, "What happens when it's used: pressed, switched, let go, chosen, a pin dropped, a hotspot touched. They're in the rule book (GM → Controls → Rules) too."));
  draw();
  return box;
}

function editControlPanel(panel) {
  const isNew = !panel;
  const draft = panel ? { name: panel.name, size: panelSize(panel), cols: panel.cols, rows: panel.rows, ...(panel.showIf ? { showIf: clone(panel.showIf) } : {}), ...(panel.bg ? { bg: clone(panel.bg) } : {}),
    ...(panel.display ? { display: clone(panel.display) } : {}), ...(panel.css ? { css: panel.css } : {}) }
    : { name: "", size: "phone", cols: PANEL_SIZES.phone.cols, rows: 12 };
  let close;
  const num = (key, label, min, max) => h("label", { class: "field" }, h("span", null, label),
    h("input", { type: "number", min, max, step: 1, value: draft[key], onchange: e => { draft[key] = Math.max(min, Math.min(max, Math.round(+e.target.value || min))); e.target.value = draft[key]; } }));
  const save = () => {
    const name = draft.name.trim() || "Panel";
    const resized = panel && draft.size !== panelSize(panel);
    draft.cols = PANEL_SIZES[draft.size].cols;
    if (panel && !resized && panelItems(panel).some(c => !fitsPanel(draft, c))) return toast("Some controls or tabs would be below the last row: move or remove them first");
    if (draft.showIf && !clockwork.find(draft.showIf.value)) return toast("Shown when: choose a value (global.door, char.local.luck…)");
    close();
    if (isNew) {
      const p = { id: "gc" + uid(), kind: "panel", name, size: draft.size, cols: draft.cols, rows: draft.rows, controls: [], ...(draft.showIf ? { showIf: draft.showIf } : {}),
        ...(cleanBg(draft.bg) ? { bg: cleanBg(draft.bg) } : {}), ...(draft.display ? { display: draft.display } : {}), ...(draft.css?.trim() ? { css: draft.css.slice(0, 20000) } : {}) };
      commit(s => { s.gmControls = [...(s.gmControls || []), p]; }, `Made ${name}`);
    } else updatePanel(panel.id, p => {
      Object.assign(p, { name, rows: draft.rows });
      if (resized) fitPanelTo(p, draft.size); // (its controls refitted: kept where they fit, else moved)
      if (draft.showIf) p.showIf = draft.showIf; else delete p.showIf;
      const bg = cleanBg(draft.bg);
      if (bg) p.bg = bg; else delete p.bg;
      if (draft.display) p.display = draft.display; else delete p.display;
      if (draft.css?.trim()) p.css = draft.css.slice(0, 20000); else delete p.css;
    }, `Saved ${name}`);
  };
  close = openModal(isNew ? "New panel" : `Edit ${panel.name}`, h("div", { class: "form" },
    h("label", { class: "field" }, h("span", null, "Name"),
      h("input", { type: "text", value: draft.name, maxlength: 60, placeholder: "e.g. Ship's helm, Weather, Doom clock", oninput: e => { draft.name = e.target.value; } })),
    h("div", { class: "form grid" },
      h("label", { class: "field" }, h("span", null, "Size"),
        h("select", { onchange: e => { draft.size = e.target.value; } }, Object.entries(PANEL_SIZES).map(([k, z]) => h("option", { value: k, selected: k === draft.size }, `${z.label}: ${z.words}`)))),
      num("rows", "Rows", 1, PANEL_ROWS_MAX)),
    h("p", { class: "muted small" }, "A grid for your controls: sliders, range sliders, switches, buttons, dropdowns, polygons, boards, pictures and text. Each sets a Global value or a player's or item's Local value. "
      + "A Phone panel is 8 cells across, drawn at a phone's width: the size to show to players. A Desktop panel is 24 across, as wide as your screen: your own controls."
      + (panel ? " Changing the size keeps each control where it fits, and moves the rest below." : "")),
    bgField(draft, "Background (behind its controls)"),
    condField(draft, "showIf", "Shown when", "Always shown", "Only while…", "Hidden while it doesn't hold (Edit mode still shows it, marked). A rule shows it by setting the value."),
    lookField(draft), cssField(draft, panel?.id)),
  { footer: [h("button", { class: "btn", onclick: () => close() }, "Cancel"), h("button", { class: "btn primary", onclick: save }, icon("check"), isNew ? "Make it" : "Save")] });
}

// A dropdown's choices: a label and a value per row, with + and − for more or fewer. Either can
// be left empty: the value is then the label (when it's a number), else the choice's place
// (0, 1, 2…: values are numbers); the label is then the value. The placeholders show what an
// empty one becomes.
const choiceValue = (r, i) => r.value.trim() !== "" ? +r.value : r.label.trim() !== "" && Number.isFinite(+r.label) ? +r.label : i;
function choicesEditor(rows) {
  const box = h("div", { class: "cp-choices" });
  const draw = () => setChildren(box,
    h("span", { class: "muted small" }, "Label"), h("span", { class: "muted small" }, "Value"),
    rows.map((r, i) => {
      const val = h("input", { type: "number", step: "any", value: r.value, "aria-label": `Value ${i + 1}`, placeholder: String(choiceValue({ ...r, value: "" }, i)),
        oninput: e => { r.value = e.target.value; lab.placeholder = r.value || `Choice ${i + 1}`; } });
      const lab = h("input", { type: "text", maxlength: 40, value: r.label, "aria-label": `Label ${i + 1}`, placeholder: r.value || `Choice ${i + 1}`,
        oninput: e => { r.label = e.target.value; val.placeholder = String(choiceValue({ ...r, value: "" }, i)); } });
      return [lab, val];
    }),
    h("div", { class: "cp-choices-buttons" },
      iconBtn("minus", "One choice fewer", () => { if (rows.length > 1) { rows.pop(); draw(); } }),
      iconBtn("plus", "One choice more", () => { if (rows.length < 30) { rows.push({ label: "", value: "" }); draw(); } }),
      h("span", { class: "muted small" }, "Leave them all empty to use the value's own choices.")));
  draw();
  return h("div", { class: "field" }, h("span", null, "Choices"), box);
}
function choicesFromRows(rows) {
  const used = rows.map((r, i) => [r, i]).filter(([r]) => r.label.trim() !== "" || r.value.trim() !== "");
  if (used.some(([r]) => r.value.trim() !== "" && !Number.isFinite(+r.value))) return { error: "Choice values are numbers" };
  return { list: used.map(([r, i]) => { const value = choiceValue(r, i); return { label: (r.label.trim() || String(value)).slice(0, 40), value }; }) };
}

// After tabs are removed (or a Tabs control): controls on a tab that's gone go to the nearest tab
// above it that's still there, else to where its Tabs control showed (or every tab).
function rehomeControls(panel, before) {
  const now = tabIndex(panel);
  for (const c of panel.controls) {
    if (!c.tab || now.has(c.tab)) continue;
    const was = before.get(c.tab);
    const up = was && [...was.path].reverse().find(id => now.has(id));
    if (up) c.tab = up;
    else if (was?.owner.tab && now.has(was.owner.tab)) c.tab = was.owner.tab;
    else delete c.tab;
  }
}

// Add (at: the empty cell clicked) or edit one control.
function editPanelControl(panel, ctl, at) {
  const isNew = !ctl;
  // (a new one: the box drawn for it, else sized for its kind when it's saved)
  const drawn = !ctl && !!at?.w;
  const draft = ctl ? clone(ctl) : { id: "c" + uid(), type: "slider", x: at.x, y: at.y, w: drawn ? at.w : 1, h: drawn ? at.h : 1, scope: "party", target: "", name: "",
    ...(at.tab ? { tab: at.tab } : {}) };
  // The dropdown's choices as typed: [{ label, value }] of strings (see choicesFromRows).
  const rows = (draft.options?.length ? draft.options : [{ label: "", value: "" }, { label: "", value: "" }])
    .map(o => ({ label: String(o.label ?? ""), value: String(o.value ?? "") }));
  const specs = knownValues();
  const listId = "cp-names-" + uid();
  let close;
  const fields = h("div", { class: "form" });
  const text = (key, label, placeholder = "") => h("label", { class: "field" }, h("span", null, label),
    h("input", { type: "text", value: draft[key] || "", placeholder, maxlength: 60, oninput: e => { draft[key] = e.target.value; } }));
  const num = (key, label, placeholder) => h("label", { class: "field" }, h("span", null, label),
    h("input", { type: "number", step: "any", value: draft[key] ?? "", placeholder: placeholder ?? "", onchange: e => { draft[key] = e.target.value === "" ? undefined : +e.target.value; } }));
  // A picture: one of your drawings (or a new one, drawn here), or a built-in icon.
  const iconPick = () => {
    const box = h("div", { class: "inline wrap" });
    const name = () => draft.label || (draft.type === "icon" ? "Picture" : "Button");
    const drawBox = () => {
      const has = draft.iconSvg || draft.icon;
      setChildren(box, has ? controlPicture(draft, "cp-pick-icon") : h("span", { class: "muted small" }, "None"),
        h("button", { type: "button", class: "btn", onclick: () => openIconPicker(draft.icon, id => {
          if (id) draft.icon = id; else delete draft.icon;
          setItemDrawing(draft, null); // an icon replaces a drawing
          drawBox();
        }, null, { drawings: drawingLibrary(), onDrawing: d => { setItemDrawing(draft, d); drawBox(); } }) }, icon("image"), "Choose…"),
        h("button", { type: "button", class: "btn", onclick: () => {
          if (draft.iconDoc) return editItemDrawing(draft, drawBox, { name: name(), self: ctl, panelPicture: draft.type === "icon" });
          openIconDrawer({ name: name(), color: draft.color, templates: true, buttons: null, panelPicture: draft.type === "icon" }, (doc, svg) => {
            if (doc) setItemDrawing(draft, addDrawing(name(), doc, svg));
            drawBox();
          });
        } }, icon("edit"), draft.iconDoc ? "Edit drawing…" : "Draw…"),
        has && h("button", { type: "button", class: "btn", onclick: () => { delete draft.icon; setItemDrawing(draft, null); drawBox(); } }, "None"),
        draft.type === "icon" && h("small", { class: "muted", style: "flex-basis: 100%" },
          "A drawing that reads Global values (global_…) moves with them: a weather vane, a tide gauge, a clock. One with hotspots can be used on the panel: its hotspots set its values and can run its rules (below)."));
    };
    drawBox();
    return h("div", { class: "field" }, h("span", null, draft.type === "icon" ? "Picture" : "Icon"), box);
  };
  const nameInput = (obj, key, aria, placeholder = "value name, e.g. storm") => h("input", { type: "text", list: listId, value: obj[key] || "", placeholder,
    spellcheck: "false", autocomplete: "off", "aria-label": aria, onchange: e => { obj[key] = e.target.value.trim(); } });
  const nameField = (key, label) => h("label", { class: "field" }, h("span", null, label), nameInput(draft, key, label));
  const playerDropdowns = () => panel.controls.filter(c => isPlayersDropdown(c) && c.id !== draft.id);
  // Who it sets values for: everyone (Globals), a player, an item, or whoever is chosen in a
  // Players dropdown on this panel.
  const forField = () => {
    const dds = playerDropdowns(), cur = draft.from ? "from:" + draft.from : `${draft.scope}:${draft.target}`;
    const sel = h("select", { onchange: e => {
      const v = e.target.value;
      if (v.startsWith("from:")) { draft.from = v.slice(5); draft.scope = "character"; draft.target = ""; }
      else { delete draft.from; const [scope, target] = v.split(/:(.*)/); draft.scope = scope; draft.target = target || ""; }
    } }, pinScopeOptions(draft.from ? "party:" : cur),
      dds.length > 0 && h("optgroup", { label: "Chosen in a Players dropdown" },
        dds.map(d => h("option", { value: "from:" + d.id }, `Whoever is chosen in ${d.label || "the Players dropdown"}`))));
    setTimeout(() => { sel.value = cur; });
    return [h("label", { class: "field" }, h("span", null, "For"), sel),
      h("datalist", { id: listId }, [...new Set([...specs.values()].map(v => v.name))].sort().map(n => h("option", { value: n })))];
  };
  const valueFields = () => [nameField("name", draft.type === "text" ? "Shows the value (optional)" : "Sets the value"), forField()];
  const rulesOnly = () => draft.type === "button" && draft.action === "rules";
  const players = () => isPlayersDropdown(draft);
  // A dropdown lists the value's choices (and sets it), or the party's players (whose values other controls use).
  const listsField = () => h("div", { class: "field" }, h("span", null, "Lists"),
    slideSwitch("Lists", [["values", "Choices: sets a value"], ["players", "Players: choose whose"]], players() ? "players" : "values",
      v => { if (v === "players") draft.choose = "players"; else delete draft.choose; drawFields(); }, { even: true, cls: "seg-field" }),
    players() && h("small", { class: "muted" }, "The party's characters. Other controls can follow whoever is chosen here: a picture shows their Local values (its Local values of), a slider or switch sets them (its For)."));
  // Whose Local values a picture shows: none (Global values only), a character's, an item's, or
  // whoever is chosen in a Players dropdown on this panel.
  const whoseField = () => {
    const dds = playerDropdowns();
    const cur = draft.from ? "from:" + draft.from : `${draft.scope || "party"}:${draft.target || ""}`;
    const sel = h("select", { onchange: e => {
      const v = e.target.value;
      if (v.startsWith("from:")) { draft.from = v.slice(5); draft.scope = "party"; draft.target = ""; }
      else { delete draft.from; const [scope, target] = v.split(/:(.*)/); draft.scope = scope; draft.target = target || ""; }
    } }, pinScopeOptions(draft.from ? "party:" : cur),
      dds.length > 0 && h("optgroup", { label: "Chosen in a Players dropdown" },
        dds.map(d => h("option", { value: "from:" + d.id }, `Whoever is chosen in ${d.label || "the Players dropdown"}`))));
    setTimeout(() => { sel.value = cur; });
    return h("label", { class: "field" }, h("span", null, "Local values of"), sel,
      h("small", { class: "muted" }, "Its drawing reads their Local values (local_…) as well as the Global ones."
        + (dds.length ? "" : " To switch between players, add a dropdown that lists Players, then choose it here.")));
  };
  // A polygon's corners: a row each (label, the value it sets, its amount at the corner), 3 to 8.
  const cornersEditor = () => {
    const box = h("div", { class: "cp-corners" });
    const draw = () => setChildren(box,
      h("span", { class: "muted small" }, "Label"), h("span", { class: "muted small" }, "Sets the value"), h("span", { class: "muted small" }, "At the corner"),
      draft.vertices.map((v, i) => [
        h("input", { type: "text", maxlength: 30, value: v.label || "", placeholder: `Corner ${i + 1}`, "aria-label": `Corner ${i + 1}: label`, oninput: e => { v.label = e.target.value; } }),
        nameInput(v, "name", `Corner ${i + 1}: value`, "value name"),
        h("input", { type: "number", step: "any", value: v.amount ?? "", placeholder: "1", "aria-label": `Corner ${i + 1}: amount`,
          onchange: e => { v.amount = e.target.value === "" ? undefined : +e.target.value; } })]),
      h("div", { class: "cp-choices-buttons" },
        iconBtn("minus", "One corner fewer", () => { if (draft.vertices.length > 3) { draft.vertices.pop(); draw(); } }),
        iconBtn("plus", "One corner more", () => { if (draft.vertices.length < 8) { draft.vertices.push({ label: "", name: "" }); draw(); } }),
        h("span", { class: "muted small" }, "3 to 8 corners. Each value is its amount × how close the handle is to its corner.")));
    draw();
    return h("div", { class: "field" }, h("span", null, "Corners"), box);
  };
  // Which tab it shows on (when the panel has Tabs controls): any tab of any of them, or always.
  // Not one of its own tabs, nor a tab of a Tabs control shown on its own (a Tabs control can't be
  // inside itself).
  const index = tabIndex(panel);
  const whereFields = () => {
    const inside = id => { for (let at = index.get(id); at; at = at.owner.tab && index.get(at.owner.tab)) if (at.owner.id === draft.id) return true; return false; };
    const tabs = [...index.entries()].filter(([id]) => !inside(id));
    if (!tabs.length) return null;
    const many = new Set(tabs.map(([, at]) => at.owner.id)).size > 1;
    return h("label", { class: "field" }, h("span", null, "Shows on"),
      h("select", { onchange: e => { if (e.target.value) draft.tab = e.target.value; else delete draft.tab; } },
        h("option", { value: "", selected: !draft.tab }, "Always (every tab)"),
        tabs.map(([id, at]) => h("option", { value: id, selected: draft.tab === id },
          (many ? `${at.owner.label || "Tabs"}: ` : "") + "\u2003".repeat(at.path.length - 1) + (at.tab.label || "Unnamed tab")))),
      h("small", { class: "muted" }, "On a tab, it shows while that tab is chosen, and any tab under it."));
  };
  // A Tabs control's tabs: a tree, levels deep (rename, icon, reorder, add under, remove).
  const tabsEditor = () => {
    draft.levels = Math.max(1, Math.min(MAX_TAB_LEVELS, draft.levels || 1));
    draft.items ||= [{ id: "tb" + uid(), label: "Tab 1" }, { id: "tb" + uid(), label: "Tab 2" }];
    const box = h("div", { class: "cp-tab-tree" });
    const node = (list, it, i, depth) => h("div", { class: "cp-tab-node" },
      h("div", { class: "cp-tab-row", style: { paddingLeft: depth * 22 + "px" } },
        h("button", { type: "button", class: "btn cp-tab-pick", title: "Choose its picture: one of your drawings or an icon (optional)",
          onclick: () => openIconPicker(it.icon, id => { if (id) it.icon = id; else delete it.icon; setItemDrawing(it, null); draw(); }, null,
            { drawings: drawingLibrary(), onDrawing: d => { setItemDrawing(it, d); delete it.icon; draw(); } }) },
          controlPicture(it, "cp-tab-icon") || icon("image")),
        h("input", { type: "text", value: it.label || "", maxlength: 30, placeholder: `Tab ${i + 1}`, "aria-label": `Level ${depth + 1}, tab ${i + 1}: name`,
          oninput: e => { it.label = e.target.value; } }),
        iconBtn("up", "Earlier", () => { if (i > 0) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; draw(); } }),
        iconBtn("down", "Later", () => { if (i < list.length - 1) { [list[i + 1], list[i]] = [list[i], list[i + 1]]; draw(); } }),
        depth + 1 < draft.levels && iconBtn("plus", `Add a tab under ${it.label || "this one"}`, () => { (it.items ||= []).push({ id: "tb" + uid(), label: `Tab ${it.items.length + 1}` }); draw(); }),
        iconBtn("trash", "Remove this tab (and the tabs under it)", () => { list.splice(i, 1); draw(); }, "danger-hover")),
      depth + 1 < draft.levels && (it.items || []).map((k, j) => node(it.items, k, j, depth + 1)));
    const draw = () => setChildren(box, draft.items.map((it, i) => node(draft.items, it, i, 0)),
      h("button", { type: "button", class: "btn", onclick: () => { draft.items.push({ id: "tb" + uid(), label: `Tab ${draft.items.length + 1}` }); draw(); } },
        icon("plus"), "Add a tab"));
    draw();
    return [
      h("label", { class: "field" }, h("span", null, "Style"),
        h("select", { onchange: e => { if (e.target.value) draft.style = e.target.value; else delete draft.style; drawFields(); } },
          h("option", { value: "", selected: !draft.style }, "As its shape: rows if it's wide, columns if it's tall"),
          h("option", { value: "horizontal", selected: draft.style === "horizontal" }, "Horizontal: rows of tabs"),
          h("option", { value: "vertical", selected: draft.style === "vertical" }, "Vertical: columns of tabs"))),
      draft.style !== "horizontal" && h("label", { class: "check field" },
        h("input", { type: "checkbox", checked: tabsTurned(draft), onchange: e => { draft.turn = e.target.checked; } }),
        " Turn the labels in columns: reading upwards on the panel's left side, downwards on its right"),
      h("label", { class: "field" }, h("span", null, "Levels"),
        h("select", { onchange: e => { draft.levels = +e.target.value; drawFields(); } },
          Array.from({ length: MAX_TAB_LEVELS }, (_, i) => i + 1).map(n => h("option", { value: n, selected: draft.levels === n }, n === 1 ? "1: one row of tabs" : `${n}: tabs under tabs, ${n} rows`))),
        h("small", { class: "muted" }, "Each level is a row of tabs: the tabs under the one chosen in the row before. Controls show on a tab at any level.")),
      h("div", { class: "field" }, h("span", null, "Tabs"), box,
        h("small", { class: "muted" }, "Removing a tab moves its controls to the tab above it (or to every tab).")),
    ];
  };
  const drawFields = () => setChildren(fields,
    h("label", { class: "field" }, h("span", null, "Kind"), h("select", { onchange: e => { draft.type = e.target.value; drawFields(); } },
      CONTROL_GROUPS.map(([group, kinds]) => h("optgroup", { label: group }, kinds.map(k => h("option", { value: k, selected: (draft.type === "range" ? "slider" : draft.type) === k },
        CONTROL_KINDS.find(t => t[0] === k)[1])))))),
    (draft.type === "slider" || draft.type === "range") && h("div", { class: "field" }, h("span", null, "Handles"),
      slideSwitch("Handles", [["slider", "One: a value"], ["range", "Two: a lower and an upper value"]], draft.type, v => { draft.type = v; drawFields(); }, { even: true, cls: "seg-field" })),
    text("label", draft.type === "text" ? "Text" : "Label", draft.type === "icon" ? "Optional" : ""),
    draft.type === "dropdown" && listsField(),
    ((SETS_VALUE.has(draft.type) && !players() && !rulesOnly()) || draft.type === "text") && valueFields(),
    draft.type === "text" && h("small", { class: "muted field" }, "Its text can show values too, in braces: The door is {door}, The storm is {global.storm}."),
    draft.type === "range" && [nameField("name", "Sets the lower value"), nameField("name2", "Sets the upper value"), forField()],
    draft.type === "polygon" && [(draft.vertices = draft.vertices?.length >= 3 ? draft.vertices : [{ label: "", name: "" }, { label: "", name: "" }, { label: "", name: "" }], cornersEditor()), forField()],
    (draft.type === "slider" || draft.type === "range") && h("div", { class: "form grid" }, num("min", "From", "the value's own"), num("max", "To", "the value's own"), num("step", "Step", "any")),
    draft.type === "toggle" && h("div", { class: "form grid" }, num("off", "Off sets", "0"), num("on", "On sets", "1")),
    (draft.type === "slider" || draft.type === "range" || draft.type === "toggle") && h("label", { class: "field" },
      h("span", null, draft.type === "toggle" ? "On is towards" : "More is towards"),
      h("select", { onchange: e => { draft.reverse = e.target.value === "1"; } },
        h("option", { value: "", selected: !draft.reverse }, "The right, or the top when upright"),
        h("option", { value: "1", selected: !!draft.reverse }, "The left, or the bottom when upright")),
      h("small", { class: "muted" }, "Make it taller than it's wide (in Edit mode, drag its corner) and it stands upright.")),
    draft.type === "button" && [
      h("label", { class: "field" }, h("span", null, "When pressed"), h("select", { onchange: e => { draft.action = e.target.value; drawFields(); } },
        h("option", { value: "set", selected: draft.action !== "add" && draft.action !== "rules" }, "Set the value to"),
        h("option", { value: "add", selected: draft.action === "add" }, "Add to the value (negative takes away)"),
        h("option", { value: "rules", selected: draft.action === "rules" }, "Nothing: just its rules"))),
      !rulesOnly() && num("amount", "Amount", "1")],
    draft.type === "dropdown" && !players() && choicesEditor(rows),
    draft.type === "socket" && socketStartField(draft),
    draft.type === "board" && h("div", { class: "field" }, h("span", null, "Picture and pins"),
      h("div", { class: "inline wrap" },
        h("span", { class: "muted small" }, `${draft.board?.image ? "A picture" : "A blank square"}, ${plural(draft.board?.pins?.length || 0, "pin")}`),
        h("button", { type: "button", class: "btn", onclick: () => editBoard(draft.board || { pins: [] }, b => { draft.board = b; drawFields(); }, draft.label || "") },
          icon("edit"), "Edit board…"))),
    (draft.type === "icon" || draft.type === "button") && iconPick(),
    draft.type === "icon" && whoseField(),
    draft.type === "tabs" && tabsEditor(),
    whereFields(),
    BG_KINDS.has(draft.type) && bgField(draft),
    h("label", { class: "field" }, h("span", null, "Colour (its edge, background and highlights)"), h("div", { class: "inline" },
      h("input", { type: "color", value: draft.color || "#888888", onchange: e => { draft.color = e.target.value; } }),
      draft.color && h("button", { type: "button", class: "btn", onclick: () => { delete draft.color; drawFields(); } }, "Default"))),
    condField(draft, "showIf", "Shown when", "Always shown", "Only while…", "Hidden while it doesn't hold (Edit mode still shows it, faded). A rule shows it by setting the value."),
    condField(draft, "lockIf", "Locked when", "Never locked", "Locked while…", "It can't be used while it holds. A rule locks or unlocks it by setting the value."),
    lookField(draft, panel),
    !isNew && draft.type !== "tabs" && controlRules(panel, draft));
  drawFields();

  const save = () => {
    if (draft.type !== "dropdown") delete draft.choose;
    if (players()) { delete draft.options; delete draft.name; draft.scope = "party"; draft.target = ""; }
    else if (draft.type === "dropdown") {
      const opts = choicesFromRows(rows);
      if (opts.error) return toast(opts.error);
      draft.options = opts.list;
    }
    if (draft.type === "board") draft.board = draft.board || { pins: [] };
    else delete draft.board;
    for (const [k, what] of [["showIf", "Shown when"], ["lockIf", "Locked when"]]) {
      if (!draft[k]) continue;
      if (!clockwork.find(draft[k].value)) return toast(`${what}: choose a value (global.door, char.local.luck…)`);
      if (draft[k].to === "" || draft[k].to == null) return toast(`${what}: what it's compared with`);
    }
    if (rulesOnly()) { delete draft.name; delete draft.amount; }
    else if (draft.type === "button" && draft.action !== "add") delete draft.action;
    if (SETS_VALUE.has(draft.type) && !players() && !rulesOnly() && !isValueName(draft.name)) return toast("Choose the value it sets: a letter, then letters, digits or _");
    if (draft.type === "text" && draft.name && !isValueName(draft.name)) return toast("Not a value name");
    if (draft.type === "range" && (!isValueName(draft.name) || !isValueName(draft.name2))) return toast("Choose the two values it sets: a letter, then letters, digits or _");
    if (draft.type === "range" && draft.name === draft.name2) return toast("The lower and upper values need different names");
    if (draft.type === "polygon") {
      if (draft.vertices.some(v => !isValueName(v.name))) return toast("Each corner needs a value to set: a letter, then letters, digits or _");
      if (new Set(draft.vertices.map(v => v.name)).size < draft.vertices.length) return toast("Each corner needs a value of its own");
    }
    if (!SETS_VALUE.has(draft.type) && draft.type !== "text" && draft.type !== "range") delete draft.name;
    if (draft.type !== "button") delete draft.action;
    if (draft.type !== "socket" || !draft.held?.length) delete draft.held;
    draft.bg = BG_KINDS.has(draft.type) ? cleanBg(draft.bg) : undefined;
    if (!draft.bg) delete draft.bg;
    if (draft.type !== "range") delete draft.name2;
    if (draft.type !== "polygon") { delete draft.vertices; delete draft.at; }
    if (draft.type === "tabs" || draft.type === "board" || players()) delete draft.from;
    if (draft.type !== "icon" && draft.type !== "button") { delete draft.icon; setItemDrawing(draft, null); }
    if (draft.type === "tabs") {
      // Tabs as saved: named, at most `levels` deep.
      const tidy = (items, depth) => (items || []).map(it => ({ id: it.id, label: (it.label || "").trim().slice(0, 30), ...(it.icon ? { icon: it.icon } : {}),
        ...(it.iconSvg && it.iconDoc ? { iconDoc: it.iconDoc, iconSvg: it.iconSvg, ...(it.iconLib ? { iconLib: it.iconLib } : {}) } : {}),
        ...(depth + 1 < draft.levels && it.items?.length ? { items: tidy(it.items, depth + 1) } : {}) }));
      draft.items = tidy(draft.items, 0);
      if (!draft.items.length) return toast("Tabs need at least one tab");
      if (draft.style === "horizontal") delete draft.turn;
    } else { delete draft.levels; delete draft.items; delete draft.style; delete draft.turn; }
    if (isNew && !drawn) {
      // Clicked, not drawn: as big as suits its kind (the cells are small), where there's room.
      const big = draft.type === "board" || draft.type === "polygon";
      const want = big ? 6 : draft.type === "tabs" ? Math.min(panel.cols, 8) : draft.type === "slider" || draft.type === "range" ? 4 : 2;
      const tall = big ? 6 : draft.type === "tabs" ? draft.levels : 2;
      const room = (w, ht) => fitsPanel(panel, { ...draft, w, h: ht }) && !clashes(panel, draft, { ...draft, w, h: ht });
      outer: for (let ht = tall; ht >= 1; ht--) for (let w = want; w >= 1; w--) if (room(w, ht)) { draft.w = w; draft.h = ht; break outer; }
    }
    if (clashes(panel, draft, draft)) return toast("It would overlap another control where it shows: choose another tab, or move it first");
    close();
    updatePanel(panel.id, p => {
      const before = tabIndex(p);
      const i = p.controls.findIndex(c => c.id === draft.id);
      if (i >= 0) p.controls[i] = draft; else p.controls.push(draft);
      if (isTabs(draft) || isTabs(ctl)) rehomeControls(p, before);
    });
  };
  const remove = () => {
    close();
    const rules = rulesForGone(r => r.appliesTo?.control === draft.id);
    updatePanel(panel.id, p => {
      const before = tabIndex(p);
      p.controls = p.controls.filter(c => c.id !== draft.id);
      if (isTabs(ctl)) rehomeControls(p, before);
    }, rules ? `Removed the control and its ${plural(rules, "rule")}` : "Removed the control");
    if (rules) saveRuleBook(list => list.filter(r => r.appliesTo?.control !== draft.id), null);
  };
  close = openModal(isNew ? "New control" : "Edit control", fields, { footer: [
    !isNew && h("button", { class: "btn danger", onclick: remove }, icon("trash"), "Remove"),
    h("button", { class: "btn", onclick: () => close() }, "Cancel"),
    h("button", { class: "btn primary", onclick: save }, icon("check"), "Save"),
  ] });
}
