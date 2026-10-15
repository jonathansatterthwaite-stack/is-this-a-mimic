// Rules as blocks, and the campaign's rule book (docs/clockwork-overhaul-plan.md, step 2; the
// mock-up is mockups/rule-book.html). A rule is edited as blocks: When (its event), If (conditions
// checked when it fires), Do (actions, in order) and Applies to (its scope). The GM's Rules tab
// (GM → Controls → Rules) lists every rule: the rule book's (campaign.rules) and those items carry.
// The item and template editors' Rules tabs use the same blocks. The engine is js/triggers.js.

// ------------------------------------------------------------------ in words

// What a part of a scope is called: "Pip", "Lantern", "All weapons", "Drawing: Lantern".
function scopePartLabel(part, v) {
  if (part === "character") return [...gmChars(), ...store.state.characters].find(c => c.id === v)?.name || "a character";
  if (part === "item") {
    if (v === "self") return "This item";
    const tpl = /^template:(.+)$/.exec(v);
    if (tpl) { const t = templateById(tpl[1]); return t ? `All ${templatePlural(t).toLowerCase()}` : "a template"; }
    return store.findItem(v)?.name || "an item";
  }
  if (part === "drawing") return `Drawing: ${findDrawing(v)?.name || "a drawing"}`;
  if (part === "panel") return `Panel: ${gmControls().find(p => p.id === v)?.name || "a panel"}`;
  if (part === "control") return controlName(findControl(v)?.ctl) || "a control";
  return v;
}
// A GM panel's control by id: { panel, ctl } (null if it's gone); what it's called.
function findControl(id) {
  for (const panel of gmControls()) { const ctl = (panel.controls || []).find(c => c.id === id); if (ctl) return { panel, ctl }; }
  return null;
}
const controlName = ctl => ctl && (ctl.label?.replace(/\{[^}]*\}/g, "…").trim() || ctl.name || CONTROL_TYPES.find(t => t[0] === ctl.type)?.[1] || "Control");
const scopeParts = scope => SCOPE_PARTS.filter(p => scope?.[p] != null);
// "For Pip's Lantern.", "For all weapons.", "For the world."
function scopeWords(scope) {
  const parts = scopeParts(scope);
  if (!parts.length) return "For the world.";
  if (scope.panel) return `For ${scope.control ? `${scopePartLabel("control", scope.control)} on ` : ""}the ${scopePartLabel("panel", scope.panel).replace(/^Panel: /, "")} panel.`;
  const who = scope.character ? scopePartLabel("character", scope.character) : null;
  const rest = parts.filter(p => p !== "character").map(p => scopePartLabel(p, scope[p]));
  const what = rest.join(", ");
  return who ? `For ${who}${what ? `'s ${what.replace(/^All /, "").replace(/^This item$/, "item")}` : ""}.` : `For ${what.charAt(0).toLowerCase() + what.slice(1)}.`;
}
const ruleTitle = r => r.name || ruleWords(r);

// ------------------------------------------------------------------ which rules override which

// Does scope a name everything b does, the same or narrower? (An item in a template, or a template
// under it, is narrower than the template.)
function scopeRefines(a, b) {
  for (const part of scopeParts(b)) {
    const av = a?.[part], bv = b[part];
    if (av == null) return false;
    if (av === bv) continue;
    const bt = part === "item" && /^template:(.+)$/.exec(bv);
    if (!bt) return false;
    const at = /^template:(.+)$/.exec(av);
    const lineage = at ? templateLineage(templateById(at[1])) : templateLineage(itemTemplate(store.findItem(av) || {}));
    if (!lineage.some(t => t.id === bt[1])) return false;
  }
  return true;
}
// Every rule there is, for the rule book: the book's own, and those the catalog's items carry.
// [{ rule, scope, source: "book" | "item", owner? (the item carrying it), broken? (a book rule that
// wouldn't pass the checks rules get before they run: cleanTriggers) }]
function allRulesListed() {
  // (a panel's rule whose panel or control has gone won't run either)
  const gone = s => (s.panel && !gmControls().some(p => p.id === s.panel)) || (s.control && !findControl(s.control));
  const out = (store.campaign()?.rules || []).map(r => ruleOf(r)).filter(Boolean).map(rule => ({ rule, scope: rule.appliesTo || {}, source: "book",
    broken: !cleanTriggers([rule]).length || gone(rule.appliesTo || {}) }));
  for (const item of store.catalog()) for (const rule of rulesOf(item)) out.push({ rule, scope: { item: item.id, ...(rule.appliesTo || {}) }, source: "item", owner: item });
  return out;
}
// For one rule: the less specific rules it overrides (for the same event, where it applies), and
// the more specific ones that override it.
function overrideLinks(x, all) {
  const k = ruleKey(x.rule), s = clockwork.scopeSpecificity(x.scope), same = all.filter(o => o !== x && o.rule !== x.rule && ruleKey(o.rule) === k);
  return {
    overrides: same.filter(o => clockwork.scopeSpecificity(o.scope) < s && scopeRefines(x.scope, o.scope)),
    overriddenBy: same.filter(o => clockwork.scopeSpecificity(o.scope) > s && scopeRefines(o.scope, x.scope)),
  };
}

