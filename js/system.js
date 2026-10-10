// System packages: what makes the app a D&D 5e inventory, or any other game's.
//
// Each campaign plays one system (campaign.system), or none. The systems you have are listed in
// store.data.systems: ones imported from files, and ones that come with the app (D&D 5e, in
// js/systems/dnd5e.js), listed as { id, bundled: true } rather than copied. Either kind can be
// removed (and a bundled one added again from Files). The system supplies the item templates,
// the features only it has, fields all its templates share, its catalog and its roll tables. Rule
// packages (custom items and templates) add to it, per campaign.
//
// Templates have one shape, built-in or yours (yours can be changed and deleted; that's all):
//   { id, name, plural?, parent?: templateId, hue?, icon?, abstract?, categories?,
//     categoryLabel?, categorySegmented?, fields?: [field], features?: { key: true | "main" | false },
//     defaults?: {...}, hide?: [fieldKey], from?: templateId (the template it started as a copy of),
//     ghost? (deleted while items still use it) }
// They nest: one under another (parent) is a kind of it. The top ones are what the filters and
// catalog list, each with a colour (hue); the ones under them are sub-filters in shades of it, and
// their categories one level more.
// An item made from one of the system's templates has `type` = its id; one made from a template of
// yours has `template` = yours, and `type` the system's it descends from (see newItemFrom).

// Systems that come with the app. `optional` ones (the Slot Delve example) aren't added unless
// you add them (Files).
const BUNDLED_SYSTEMS = [DND5E_SYSTEM, SLOT_DELVE_SYSTEM];
const DEFAULT_BUNDLED = BUNDLED_SYSTEMS.filter(s => !s.optional);
const bundledSystem = id => BUNDLED_SYSTEMS.find(s => s.id === id);
const isBundled = sys => BUNDLED_SYSTEMS.includes(sys);

// Playing without a game system: one plain template, no catalog, no panels.
const NO_SYSTEM = {
  mimic: "system", id: "", name: "No game system", none: true,
  templates: [{ id: "item", name: "Item", plural: "Items", hue: 30, icon: "sack" }],
  features: [], commonFields: [], starterTemplates: [], catalog: [], tables: [], glossary: {}, panels: [], stats: {}, states: [],
  currency: null, weight: null, // the basic ones (see below)
};

// The systems you have (in the order added).
function systems() { return (store.data?.systems || []).map(x => x.bundled ? bundledSystem(x.id) : x).filter(Boolean); }
function systemById(id) { return id ? systems().find(s => s.id === id) : undefined; }
// What a new campaign plays to begin with: the first system you have, else none.
const defaultSystemId = () => systems()[0]?.id || null;
const systemName = id => systemById(id)?.name || (id ? bundledSystem(id)?.name
  || store.data?.campaigns.find(c => c.system === id && c.systemName)?.systemName || id : NO_SYSTEM.name);

// A campaign's system (none if it hasn't one, or you don't have it).
const sysOf = camp => (camp && systemById(camp.system)) || NO_SYSTEM;

// The system of the campaign being played (none if it hasn't one, or you don't have it).
function activeSystem() {
  const camp = store.data ? store.campaign() : null;
  return (camp && systemById(camp.system)) || NO_SYSTEM;
}

// Lookups for a system, worked out once per system.
const systemIndexes = new WeakMap();
function systemIndex(sys = activeSystem()) {
  let ix = systemIndexes.get(sys);
  if (!ix) {
    const templates = sys.templates || [];
    ix = {
      list: templates,
      templates: new Map(templates.map(t => [t.id, t])),
      catalog: new Map((sys.catalog || []).map(i => [i.id, i])),
      byName: new Map((sys.catalog || []).map(i => [i.name, i])),
      features: new Map((sys.features || []).map(f => [f.key, f])),
    };
    systemIndexes.set(sys, ix);
  }
  return ix;
}

// ------------------------------------------------------------------ templates

const systemTemplates = () => systemIndex().list;

