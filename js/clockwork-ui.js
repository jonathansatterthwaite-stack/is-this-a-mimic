// Clockwork in the GM tab: the Values tab (Global and Local values, and the boards), the
// Clockwork tab (what's connected to what), and the cog beside a connected item's name, which
// only GMs see. See js/clockwork.js.

// ------------------------------------------------------------------ a value's control

// A value at one level: its choices, or a slider and a number; "inherited" (the level above, or
// the value's default, applies) until set.
function valueControl(spec, own, inherited, onSet) {
  const shown = Math.round((own ?? inherited ?? 0) * 1000) / 1000; // (a value changing over time is shown as it is now, rounded)
  const clear = own !== undefined ? iconBtn("x", "Clear (use the value above)", () => onSet(null))
    : h("span", { class: "muted small gm-inherit" }, "inherited");
  if (spec.choices?.length) {
    return h("div", { class: "gm-control" + (own === undefined ? " inherits" : "") },
      h("select", { "aria-label": "Value", onchange: ev => onSet(+ev.target.value) },
        spec.choices.map((c, i) => h("option", { value: i, selected: Math.round(shown) === i }, c))), clear);
  }
  const min = Math.min(spec.min ?? 0, shown), max = Math.max(spec.max ?? 1, shown), step = spec.step || "any";
  // (Any number can be typed: a value set elsewhere, or moving, needn't be on the slider's steps.)
  const num = h("input", { type: "number", class: "gm-num", step: "any", value: shown, "aria-label": "Value",
    onchange: ev => { if (ev.target.value !== "") onSet(+ev.target.value); } });
  const range = h("input", { type: "range", min, max, step, value: shown, "aria-label": "Value",
    oninput: ev => { num.value = ev.target.value; }, onchange: ev => onSet(+ev.target.value) });
  return h("div", { class: "gm-control" + (own === undefined ? " inherits" : "") }, range, num, clear);
}

// Changing a value over time (a moving value, js/clockwork.js): while it moves, how, and Stop (it
// keeps the value it's reached); else a clock button to start it. (Not for a state's limit.)
function moveControl(spec, scope, target, name) {
  if (systemStates().some(st => limitValueName(st) === name)) return null;
  const key = valueKey(name), g = valueSet();
  const raw = (scope === "party" ? g.party : g[scope === "item" ? "items" : "characters"]?.[target])?.[key];
  const [ctx, address] = clockwork.at(scope, target, name);
  if (stillMoving(raw)) {
    return h("span", { class: "gm-moving", title: "Changing over time" }, icon("clock"),
      h("span", null, `${raw.rate > 0 ? "+" : ""}${fmtNum(raw.rate)} a second` + (raw.until != null ? `, to ${fmtNum(raw.until)}` : "")),
      h("button", { class: "btn", onclick: () => clockwork.change(ctx, address, Math.round(valueNow(raw) * 1e6) / 1e6, "gm") }, "Stop"));
  }
  return iconBtn("clock", "Change over time…", () => {
    const from = valueAt(scope, target, key) ?? spec.value ?? 0;
    const rate = h("input", { type: "number", step: "any", value: 1, "aria-label": "How much a second" });
    const until = h("input", { type: "number", step: "any", value: spec.max ?? "", placeholder: "Never", "aria-label": "Stops at" });
    let close;
    const go = () => {
      const r = +rate.value, u = until.value === "" ? null : +until.value;
      if (!r) return toast("How much a second? (Negative to go down)");
      close();
      clockwork.change(ctx, address, { rate: r, ...(u != null ? { until: u } : {}) }, "gm");
    };
    close = openModal(`Change ${name} over time`, h("form", { class: "form", onsubmit: ev => { ev.preventDefault(); go(); } },
      h("p", { class: "muted small" }, `From ${fmtNum(from)} now, by this much every second (negative to go down), until it reaches where it stops. Every device works it out from the time, so it moves smoothly for everyone.`),
      h("div", { class: "form grid" },
        h("label", { class: "field" }, h("span", null, "A second"), rate),
        h("label", { class: "field" }, h("span", null, "Stops at"), until))), { footer: [
      h("button", { class: "btn", onclick: () => close() }, "Cancel"),
      h("button", { class: "btn primary", onclick: go }, icon("clock"), "Start") ] });
  });
}

