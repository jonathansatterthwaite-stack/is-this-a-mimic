// Clockwork: the app's interactive layer. Values, what changes them (rules, controls) and what they
// drive (layers, live icons, panels). See docs/clockwork-plan.md.
//
// Every value has an address, read with clockwork.get(ctx, address), ctx being { char, entry }:
//   item.state.<key>   1 when the item's state is on (the GM's override applied), else 0
//   item.qty  item.equipped  item.charges  item.fill  item.worth  item.weight
//   char.stat.<key>    a system stat          char.carried
//   char.count.<state> items with it on       char.limit.<state>  how many may have it on
//   global.<name>      a Global value: one for the campaign, the same for everyone
//   local.<name>       an item's Local value, else its character's
//   char.local.<name>  a character's Local value
// Built-ins are registered (clockwork.value); a later piece adds a line and everything can read it.
//
// Global and Local values are kept as GM values were, which the party servers check:
//   { party: { gm_<name>: n }, characters: { charId: { … } }, items: { "charId/uid": { … } } }
// so a value's key is "gm_" + its name, and the "party" set holds the Globals. In a party the host
// keeps them (party.gm); outside one, the campaign (its starting values, sent when it's loaded).
// The GM's state overrides are item values named state_<key>: internal, not a name anyone uses.
// Drawn icons read them as global_<name> and local_<name>.

const VALUE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const RESERVED_VALUE = /^(state_|gm_|global_|local_)/;
const isValueName = n => typeof n === "string" && VALUE_NAME.test(n) && !RESERVED_VALUE.test(n);
const valueKey = name => "gm_" + name;
const keyName = key => key.replace(/^gm_/, "");

// ------------------------------------------------------------------ on or off
// Clockwork can be switched off for a campaign (on its card in Settings → Campaigns, by the GM; users see it as
// "Rules, values and controls"): the GM's Controls tab, the cogs, items' Rules, Global and Local
// values in drawings and shops following values are put away, and items' rules don't run (they
// keep up with what happens, so switching it back on fires nothing from meanwhile). Item states,
// layers and limits are the game's own, and stay. In a party the host keeps the GM's choice.
const clockworkOn = () => (party.active ? party.campaign?.clockwork : store.campaign()?.clockwork) !== false;

// ------------------------------------------------------------------ where values are kept

// With what a control being dragged shows meanwhile (clockwork.preview) on top.
let previewing = null, previewMerged = null;
function valueSet() {
  const g = party.active ? party.gm || {} : store.state.gmValues || {};
  if (!previewing) return g;
  if (previewMerged?.from !== g) {
    const merged = { party: { ...g.party, ...previewing.party }, characters: { ...g.characters }, items: { ...g.items } };
    for (const group of ["characters", "items"]) for (const [t, b] of Object.entries(previewing[group] || {})) merged[group][t] = { ...merged[group][t], ...b };
    previewMerged = { from: g, merged };
  }
  return previewMerged.merged;
}

// A value is kept as a number, or as a moving one: { value, rate, since, until? }, rising (or, with a
// negative rate, falling) rate a second from value at the time since (ms, the host's clock), and
// stopping at until. Every device works it out from the time, so only starting and stopping one is
// sent; the readers below give it as it is now.
const clockNow = () => Date.now() + (party.active ? party.clockOffset || 0 : 0);
const isMoving = v => !!v && typeof v === "object";
function valueNow(v, now = clockNow()) {
  if (!isMoving(v)) return v;
  const x = v.value + v.rate * Math.max(0, (now - v.since) / 1000);
  return v.until == null ? x : v.rate > 0 ? Math.min(x, v.until) : Math.max(x, v.until);
}
// Values to send to a host (loading a campaign): moving ones from where they are now (the host
// stamps its own time).
const valuesFromNow = g => g && JSON.parse(JSON.stringify(g, (k, v) => isMoving(v) && "rate" in v ? { ...v, value: valueNow(v, Date.now()), since: undefined } : v)); // (kept by this device: its own clock)
// When a moving value reaches its end (ms), or null if it never does.
const movingEnd = v => isMoving(v) && v.until != null && v.rate ? v.since + Math.max(0, (v.until - v.value) / v.rate) * 1000 : null;
// Still moving: it hasn't reached its end yet.
const stillMoving = (v, now = clockNow()) => isMoving(v) && v.rate !== 0 && (movingEnd(v) ?? Infinity) > now;

// Keep (or, with value null, clear) one value by its stored key, unchecked: changes go through
// clockwork.set (below). scope: "party" (a Global), "character" or "item" (Locals); target: "" |
// charId | "charId/uid".
async function putValue(scope, target, key, value) {
  if (party.active) return party.setGm(scope, target, key, value);
  store.update(s => { s.gmValues = putGmValue(s.gmValues || {}, scope, target, key, value); });
}

const globalValue = name => valueNow(valueSet().party?.[valueKey(name)]);
const charLocal = (charId, name) => valueNow(valueSet().characters?.[charId]?.[valueKey(name)]);
const itemLocal = (charId, entryUid, name) => valueNow(valueSet().items?.[`${charId}/${entryUid}`]?.[valueKey(name)]);
const localValue = (charId, entryUid, name) => itemLocal(charId, entryUid, name) ?? charLocal(charId, name);