// A template by id: one of the rule packages' (any package, so an item keeps its fields if the
// package is switched off), else the system's.
function templateById(id) {
  if (!id) return null;
  return (store.data && store.allTemplates().find(t => t.id === id)) || systemIndex().templates.get(id) || null;
}

const isSystemTemplate = tpl => !!tpl && systemIndex().templates.get(tpl.id) === tpl;

// The template an item was made from: yours (`template`), else the system's (`type`).
function itemTemplate(item) {
  return templateById(item?.template) || templateById(item?.type)
    || systemIndex().templates.get("gear") || systemTemplates().find(t => !t.abstract) || { id: "item", name: "Item", features: {} };
}

// The built-in template a template descends from (copies remember theirs in `from`).
function rootTemplate(tpl) {
  for (let t = tpl, n = 0; t && n < 10; n++) {
    if (isSystemTemplate(t)) return t;
    t = templateById(t.from);
  }
  return tpl;
}

const templatePlural = tpl => tpl.plural || tpl.name;

// ------------------------------------------------------------------ the template tree

// The template a template is under.
function templateParent(tpl) {
  const id = tpl?.parent;
  return id && id !== tpl.id ? templateById(id) : null;
}
// A template and those it's under, up to the top one.
function templateLineage(tpl) {
  const out = [];
  for (let t = tpl; t && out.length < 12 && !out.includes(t); t = templateParent(t)) out.push(t);
  return out;
}
const topTemplate = tpl => templateLineage(tpl).at(-1) || tpl;
const topTemplateOf = item => topTemplate(itemTemplate(item));
// Every template there is to show: the system's, then the packages' in use (and deleted ones
// still used: ghosts), in the tree's order.
let treeCache = null;
function treeTemplates({ ghosts = true } = {}) {
  // (worked out once per change: sorting asks for it often)
  const key = `${store.rev || 0}|${store.data ? store.campaign()?.id : ""}|${activeSystem().id}|${ghosts}`;
  if (treeCache?.key === key && treeCache.data === store.data) return treeCache.list;
  const all = [...systemTemplates().filter(t => !t.hidden), ...store.templates(), ...(ghosts ? store.ghostTemplates() : [])];
  const seen = new Set(), out = [];
  const visit = (t, depth) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    out.push(t);
    for (const k of all) if (templateParent(k) === t) visit(k, depth + 1);
  };
  for (const t of all) if (!templateParent(t) || !all.includes(templateParent(t))) visit(t, 0);
  treeCache = { key, data: store.data, list: out };
  return out;
}
// The top ones (the filters and the catalog's list), and the ones directly under a template.
const topTemplates = (o) => treeTemplates(o).filter(t => !templateParent(t));
const childTemplates = (tpl, o) => treeTemplates(o).filter(t => templateParent(t) === tpl);
// Is an item made with this template, or one under it?
const inTemplate = (item, id) => templateLineage(itemTemplate(item)).some(t => t.id === id);
// How deep a template sits (0: a top one).
const templateDepth = tpl => templateLineage(tpl).length - 1;

// ------------------------------------------------------------------ features and catalog

// Every feature an item can have: the core ones and the system's own.
const allFeatures = () => [...CORE_FEATURES, ...(activeSystem().features || [])];
const featureByKey = key => CORE_FEATURES.find(f => f.key === key) || systemIndex().features.get(key);

// A catalog item by id.
const catalogItem = id => id ? systemIndex().catalog.get(id) : undefined;

// ------------------------------------------------------------------ states
// What an inventory item can be (D&D 5e: Attuned, Identified, Cursed). A system lists them:
//   { key, label, who: "player" | "gm", requires?: feature, limit?: { value?, default, mode: "warn" | "block", text?, label? } }
// - who: the player switches "player" states (a checkbox on the item); "gm" ones only the GM.
// - requires: only items with that feature can have it (5e: Attuned needs Attunement).
// - limit: how many of a character's items can have it on: the character's Local value `value`
//   (see js/clockwork.js), else `default`. Over it, "warn" allows it with a warning, "block" doesn't.
// An entry keeps its own in `states` ({ attuned: true }). The GM can set any state of any item,
// overriding it: the item's internal value gm_state_<key> (1 on, 0 off).
// A state can be locked: then only the GM can change it (Release 3 step 2: layers lock states).