// ------------------------------------------------------------------ the rule book (GM → Controls → Rules)

const saveRuleBook = (fn, msg) => {
  commit(() => { const c = store.campaign(); c.rules = fn(Array.isArray(c.rules) ? c.rules : []); }, msg);
  if (party.active && party.isGm()) party.loadCampaign(store.campaign()).catch(e => toast(e.message));
};

function ruleBookView() {
  const st = ui.ruleBook ||= { q: "" };
  const all = allRulesListed(), q = st.q.trim().toLowerCase();
  const shown = all.filter(x => !q || [ruleTitle(x.rule), ruleWords(x.rule), scopeWords(x.scope)].some(t => t.toLowerCase().includes(q)));
  const level = x => ruleLevel(scopeParts(x.scope).length ? x.scope : null);
  const groups = [
    ["The world", "run on the GM's device", shown.filter(x => level(x) === "world")],
    ["Characters", "", shown.filter(x => level(x) === "character")],
    ["Items", "by template, then item", shown.filter(x => level(x) === "item" && x.scope.item)],
    ["Drawings", "", shown.filter(x => level(x) === "item" && !x.scope.item)],
    ["Panels", "run where a control is used", shown.filter(x => level(x) === "control")],
  ];
  const card = x => {
    const { overrides, overriddenBy } = overrideLinks(x, all);
    const open = () => x.source === "book" ? (editing() ? openRuleEditor(x.rule) : toast("Switch to Edit to change rules"))
      : store.findCustom(x.owner.id) ? (editing() ? openItemForm(x.owner, { tab: "triggers" }) : toast("Switch to Edit to change rules"))
      : toast(`${x.owner.name} comes with the game system: Customize it in the catalog to change its rules`);
    return h("button", { type: "button", class: "rule-card", onclick: open },
      h("span", { class: "rule-card-words" }, x.rule.name && h("b", null, x.rule.name + ": "), ruleWords(x.rule)),
      h("span", { class: "chips" },
        scopeParts(x.scope).length ? scopeParts(x.scope).map(p => h("span", { class: "chip scope" }, scopePartLabel(p, x.scope[p]))) : h("span", { class: "chip scope" }, "The world"),
        x.source === "item" && h("span", { class: "chip carried" }, "carried by the item"),
        x.broken && h("span", { class: "chip overridden", title: "Something in it isn't right (a value, an action): open it to fix it" }, "won't run"),
        overrides.length > 0 && h("span", { class: "chip overrides", title: overrides.map(o => ruleWords(o.rule)).join("\n") }, `overrides ${overrides.length} rule${overrides.length === 1 ? "" : "s"}`),
        overriddenBy.length > 0 && h("span", { class: "chip overridden", title: overriddenBy.map(o => ruleWords(o.rule)).join("\n") },
          `overridden for ${overriddenBy.map(o => scopeWords(o.scope).replace(/^For |\.$/g, "")).join("; ")}`)));
  };
  return h("section", { class: "rule-book" },
    h("div", { class: "section-head" }, h("h2", null, "Rules"),
      editing() && h("button", { class: "btn primary", onclick: () => openRuleEditor(null) }, icon("plus"), "New rule")),
    h("p", { class: "muted small" }, "Everything that happens by itself in this campaign. Each rule says what it applies to; for the same event, a more specific rule overrides a less specific one."),
    h("input", { type: "search", class: "rule-search", placeholder: "Search rules…", value: st.q, "aria-label": "Search rules",
      oninput: e => { st.q = e.target.value; render(); requestAnimationFrame(() => { const i = document.querySelector(".rule-search"); i?.focus(); i?.setSelectionRange(i.value.length, i.value.length); }); } }),
    all.length === 0 ? emptyState("wand", "No rules yet. A rule does something by itself: when the storm passes 5, open the harbour shop; when a lantern's oil runs out, put it out.",
      editing() && h("button", { class: "btn primary", onclick: () => openRuleEditor(null) }, icon("plus"), "New rule"))
    : groups.map(([title, note, list]) => list.length > 0 && [
        h("div", { class: "rule-group-head" }, h("h3", null, title), note && h("span", { class: "muted small" }, note)),
        list.map(card)]),
    !clockworkOn() && h("p", { class: "muted small" }, "Rules, values and controls are off for this campaign: rules don't run."));
}