// A stored value where a control (a board's pin) sets it: that level's own, else the levels above
// (an item's, else its character's; a Local never falls back to a Global).
function valueAt(scope, target, key) {
  const g = valueSet();
  const charId = scope === "item" ? target.split("/")[0] : target;
  for (const level of [scope === "item" && g.items?.[target], scope !== "party" && g.characters?.[charId], scope === "party" && g.party]) {
    if (level && key in level) return valueNow(level[key]);
  }
  return undefined;
}

// The values a drawn icon on an item gets: global_<name>, and local_<name> (its own, else its character's).
function iconValueVars(charId, entryUid) {
  if (!clockworkOn()) return {}; // (off: drawings show their own defaults)
  const g = valueSet(), out = {}, now = clockNow();
  const put = (bucket, prefix) => { for (const [k, v] of Object.entries(bucket || {})) if (!k.startsWith("gm_state_")) out[prefix + keyName(k)] = valueNow(v, now); };
  put(g.party, "global_");
  put(g.characters?.[charId], "local_");
  put(g.items?.[`${charId}/${entryUid}`], "local_");
  return out;
}

// ------------------------------------------------------------------ addresses

const clockwork = {
  addresses: [], // { pattern: "item.qty" | "item.state.*", label, get(ctx, rest) }
  value(pattern, def) { this.addresses.push({ pattern, ...def }); },
  find(address) {
    for (const a of this.addresses) {
      if (a.pattern === address) return { def: a, rest: "" };
      if (a.pattern.endsWith(".*") && address.startsWith(a.pattern.slice(0, -1))) return { def: a, rest: address.slice(a.pattern.length - 1) };
    }
    return null;
  },
  // A value as a number (yes/no as 1/0); undefined when it doesn't apply or isn't set.
  get(ctx, address) {
    const f = this.find(address);
    if (!f) return undefined;
    let v;
    try { v = f.def.get(ctx || {}, f.rest); } catch { return undefined; }
    return typeof v === "boolean" ? +v : v;
  },
};

const ctxHas = (ctx, ...keys) => keys.every(k => ctx[k]);
clockwork.value("item.state.*", { label: "On when the item is in this state", get: (c, key) => ctxHas(c, "char", "entry") ? stateOn(c.char, c.entry, key) : undefined });
clockwork.value("item.qty", { label: "How many in the stack", get: c => c.entry?.qty });
clockwork.value("item.equipped", { label: "1 when equipped or worn", get: c => c.entry && !!c.entry.equipped });
clockwork.value("item.charges", { label: "Charges left", get: c => {
  if (!c.entry) return undefined;
  const it = currentItem(c.entry, c.char);
  return hasFeature(it, "charges", c.entry.srcId) && it.maxCharges ? c.entry.charges ?? it.maxCharges : undefined;
} });
clockwork.value("item.fill", { label: "How full it is, 0 to 1", get: c => ctxHas(c, "char", "entry") ? fillLevel(c.char, c.entry)?.ratio : undefined });
clockwork.value("item.worth", { label: "Worth, with anything inside", get: c => ctxHas(c, "char", "entry") ? entryTotalValue(c.char, c.entry) : undefined });
clockwork.value("item.weight", { label: "Weight, with anything inside", get: c => ctxHas(c, "char", "entry") ? entryTotalWeight(c.char, c.entry) : undefined });
clockwork.value("char.stat.*", { label: "A character stat", get: (c, key) => c.char ? statsOf(c.char)[key] : undefined });
clockwork.value("char.carried", { label: "Weight carried", get: c => c.char ? carriedWeight(c.char, store.state.settings) : undefined });
clockwork.value("char.count.*", { label: "Items in this state", get: (c, key) => c.char ? stateCount(c.char, key) : undefined });
clockwork.value("char.limit.*", { label: "How many may be in this state", get: (c, key) => c.char ? stateLimit(c.char, stateByKey(key)) ?? undefined : undefined });
clockwork.value("char.local.*", { label: "A character's Local value", get: (c, name) => c.char ? charLocal(c.char.id, name) : undefined });
clockwork.value("local.*", { label: "An item's Local value, else its character's", get: (c, name) => c.char ? localValue(c.char.id, c.entry?.uid, name) : undefined });
clockwork.value("global.*", { label: "A Global value", get: (c, name) => globalValue(name) });
// A panel's control, as it's used (its rules: "A control is used"): its value after the change.
clockwork.value("control.value", { label: "The control's value, as it's used", get: c => c.controlValue });
// A socket, as it's used (an item put in or taken out): whether it holds something now, and that
// item (the one put in, or the one taken out): its weight, worth, how many, and whether it's a
// certain catalog item or one of a template ("control.item.is.<id>" / "….template:<id>": 1 or 0).
clockwork.value("control.has", { label: "1 when the socket holds something", get: c => c.socketHas == null ? undefined : c.socketHas ? 1 : 0 });
clockwork.value("control.item.weight", { label: "The socket's item: its weight", get: c => c.controlItem?.weight });
clockwork.value("control.item.worth", { label: "The socket's item: its worth", get: c => c.controlItem?.worth });
clockwork.value("control.item.qty", { label: "The socket's item: how many", get: c => c.controlItem?.qty });
clockwork.value("control.item.is.*", { label: "1 when the socket's item is that item (or one of that template)", get: (c, key) => {
  const it = c.controlItem;
  if (!it) return undefined;
  const tpl = /^template:(.+)$/.exec(key);
  return (tpl ? it.templates.includes(tpl[1]) : it.ids.includes(key)) ? 1 : 0;
} });