// The system's states, and the campaign's own.
function systemStates(sys = activeSystem()) {
  const base = sys.states || [];
  // The campaign's own states come after its system's (which they can't replace).
  const own = sys === activeSystem() ? campaignStates() : [];
  return own.length ? [...base, ...own.filter(st => !base.some(b => b.key === st.key))] : base;
}
// A campaign's own states (Settings → Campaigns → Item states), the same shape as a system's:
// Broken, Lit, Wet… In a party, the GM's campaign's (the host passes them on).
const campaignStates = (camp = store.data ? store.campaign() : null) => Array.isArray(camp?.states) ? camp.states : [];
const stateByKey = key => systemStates().find(st => st.key === key);

// The states an entry has set itself.
const ownStates = e => ({ ...(e.states || {}) });

// The GM's overrides for an entry: { key: true | false } (in a party the host's values, else
// this campaign's). Without its character, found by the entry's uid alone.
function stateOverrides(char, e) {
  const items = valueSet().items || {};
  const bucket = (char ? items[`${char.id}/${e.uid}`]
    : Object.entries(items).find(([k]) => k.endsWith("/" + e.uid))?.[1]) || {};
  const out = {};
  for (const st of systemStates()) {
    const v = bucket["gm_state_" + st.key];
    if (typeof v === "number") out[st.key] = !!v;
  }
  return out;
}

// The states an entry is in: its own, with the GM's overrides.
function entryStates(char, e) {
  const all = { ...ownStates(e), ...stateOverrides(char, e) };
  return Object.fromEntries(Object.entries(all).filter(([, v]) => v));
}
const stateOn = (char, e, key) => !!entryStates(char, e)[key];
// The states an entry can have: those requiring a feature only if it has it (or a layer for the state).
const statesFor = e => systemStates().filter(st => (!st.requires || e.item.layers?.[st.key] || hasFeature(e.item, st.requires, e.srcId))
  && (!st.requiresProperty || itemHasProperty(currentItem(e), st.requiresProperty)));
// One of an item's properties starts with it ("Versatile" for "Versatile (1d10)").
const itemHasProperty = (it, p) => (it?.properties || []).some(x => String(x).toLowerCase().startsWith(String(p).toLowerCase()));

// ------------------------------------------------------------------ equipment slots
// Where equipped things go, as the game system has it (D&D 5e: Hands ×2, Armor ×1):
//   slots: [{ key, label, count, rules: [rule] }]
// An item goes in the first slot with a rule it matches (the same rules as containers' allowed
// contents, see ruleMatches; a rule's `state` must be on too), taking `size` of it (a greatsword
// both hands; a versatile one both while it's Two-handed). An item can say its own: slot (a key,
// or "none") and slotSize. A system without slots: anything can be equipped, as before.
const systemSlots = () => Array.isArray(activeSystem().slots) ? activeSystem().slots : [];
function slotFor(char, e, states = null) {
  const it = currentItem(e, char);
  if (it.slot === "none") return null;
  const on = states || entryStates(char, e);
  for (const s of systemSlots()) {
    if (it.slot && it.slot !== s.key) continue;
    const r = it.slot ? { size: it.slotSize } : (s.rules || []).find(x => (!x.state || on[x.state]) && ruleMatches(x, it, e.srcId));
    if (r) return { ...s, size: Math.max(1, Math.floor(r.size || 1)) };
  }
  return null;
}
// What's equipped in a slot (but `except`), and how much of it they take.
function slotHolders(char, key, except = null) {
  return char.items.filter(x => x.equipped && x.uid !== except).map(x => ({ e: x, slot: slotFor(char, x) })).filter(x => x.slot?.key === key);
}
const slotUsed = (char, key, except = null) => slotHolders(char, key, except).reduce((n, x) => n + x.slot.size, 0);
// "Hands (1, or 2 while Two-handed)": where an item goes, in words (for its details).
function slotWords(it, srcId) {
  if (it.slot === "none") return null;
  for (const s of systemSlots()) {
    if (it.slot) { if (it.slot === s.key) return `${s.label} (${Math.max(1, it.slotSize || 1)})`; continue; }
    const base = (s.rules || []).find(x => !x.state && ruleMatches(x, it, srcId));
    if (!base) continue;
    const alt = (s.rules || []).find(x => x.state && (x.size || 1) !== (base.size || 1) && ruleMatches(x, it, srcId));
    const st = alt && stateByKey(alt.state);
    return `${s.label} (${base.size || 1}${alt ? `, or ${alt.size || 1} while ${st?.label || alt.state}` : ""})`;
  }
  return null;
}
// The states that are on, for its tags.
const statesOnFor = (char, e) => systemStates().filter(st => stateOn(char, e, st.key));