// A rule of the book in blocks: new (null) or one to change.
// start: what a new one starts as; after(): once it's saved or deleted (a control's editor redraws).
function openRuleEditor(existing, start = null, after = null) {
  const draft = clone(existing || { id: "r" + uid(), ...(start || { when: "becomes", test: [{ value: "global.storm", op: ">", to: 5 }], do: [{ message: "" }] }) });
  if (!draft.id) draft.id = "r" + uid();
  if (draft.message) { (draft.do ||= []).push({ message: draft.message }); delete draft.message; }
  const body = h("div", { class: "rule-editor" });
  let close;
  const draw = () => setChildren(body,
    h("label", { class: "field" }, h("span", null, "Name (optional)"),
      h("input", { type: "text", value: draft.name || "", maxlength: 80, placeholder: ruleWords(draft), "aria-label": "Name",
        oninput: e => { draft.name = e.target.value; } })),
    ruleBlocks(draft, { onChange: draw, book: true }));
  draw();
  const save = () => {
    const cleaned = cleanTriggers([draft])[0];
    if (!cleaned) return toast("Finish the rule first: it needs a When and at least one thing to do");
    saveRuleBook(list => { const i = list.findIndex(r => r.id === cleaned.id); const out = [...list]; if (i >= 0) out[i] = cleaned; else out.push(cleaned); return out; },
      existing ? "Rule saved" : "Rule added");
    close();
    after?.();
  };
  // (on a wide screen, beside the rule book)
  close = openModal(existing ? "Rule" : "New rule", body, { wide: true, dock: true, footer: [
    existing && h("button", { class: "btn danger", onclick: () => { saveRuleBook(list => list.filter(r => r.id !== draft.id), "Rule removed"); close(); after?.(); } }, icon("trash"), "Delete"),
    h("button", { class: "btn", onclick: () => close() }, "Cancel"),
    h("button", { class: "btn primary", onclick: save }, icon("check"), "Save")] });
}

// ------------------------------------------------------------------ the blocks

// The events a rule at this level can be for; the actions it can do.
const levelEvents = level => [...clockwork.events.values()].filter(e => level === "control" ? e.kind === "control" : e.kind !== "control" && (level === "item" || !e.kind));
// (those that ask the person, press actions, only where someone presses: a button, a hotspot)
const pressedWhen = when => !!clockwork.events.get(when)?.pressed;
// (a control's rules run as the world's do: on the GM's device, as the GM)
const levelActions = (level, when) => [...ruleActions.values()].filter(a => (!a.level || a.level === level || (level === "control" && a.level === "world"))
  && (!a.press || (level === "item" && pressedWhen(when))));
// A first condition that makes sense where a rule is.
const firstCond = level => level === "world" ? { value: "global.storm", op: ">", to: 5 }
  : level === "character" ? { value: "char.local.luck", op: ">=", to: 1 }
  : { value: "item.charges", op: "=", to: 0 };
const firstStateAddr = () => systemStates()[0] ? `item.state.${systemStates()[0].key}` : "item.charges";
// A new action of a kind, for where the rule is.
function newAction(kind, level, buttons = []) {
  if (level === "control") level = "world";
  if (kind === "take") return { take: "random" };
  if (kind === "putIn") return { putIn: 1 };
  if (kind === "use") return { use: 1 };
  if (kind === "details") return { details: 1 };
  if (kind === "press") return { press: buttons[0] || "Draw a card" };
  if (kind === "set") return level === "item" ? { set: firstStateAddr(), to: 1 } : { set: level === "world" ? "global.storm" : "char.local.luck", to: 1 };
  if (kind === "add") return { add: level === "item" ? "item.charges" : level === "world" ? "global.storm" : "char.local.luck", by: 1 };
  if (kind === "change") return { change: level === "world" ? "global.storm" : "local.heat", rate: 1 };
  if (kind === "shop") return { shop: shopStore.list()[0]?.id || "", open: 1 };
  return { message: "" };
}

