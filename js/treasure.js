// Treasure: hoards the GM makes, to give out as loot, and treasure tables to roll them up (the GM
// Items tab's Treasure: a GM's). Plan: docs/gm-tools-plan.md (presenting a hoard to players comes next).
//
// A hoard is kept like a character's inventory, so containers, stacks and sets work the same:
//   store.state.hoards: [{ id, name, notes, coins: { gp: 3, … }, items: [entry] }]
// with entries as in an inventory (parent = the container it's in, compartment = which of its spaces).
// Kept with the campaign, on the GM's device.
//
// Giving a hoard to a character moves everything across, containers and all: items arrive as
// newly acquired (their triggers fire), and loose stackable items join the character's stacks.

const hoards = () => store.state.hoards || [];
const newHoard = name => ({ id: "h" + uid(), name, notes: "", coins: {}, items: [] });

// Change one of this campaign's hoards (found again by id: the data may have been replaced).
function updateHoard(id, fn, msg, undoable = false) {
  commit(s => { const hd = (s.hoards || []).find(x => x.id === id); if (hd) fn(hd); }, msg, undoable);
}

// What a hoard is worth: its items, with their contents (its coins are items too).
const hoardWorth = hd => hd.items.filter(e => !e.parent).reduce((s, e) => s + entryTotalValue(hd, e), 0);
const hoardCoinsLabel = hd => coinOrder().filter(k => hd.coins?.[k]).map(k => `${hd.coins[k]} ${k}`).join(", ");

// ------------------------------------------------------------------ giving

// Move a hoard's contents into a character (this device's). Returns how many entries arrived.
function giveHoard(hd, char) {
  syncCoins(hd, store.state.settings); // (its coins are items: they go across with the rest)
  const newUid = new Map();
  let n = 0;
  // Parents before their contents, so each knows where its container went.
  const place = parent => {
    for (const e of hd.items.filter(x => (x.parent || null) === parent)) {
      const kids = hd.items.some(x => x.parent === e.uid);
      const to = e.parent ? newUid.get(e.parent) ?? null : null;
      if (!kids && !isDeckEntry(e) && !e.customName && !e.item.card && !e.fromDeck) {
        // A plain item: joins a matching stack where it lands.
        // (coins: into the purse, or a pile of them where they go)
        const got = isCoinEntry(e) && !entryComp(e) ? addCoins(char, e.item.coin, e.qty, to) : addToInventory(char, { ...clone(e.item), id: e.srcId }, e.qty, to, to && entryComp(e));
        newUid.set(e.uid, got.uid);
        if (e.liquid) got.liquid = clone(e.liquid);
        if (e.charges != null) got.charges = e.charges;
      } else {
        // As it is (a container, a set and its pieces, a named item).
        const copy = { ...clone(e), uid: uid(), parent: to, equipped: false };
        delete copy.seen; // new to this inventory: "acquired" triggers fire
        if (e.fromDeck) { if (newUid.has(e.fromDeck)) copy.fromDeck = newUid.get(e.fromDeck); else delete copy.fromDeck; }
        newUid.set(e.uid, copy.uid);
        char.items.push(copy);
      }
      n++;
      place(e.uid);
    }
  };
  place(null);
  return n;
}

// ------------------------------------------------------------------ the Treasure tab

function treasureView() {
  const list = hoards();
  return h("section", { class: "treasure" },
    showingsSection(),
    h("div", { class: "section-head" }, h("h2", null, "Treasure"),
      h("button", { class: "btn primary", onclick: () => editHoard(null) }, icon("plus"), "New hoard")),
    h("p", { class: "muted small" }, "Loot to give out: items from the catalog and coins, packed into containers as you like (a chest holding a pouch of gems). Give a hoard to a character and it all arrives in their inventory. Kept on this device, with the campaign."),
    list.length ? list.map(hoardCard)
      : emptyState("coins", "No hoards yet.", h("button", { class: "btn primary", onclick: () => editHoard(null) }, icon("plus"), "Make a hoard")),
    tablesSection());
}