// ------------------------------------------------------------------ objects and scopes
// (docs/clockwork-overhaul-plan.md) Everything interactive is an object of a kind: the world (the
// campaign), a character, an item (a copy in an inventory), a drawing, a panel's control. A kind has
// properties (the addresses above that belong to it), events (clockwork.event, in js/triggers.js) and
// actions (clockwork.action). Drawings and controls get theirs in a later step.
//
// A rule says what it applies to (its scope, `appliesTo`): any mix of
//   character: a character's id          item: a catalog item's id, or "template:<id>" (and those under it)
//   drawing: a library drawing's id       panel: a GM panel's id
// A part left out means any. A rule carried by an item (item.triggers) applies to that item.
// Rules come from sources (clockwork.ruleSource): the item's own today, the campaign's rule book
// later. For the same event on the same object, only the most specific rules run (they override
// the rest); rules for other events all run.

clockwork.kinds = new Map(); // name -> { name, label, addresses: [patterns] }
clockwork.kind = (name, def) => clockwork.kinds.set(name, { name, addresses: [], ...def });
clockwork.kind("world", { label: "The world", addresses: ["global.*"] });
clockwork.kind("character", { label: "A character", addresses: ["char.*"] });
clockwork.kind("item", { label: "An item", addresses: ["item.*", "local.*"] });
clockwork.kind("drawing", { label: "A drawing" });
clockwork.kind("panel", { label: "A panel or control", addresses: ["control.*"] });
// The kind of object an address is a property of.
clockwork.kindOf = address => [...clockwork.kinds.values()].find(k => k.addresses.some(p =>
  p === address || (p.endsWith(".*") && String(address).startsWith(p.slice(0, -1)))))?.name;

const SCOPE_PARTS = ["character", "item", "drawing", "panel", "control"];
// What a context is, for scopes: its character, item (catalog id and template lineage), drawing,
// panel and control (a GM panel's: ids).
function scopeFacts(ctx) {
  const e = ctx.entry, it = e ? currentItem(e, ctx.char) : null;
  return { character: ctx.char?.id, itemIds: it ? [e.srcId, it.id].filter(Boolean) : [],
    templates: it ? templateLineage(itemTemplate(it)).map(t => t.id) : [], drawing: ctx.drawing ?? it?.iconLib, panel: ctx.panel, control: ctx.control };
}
// facts: the context's facts, or a function giving them (worked out only when a scope needs them).
function scopeMatches(scope, ctx, facts) {
  if (!scope) return true;
  const f = () => typeof facts === "function" ? facts() : facts || (facts = scopeFacts(ctx));
  for (const part of SCOPE_PARTS) {
    const want = scope[part];
    if (want == null) continue;
    if (part === "item" && want === "self") { if (!ctx.entry) return false; continue; }
    const is = f();
    if (part === "item") {
      const tpl = /^template:(.+)$/.exec(want);
      if (tpl ? !is.templates.includes(tpl[1]) : !is.itemIds.includes(want)) return false;
    } else if (is[part] !== want) return false;
  }
  return true;
}
// How specific a scope is: each part it names counts 100; for the item part, an exact item counts
// more than a template, and a template further down the tree more than one above it.
function scopeSpecificity(scope) {
  let n = 0;
  for (const part of SCOPE_PARTS) if (scope?.[part] != null) n += 100;
  const item = scope?.item;
  if (item != null) {
    const tpl = /^template:(.+)$/.exec(item);
    n += tpl ? Math.min(49, templateLineage(templateById(tpl[1])).length) : 50;
  }
  return n;
}
Object.assign(clockwork, { scopeMatches, scopeSpecificity });

// Where rules come from: name -> (ctx) => [{ rule, scope }].
clockwork.ruleSources = new Map();
clockwork.ruleSource = (name, fn) => clockwork.ruleSources.set(name, fn);
// The rules that apply to an object (ctx: { char, entry?, drawing?, panel? }), the most specific for
// each event: [{ rule, scope, source, specificity }]. key(rule) says which event a rule is for.
clockwork.rulesFor = (ctx, key = r => JSON.stringify([r.when, r.test || [], ...(r.button ? [r.button] : []), ...(r.signal ? [r.signal] : [])])) => {
  let known = null;
  const facts = () => known || (known = scopeFacts(ctx)), found = [];
  for (const [source, fn] of clockwork.ruleSources) {
    let list;
    try { list = fn(ctx) || []; } catch { list = []; }
    for (const x of list) if (x?.rule && scopeMatches(x.scope, ctx, facts)) found.push({ ...x, source, specificity: scopeSpecificity(x.scope) });
  }
  if (found.length < 2) return found;
  const best = new Map();
  for (const x of found) { const k = key(x.rule); best.set(k, Math.max(best.get(k) ?? -1, x.specificity)); }
  return found.filter(x => x.specificity === best.get(key(x.rule)));
};