// A value's box (addressInput: the box and its suggestions), as a pill.
const asPill = el => { if (el.tagName === "INPUT") el.classList.add("pill", "pill-addr"); return el; };
// Ready-made actions for an item (+ Add a rule): a button and what it does.
function actionStarters() {
  const broken = systemStates().find(st => /broken/i.test(st.key + st.label));
  return [
    ["Draw a card", [{ take: "random", to: "window" }]], ["Shake one out", [{ take: "random" }]], ["Take one out", [{ take: "choose" }]],
    ["Take all out", [{ take: "all" }]], ["Smash it", [{ take: "all" }, ...(broken ? [{ set: `item.state.${broken.key}`, to: 1 }] : [])]],
    ["Put things in", [{ putIn: 1 }]], ["Use one", [{ use: 1 }]],
  ].map(([button, act]) => ({ label: button, rule: { when: "used", button, do: act } }));
}
// The names of a drawing's hotspots (its layers that have one), for "A hotspot is used".
const drawingHotspots = doc => typeof hotspotNames === "function" ? hotspotNames(doc) : [];

// A rule's event changed: what it watches, its button or hotspot, and only the actions that fit.
function setWhen(r, v, level, opts = {}) {
  r.when = v;
  if ((v === "becomes" || v === "while") && !r.test?.length) r.test = [firstCond(level)];
  if (v !== "becomes" && v !== "while") delete r.test;
  if (v === "while") r.every ??= 1; else delete r.every;
  if (v === "used") r.button ||= "New action"; else delete r.button;
  if (v === "signal") r.signal ||= drawingHotspots(opts.drawing || findDrawing(r.appliesTo?.drawing)?.doc)[0] || ""; else if (v !== "control") delete r.signal;
  r.do = (r.do || []).filter(a => !actionOf(a)?.press || pressedWhen(v));
  if (!r.do.length) r.do.push({ message: "" });
}

// One block: When, If, Do, a Do's action, Applies to.
const ruleBlock = (kind, label, ...content) => h("div", { class: "rblk rblk-" + kind }, label && h("span", { class: "rblk-label" }, label), ...content);
const pillSelect = (label, options, value, onPick) => h("select", { class: "pill", "aria-label": label, onchange: e => onPick(e.target.value) },
  options.map(o => Array.isArray(o) ? h("option", { value: o[0], selected: String(o[0]) === String(value) }, o[1])
    : h("optgroup", { label: o.group }, o.options.map(([v, l]) => h("option", { value: v, selected: String(v) === String(value) }, l)))));
const pillInput = (label, value, onSet, attrs = {}) => h("input", { type: "text", class: "pill pill-input", value: value ?? "", "aria-label": label,
  onchange: e => onSet(e.target.value), ...attrs });

// One condition as pills, edited in place: the value, how it's compared, with what (a rule's When
// and If, a control's Shown when and Locked when).
const condPills = (c, redraw, label = "Condition") => [
  addressInput(c.value, v => { c.value = v; redraw(); }, false, `${label}: which value`).map(asPill),
  pillSelect("Compared how", RULE_OPS.map(([op, w]) => [op, w]), c.op, v => { c.op = v; redraw(); }),
  pillInput("To", c.to, v => { c.to = ruleTo(v); redraw(); }, { placeholder: "1, on, a choice or a formula" }),
  c.op === "between" && pillInput("And", c.to2, v => { c.to2 = ruleTo(v); redraw(); }, { placeholder: "and" })];