function hoardCard(hd) {
  const key = "hoard:" + hd.id, closed = ui.collapsed.has(key);
  const toggle = () => { closed ? ui.collapsed.delete(key) : ui.collapsed.add(key); render(); };
  const count = hd.items.filter(e => !inDeck(hd, e)).length;
  return h("div", { class: "group hoard-card" },
    h("div", { class: "group-head" },
      h("button", { class: "collapse" + (closed ? " closed" : ""), "aria-expanded": String(!closed), onclick: toggle }, icon("chevron"), h("h3", null, hd.name)),
      h("span", { class: "muted small" }, [plural(count, "item"), hoardCoinsLabel(hd), `worth ${fmtCost(hoardWorth(hd))}`].filter(Boolean).join(" · ")),
      iconBtn("edit", `Rename ${hd.name}`, () => editHoard(hd)),
      iconBtn("copy", `Copy ${hd.name}`, () => commit(s => { s.hoards.push({ ...clone(hd), id: "h" + uid(), name: hd.name + " (copy)" }); }, `Copied ${hd.name}`)),
      iconBtn("trash", `Delete ${hd.name}`, () => confirmDialog(`Delete the hoard “${hd.name}”?`, "Delete",
        () => commit(s => { s.hoards = s.hoards.filter(x => x.id !== hd.id); }, `Deleted ${hd.name}`, true)), "danger-hover")),
    !closed && hd.showing && h("div", { class: "hoard-body" },
      h("p", { class: "warn-text small" }, "Being shown to players: it's locked until they've picked, then what's left comes back here (see Showing, above)."),
      showings().some(t => t.id === hd.showing) ? null
        : h("button", { class: "btn", onclick: () => updateHoard(hd.id, x => { delete x.showing; }, "Unlocked") }, "Unlock it (the showing has gone)")),
    !closed && !hd.showing && h("div", { class: "hoard-body" },
      hd.notes && h("p", { class: "muted small" }, hd.notes),
      h("div", { class: "hoard-items" }, itemManager({ key: "hoard:" + hd.id, prefsKey: "treasure", placeholder: "Search the hoard", storage: () => hoardStorage(hd) })),
      h("div", { class: "inline wrap hoard-actions" },
        h("button", { class: "btn", onclick: () => openStockPicker({
          title: `Add to ${hd.name}`,
          has: () => false, // the same item again just adds more
          add: (id, snapshot) => updateHoard(hd.id, x => addToInventory(x, { ...clone(snapshot), id })),
        }) }, icon("plus"), "Add items"),
        party.active && isGmDevice() && h("button", { class: "btn", disabled: !hd.items.length && !coinTotalCp(hd.coins || {}), onclick: () => showHoard(hd) },
          icon("users"), "Show to players…"),
        hoardGive(hd)),
      hoardCoins(hd)));
}

// A hoard as a storage (see storageTree in js/app.js): shown like an inventory. Drag items between
// its containers, change how many, reorder its containers; an item's details move it or take it out.
function hoardStorage(hd) {
  const change = fn => updateHoard(hd.id, fn);
  return {
    char: hd, id: "hoard:" + hd.id, rootLabel: "Loose",
    open: e => hoardItem(hd, e),
    setQty: (e, n) => {
      n = Math.max(0, Math.floor(+n || 0));
      updateHoard(hd.id, x => { const it = x.items.find(i => i.uid === e.uid); if (!it) return; if (n) it.qty = n; else removeEntry(x, it.uid); },
        n ? null : `Took ${entryName(e)} out`, !n);
    },
    move: (uid, parent, compartment) => {
      if (uid === parent || (parent && isDescendant(hd, parent, uid))) return toast("Can't put a container inside itself");
      change(x => { const it = x.items.find(i => i.uid === uid); if (it) placeEntry(it, parent, compartment); });
    },
    reorder: ids => change(x => { x.containerOrder = [...ids, ...(x.containerOrder || []).filter(id => !ids.includes(id))]; }),
    empty: () => h("p", { class: "muted pad" }, "Empty. Add items from the catalog, then put them in containers."),
  };
}

// An item in a hoard: where it is, how many, or out of the hoard.
function hoardItem(hd, e) {
  let close;
  const where = h("select", { "aria-label": "Location" }, containerOptions(hd, e.uid));
  where.options[0].textContent = "Loose";
  where.value = locationValue(e, hd);
  where.onchange = () => { const loc = parseLocation(where.value); hoardStorage(hd).move(e.uid, loc.parent, loc.compartment); close(); };
  const controls = h("div", { class: "entry-controls" },
    h("label", { class: "field" }, h("span", null, "Location"), where),
    h("label", { class: "field" }, h("span", null, "Quantity"),
      h("input", { type: "number", min: 0, value: e.qty, inputmode: "numeric",
        onchange: ev => { hoardStorage(hd).setQty(e, ev.target.value); close(); } })));
  close = openStoredItem(hoardStorage(hd), e, controls,
    [h("button", { class: "btn danger", onclick: () => { close(); hoardStorage(hd).setQty(e, 0); } }, icon("trash"), "Take it out")]);
}

function hoardCoins(hd) {
  return h("div", { class: "hoard-coins" }, h("span", { class: "muted small" }, "Coins"),
    currency().coins.map(c => h("label", { class: "field mini" }, h("span", null, c.key),
      h("input", { type: "number", min: 0, inputmode: "numeric", value: hd.coins?.[c.key] || "", placeholder: "0", "aria-label": `${c.name || c.key} coins`,
        onchange: ev => { const n = Math.max(0, Math.floor(+ev.target.value || 0)); updateHoard(hd.id, x => { x.coins = { ...(x.coins || {}) }; if (n) x.coins[c.key] = n; else delete x.coins[c.key]; }); } }))));
}

// Give it to one of this device's characters. (Showing it to players in a party comes next.)
function hoardGive(hd) {
  const chars = (party.active ? party.linked() : store.state.characters).filter(c => !isBlankCharacter(c) || c.id === store.state.activeId);
  if (!chars.length) return null;
  const sel = h("select", { "aria-label": `Give ${hd.name} to` }, chars.map(c => h("option", { value: c.id }, c.name)));
  sel.value = store.state.activeId;
  const empty = !hd.items.length && !coinTotalCp(hd.coins || {});
  return h("div", { class: "inline hoard-give" }, h("span", { class: "muted small" }, "Give to"), sel,
    h("button", { class: "btn primary", disabled: empty, onclick: () => {
      const char = store.state.characters.find(c => c.id === sel.value);
      if (!char) return;
      confirmDialog(`Give everything in “${hd.name}” to ${char.name}? The hoard is emptied.`, "Give", () => {
        let n = 0;
        commit(s => {
          const x = s.hoards.find(y => y.id === hd.id), c = s.characters.find(y => y.id === char.id);
          if (!x || !c) return;
          n = giveHoard(x, c);
          x.items = [];
          x.coins = {};
        }, `${char.name} received ${hd.name}`, true);
        if (party.active && party.isLinked(char.id)) party.put(char.id).catch(e => toast(e.message));
      });
    } }, icon("check"), "Give"));
}