const showValue = (spec, v) => v === undefined ? "not set" : spec?.choices?.[Math.round(v)] ?? String(v);

// Which items' drawings use each value: "global:name" / "local:name" -> [{ char, e }].
function valueUsers() {
  const out = new Map();
  for (const c of gmChars()) for (const e of c.items) {
    if (!e.item.iconDoc) continue;
    for (const r of drawingValueRefs(e.item.iconDoc).values()) {
      for (const s of r.scope === "any" ? ["global", "local"] : [r.scope]) {
        const k = `${s}:${r.name}`;
        if (!out.has(k)) out.set(k, []);
        out.get(k).push({ char: c, e });
      }
    }
  }
  return out;
}

const foldToggle = key => {
  const closed = ui.collapsed.has(key);
  return [closed, h("button", { class: "collapse" + (closed ? " closed" : ""), "aria-expanded": String(!closed),
    onclick: () => { closed ? ui.collapsed.delete(key) : ui.collapsed.add(key); render(); } }, icon("chevron"))];
};

// ------------------------------------------------------------------ the Values tab

function valuesView() {
  const vals = [...knownValues().values()];
  const users = valueUsers(), chars = gmChars();
  const set = (scope, target, name) => value => clockwork.change(...clockwork.at(scope, target, name), value, "gm");
  const usedBy = list => list?.length ? `Read by the icons of ${plural(list.length, "item")}` : "No item's icon reads it yet";
  const title = v => [h("code", null, v.name), v.label && h("span", { class: "muted" }, " " + v.label)];

  // A card grid (docs/ui-patterns.md): the Global values together, then a card per Local value.
  const globals = vals.filter(v => v.scope === "global");
  const globalCard = h("div", { class: "group gm-var gm-globals" },
    h("div", { class: "group-head" }, h("h3", null, "Global values"), h("span", { class: "muted small" }, "One for the whole campaign")),
    globals.length ? globals.map(v => h("div", { class: "row gm-level" },
      h("div", { class: "row-main static" }, h("div", { class: "row-title" }, title(v)),
        h("div", { class: "row-sub" }, usedBy(users.get(`global:${v.name}`)))),
      valueControl(v, globalValue(v.name), v.value, set("party", "", v.name)), moveControl(v, "party", "", v.name)))
      : h("p", { class: "muted pad" }, "No Global values yet. In the icon editor's Variables tab, add one with + Global value (a name starting ",
        h("code", null, "global_"), ") and bind layers to it, or set one with a board's pin for Everyone."));

  const locals = vals.filter(v => v.scope === "local");
  const localCards = !locals.length ? [h("div", { class: "group gm-var" },
      h("div", { class: "group-head" }, h("h3", null, "Local values")),
      h("p", { class: "muted pad" }, "No Local values yet. In the icon editor's Variables tab, add one with + Local value (a name starting ",
        h("code", null, "local_"), ")."))]
    : locals.map(v => {
      const [closed, toggle] = foldToggle(`val:local:${v.name}`);
      const using = users.get(`local:${v.name}`) || [];
      return h("div", { class: "group gm-var" },
        h("div", { class: "group-head" }, toggle, h("h3", null, title(v), " ", h("span", { class: "tag" }, "Local")), h("span", { class: "muted small" }, usedBy(using))),
        !closed && chars.map(c => {
          const mine = charLocal(c.id, v.name);
          const items = c.items.filter(e => using.some(u => u.e === e) || itemLocal(c.id, e.uid, v.name) !== undefined);
          return h("div", { class: "gm-player" },
            h("div", { class: "row gm-level" },
              h("div", { class: "row-main static" }, h("div", { class: "row-title" }, c.name, c.mine && h("span", { class: "tag" }, "yours")),
                h("div", { class: "row-sub" }, "Their items use this unless it's set on the item")),
              valueControl(v, mine, v.value, set("character", c.id, v.name)), moveControl(v, "character", c.id, v.name)),
            items.map(e => {
              const own = itemLocal(c.id, e.uid, v.name);
              return h("div", { class: "row gm-level gm-item" },
                itemIcon(currentItem(e, c), "row-icon", () => entryIconVars(c, e)),
                h("div", { class: "row-main static" }, h("div", { class: "row-title" }, entryName(e)),
                  h("div", { class: "row-sub" }, `Uses ${showValue(v, own ?? mine ?? v.value)} (from ${own !== undefined ? "this item" : mine !== undefined ? "the character" : "the default"})`)),
                valueControl(v, own, mine ?? v.value, set("item", `${c.id}/${e.uid}`, v.name)), moveControl(v, "item", `${c.id}/${e.uid}`, v.name));
            }));
        }));
    });

  return [
    !party.active && h("p", { class: "muted small pad" }, `Starting values for ${store.campaign().name}, ready for the next session: they go to the party when you load this campaign into it. Your own icons show them meanwhile.`),
    h("p", { class: "muted small gm-values-intro" }, h("b", null, "Global values"), " are one for the whole campaign: every item sees the same, like the weather or a doom clock (drawn icons read them as ",
      h("code", null, "global_name"), "). ", h("b", null, "Local values"), " are each character's own, and each item's own: an item uses its own, else its character's (",
      h("code", null, "local_name"), ")."),
    cardGrid([globalCard, ...localCards], { cls: "gm-values" }),
    h("p", { class: "muted small pad" }, "Panels and boards for setting these in play are on the Panels tab."),
  ];
}