// The blocks of one rule, edited in place. opts: { onChange (redraw), book (a rule-book rule: its
// scope is free, and what it overrides shows), self ("item" | "template": a rule an item or a
// template carries: it applies to that, and can add a character) }.
function ruleBlocks(r, opts = {}) {
  const level = opts.self ? "item" : ruleLevel(scopeParts(r.appliesTo).length ? r.appliesTo : null);
  const redraw = () => opts.onChange?.();
  // The drawing's hotspots (an item's, or the scope's drawing), and the item's actions (buttons).
  const hotspots = drawingHotspots(opts.drawing || findDrawing(r.appliesTo?.drawing)?.doc);
  const buttons = (opts.buttons || []).filter(b => b !== r.button);
  // A Picture control's hotspots (its rule can be for one of them).
  const pictured = r.appliesTo?.control && findControl(r.appliesTo.control)?.ctl;
  const pictureHotspots = pictured?.type === "icon" ? drawingHotspots(pictured.iconDoc) : [];
  const conds = (list, label) => list.map((c, i) => h("div", { class: "rblk-line" }, condPills(c, redraw, label),
    h("button", { type: "button", class: "rblk-x", "aria-label": `Remove this ${label.toLowerCase()}`, onclick: () => { list.splice(i, 1); redraw(); } }, "×")));

  const watched = r.when === "becomes" || r.when === "while";
  const when = ruleBlock("when", "When",
    h("div", { class: "rblk-line" }, pillSelect("When", levelEvents(level).map(e => [e.name, e.label]), r.when, v => { setWhen(r, v, level, opts); redraw(); }),
      r.when === "used" && pillInput("Button", r.button, v => { r.button = v.trim(); redraw(); }, { placeholder: "e.g. Draw a card", maxlength: 40 }),
      r.when === "signal" && (hotspots.length
        ? pillSelect("Which hotspot", [...new Set([...hotspots, ...(r.signal ? [r.signal] : [])])].map(n => [n, n]), r.signal, v => { r.signal = v; redraw(); })
        : pillInput("Which hotspot", r.signal, v => { r.signal = v.trim(); redraw(); }, { placeholder: "the hotspot layer's name", maxlength: 40 })),
      r.when === "control" && pictureHotspots.length > 0 && pillSelect("Which hotspot", [["", "any of its hotspots"], ...[...new Set([...pictureHotspots, ...(r.signal ? [r.signal] : [])])].map(n => [n, n])],
        r.signal || "", v => { if (v) r.signal = v; else delete r.signal; redraw(); })),
    watched && conds(r.test || (r.test = []), "Condition"),
    watched && h("div", { class: "rblk-line" },
      h("button", { type: "button", class: "pill pill-add", onclick: () => { r.test.push(firstCond(level)); redraw(); } }, "+ and"),
      r.when === "while" && [h("span", null, "every"), h("input", { type: "number", class: "pill pill-num", min: 0.25, step: "any", value: r.every ?? 1, "aria-label": "Every how many seconds",
        onchange: e => { r.every = Math.max(0.25, +e.target.value || 1); redraw(); } }), h("span", null, "seconds")]));

  const ifBlock = r.if?.length > 0 && ruleBlock("if", "If", conds(r.if, "Condition"),
    h("div", { class: "rblk-line" }, h("button", { type: "button", class: "pill pill-add", onclick: () => { r.if.push(firstCond(level)); redraw(); } }, "+ and")));

  const action = (a, i) => {
    const d = actionOf(a), list = r.do;
    const kind = pillSelect("Do what", levelActions(level, r.when).map(x => [x.name, x.label]), d?.name, v => { list[i] = newAction(v, level, buttons); redraw(); });
    const isState = d?.key === "set" && /^item\.state\./.test(a.set);
    const fields = !d ? [] : d.key === "message" ? [pillInput("Message", a.message, v => { a.message = v; redraw(); }, { placeholder: "e.g. The wand crumbles to dust.", class: "pill pill-input pill-wide" })]
      : d.key === "take" ? [pillSelect("Which", [["random", "one at random"], ["choose", "one (you choose)"], ["all", "everything"]], a.take, v => { a.take = v; redraw(); }),
          pillSelect("Where to", [["inventory", "straight into the inventory"], ["window", "into a window"]], a.to === "window" ? "window" : "inventory",
            v => { if (v === "window") a.to = "window"; else delete a.to; redraw(); })]
      : d.key === "use" ? [h("input", { type: "number", class: "pill pill-num", step: 1, value: a.use, "aria-label": "How many (negative adds)",
          onchange: e => { const n = Math.round(+e.target.value); if (n) a.use = n; redraw(); } })]
      : d.key === "press" ? [buttons.length ? pillSelect("Which action", [...new Set([...buttons, a.press])].map(b => [b, b]), a.press, v => { a.press = v; redraw(); })
          : pillInput("Which action", a.press, v => { a.press = v.trim(); redraw(); }, { placeholder: "its button's words", maxlength: 40 })]
      : d.key === "putIn" || d.key === "details" ? []
      : d.key === "shop" ? [pillSelect("Which shop", shopStore.list().map(s => [s.id, s.name]), a.shop, v => { a.shop = v; redraw(); }),
          pillSelect("Open or close", [[1, "open"], [0, "closed"]], a.open, v => { a.open = +v; redraw(); })]
      : d.key === "change" ? [addressInput(a.change, v => { a.change = v; redraw(); }, true, "Which value").map(asPill),
          h("input", { type: "number", class: "pill pill-num", step: "any", value: a.rate, "aria-label": "How much a second", onchange: e => { a.rate = +e.target.value; redraw(); } }),
          h("span", null, "a second, to"),
          h("input", { type: "number", class: "pill pill-num", step: "any", value: a.until ?? "", placeholder: "never", "aria-label": "Stops at",
            onchange: e => { if (e.target.value === "") delete a.until; else a.until = +e.target.value; redraw(); } })]
      : [addressInput(a[d.key], v => { a[d.key] = v; redraw(); }, true, "Which value").map(asPill),
         isState ? pillSelect("On or off", [[1, "on"], [0, "off"]], ruleNumber({}, a.to) ? 1 : 0, v => { a.to = +v; redraw(); })
         : [h("span", null, d.key === "set" ? "to" : "by"), pillInput(d.key === "set" ? "To" : "By", a[d.key === "set" ? "to" : "by"], v => { a[d.key === "set" ? "to" : "by"] = ruleTo(v); redraw(); })]];
    return ruleBlock(d?.key === "message" ? "say" : "action", null, h("div", { class: "rblk-line" }, kind, fields,
      h("span", { class: "rblk-tools" },
        i > 0 && h("button", { type: "button", class: "rblk-x", "aria-label": "Move up", onclick: () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; redraw(); } }, "↑"),
        i < list.length - 1 && h("button", { type: "button", class: "rblk-x", "aria-label": "Move down", onclick: () => { [list[i + 1], list[i]] = [list[i], list[i + 1]]; redraw(); } }, "↓"),
        h("button", { type: "button", class: "rblk-x", "aria-label": "Remove this action", onclick: () => { list.splice(i, 1); redraw(); } }, "×"))));
  };
  const doBlock = ruleBlock("do", "Do", h("div", { class: "rblk-inner" }, (r.do ||= []).map(action)));

  // Applies to: its parts (a rule an item carries: that item, and maybe a character).
  const scope = r.appliesTo || {};
  const setPart = (part, v) => { const s = { ...(r.appliesTo || {}) }; if (v == null) delete s[part]; else s[part] = v;
    if (part === "panel" && s.control && findControl(s.control)?.panel.id !== s.panel) delete s.control; // (a control is on its panel)
    if (part === "control" && v && !s.panel) s.panel = findControl(v)?.panel.id;
    if (!s.control) delete r.signal;
    if (Object.keys(s).length) r.appliesTo = s; else delete r.appliesTo;
    // (a rule that changes level keeps only what it can still do there)
    const lvl = opts.self ? "item" : ruleLevel(Object.keys(s).length ? s : null);
    if (!levelEvents(lvl).some(e => e.name === r.when)) setWhen(r, levelEvents(lvl)[0].name, lvl, opts);
    r.do = (r.do || []).filter(a => levelActions(lvl, r.when).includes(actionOf(a)));
    redraw(); };
  const chars = [...new Map([...gmChars(), ...store.state.characters].map(c => [c.id, c])).values()];
  const partOptions = part => part === "character" ? chars.map(c => [c.id, c.name])
    : part === "item" ? [{ group: "Templates", options: treeTemplates({ ghosts: false }).map(t => ["template:" + t.id, `All ${templatePlural(t).toLowerCase()}`]) },
        { group: "Items", options: store.catalog().filter(i => i.name).sort((a, b) => a.name.localeCompare(b.name)).map(i => [i.id, i.name]) }]
    : part === "drawing" ? drawingLibrary().map(d => [d.id, d.name || "Untitled drawing"])
    : part === "panel" ? gmControls().filter(p => p.kind === "panel" || p.controls).map(p => [p.id, p.name || "Untitled panel"])
    : part === "control" ? (gmControls().find(p => p.id === scope.panel)?.controls || []).filter(c => c.type !== "tabs").map(c => [c.id, controlName(c)]) : [];
  // What can be added to the scope: a panel's control's rule names only its panel and control;
  // other rules a character, item or drawing (a rule an item carries: a character).
  const addable = opts.self ? ["character"] : scope.panel ? ["control"] : scopeParts(scope).length ? ["character", "item", "drawing"] : ["character", "item", "drawing", "panel"];
  const firstOf = part => { const o = partOptions(part)[0]; return Array.isArray(o) ? o[0] : o?.options?.[0]?.[0]; };
  const scopeBlock = ruleBlock("scope", "Applies to", h("div", { class: "rblk-line" },
    opts.self && h("span", { class: "pill pill-fixed" }, opts.self === "template" ? "Items made from it" : "This item"),
    SCOPE_PARTS.filter(p => scope[p] != null && !(opts.self && p === "item")).map(p => [
      pillSelect(`Applies to: ${p}`, partOptions(p), scope[p], v => setPart(p, v)),
      h("button", { type: "button", class: "rblk-x", "aria-label": `Remove the ${p}`, onclick: () => setPart(p, null) }, "×")]),
    addable.filter(p => scope[p] == null && partOptions(p).length)
      .map(p => h("button", { type: "button", class: "pill pill-slot", onclick: () => setPart(p, firstOf(p)) }, `+ ${p === "item" ? "item or template" : p}`)),
    !opts.self && !scopeParts(scope).length && h("span", { class: "rblk-note" }, "the world")));

  // What it overrides, or what overrides it (a rule-book rule, as it is now).
  const all = opts.book ? allRulesListed() : [];
  const me = opts.book ? { rule: r, scope: r.appliesTo || {}, source: "book" } : null;
  const links = me ? overrideLinks(me, all.filter(x => !(x.source === "book" && x.rule.id === r.id))) : { overrides: [], overriddenBy: [] };
  const overBox = (links.overrides.length > 0 || links.overriddenBy.length > 0) && h("div", { class: "rule-override" },
    links.overrides.length > 0 && h("p", null, h("b", null, "Overrides "), links.overrides.map(o => `“${ruleWords(o.rule)}” (${scopeWords(o.scope).replace(/^For |\.$/g, "")})`).join("; "),
      ` ${scopeWords(r.appliesTo).replace(/^For /, "for ").replace(/\.$/, "")}: only this one runs then.`),
    links.overriddenBy.length > 0 && h("p", null, h("b", null, "Overridden "), links.overriddenBy.map(o => scopeWords(o.scope).replace(/\.$/, "").replace(/^For /, "for ")).join("; "),
      ", where a more specific rule runs instead."));

  // Add a block: a palette of what fits here.
  const palette = () => {
    const pick = fn => () => { fn(); closePal?.(); redraw(); };
    let closePal = null;
    const chip = (kind, label, fn, off) => h("button", { type: "button", class: "rblk rblk-" + kind + " rblk-chip", disabled: !!off, title: off || "", onclick: off ? null : pick(fn) }, label);
    const groups = h("div", { class: "rule-palette" },
      h("h4", null, "When"), h("div", { class: "rule-palette-row" },
        levelEvents(level).map(e => chip("when", e.label, () => setWhen(r, e.name, level, opts))),
        !opts.self && level !== "control" && chip("when", "A control is used", () => { setPart("panel", firstOf("panel")); },
          partOptions("panel").length ? null : "Make a panel first (GM → Controls → Panels)")),
      level === "item" && [h("h4", null, "Ready-made actions"), h("div", { class: "rule-palette-row" },
        actionStarters().map(s => chip("when", s.label, () => { Object.assign(r, clone(s.rule)); delete r.test; delete r.every; })))],
      h("h4", null, "If"), h("div", { class: "rule-palette-row" },
        chip("if", "a value is…", () => { (r.if ||= []).push(firstCond(level)); }),
        level === "item" && chip("if", "a state is on", () => { (r.if ||= []).push({ value: firstStateAddr(), op: "=", to: 1 }); }),
        level === "item" && chip("if", "it's equipped", () => { (r.if ||= []).push({ value: "item.equipped", op: "=", to: 1 }); })),
      h("h4", null, "Do"), h("div", { class: "rule-palette-row" },
        levelActions(level, r.when).map(a => chip(a.key === "message" ? "say" : "action", a.label, () => { r.do.push(newAction(a.name, level, buttons)); }))),
      !opts.self && [h("h4", null, "Applies to"), h("div", { class: "rule-palette-row" },
        addable.filter(p => scope[p] == null && partOptions(p).length).map(p => chip("scope", p === "item" ? "an item or template" : `a ${p}`, () => setPart(p, firstOf(p)))))]);
    closePal = openModal("Add a block", groups);
  };

  return h("div", { class: "rule-blocks" },
    h("div", { class: "rule-words" }, h("b", null, "In words"), ruleWords(r), " ", opts.self ? "" : scopeWords(r.appliesTo)),
    when, ifBlock, doBlock,
    h("button", { type: "button", class: "rule-add-block", onclick: palette }, "+ Add a block"),
    scopeBlock, overBox);
}