// ------------------------------------------------------------------ changing values
// One way to change anything (docs/clockwork-plan.md, 2):
//   clockwork.set(ctx, address, value, by)    by: "player", "gm" or "rule" (an item's trigger)
// checks who may (a player: their own characters' states and Locals; a rule: those of the characters
// on this device; a GM: anything), locks, limits and the value's range, then keeps it where it
// belongs. Returns { ok, warning?, error?, done? }; done waits for a value the party keeps.
// clockwork.change does the same and shows the message. A rule's change is made in place, on
// ctx.entry (triggers save when they're done); the others are saved here.
//   clockwork.preview(ctx, address, value)    while a control is dragged: this device's live icons
//   clockwork.endPreview()                    follow at once; its value is set as it goes, and when
//                                             it's let go
// Controls name values as boards' pins do: clockwork.at(scope, target, name) is [ctx, address].

const ownChar = char => !!char && store.state.characters.some(c => c.id === char.id);
const failed = error => ({ ok: false, error });

// A state turning on, past its limit: blocked for a player when the system says so, else a warning.
function limitCheck(char, e, st, on, by) {
  const lim = on && !stateOn(char, e, st.key) ? stateLimit(char, st) : null;
  if (lim == null || stateCount(char, st.key) < lim) return { ok: true };
  if (st.limit.mode === "block" && by === "player") return failed(limitText(st, lim));
  return { ok: true, warning: `${limitText(st, lim)} (keeping it anyway)` };
}

// A value as it may be set: a number (null clears it), within a system's declared range and step.
// { rate, until?, from? } starts it moving from from (else where it is now), rate a second, stopping
// at until (a declared value stops at the end of its range anyway).
const okNum = (v, limit = 1e9) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= limit;
// A value may be as big as a time in ms (a drawing's "mark the time" keeps now); the hosts agree.
const VALUE_LIMIT = 1e13;
function valueCheck(name, value, from = 0) {
  if (value === null) return { value };
  const decl = (activeSystem().values || []).find(v => v.name === name);
  const [lo, hi] = !decl ? [-VALUE_LIMIT, VALUE_LIMIT] : decl.choices?.length ? [0, decl.choices.length - 1] : [decl.min ?? -VALUE_LIMIT, decl.max ?? VALUE_LIMIT];
  const clampTo = x => Math.max(Math.min(lo, hi), Math.min(Math.max(lo, hi), x));
  if (isMoving(value)) {
    if (!okNum(value.rate, 1e6) || (value.until != null && !okNum(value.until))) return { error: "A change over time needs a rate a second, and where it stops" };
    const until = value.until != null ? clampTo(value.until) : !decl ? undefined : value.rate > 0 ? Math.max(lo, hi) : Math.min(lo, hi);
    return { value: { value: okNum(value.from) ? value.from : okNum(from) ? from : 0, rate: value.rate, since: clockNow(), ...(until !== undefined ? { until } : {}) } };
  }
  if (!okNum(value, VALUE_LIMIT)) return { error: "Values are numbers" };
  if (!decl) return { value };
  let v = clampTo(value);
  if (decl.choices?.length) v = Math.round(v);
  else if (typeof decl.step === "number" && decl.step > 0) v = Math.round(Math.round((v - lo) / decl.step) * decl.step * 1e6) / 1e6 + lo;
  return { value: v };
}

// Global and Local values: where each is kept ({ scope, target, name }), and who reaches it.
const valuePlace = {
  "global.*": (c, name) => ({ scope: "party", target: "", name }),
  "char.local.*": (c, name) => c.char && { scope: "character", target: c.char.id, name },
  "local.*": (c, name) => c.char && (c.entry ? { scope: "item", target: `${c.char.id}/${c.entry.uid}`, name } : { scope: "character", target: c.char.id, name }),
};
const ruleWrites = { second: 0, n: 0 };
function ruleWriteAllowed() {
  const s = Math.floor(Date.now() / 1000);
  if (s !== ruleWrites.second) Object.assign(ruleWrites, { second: s, n: 0 });
  return ++ruleWrites.n <= 20;
}
function setValue(c, place, value, by) {
  if (!place || !isValueName(place.name)) return failed("Not a value");
  if (by !== "gm") {
    if (place.scope === "party") return failed(`Only the ${term("gm")} can set Global values`);
    if (!ownChar(c.char)) return failed("Not one of your characters");
    if (systemStates().some(st => limitValueName(st) === place.name)) return failed(`Only the ${term("gm")} can set that`);
    // Rules (from an item anyone could have made) change values at most so often: each change is
    // sent to the party's host.
    if (by === "rule" && !ruleWriteAllowed()) return failed("Rules are changing values too fast");
  }
  const r = valueCheck(place.name, value, valueAt(place.scope, place.target, valueKey(place.name)));
  if (r.error) return failed(r.error);
  // A rule's change waits until the redraw it ran in is over (it redraws again itself).
  // (A refusal is the host's to give: a rule doesn't fail loudly for it.)
  if (by === "rule") return { ok: true, done: new Promise(res => queueMicrotask(() => res(putValue(place.scope, place.target, valueKey(place.name), r.value)))).catch(() => false) };
  return { ok: true, done: putValue(place.scope, place.target, valueKey(place.name), r.value) };
}
for (const [pattern, place] of Object.entries(valuePlace)) clockwork.find(pattern).def.set = (c, rest, value, by) => setValue(c, place(c, rest), value, by);