// ------------------------------------------------------------------ the Clockwork tab

const LAYER_FIELD_WORDS = { cost: "worth", acBonus: "AC bonus", maxCharges: "charges" };

function layerWords(L) {
  const fields = Object.keys(L).filter(k => !LAYER_META.has(k) && L[k] !== "" && L[k] != null).map(k => LAYER_FIELD_WORDS[k] || k);
  const feats = Object.entries(L.features || {}).filter(([, on]) => on).map(([k]) => featureByKey(k)?.label || k);
  const locks = (L.locks || []).map(k => stateByKey(k)?.label || k);
  return [fields.length && `changes ${fields.join(", ")}`, feats.length && `turns on ${feats.join(", ")}`,
    locks.length && `locks ${locks.join(", ")}`].filter(Boolean).join("; ") || "nothing yet";
}

function clockworkItemCard(c, e) {
  const k = itemConnections(c, e), key = `${c.id}/${e.uid}`;
  const line = (label, ...content) => h("div", { class: "cw-line" }, h("span", { class: "cw-label muted small" }, label), h("div", { class: "cw-what" }, content));
  const changers = [
    ...statesFor(e).filter(st => k.reads.some(r => r.address === `item.state.${st.key}`) && canPlayerSet(c, e, st.key))
      .map(st => `the player (${st.label})`),
    k.reads.some(r => r.address.startsWith("item.state.")) && `the ${term("gm")}'s state menu`,
    k.triggers.length > 0 && "its own rules",
    ...k.setters.map(s => s.label),
    k.refs.size > 0 && `the ${term("gm")}'s values (Values tab)`,
  ].filter(Boolean);
  return h("div", { class: "group cw-item" + (ui.cwFocus === key ? " focus" : ""), id: "cw-" + key.replace("/", "-") },
    h("div", { class: "group-head" },
      itemIcon(currentItem(e, c), "row-icon", () => entryIconVars(c, e)),
      h("h3", null, entryName(e)),
      statesOnFor(c, e).map(st => h("span", { class: "tag attuned" }, st.label.toLowerCase()))),
    h("div", { class: "cw-body" },
      k.triggers.length > 0 && line("Rules", h("ul", { class: "cw-rules" }, k.triggers.map(t => h("li", null, ruleWords(t))))),
      k.layers.length > 0 && line("Layers", h("ul", { class: "cw-rules" }, k.layers.map(st => h("li", null,
        h("b", null, st.label), ` (${stateOn(c, e, st.key) ? "on" : "off"}): ${layerWords(e.item.layers[st.key])}`)))),
      k.reads.length > 0 && line("Reads", k.reads.map(r => h("span", { class: "chip" + (r.value === undefined ? " muted" : ""), title: r.address },
        `${r.label} = ${r.value === undefined ? (r.fallback !== undefined ? `${r.fallback} (default)` : "not set") : r.value}`))),
      (k.overrides.length > 0 || k.setHere.length > 0) && line("Set here",
        k.overrides.map(o => h("span", { class: "chip" }, `${o.state.label} held ${o.on ? "on" : "off"} by the ${term("gm")}`)),
        k.setHere.map(v => h("span", { class: "chip" }, `${v.name} = ${v.value}`))),
      changers.length > 0 && line("Changed by", changers.join(" · ")),
      (k.live || k.layers.length > 0) && line("Shows", [k.live && "its live icon", k.layers.length > 0 && "what it is now (its layers)"].filter(Boolean).join(" · "))));
}