// States locked by others that are on (an item's layers can lock states: step 2).
function lockedStates(char, e) {
  const on = entryStates(char, e), layers = e.item.layers || {};
  return new Set(Object.keys(on).flatMap(k => Array.isArray(layers[k]?.locks) ? layers[k].locks : []));
}
// Whether the player may switch a state of this entry (the GM always may).
const canPlayerSet = (char, e, key) => stateByKey(key)?.who === "player" && !lockedStates(char, e).has(key);

// How many of a character's items may have a state on (null: no limit).
function stateLimit(char, st) {
  if (!st?.limit) return null;
  const name = limitValueName(st), v = name ? charLocal(char.id, name) : undefined;
  return typeof v === "number" ? v : st.limit.default ?? null;
}
const stateCount = (char, key) => char.items.filter(x => stateOn(char, x, key)).length;
const limitText = (st, limit) => (st.limit.text || `At most ${limit} can be ${st.label.toLowerCase()}`).replace("{limit}", limit);

// ------------------------------------------------------------------ layers
// What an item becomes in each state: item.layers = { identified: { name, description, acBonus… },
// cursed: { weight, locks: ["attuned"] }, … }. A layer holds only what changes: fields, features it
// turns on ({ features: { charges: true } }), and the states it locks for the player while it's on.
// The item as it is now is the item with the layers of the states that are on, in the system's
// order of states. Inventory entries are shown and used as they are now; editing changes the item
// or one of its layers.

const LAYER_META = new Set(["locks", "features"]);
const currentCache = new WeakMap(); // item -> { key, item }

function currentItem(e, char = null) {
  const base = e.item, layers = base?.layers;
  if (!layers || !Object.keys(layers).length) return base;
  const on = entryStates(char, e);
  const active = systemStates().filter(st => on[st.key] && layers[st.key]);
  const key = active.map(st => st.key).join(",");
  const cached = currentCache.get(base);
  if (cached && cached.key === key) return cached.item;
  let it = base;
  for (const st of active) {
    const layer = layers[st.key];
    it = { ...it, ...Object.fromEntries(Object.entries(layer).filter(([k, v]) => !LAYER_META.has(k) && v !== "" && v != null)) };
    if (layer.features) it.features = { ...(it.features || {}), ...layer.features };
  }
  currentCache.set(base, { key, item: it });
  return it;
}

// Set an entry's own state (an override of the GM's still wins).
function setState(e, key, on) {
  const st = ownStates(e);
  if (on) st[key] = true; else delete st[key];
  e.states = st;
}

// ------------------------------------------------------------------ money and weight
// A system's money: { coins: [{ key, name, value, color? }] largest first, each worth `value` of the
// smallest (prices are in it, so one coin is worth 1); change: the coins shops pay out and give
// change in, largest first; show: the coin prices are shown in; perWeight: how many coins weigh one
// unit (0: none) }. Its weight: { unit }. The party servers are sent the coins and change when the
// GM loads a campaign (currencyRules), and work out payments the same way.