function editHoard(hd) {
  const draft = { name: hd?.name || "", notes: hd?.notes || "" };
  let close;
  const save = () => {
    const name = draft.name.trim() || "Hoard";
    close();
    if (hd) updateHoard(hd.id, x => Object.assign(x, { name, notes: draft.notes.trim() }), "Saved");
    else commit(s => { s.hoards = [...(s.hoards || []), { ...newHoard(name), notes: draft.notes.trim() }]; }, `Made ${name}`);
  };
  close = openModal(hd ? `Edit ${hd.name}` : "New hoard", h("div", { class: "form" },
    h("label", { class: "field" }, h("span", null, "Name"),
      h("input", { type: "text", value: draft.name, maxlength: 80, placeholder: "e.g. The ogre's chest, Bandit leader's purse", oninput: e => { draft.name = e.target.value; } })),
    h("label", { class: "field" }, h("span", null, "Notes (only you see them)"),
      h("textarea", { rows: 2, maxlength: 1000, value: draft.notes, placeholder: "Where it is, what guards it…", oninput: e => { draft.notes = e.target.value; } }))),
  { footer: [h("button", { class: "btn", onclick: () => close() }, "Cancel"), h("button", { class: "btn primary", onclick: save }, icon("check"), hd ? "Save" : "Make it")] });
}

// ------------------------------------------------------------------ treasure tables
// Tables the GM rolls on to fill a hoard (step 2 of treasure):
//   store.state.treasureTables: [{ id, name, die: "d20", rows: [{ id, from, to, gives: [give] }] }]
// A row is chosen when the die's roll is from `from` to `to`. What it gives:
//   { kind: "item", srcId, item, qty: "1d4" }      an item (how many: dice or a number)
//   { kind: "coins", coin: "gp", amount: "3d6×10" } coins
//   { kind: "table", table: id, times: "1" }       roll on another table (up to 5 deep)
//   { kind: "hoard", hoard: id }                    a copy of everything in a hoard
// Rolled into a new hoard, or added to one, to edit before giving it out.

const treasureTables = () => store.state.treasureTables || [];

// Dice: "d20", "2d6", "3d6+2", "3d6×10" (or *10), "1d4-1", or a plain number. null if it isn't one.
function parseDice(text) {
  const t = String(text ?? "").replace(/\s+/g, "").replace(/[×x]/gi, "*").toLowerCase();
  const m = /^(\d{0,3})d(\d{1,4})([+-]\d{1,6})?(?:\*(\d{1,6}))?$/.exec(t);
  if (m) return +m[2] > 0 && +(m[1] || 1) <= 100 ? { n: +(m[1] || 1), sides: +m[2], plus: +(m[3] || 0), times: +(m[4] || 1) } : null;
  return /^\d{1,7}$/.test(t) ? { n: 0, sides: 0, plus: +t, times: 1 } : null;
}
function rollDice(text, random = Math.random) {
  const d = parseDice(text);
  if (!d || d.n > 100 || (d.n && d.sides < 1)) return null;
  let sum = d.plus;
  for (let i = 0; i < d.n; i++) sum += 1 + Math.floor(random() * d.sides);
  return Math.max(0, sum * d.times);
}
// The die's lowest and highest roll ("2d6": 2 to 12).
function diceRange(text) {
  const d = parseDice(text);
  return d ? [Math.max(0, (d.n + d.plus) * d.times), Math.max(0, (d.n * d.sides + d.plus) * d.times)] : [1, 1];
}

function giveWords(g) {
  const name = id => treasureTables().find(t => t.id === id)?.name || hoards().find(x => x.id === id)?.name || "(gone)";
  if (g.kind === "item") return `${g.qty || 1} × ${g.item?.name || "item"}`;
  if (g.kind === "coins") return `${g.amount || 0} ${g.coin}`;
  if (g.kind === "table") return `roll ${g.times && g.times !== "1" ? g.times + " times " : ""}on ${name(g.table)}`;
  if (g.kind === "hoard") return `everything in ${name(g.hoard)}`;
  return "?";
}

// Roll on a table into a hoard (changes `into`). log: [{ table, roll, row, depth }].
function rollTreasure(table, into, log = [], depth = 0, random = Math.random) {
  const roll = rollDice(table.die || "d20", random) ?? 0;
  const row = (table.rows || []).find(r => roll >= r.from && roll <= r.to);
  log.push({ table: table.name, roll, row, depth });
  for (const g of row?.gives || []) {
    if (g.kind === "item" && g.item) {
      const n = rollDice(g.qty || "1", random);
      if (n > 0) addToInventory(into, { ...clone(g.item), id: g.srcId }, n);
    } else if (g.kind === "coins") {
      const n = rollDice(g.amount || "0", random);
      if (n > 0) into.coins = { ...(into.coins || {}), [g.coin]: (into.coins?.[g.coin] || 0) + n };
    } else if (g.kind === "table" && depth < 5) {
      const t = treasureTables().find(x => x.id === g.table);
      const times = Math.min(20, rollDice(g.times || "1", random) || 0);
      for (let i = 0; t && i < times; i++) rollTreasure(t, into, log, depth + 1, random);
    } else if (g.kind === "hoard") {
      const src = hoards().find(x => x.id === g.hoard);
      if (src && src !== into) giveHoard(src, into); // a copy: the hoard keeps its own
    }
  }
  return log;
}