Object.assign(clockwork.find("item.state.*").def, {
  // The entry's own state (the player's switch). A GM's override still wins (item.override).
  set(c, key, value, by) {
    const { char, entry: e } = c, st = stateByKey(key), on = !!value;
    // (A trigger may give an item a state it has no feature for, as it always could.)
    if (!char || !e || !st || (by !== "rule" && !statesFor(e).includes(st))) return failed("That item doesn't have that state");
    if (by !== "gm" && !ownChar(char)) return failed("Not one of your characters");
    if (by === "player" && !canPlayerSet(char, e, key)) return failed(`Only the ${term("gm")} can change that now`);
    const r = limitCheck(char, e, st, on, by);
    if (!r.ok) return r;
    if (by === "rule") setState(e, key, on);
    else {
      let found = false;
      store.update(s => {
        const x = s.characters.find(x => x.id === char.id)?.items.find(x => x.uid === e.uid);
        if (x) { setState(x, key, on); found = true; }
      });
      if (!found) return failed("That item isn't on this device");
    }
    return r;
  },
});

// Charges left, from 0 to the item's most.
Object.assign(clockwork.find("item.charges").def, {
  set(c, rest, value, by) {
    const { char, entry: e } = c, it = e && currentItem(e, char);
    if (!char || !e || !hasFeature(it, "charges", e.srcId) || !it.maxCharges) return failed("That item has no charges");
    if (by !== "gm" && !ownChar(char)) return failed("Not one of your characters");
    if (!okNum(value)) return failed("Charges are a number");
    const n = Math.max(0, Math.min(it.maxCharges, Math.round(value)));
    if (by === "rule") e.charges = n;
    else store.update(s => { const x = s.characters.find(x => x.id === char.id)?.items.find(x => x.uid === e.uid); if (x) x.charges = n; });
    return { ok: true };
  } });

// The GM's override of an item's state: 1 (always on), 0 (always off) or null (as the item has it).
clockwork.value("item.override.*", { label: "The GM's override of a state", gmOnly: true,
  get: (c, key) => c.char && c.entry ? valueSet().items?.[`${c.char.id}/${c.entry.uid}`]?.["gm_state_" + key] : undefined,
  set(c, key, value) {
    const st = stateByKey(key);
    if (!c.char || !c.entry || !st) return failed("That item doesn't have that state");
    if (value !== null && value !== 0 && value !== 1) return failed("On, off, or not set");
    const r = value === 1 && c.char.items ? limitCheck(c.char, c.entry, st, true, "gm") : { ok: true };
    return { ...r, done: putValue("item", `${c.char.id}/${c.entry.uid}`, "gm_state_" + key, value) };
  } });

// How many of a character's items may have a state on (5e: attunement slots); null: the default.
Object.assign(clockwork.find("char.limit.*").def, { gmOnly: true,
  set(c, key, value) {
    const name = limitValueName(stateByKey(key));
    if (!c.char || !name) return failed("That state has no limit");
    if (value !== null && !okNum(value)) return failed("A limit is a number");
    return setValue(c, { scope: "character", target: c.char.id, name }, value === null ? null : Math.max(0, Math.min(99, Math.round(+value) || 0)), "gm");
  } });

Object.assign(clockwork, {
  set(ctx, address, value, by = "player") {
    const f = this.find(address);
    if (!f?.def.set) return failed(`${address} can't be changed`);
    if (by === "gm" && !isGmDevice()) by = "player";
    if (f.def.gmOnly && by !== "gm") return failed(`Only the ${term("gm")} can change that`);
    try { return f.def.set(ctx || {}, f.rest, value, by); } catch (err) { return failed(err.message); }
  },
  // Set, and show what came of it (a refusal, a warning, or the party saying no).
  change(ctx, address, value, by) {
    const r = this.set(ctx, address, value, by);
    if (r.error || r.warning) toast(r.error || r.warning);
    if (r.done) r.done = r.done.then(() => true, err => { toast(err.message); return false; });
    return r;
  },
  // A control's value: [ctx, address] from scope ("party", "character", "item"), target and name.
  at(scope, target, name) {
    if (scope === "party") return [{}, `global.${name}`];
    const [charId, entryUid] = String(target || "").split("/");
    const char = gmChars().find(c => c.id === charId) || store.state.characters.find(c => c.id === charId) || { id: charId };
    return scope === "item" ? [{ char, entry: char.items?.find(e => e.uid === entryUid) || { uid: entryUid } }, `local.${name}`]
      : [{ char }, `char.local.${name}`];
  },
  preview(ctx, address, value) {
    const f = this.find(address), place = f && valuePlace[f.def.pattern]?.(ctx || {}, f.rest);
    if (!place || typeof value !== "number" || !Number.isFinite(value)) return;
    previewing = putGmValue(previewing || {}, place.scope, place.target, valueKey(place.name), value);
    previewMerged = null;
    redrawSoon();
  },
  endPreview() {
    if (!previewing) return;
    previewing = previewMerged = null;
    redrawSoon();
  },
});

// Live icons follow a preview once a frame, however fast the pointer moves.
let redrawQueued = false;
function redrawSoon() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => { redrawQueued = false; refreshLiveIcons(); });
}

// ------------------------------------------------------------------ what values there are