// ------------------------------------------------------------------ an item's or a template's Rules tab

// The rules an item (or a template) carries, edited in place in owner.triggers, as blocks; then,
// read-only, the rule book's rules that apply to it. what: "item" | "template"; id: the catalog
// item it is (an inventory copy's item has none of its own: its entry's srcId).
function itemRulesEditor(owner, what = "item", id = owner.id) {
  owner.triggers = (owner.triggers || []).map(ruleOf).filter(Boolean).map(clone);
  for (const r of owner.triggers) if (r.message) { (r.do ||= []).push({ message: r.message }); delete r.message; }
  const box = h("div", { class: "item-rules" });
  const states = systemStates();
  // The book's rules for this kind of item: those naming it, or a template it's in.
  const fromBook = () => {
    const tpl = what === "template" ? templateById(owner.id) : itemTemplate(owner);
    const lineage = templateLineage(tpl).map(t => "template:" + t.id);
    return (store.campaign()?.rules || []).map(ruleOf).filter(Boolean).filter(r => {
      const it = r.appliesTo?.item;
      return it && (it === id || lineage.includes(it));
    });
  };
  const draw = () => setChildren(box,
    h("p", { class: "muted small" }, what === "template" ? "Items made from this template start with these: their actions (buttons) and what happens by itself."
      : "Its actions (each a button in its details and menu, or a hotspot of its drawing) and what happens by itself. They travel with it (exports, rule packages)."),
    !clockworkOn() && h("p", { class: "muted small" }, "Rules, values and controls are off for this campaign: its actions still work; nothing happens by itself."),
    owner.triggers.length > 0 && h("div", { class: "rule-group-head" }, h("h3", null, what === "template" ? "Its rules" : "This item's own")),
    owner.triggers.map((r, i) => h("div", { class: "item-rule" },
      ruleBlocks(r, { onChange: draw, self: what, drawing: owner.iconDoc || findDrawing(owner.iconLib)?.doc,
        buttons: owner.triggers.filter(x => x.when === "used" && x.button).map(x => x.button) }),
      h("button", { type: "button", class: "btn danger-hover item-rule-remove", onclick: () => { owner.triggers.splice(i, 1); draw(); } }, icon("trash"), "Remove this rule"))),
    h("button", { type: "button", class: "rule-add-block", onclick: () => {
      // A ready-made action (a button), or a blank rule.
      let close;
      const add = rule => { owner.triggers.push(clone(rule)); close(); draw(); };
      close = openModal("Add a rule", h("div", { class: "rule-palette" },
        h("h4", null, "An action (a button in its details and menu)"), h("div", { class: "rule-palette-row" },
          actionStarters().map(s => h("button", { type: "button", class: "rblk rblk-when rblk-chip", onclick: () => add(s.rule) }, s.label)),
          h("button", { type: "button", class: "rblk rblk-when rblk-chip", onclick: () => add({ when: "used", button: "New action", do: [{ message: "" }] }) }, "Another…")),
        h("h4", null, "Something that happens by itself"), h("div", { class: "rule-palette-row" },
          h("button", { type: "button", class: "rblk rblk-do rblk-chip", onclick: () => add({ when: "acquired", do: states[0] ? [{ set: `item.state.${states[0].key}`, to: 1 }] : [{ message: "" }] }) }, "A rule"))));
    } }, "+ Add a rule"),
    (() => { const list = fromBook(); return list.length > 0 && [
      h("div", { class: "rule-group-head" }, h("h3", null, "From the rule book")),
      list.map(r => h("button", { type: "button", class: "rule-card", onclick: () => isGmDevice() && editing() ? openRuleEditor(r) : toast("The GM's rule book: GM → Controls → Rules") },
        h("span", { class: "rule-card-words" }, ruleWords(r)),
        h("span", { class: "chips" }, scopeParts(r.appliesTo).map(p => h("span", { class: "chip scope" }, scopePartLabel(p, r.appliesTo[p])))))),
      isGmDevice() && h("p", { class: "muted small" }, "Tap one to open it in the rule book.")]; })());
  draw();
  return box;
}