function tablesSection() {
  const list = treasureTables();
  return h("section", { class: "treasure-tables" },
    h("div", { class: "section-head" }, h("h2", null, "Treasure tables"),
      editing() && h("button", { class: "btn", onclick: () => editTreasureTable(null) }, icon("plus"), "New table")),
    h("p", { class: "muted small" }, "Roll for loot: each row of a table covers some rolls of its die and gives items, coins, a roll on another table or a hoard's contents. A roll fills a hoard, to look over before giving it out."),
    list.length ? h("div", { class: "group" }, list.map(t => h("div", { class: "row treasure-table-row" },
      icon("dice"),
      h("div", { class: "row-main static" }, h("div", { class: "row-title" }, t.name, h("span", { class: "tag" }, t.die)),
        h("div", { class: "row-sub" }, plural(t.rows.length, "row"))),
      h("button", { class: "btn primary", onclick: () => openRollTreasure(t) }, icon("dice"), "Roll"),
      editing() && iconBtn("edit", `Edit ${t.name}`, () => editTreasureTable(t)),
      editing() && iconBtn("trash", `Delete ${t.name}`, () => confirmDialog(`Delete the table “${t.name}”?`, "Delete",
        () => commit(s => { s.treasureTables = s.treasureTables.filter(x => x.id !== t.id); }, `Deleted ${t.name}`, true)), "danger-hover"))))
      : emptyState("dice", "No treasure tables yet.", editing() && h("button", { class: "btn", onclick: () => editTreasureTable(null) }, icon("plus"), "Make a table")));
}

// Roll: how many times, and into which hoard (a new one, or one there is); then what came up.
function openRollTreasure(t) {
  let close, times = 1, into = "";
  const save = () => {
    close();
    let log = [], name = "";
    commit(s => {
      s.hoards = s.hoards || [];
      let hd = into && s.hoards.find(x => x.id === into);
      if (!hd) { hd = newHoard(`${t.name} (rolled)`); s.hoards.push(hd); }
      name = hd.name;
      for (let i = 0; i < times; i++) rollTreasure(t, hd, log);
      ui.collapsed.delete("hoard:" + hd.id);
    }, null, true);
    let done;
    done = openModal(`Rolled on ${t.name}`, h("div", { class: "form" },
      h("ul", { class: "roll-log" }, log.map(l => h("li", { style: { marginLeft: l.depth * 18 + "px" } },
        h("b", null, `${l.table}: ${l.roll}`), " — ", l.row ? (l.row.gives.length ? l.row.gives.map(giveWords).join(", ") : "nothing") : "no row for that roll"))),
      h("p", { class: "muted small" }, `It's in the hoard “${name}”, to look over before giving it out.`)),
    { footer: [h("button", { class: "btn primary", onclick: () => done() }, "Done")] });
  };
  close = openModal(`Roll on ${t.name}`, h("div", { class: "form" },
    h("label", { class: "field" }, h("span", null, "How many rolls"),
      h("input", { type: "number", min: 1, max: 20, value: 1, onchange: e => { times = Math.max(1, Math.min(20, Math.floor(+e.target.value || 1))); } })),
    h("label", { class: "field" }, h("span", null, "Into"),
      h("select", { onchange: e => { into = e.target.value; } },
        h("option", { value: "" }, "A new hoard"),
        hoards().map(x => h("option", { value: x.id }, `Add to ${x.name}`))))),
  { footer: [h("button", { class: "btn", onclick: () => close() }, "Cancel"), h("button", { class: "btn primary", onclick: save }, icon("dice"), "Roll")] });
}