const BASIC_CURRENCY = {
  coins: [{ key: "gp", name: "gold", value: 100 }, { key: "sp", name: "silver", value: 10 }, { key: "cp", name: "copper", value: 1 }],
  change: ["gp", "sp", "cp"], show: "gp", perWeight: 0,
};
const currency = (sys = activeSystem()) => sys.currency || BASIC_CURRENCY;
const coinOrder = (cur = currency()) => cur.coins.map(c => c.key);
const coinValue = (key, cur = currency()) => cur.coins.find(c => c.key === key)?.value || 0;
const changeCoins = (cur = currency()) => (cur.change?.length ? cur.change : coinOrder(cur));
// The coin prices are shown in: { key, value }.
const showCoin = (cur = currency()) => cur.coins.find(c => c.key === cur.show) || cur.coins[0];
const weightUnit = (sys = activeSystem()) => sys.weight?.unit || "lb";
// The unit for an amount: "1 slot", "2 slots" (a system can name one: weight.one).
const weightUnitFor = (n, sys = activeSystem()) => n === 1 && sys.weight?.one ? sys.weight.one : weightUnit(sys);
// What the party servers need: [[key, value]…] and the change coins.
const currencyRules = sys => { const cur = currency(sys); return { coins: cur.coins.map(c => [c.key, c.value]), change: changeCoins(cur) }; };

// A currency, checked: coins with keys and whole values, largest first, one worth 1.
function cleanCurrency(raw) {
  if (!raw || !Array.isArray(raw.coins)) return null;
  const coins = raw.coins.filter(c => c && /^[a-z][a-z0-9]{0,7}$/.test(c.key) && Number.isInteger(c.value) && c.value >= 1)
    .filter((c, i, all) => all.findIndex(d => d.key === c.key) === i).slice(0, 12)
    .map(c => ({ key: c.key, name: String(c.name || c.key).slice(0, 30), value: c.value, ...(typeof c.color === "string" ? { color: c.color.slice(0, 30) } : {}) }))
    .sort((a, b) => b.value - a.value);
  if (!coins.some(c => c.value === 1)) return null;
  const keys = coins.map(c => c.key);
  let change = (Array.isArray(raw.change) ? raw.change : keys).filter(k => keys.includes(k));
  change = keys.filter(k => change.includes(k));
  if (!change.includes(coins[coins.length - 1].key)) change.push(coins[coins.length - 1].key);
  return { coins, change, show: keys.includes(raw.show) ? raw.show : change[0], perWeight: Math.max(0, +raw.perWeight || 0) };
}

// ------------------------------------------------------------------ words
// The words a system can change on the app's own screens (a system's `terminology`), e.g. a game
// whose players are "investigators". term("character") -> "character"; termCap("character") -> "Character".

const TERMS = {
  character: "character", characters: "characters",
  gm: "GM", gameMaster: "Game master",
  rollTable: "Roll on a table", rollTitle: "Roll on a table",
};
const term = key => (activeSystem().terminology || {})[key] || TERMS[key] || key;
const termCap = key => { const w = term(key); return w[0].toUpperCase() + w.slice(1); };

// ------------------------------------------------------------------ system files

// A system as a file: everything, its catalog included (D&D 5e's comes from srd-data.js).
function systemFile(sys) {
  const { builtin, none, optional, ...rest } = sys;
  return { ...rest, mimic: "system", format: FILE_FORMAT, catalog: sys.catalog || [], tables: sys.tables || [], glossary: sys.glossary || {},
    panels: sys.panels || [], panelLib: sys.panelLib || "", stats: sys.stats || {}, states: systemStates(sys), values: sys.values || [], terminology: sys.terminology || {},
    currency: currency(sys), weight: sys.weight || { unit: weightUnit(sys) } };
}