function clockworkView() {
  const chars = gmChars();
  const groups = chars.map(c => [c, byName(c.items.filter(e => usesClockwork(c, e)))]).filter(([, list]) => list.length);
  // Opened from an item's cog: show it.
  if (ui.cwFocus) {
    const id = "cw-" + ui.cwFocus.replace("/", "-");
    setTimeout(() => { document.getElementById(id)?.scrollIntoView({ block: "center" }); ui.cwFocus = null; }, 0);
  }
  const users = valueUsers();
  const globals = [...knownValues().values()].filter(v => v.scope === "global");
  const pinsFor = name => valueSetters().filter(s => s.scope === "party" && s.names.includes(name)).map(s => s.label);
  return [
    h("section", { class: "cw" },
      h("p", { class: "muted small" }, "What makes items react: their rules and layers, the values their icons read, and what changes them. Items with a cog beside their name (only you see it) are here."),
      groups.length ? groups.map(([c, list]) => h("div", { class: "cw-char" },
        h("h3", { class: "cw-char-name" }, c.name, c.mine && h("span", { class: "tag" }, "yours")),
        cardGrid(list.map(e => clockworkItemCard(c, e)))))
        : emptyState("link", "Nothing is connected yet. Items with rules, layers, or a drawn icon that reads values show up here.")),
    globals.length > 0 && h("section", { class: "cw" },
      h("h3", null, "What each Global value reaches"),
      h("p", { class: "muted small" }, "Moving one changes all of these."),
      cardGrid(globals.map(v => {
        const using = users.get(`global:${v.name}`) || [], pins = pinsFor(v.name), shops = shopValueReaders().filter(r => r.name === v.name);
        return h("div", { class: "group" }, h("div", { class: "row gm-level" }, h("div", { class: "row-main static" },
          h("div", { class: "row-title" }, h("code", null, v.name), h("span", { class: "muted" }, ` = ${showValue(v, globalValue(v.name) ?? v.value)}`)),
          h("div", { class: "row-sub" }, [using.length ? "Read by " + using.map(u => `${u.char.name}'s ${entryName(u.e)}`).join(", ") : !shops.length && "Nothing reads it",
            ...shops.map(r => r.what === "opens" ? `opens ${r.shop.name}` : r.what === "prices" ? `sets ${r.shop.name}'s prices`
              : `puts ${r.item.name} on sale at ${r.shop.name}`),
            pins.length && "set by " + pins.join(", ")].filter(Boolean).join(" · ")))));
      }), { min: 320 })),
  ];
}

// ------------------------------------------------------------------ the cog

// Beside a connected item's name, for GMs: opens Controls → Connections at it. before: e.g. close a dialog.
function clockworkCog(char, e, before) {
  if (!char || !isGmDevice() || !clockworkOn() || !usesClockwork(char, e)) return null;
  return iconBtn("cog", `Connections: what drives ${entryName(e)}`, () => {
    before?.();
    const root = document.getElementById("modal-root");
    root.replaceChildren();
    document.body.classList.remove("modal-open");
    ui.gmTab = "controls";
    ui.gmControlsTab = "connections";
    ui.cwFocus = `${char.id}/${e.uid}`;
    go("gm");
  }, "cw-cog");
}