function editTreasureTable(t) {
  const draft = t ? clone(t) : { id: "tt" + uid(), name: "", die: "d20", rows: [] };
  let close;
  const body = h("div", { class: "form" });
  const others = () => treasureTables().filter(x => x.id !== draft.id);
  const nextFrom = () => draft.rows.length ? Math.max(...draft.rows.map(r => r.to)) + 1 : diceRange(draft.die)[0];
  const addRow = () => { const from = nextFrom(); draft.rows.push({ id: "r" + uid(), from, to: from, gives: [] }); draw(); };
  // Rows that share a roll, and rolls no row covers (shown, not refused).
  const coverage = () => {
    const [lo, hi] = diceRange(draft.die), notes = [];
    if (hi - lo <= 1000) {
      const missing = [], doubled = [];
      for (let v = lo; v <= hi; v++) {
        const n = draft.rows.filter(r => v >= r.from && v <= r.to).length;
        if (!n) missing.push(v); else if (n > 1) doubled.push(v);
      }
      const ranges = vs => vs.reduce((out, v) => { const last = out[out.length - 1]; if (last && last[1] === v - 1) last[1] = v; else out.push([v, v]); return out; }, [])
        .map(([a, b]) => a === b ? `${a}` : `${a}–${b}`).join(", ");
      if (missing.length) notes.push(`No row for ${ranges(missing)}: nothing comes up then.`);
      if (doubled.length) notes.push(`Rows share ${ranges(doubled)}: the first one is used.`);
    }
    return notes.length ? h("p", { class: "warn-text small" }, notes.join(" ")) : null;
  };
  const addGive = (r, kind) => {
    if (kind === "item") return openStockPicker({ title: "Add an item to the row", has: () => false,
      add: (id, snapshot) => { r.gives.push({ kind: "item", srcId: id, item: clone(snapshot), qty: "1" }); draw(); } });
    if (kind === "coins") r.gives.push({ kind: "coins", coin: currency().coins.find(c => c.key === showCoin().key)?.key || coinOrder()[0], amount: "1d6" });
    if (kind === "table") { const o = others()[0]; if (!o) return toast("Make another table first"); r.gives.push({ kind: "table", table: o.id, times: "1" }); }
    if (kind === "hoard") { const o = hoards()[0]; if (!o) return toast("Make a hoard first"); r.gives.push({ kind: "hoard", hoard: o.id }); }
    draw();
  };
  // A give's details, edited in place: dice for amounts, which coin, table or hoard.
  const giveEdit = (r, g, i) => {
    const dice = (key, label) => h("input", { type: "text", class: "dice-in" + (parseDice(g[key]) ? "" : " invalid"), value: g[key] || "", "aria-label": label, title: "A number, or dice: 1d4, 2d6+1, 3d6×10",
      onchange: e => { g[key] = e.target.value.trim(); e.target.classList.toggle("invalid", !parseDice(g[key])); } });
    const pick = (key, list) => h("select", { onchange: e => { g[key] = e.target.value; draw(); } }, list.map(x => h("option", { value: x.id, selected: x.id === g[key] }, x.name)));
    return h("div", { class: "give-edit" },
      g.kind === "item" && [dice("qty", "How many"), h("span", null, "×"), itemIcon(g.item, "row-icon small"), h("span", null, g.item?.name)],
      g.kind === "coins" && [dice("amount", "How many coins"), h("select", { onchange: e => { g.coin = e.target.value; } },
        currency().coins.map(c => h("option", { value: c.key, selected: c.key === g.coin }, c.key)))],
      g.kind === "table" && [h("span", null, "Roll"), dice("times", "How many times"), h("span", null, "times on"), pick("table", others())],
      g.kind === "hoard" && [h("span", null, "Everything in"), pick("hoard", hoards())],
      iconBtn("x", "Remove", () => { r.gives.splice(i, 1); draw(); }, "danger-hover"));
  };
  const draw = () => setChildren(body,
    h("div", { class: "form grid" },
      h("label", { class: "field" }, h("span", null, "Name"),
        h("input", { type: "text", value: draft.name, maxlength: 80, placeholder: "e.g. Goblin pockets, Dragon hoard (CR 17+)", oninput: e => { draft.name = e.target.value; } })),
      h("label", { class: "field" }, h("span", null, "Die"),
        h("input", { type: "text", value: draft.die, maxlength: 20, placeholder: "d20", class: parseDice(draft.die) ? "" : "invalid",
          onchange: e => { draft.die = e.target.value.trim() || "d20"; draw(); } }))),
    h("p", { class: "muted small" }, `Rolls ${diceRange(draft.die).join(" to ")}. Each row covers some of them.`),
    draft.rows.map((r, ri) => h("div", { class: "tt-row" },
      h("div", { class: "tt-row-head" },
        h("span", { class: "muted small" }, "Rolls"),
        h("input", { type: "number", class: "tt-n", value: r.from, "aria-label": "From", onchange: e => { r.from = Math.floor(+e.target.value || 0); if (r.to < r.from) r.to = r.from; draw(); } }),
        h("span", null, "to"),
        h("input", { type: "number", class: "tt-n", value: r.to, "aria-label": "To", onchange: e => { r.to = Math.max(r.from, Math.floor(+e.target.value || 0)); draw(); } }),
        h("span", { class: "grow" }),
        iconBtn("trash", "Remove the row", () => { draft.rows.splice(ri, 1); draw(); }, "danger-hover")),
      r.gives.length ? r.gives.map((g, i) => giveEdit(r, g, i)) : h("p", { class: "muted small" }, "Gives nothing."),
      h("div", { class: "inline wrap tt-adds" }, h("span", { class: "muted small" }, "Add:"),
        [["item", "Item"], ["coins", "Coins"], ["table", "A roll on a table"], ["hoard", "A hoard"]].map(([k, label]) =>
          h("button", { type: "button", class: "btn", onclick: () => addGive(r, k) }, icon("plus"), label))))),
    h("button", { type: "button", class: "btn", onclick: addRow }, icon("plus"), "Add a row"),
    coverage());
  draw();
  const save = () => {
    if (!parseDice(draft.die)) return toast("The die isn't one the app can roll: try d20, d100 or 2d6");
    const bad = draft.rows.flatMap(r => r.gives).find(g => (g.kind === "item" && !parseDice(g.qty)) || (g.kind === "coins" && !parseDice(g.amount)) || (g.kind === "table" && !parseDice(g.times)));
    if (bad) return toast(`Not a number or dice: ${giveWords(bad)}`);
    draft.name = draft.name.trim() || "Treasure table";
    close();
    commit(s => {
      s.treasureTables = s.treasureTables || [];
      const i = s.treasureTables.findIndex(x => x.id === draft.id);
      if (i >= 0) s.treasureTables[i] = draft; else s.treasureTables.push(draft);
    }, t ? "Saved the table" : `Made ${draft.name}`);
  };
  close = openModal(t ? `Edit ${t.name}` : "New treasure table", body, { wide: true, footer: [
    h("button", { class: "btn", onclick: () => close() }, "Cancel"),
    h("button", { class: "btn primary", onclick: save }, icon("check"), "Save"),
  ] });
  if (!t) addRow();
}