// The values a drawing uses: declared (with a slider: its default and range) or only in formulas
// (0, from 0 to 1). variable name -> { name, scope: "global" | "local", spec }.
const DRAWING_VALUE_RE = /\b(global|local)_([A-Za-z][A-Za-z0-9_]*)\b/g;
const DRAWING_SCOPE = { global: "global", local: "local" };
// Cached per saved drawing (they're replaced, not changed, when edited); the editor's own
// document changes as you draw, so it's read fresh (live: true).
const drawingRefsCache = new WeakMap();
function drawingValueRefs(doc, live = false) {
  if (!doc) return new Map();
  const cached = !live && drawingRefsCache.get(doc);
  if (cached) return cached;
  const refs = new Map();
  const add = (varName, prefix, name, spec) => {
    if (!refs.has(varName) && isValueName(name)) refs.set(varName, { varName, name, scope: DRAWING_SCOPE[prefix], spec });
  };
  for (const v of doc?.variables || []) {
    const m = /^(gm|global|local)_([A-Za-z][A-Za-z0-9_]*)$/.exec(v.name || "");
    if (m && !(v.expression || "").trim()) add(v.name, m[1], m[2], v);
  }
  for (const m of drawingFormulas(doc).join(" ").matchAll(DRAWING_VALUE_RE)) {
    add(m[0], m[1], m[2], { name: m[0], value: 0, min: 0, max: 1, step: 0.01 });
  }
  if (!live) drawingRefsCache.set(doc, refs);
  return refs;
}

// The characters the GM looks after: the party's, else this campaign's.
const gmChars = () => party.active ? party.chars : store.state.characters;

// A system's declared values: [{ name, scope: "global" | "local", label, default, min, max, step, choices }].
function cleanValueDecls(list) {
  return (Array.isArray(list) ? list : []).filter(v => v && isValueName(v.name)).slice(0, 100).map(v => {
    const choices = Array.isArray(v.choices) ? v.choices.map(c => String(c).slice(0, 40)).slice(0, 20) : null;
    const num = (x, d) => typeof x === "number" && Number.isFinite(x) ? x : d;
    return { name: v.name, scope: v.scope === "global" ? "global" : "local", label: v.label ? String(v.label).slice(0, 60) : undefined,
      ...(choices?.length ? { choices, default: num(v.default, 0), min: 0, max: choices.length - 1, step: 1 }
        : { default: num(v.default, 0), min: num(v.min, 0), max: num(v.max, 1), step: num(v.step, 0.01) }) };
  });
}