// A system's states, checked.
function cleanStates(list) {
  return (Array.isArray(list) ? list : []).filter(st => st && /^[a-z]\w{0,30}$/.test(st.key) && st.label).slice(0, 30).map(st => {
    const lim = st.limit && typeof st.limit === "object" ? st.limit : null;
    return {
      key: st.key, label: String(st.label).slice(0, 40), who: st.who === "gm" ? "gm" : "player",
      requires: typeof st.requires === "string" ? st.requires : undefined,
      limit: lim && (lim.default > 0 || typeof lim.value === "string") ? {
        value: isValueName(lim.value) ? lim.value : undefined,
        default: lim.default > 0 ? Math.floor(lim.default) : null, mode: lim.mode === "block" ? "block" : "warn",
        text: lim.text ? String(lim.text).slice(0, 120) : undefined, label: lim.label ? String(lim.label).slice(0, 40) : undefined,
      } : undefined,
    };
  });
}

// Check an imported system has what the app needs, and fill in the rest.
function cleanSystem(raw) {
  if (!raw || raw.mimic !== "system" || typeof raw.id !== "string" || !raw.id) throw new Error("Not a game system file");
  const templates = (Array.isArray(raw.templates) ? raw.templates : []).filter(t => t && typeof t.id === "string" && t.name);
  if (!templates.length) throw new Error("A system needs at least one template");
  const ids = new Set(templates.map(t => t.id));
  for (const t of templates) if (t.parent && (!ids.has(t.parent) || t.parent === t.id)) delete t.parent;
  if (!templates.some(t => t.hue != null)) templates.forEach((t, i) => { if (!t.parent) t.hue = (210 + i * 47) % 360; });
  return {
    mimic: "system", id: raw.id, name: String(raw.name || raw.id), version: raw.version || 1, description: raw.description || "",
    templates,
    commonFields: Array.isArray(raw.commonFields) ? raw.commonFields : [],
    features: (Array.isArray(raw.features) ? raw.features : []).filter(f => f && f.key && !CORE_FEATURES.some(c => c.key === f.key))
      .map(f => ({ ...f, fields: Array.isArray(f.fields) ? f.fields : [] })),
    starterTemplates: Array.isArray(raw.starterTemplates) ? raw.starterTemplates : [],
    panels: (Array.isArray(raw.panels) ? raw.panels : []).filter(p => p && typeof p.id === "string" && typeof p.html === "string"
      && ["inventory", "gm-player"].includes(p.slot)).map(p => ({ id: p.id, slot: p.slot, title: String(p.title || p.id), html: p.html })),
    panelLib: typeof raw.panelLib === "string" ? raw.panelLib : "",
    stats: raw.stats && typeof raw.stats === "object" && !Array.isArray(raw.stats) ? raw.stats : {},
    campaignSettings: Array.isArray(raw.campaignSettings) ? raw.campaignSettings.filter(k => typeof k === "string") : [],
    currency: cleanCurrency(raw.currency),
    weight: raw.weight && typeof raw.weight.unit === "string" && raw.weight.unit.trim()
      ? { unit: raw.weight.unit.trim().slice(0, 12), ...(typeof raw.weight.one === "string" && raw.weight.one.trim() ? { one: raw.weight.one.trim().slice(0, 12) } : {}) } : null,
    states: cleanStates(raw.states),
    values: cleanValueDecls(raw.values),
    terminology: raw.terminology && typeof raw.terminology === "object"
      ? Object.fromEntries(Object.entries(raw.terminology).filter(([k, v]) => k in TERMS && typeof v === "string" && v.trim()).map(([k, v]) => [k, v.trim().slice(0, 40)])) : {},
    catalog: (Array.isArray(raw.catalog) ? raw.catalog : []).filter(i => i && i.id && i.name),
    tables: Array.isArray(raw.tables) ? raw.tables : [],
    glossary: raw.glossary && typeof raw.glossary === "object" ? raw.glossary : {},
  };
}

// Add a system: one that comes with the app is listed rather than copied. Returns its name.
function installSystem(data) {
  if (bundledSystem(data.id)) {
    if (!store.data.systems.some(x => x.id === data.id)) store.data.systems.push({ id: data.id, bundled: true });
    return bundledSystem(data.id).name;
  }
  const sys = cleanSystem(data);
  store.data.systems = [...store.data.systems.filter(x => x.id !== sys.id), sys];
  return sys.name;
}