// ------------------------------------------------------------------ showing treasure to players (a party)
// The GM shows a hoard to chosen players (the host keeps it while they pick: treasure_api in
// server.py, treasureApi in PartyServer.java). party.treasure: what this device sees, from the
// snapshot: { id, name, hoard, items, coins, players, picks: { key: { charId: qty } }, ready,
// status: "picking" | "settling" | "done", given }. A pick's key is "e:<entry uid>" or "c:<coin>".
// The hoard is locked meanwhile (hd.showing = id); what's left comes back to it when it's done.

const showings = () => party.active ? party.treasure || [] : [];
const showAvail = (t, key) => key.startsWith("c:") ? t.coins?.[key.slice(2)] || 0 : t.items.find(e => e.uid === key.slice(2))?.qty || 0;
const showPicked = (t, key) => Object.values(t.picks[key] || {}).reduce((a, b) => a + b, 0);
const charName = id => party.chars.find(c => c.id === id)?.name || "someone who left";
const showKeyName = (t, key) => key.startsWith("c:") ? key.slice(2) : entryName(t.items.find(e => e.uid === key.slice(2)) || { item: { name: "?" } });

async function treasureCall(method, path, body) {
  try { return await party.api(method, path, body); }
  catch (e) { toast(e.status === 404 && /Unknown|endpoint/i.test(e.message) ? "The party's host needs the latest version of the app to share treasure" : e.message); return null; }
}

// The GM: choose who sees it, then show it.
function showHoard(hd) {
  const chosen = new Set(party.chars.filter(c => c.online && !c.mine).map(c => c.id));
  let close;
  const go = async () => {
    if (!chosen.size) return toast("Choose who to show it to");
    close();
    // The purse's coins go as coins (each picked by how many); the rest as items.
    const r = await treasureCall("POST", "api/treasure", { name: hd.name, hoard: hd.id, items: hd.items.filter(e => !inPurse(hd, e)), coins: purseTotals(hd), players: [...chosen] });
    if (r?.id) { updateHoard(hd.id, x => { x.showing = r.id; }, `Showing ${hd.name}`); }
  };
  close = openModal(`Show ${hd.name}`, h("div", { class: "form" },
    h("p", { class: "muted small" }, "It pops up for them as an open container. Each picks what they'd like and presses Ready; once everyone is, what only one of them picked is theirs, and you settle the rest. What's left comes back to this hoard."),
    h("div", { class: "group" }, party.chars.map(c => h("label", { class: "row check-row" },
      h("input", { type: "checkbox", checked: chosen.has(c.id), onchange: e => { e.target.checked ? chosen.add(c.id) : chosen.delete(c.id); } }),
      onlineDot(c.online), h("span", { class: "grow" }, c.name), c.mine && h("span", { class: "tag" }, "yours"))))),
  { footer: [h("button", { class: "btn", onclick: () => close() }, "Cancel"), h("button", { class: "btn primary", onclick: go }, icon("users"), "Show it")] });
}

// What's left comes back to its hoard (on the device that has it), then the showing goes.
const reclaiming = new Set();
function reclaimTreasure() {
  if (!party.active || !isGmDevice()) return;
  for (const t of showings().filter(t => t.status === "done" && !reclaiming.has(t.id))) {
    const hd = hoards().find(x => x.showing === t.id);
    if (!hd) continue;
    reclaiming.add(t.id);
    // What's left: its items, and the coins left as coins (into its purse, as items).
    updateHoard(hd.id, x => {
      x.items = clone(t.items);
      x.coinsAt = coinItemTotals(x);
      x.coins = { ...x.coinsAt };
      for (const [k, v] of Object.entries(t.coins || {})) x.coins[k] = (x.coins[k] || 0) + v;
      delete x.showing;
    },
      t.given.length ? `${t.name}: ${t.given.map(g => `${g.name} took ${g.items.join(", ")}`).join("; ")}` : `${t.name} is back`);
    treasureCall("DELETE", `api/treasure/${t.id}`);
  }
}

// Treasure being shown, as a storage (see storageTree in js/app.js): shown like an inventory, each
// item with who wants how many. extras(key): a row's own control (a player's pick, the GM's settling).
// viewer: the character picking (their own wants aren't listed with the others').
const showWants = (t, key, viewer) => Object.entries(t.picks[key] || {}).filter(([id]) => id !== viewer)
  .map(([id, q]) => `${charName(id)} wants ${q}`).join(", ");