// Every Global and Local value the app knows of, with its shape: declared by the system, a state's
// limit, used by a drawing (the library, custom items, characters' items), set by a board's pin,
// or just set. "global:name" / "local:name" -> { name, scope, label, value, min, max, step, choices }.
function knownValues() {
  const out = new Map();
  const add = (scope, name, spec = {}) => {
    if (!isValueName(name)) return;
    const k = `${scope}:${name}`;
    if (!out.has(k)) out.set(k, { name, scope, label: spec.label, value: spec.default ?? spec.value ?? 0, min: spec.min ?? 0, max: spec.max ?? 1,
      step: spec.step ?? 0.01, choices: spec.choices });
  };
  for (const v of activeSystem().values || []) add(v.scope, v.name, v);
  for (const st of systemStates()) {
    const name = limitValueName(st);
    if (name) add("local", name, { label: st.limit.label || `${st.label} limit`, default: st.limit.default ?? 0, min: 0, max: 99, step: 1 });
  }
  const docs = [...drawingLibrary().map(d => d.doc), ...store.allCustomItems().map(i => i.iconDoc),
    ...store.state.characters.flatMap(c => c.items.map(e => e.item.iconDoc)), ...(party.active ? party.chars.flatMap(c => c.items.map(e => e.item.iconDoc)) : [])];
  for (const doc of docs) if (doc) for (const r of drawingValueRefs(doc).values()) add(r.scope, r.name, r.spec);
  for (const c of store.state.gmControls || []) for (const k of c.controls || []) for (const p of pinSetters(k.board || {})) {
    [[p.xVar, p.xRange], [p.yVar, p.yRange]].forEach(([n, r]) => n && add(p.scope === "party" ? "global" : "local", n,
      { value: Math.min(...r), min: Math.min(...r), max: Math.max(...r), step: "any" }));
  }
  for (const c of store.state.gmControls || []) for (const k of c.controls || []) {
    const scope = k.scope === "party" ? "global" : "local";
    const ranged = (k.type === "slider" || k.type === "range") && k.max !== undefined ? { min: k.min ?? 0, max: k.max, step: k.step ?? "any", value: k.min ?? 0 } : {};
    if (k.name) add(scope, k.name, ranged);
    if (k.name2) add(scope, k.name2, k.max !== undefined ? { ...ranged, value: k.max } : ranged); // a range's upper end starts at the top
    for (const v of k.vertices || []) if (v.name) add(scope, v.name, { min: 0, max: v.amount ?? 1, step: "any", value: 0 });
  }
  // Shops that follow values (js/shops.js): when they open, their prices, what's for sale.
  for (const r of shopValueReaders()) add("global", r.name, r.what === "prices" ? { value: 1, min: 0, max: 3, step: 0.05 } : { value: 0, min: 0, max: 1, step: 1 });
  const g = valueSet();
  for (const k of Object.keys(g.party || {})) add("global", keyName(k));
  for (const b of [...Object.values(g.characters || {}), ...Object.values(g.items || {})]) {
    for (const k of Object.keys(b || {})) if (!k.startsWith("gm_state_")) add("local", keyName(k));
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

// The Global values shops read: [{ name, shop, what: "opens" | "prices" | "sells", item? }].
function shopValueReaders() {
  const shops = typeof shopStore !== "undefined" && isGmDevice() ? shopStore.list() : store.state.shops || [];
  return shops.flatMap(s => [
    s.openIf?.name && { name: s.openIf.name, shop: s, what: "opens" },
    s.priceValue && { name: s.priceValue, shop: s, what: "prices" },
    ...(s.items || []).filter(li => li.onlyIf?.name).map(li => ({ name: li.onlyIf.name, shop: s, what: "sells", item: li.item })),
  ].filter(Boolean));
}

// The name of the Local value holding a state's limit (5e: attuneSlots).
const limitValueName = st => st?.limit?.value || null;

// ------------------------------------------------------------------ connections
// What joins an item to Clockwork (the flow map, js/flow-map.js, draws all of it).

const layerHasContent = L => !!L && Object.entries(L).some(([, v]) => v !== "" && v != null && (typeof v !== "object" || Object.keys(v).length));

// Does an item take part (the cog beside its name: the Connections map, centred on it)?
const usesClockwork = (char, e) => {
  const it = e.item;
  return (it.triggers || []).length > 0 || (!!it.iconDoc && (isLiveDrawing(it.iconDoc) || drawingValueRefs(it.iconDoc).size > 0))
    || systemStates().some(st => layerHasContent(it.layers?.[st.key]))
    || Object.keys(valueSet().items?.[`${char.id}/${e.uid}`] || {}).length > 0;
};

// ------------------------------------------------------------------ the clocks
// Two clocks (docs/clockwork-plan.md, 3):
//
// The game tick, 4 a second, for what happens over time: it's never slowed by animation. It runs
// items' "while" rules when they're due, and "becomes" rules as moving values cross their lines
// (js/triggers.js), and tells clockwork.on("reached", fn) listeners when a moving value reaches its
// end ({ scope, target, name, value }). It runs only while something is moving or a "while" rule
// is waiting. Coming back from hidden or asleep, it catches up: what reached its end meanwhile is
// told once.
//
// The frame clock, for animation: the part that may be sacrificed. One requestAnimationFrame loop
// redraws what animates (frameClock.add: live icons bound to the time, or reading a moving value),
// only while they're on screen and the app is showing. Each is given the time and dt, the seconds
// since it was last drawn. It keeps its redraws within a budget of a frame: over it, it lowers the
// animation frame rate a step (60, 30, 15, 8, 4, 1 a second); with room to spare, it climbs back
// slowly. Redraws take turns, so one heavy icon doesn't hold up the others. Drawings follow the
// time, so a lower rate is choppier, not slower. The Animations setting (this device) caps the rate.

const GAME_TICK_MS = 250; // 4 a second: recheck if performance suffers (decided 2026-10-01)
const gameTick = { timer: null, last: 0, moving: new Set() };
const clockListeners = new Map(); // event -> Set of functions

Object.assign(clockwork, {
  on(event, fn) {
    if (!clockListeners.has(event)) clockListeners.set(event, new Set());
    clockListeners.get(event).add(fn);
    return () => clockListeners.get(event).delete(fn);
  },
  emit(event, data) {
    for (const fn of clockListeners.get(event) || []) { try { fn(data); } catch (err) { console.error(err); } }
  },
});

// Every moving value: [{ scope, target, name, v }].
function movingValues() {
  const g = party.active ? party.gm || {} : store.state.gmValues || {}, out = [];
  const add = (scope, target, bucket) => { for (const [k, v] of Object.entries(bucket || {})) if (isMoving(v)) out.push({ scope, target, name: keyName(k), v }); };
  add("party", "", g.party);
  for (const [t, b] of Object.entries(g.characters || {})) add("character", t, b);
  for (const [t, b] of Object.entries(g.items || {})) add("item", t, b);
  return out;
}

function runGameTick() {
  const now = clockNow(), was = gameTick.last || now;
  gameTick.last = now;
  const moving = new Set();
  let reached = false;
  for (const m of movingValues()) {
    const end = movingEnd(m.v);
    if (stillMoving(m.v, now)) moving.add(m.name);
    else if (end != null && end > was && end <= now) {
      reached = true;
      clockwork.emit("reached", { scope: m.scope, target: m.target, name: m.name, value: valueNow(m.v, now) });
    }
  }
  const was0 = gameTick.moving;
  gameTick.moving = moving;
  const whiles = hasWhileRules();
  if (!moving.size && !whiles) { clearInterval(gameTick.timer); gameTick.timer = null; gameTick.last = 0; }
  // Rules (js/triggers.js): "while" ones when due; "becomes" ones as moving values cross their lines.
  if (whiles) runWhileRules();
  const fired = moving.size > 0 && runTriggers() > 0;
  // What shows a value as text (panels, the Values tab, shops opening) catches up when one stops.
  if (fired || reached || moving.size !== was0.size) render();
  if (moving.size && !was0.size) frameClock.start();
}

// After every change (render): the tick runs while anything is moving, or a "while" rule waits.
function syncClocks() {
  gameTick.moving = new Set(movingValues().filter(m => stillMoving(m.v)).map(m => m.name));
  if ((gameTick.moving.size || hasWhileRules()) && !gameTick.timer) {
    gameTick.last = clockNow();
    gameTick.timer = setInterval(runGameTick, GAME_TICK_MS);
  }
  if (gameTick.moving.size) frameClock.start();
}
// The names of the values moving now (a drawing reading one animates).
const movingNames = () => gameTick.moving;

// ------------------------------------------------------------------ the frame clock

const ANIMATIONS = [["smooth", "Smooth", 60], ["balanced", "Balanced", 30], ["low", "Low", 8], ["off", "Off", 0]];
const FRAME_RATES = [60, 30, 15, 8, 4, 1];
const FRAME_BUDGET_MS = 4;
const animationsSetting = () => { const a = readPref("mimic-animations", "balanced"); return ANIMATIONS.some(x => x[0] === a) ? a : "balanced"; };

const frameClock = {
  jobs: new Set(),  // { node, animates(), every()?: at most every so many ms, draw(now, dt), born, seen, visible, last }
  rate: 0,          // frames a second now (lowered under load, up to the setting's cap)
  raf: null, cursor: 0, over: 0, easy: 0, lastFrame: 0,
  stats: null,      // the last frame: { rate, due, drawn, spent }
  observer: typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
    for (const en of entries) {
      const job = frameClock.byNode.get(en.target);
      if (job) job.visible = en.isIntersecting;
    }
    frameClock.start();
  }) : null,
  byNode: new WeakMap(),
  cap() { return ANIMATIONS.find(x => x[0] === animationsSetting())[2]; },
  add(job) {
    // Every redraw makes new icons: ones gone from the page are forgotten here too, as frames don't
    // run while nothing animates (Animations off, or the app hidden).
    if (this.jobs.size >= 100) { const now = Date.now(); for (const j of this.jobs) if (!j.node.isConnected && now - j.born > 1000) this.drop(j); }
    Object.assign(job, { born: Date.now(), seen: false, visible: !this.observer, last: 0 });
    this.jobs.add(job);
    this.byNode.set(job.node, job);
    this.observer?.observe(job.node);
    this.start();
  },
  drop(job) {
    this.jobs.delete(job);
    this.observer?.unobserve(job.node);
  },
  start() {
    if (this.raf || document.hidden || !this.cap() || !this.jobs.size) return;
    this.raf = requestAnimationFrame(ts => this.frame(ts));
  },
  // Slower (under load) or faster (with room to spare), a step at a time, never past the setting.
  step(by) {
    const cap = this.cap(), steps = FRAME_RATES.filter(r => r <= cap);
    const i = Math.max(0, steps.indexOf(this.rate));
    this.rate = steps[Math.max(0, Math.min(steps.length - 1, i + by))] || cap;
  },
  frame(ts) {
    this.raf = null;
    const cap = this.cap();
    if (document.hidden || !cap) { this.lastFrame = 0; return; }
    if (!this.rate || this.rate > cap) this.rate = cap;
    const now = Date.now(), gap = this.lastFrame ? ts - this.lastFrame : 0;
    this.lastFrame = ts;
    const due = [];
    let animating = 0;
    for (const j of this.jobs) {
      // Gone from the page (or never shown): forgotten.
      if (!j.node.isConnected) { if (j.seen || now - j.born > 5000) this.drop(j); continue; }
      j.seen = true;
      if (!j.visible || !j.animates()) continue;
      animating++;
      if (now - j.last >= Math.max(1000 / this.rate, j.every?.() || 0) - 4) due.push(j);
    }
    // Taking turns, within the budget (at least one each frame).
    const t0 = performance.now(), from = due.length ? this.cursor % due.length : 0;
    let drawn = 0;
    for (; drawn < due.length; drawn++) {
      if (drawn && performance.now() - t0 > FRAME_BUDGET_MS) break;
      const j = due[(from + drawn) % due.length];
      try { j.draw(now, j.last ? (now - j.last) / 1000 : 0); } catch (err) { console.error(err); }
      j.last = now;
    }
    this.cursor = from + drawn;
    const spent = performance.now() - t0;
    // Under load: an icon falling a whole frame behind (taking turns can't keep up at this rate), or
    // the page so busy frames came late. (Some waiting for the next frame is only taking turns.)
    const interval = 1000 / this.rate;
    const behind = due.some(j => j.last && now - j.last > 2 * Math.max(interval, j.every?.() || 0) + 50);
    if (due.length && (behind || gap > 100)) {
      this.easy = 0;
      if (++this.over >= 3) { this.over = 0; this.step(1); }
    } else if (drawn) {
      this.over = 0;
      // Room to spare for about two seconds: a step faster.
      if (drawn === due.length && spent < FRAME_BUDGET_MS / 3 && ++this.easy >= this.rate * 2) { this.easy = 0; this.step(-1); }
    }
    if (due.length) this.stats = { rate: this.rate, due: due.length, drawn, spent: Math.round(spent * 100) / 100 };
    if (animating) this.raf = requestAnimationFrame(t => this.frame(t));
    else this.lastFrame = 0;
  },
};

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  frameClock.lastFrame = 0;
  frameClock.start();
  if (gameTick.timer) runGameTick(); // catch up at once
});