const showContested = (t, key) => showPicked(t, key) > showAvail(t, key);
function showStorage(t, viewer, extras) {
  const st = {
    char: t, id: "show:" + t.id, rootLabel: "Loose",
    open: e => openStoredItem(st, e),
    sub: e => showWants(t, "e:" + e.uid, viewer) || null,
    rowClass: e => showContested(t, "e:" + e.uid) ? "contested" : "",
    extras: e => [showContested(t, "e:" + e.uid) && h("span", { class: "tag warn" }, "contested"), extras("e:" + e.uid)],
    empty: () => h("p", { class: "muted pad" }, "No items."),
  };
  return st;
}
// The coins being shown, as rows like the items'.
function showCoinRows(t, viewer, extras) {
  const coins = Object.keys(t.coins || {});
  return coins.length > 0 && h("div", { class: "group" }, h("div", { class: "group-head" }, h("h3", null, "Coins")),
    coins.map(k => {
      const key = "c:" + k, c = currency().coins.find(x => x.key === k);
      return h("div", { class: "row" + (showContested(t, key) ? " contested" : "") },
        icon("coins", "row-icon"),
        h("div", { class: "row-main static" }, h("div", { class: "row-title" }, `${t.coins[k]} ${k}`),
          h("div", { class: "row-sub" }, [c?.name, showWants(t, key, viewer)].filter(Boolean).join(" — "))),
        showContested(t, key) && h("span", { class: "tag warn" }, "contested"),
        extras(key));
    }));
}

// The GM's view of what's being shown: who's ready, the picks, and settling what's contested.
function showingsSection() {
  const list = showings();
  if (!list.length) return null;
  return h("section", { class: "showings" }, h("h2", null, "Showing"), list.map(t => {
    // Settling: each contested pick gets its controls.
    const settle = key => t.status === "settling" && showContested(t, key) && settleRow(t, key, t.picks[key]);
    return h("div", { class: "group showing-card" },
      h("div", { class: "group-head" }, h("h3", null, t.name),
        h("span", { class: "tag" + (t.status === "picking" ? " on" : "") }, { picking: "picking", settling: "for you to settle", done: "done" }[t.status])),
      h("div", { class: "showing-body" },
        h("div", { class: "inline wrap" }, t.players.map(id => h("span", { class: "chip" }, t.ready.includes(id) ? "✓ " : "… ", charName(id)))),
        t.items.length > 0 && itemManager({ key: "show-gm:" + t.id, prefsKey: "showing", storage: () => showStorage(t, null, settle) }),
        showCoinRows(t, null, settle),
        !t.items.length && !Object.keys(t.coins || {}).length && h("p", { class: "muted small" }, "Nothing left."),
        t.given.length > 0 && h("p", { class: "small" }, "Given: ", t.given.map(g => `${g.name}: ${g.items.join(", ")}`).join(" · ")),
        h("div", { class: "inline wrap" },
          t.status === "picking" && h("button", { class: "btn", onclick: () => treasureCall("POST", `api/treasure/${t.id}/end`, { settle: true }) }, "Settle as it stands"),
          t.status !== "done" && h("button", { class: "btn", onclick: () => confirmDialog(`Close “${t.name}”? Nothing more is given out; what's left goes back to the hoard.`, "Close",
            () => treasureCall("POST", `api/treasure/${t.id}/end`, { settle: false })) }, "Close"),
          t.status === "done" && !hoards().some(x => x.showing === t.id) && h("button", { class: "btn", onclick: () => treasureCall("DELETE", `api/treasure/${t.id}`) }, "Dismiss"))));
  }));
}

// Settle one contested pick: how many each of them gets (their picks to start with, as far as
// they go), or roll for who gets it all.
function settleRow(t, key, p) {
  const avail = showAvail(t, key), give = {};
  let left = avail;
  for (const [id, q] of Object.entries(p)) { give[id] = Math.min(q, left); left -= give[id]; }
  return h("div", { class: "settle-row" },
    Object.keys(p).map(id => h("label", { class: "inline" }, charName(id),
      h("input", { type: "number", min: 0, max: avail, value: give[id], class: "settle-n", onchange: e => { give[id] = Math.max(0, Math.floor(+e.target.value || 0)); } }))),
    h("button", { class: "btn primary", onclick: () => {
      const total = Object.values(give).reduce((a, b) => a + b, 0);
      if (total > avail) return toast(`There are only ${avail}`);
      treasureCall("POST", `api/treasure/${t.id}/settle`, { key, give });
    } }, "Give"),
    h("button", { class: "btn", title: "One of them, at random, gets it all", onclick: () => {
      const ids = Object.keys(p), winner = ids[Math.floor(Math.random() * ids.length)];
      toast(`${charName(winner)} wins the roll for ${showKeyName(t, key)}`);
      treasureCall("POST", `api/treasure/${t.id}/settle`, { key, give: { [winner]: avail } });
    } }, icon("dice"), "Roll"));
}

// ------------------------------------------------------------------ the players' side

// The showings one of this device's characters is in.
const myShowings = () => showings().filter(t => t.players.some(id => party.isLinked(id)));
let treasurePopup = null; // { id, close, body, char }
const treasureSeen = new Set(); // showings this device has popped up (or been told the outcome of)

// Called on every render: pops up new treasure, redraws the open one, and tells what was received.
function syncTreasure() {
  reclaimTreasure();
  if (!party.active) return;
  for (const t of myShowings()) {
    // (opens by itself only where it won't replace what's open or docked: else it waits in the Shared tray)
    if (t.status === "picking" && !treasureSeen.has(t.id) && sharedMayOpen()) { treasureSeen.add(t.id); openTreasurePopup(t.id); }
    if (t.status === "done" && !treasureSeen.has("done:" + t.id)) {
      treasureSeen.add("done:" + t.id);
      const mine = t.given.filter(g => party.isLinked(g.character));
      if (mine.length) toast(mine.map(g => `${g.name} received ${g.items.join(", ")}`).join(" · "));
    }
  }
  const pop = treasurePopup;
  if (!pop) return;
  if (!document.contains(pop.panel)) { treasurePopup = null; return; }
  // Not while typing a number in it (that would lose the cursor).
  if (pop.panel.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
  drawTreasurePopup();
}

function openTreasurePopup(id) {
  treasureSeen.add(id); // (opened, by itself or from the tray: it won't open again by itself)
  if (treasurePopup?.id === id && document.contains(treasurePopup.panel)) return;
  const t = showings().find(x => x.id === id);
  if (!t) return;
  const body = h("div", { class: "treasure-pop" });
  // A shared screen (js/shared.js): minimised, it waits in the Shared tray.
  const close = sharedScreen("treasure:" + id, t.name, body);
  treasurePopup = { id, close, body, panel: close.panel,
    char: t.players.find(cid => party.isLinked(cid) && cid === store.state.activeId) || t.players.find(cid => party.isLinked(cid)) };
  drawTreasurePopup();
}

function drawTreasurePopup() {
  const pop = treasurePopup, t = showings().find(x => x.id === pop.id);
  if (!t) {
    // Gone (the GM's device took back what was left): say what arrived, if that wasn't said yet.
    pop.close();
    treasurePopup = null;
    const mine = (pop.last?.given || []).filter(g => party.isLinked(g.character));
    if (pop.last && !treasureSeen.has("done:" + pop.id)) {
      treasureSeen.add("done:" + pop.id);
      toast(mine.length ? mine.map(g => `${g.name} received ${g.items.join(", ")}`).join(" · ") : `${pop.last.name} is over`);
    }
    return;
  }
  pop.last = t;
  const cid = pop.char, picking = t.status === "picking", ready = t.ready.includes(cid);
  const mineHere = t.players.filter(id => party.isLinked(id));
  const pick = (key, qty) => treasureCall("POST", `api/treasure/${t.id}/pick`, { character: cid, key, qty });
  const control = (key, avail) => {
    const mine = t.picks[key]?.[cid] || 0;
    if (!picking) return mine ? h("span", { class: "tag on" }, `picked ${mine}`) : null;
    return avail === 1
      ? h("label", { class: "check" }, h("input", { type: "checkbox", checked: !!mine, onchange: e => pick(key, e.target.checked ? 1 : 0) }), " Take it")
      : h("label", { class: "inline" }, "Take",
        h("input", { type: "number", min: 0, max: avail, value: mine, class: "settle-n", "aria-label": `How many of ${showKeyName(t, key)}`,
          onchange: e => pick(key, Math.max(0, Math.min(avail, Math.floor(+e.target.value || 0)))) }), `of ${avail}`);
  };
  const pickControl = key => control(key, showAvail(t, key));
  setChildren(pop.body,
    mineHere.length > 1 && h("label", { class: "field" }, h("span", null, "Picking for"),
      h("select", { onchange: e => { pop.char = e.target.value; drawTreasurePopup(); } }, mineHere.map(id => h("option", { value: id, selected: id === cid }, charName(id))))),
    h("p", { class: "muted small" }, picking
      ? "Pick what you'd like, then press Ready. Everyone sees what everyone picks; anything more than one of you wants, the GM settles. Picks can change until everyone is ready."
      : t.status === "settling" ? "Everyone's ready: what only one of you picked is given out. The GM is settling the rest." : "All settled."),
    h("div", { class: "treasure-pick" }, t.items.length > 0 && itemManager({ key: "show:" + t.id, prefsKey: "showing", storage: () => showStorage(t, cid, pickControl) }),
      showCoinRows(t, cid, pickControl)),
    !t.items.length && !Object.keys(t.coins || {}).length && h("p", { class: "muted pad" }, "Nothing left."),
    h("div", { class: "inline wrap" }, t.players.map(id => h("span", { class: "chip" }, t.ready.includes(id) ? "✓ " : "… ", charName(id)))),
    t.given.length > 0 && h("p", { class: "small" }, "Given: ", t.given.map(g => `${g.name}: ${g.items.join(", ")}`).join(" · ")),
    h("div", { class: "inline wrap modal-actions" },
      picking && h("button", { class: "btn" + (ready ? "" : " primary"), onclick: () => treasureCall("POST", `api/treasure/${t.id}/ready`, { character: cid, ready: !ready }) },
        icon(ready ? "undo" : "check"), ready ? "Not ready" : "I'm ready"),
      h("button", { class: "btn", onclick: () => { pop.close(); treasurePopup = null; render(); } }, picking ? "Later (it waits in Shared)" : "Close")));
}
