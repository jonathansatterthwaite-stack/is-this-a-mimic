// Rules: an item's "when → do", Clockwork's way of making items react (docs/clockwork-plan.md, 4;
// values and addresses in js/clockwork.js, item states and layers in js/system.js).
//
//   item.triggers: [rule]   (the editor calls them rules), and the campaign's rule book, campaign.rules
//   rule: { id?, name?, when, test?, if?, every?, do: [action], message?, appliesTo? }
//     appliesTo: { character?, item?, drawing?, panel? } (js/clockwork.js: scopes). A rule an item
//       carries applies to that item (and can name a character too). A rule-book rule's scope sets
//       its level: an item, template, drawing or panel named: it runs for those items; only a
//       character: for that character; nothing: the world, on the GM's device, where it may set
//       Global values and open or close shops.
//     when: "becomes"   once, as the conditions in test all turn true (from any change: the
//                       player, the GM, a trade, a panel, another rule)
//           "while"     every `every` seconds (default 1) while they all hold (the game tick)
//           "acquired"  it enters this character's inventory (added, bought, given, traded)
//           "equipped", "unequipped"
//     if:   conditions that must also hold when it fires (checked then, not watched)
//     condition: { value: address, op, to, to2? }   op: = != < <= > >= between (to to to2)
//           to: a number, on / off, the name of one of the value's choices, or a formula
//     do:   actions, from the registry (clockwork.action): { set: address, to }, { add: address,
//           by }, { change: address, rate, until? } (a moving value), { message }
//     message: shown to the player
//   An item's actions are rules too: { when: "used", button: "Draw a card", do: […] } makes a button
//   in its details and menu (pressAction runs it); { when: "signal", signal: "Flame" } runs when a
//   hotspot of its drawing says so. Their Do can also take things out of it, put things in, use
//   some of it, show its details or use another of its actions (actions marked press: they ask
//   the person, so they only run from a press, never by themselves).
//
// Rules run on the device a character belongs to, after every change and every party update
// (render calls runTriggers), and "while" rules on the game tick. Each entry keeps, in entry.seen,
// whether each rule's conditions held last time (and its states and equipped, as before), so a
// "becomes" fires only as they turn true. Rules act with by: "rule" (js/clockwork.js): they may set
// their character's states, charges and Local values, not Globals. Changes they make to states fire
// more rules at once, up to RULE_STEPS in a row; changes to values, at the next redraw. An entry
// with no seen is new here: it fires "acquired" once, and its conditions are taken as they are.

const RULE_STEPS = 10;
const RULE_OPS = [["=", "is"], ["!=", "isn't"], ["<", "is under"], ["<=", "is at most"], [">", "is over"], [">=", "is at least"], ["between", "is between"]];
// What a rule can be for: Clockwork's events (any object's, or one kind's), in the editor's order.
clockwork.events = new Map(); // name -> { name, label, kind? }
clockwork.event = (name, def) => clockwork.events.set(name, { name, ...def });
clockwork.event("becomes", { label: "A condition becomes true" });
clockwork.event("while", { label: "While a condition holds" });
clockwork.event("acquired", { label: "It enters the inventory", kind: "item" });
clockwork.event("equipped", { label: "It's equipped", kind: "item" });
clockwork.event("unequipped", { label: "It's unequipped", kind: "item" });
clockwork.event("used", { label: "It's used (a button)", kind: "item", pressed: true });
clockwork.event("signal", { label: "A hotspot is used", kind: "item", pressed: true });
// A GM panel's control: pressed, flipped, let go, picked, a pin dropped, a picture's hotspot
// (`signal`: which; none, any). Its rule applies to the panel or the control (controlUsed).
clockwork.event("control", { label: "A control is used", kind: "control" });
const RULE_WHEN = [...clockwork.events.values()].map(e => [e.name, e.label]);

// ------------------------------------------------------------------ formulas
// A small, safe evaluator (no eval): numbers, addresses (local.heat, item.charges…), + - * / % ^,
// brackets, and min max clamp abs round floor ceil sqrt. Compiled once per text.

const FORMULA_FUNCS = { min: Math.min, max: Math.max, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, sqrt: Math.sqrt,
  clamp: (x, lo, hi) => Math.max(lo, Math.min(hi, x)) };
const formulaCache = new Map();
function compileFormula(text) {
  if (formulaCache.has(text)) return formulaCache.get(text);
  const toks = String(text).match(/\d+(?:\.\d+)?|[A-Za-z_][\w]*(?:\.[\w]+)*|[-+*/%^(),]|\S/g) || [];
  let i = 0;
  const peek = () => toks[i], next = () => toks[i++];
  const fail = () => { throw new Error("bad formula"); };
  const expr = () => { let f = term(); while (peek() === "+" || peek() === "-") { const op = next(), a = f, b = term(); f = op === "+" ? r => a(r) + b(r) : r => a(r) - b(r); } return f; };
  const term = () => { let f = unary(); while (["*", "/", "%"].includes(peek())) { const op = next(), a = f, b = unary(); f = op === "*" ? r => a(r) * b(r) : op === "/" ? r => a(r) / b(r) : r => a(r) % b(r); } return f; };
  const unary = () => { if (peek() === "-") { next(); const a = unary(); return r => -a(r); } if (peek() === "+") { next(); return unary(); } return power(); };
  const power = () => { const a = primary(); if (peek() === "^") { next(); const b = unary(); return r => a(r) ** b(r); } return a; };
  const primary = () => {
    const t = next();
    if (t === undefined) fail();
    if (/^\d/.test(t)) { const n = +t; return () => n; }
    if (t === "(") { const f = expr(); if (next() !== ")") fail(); return f; }
    if (/^[A-Za-z_]/.test(t)) {
      if (peek() === "(") {
        const fn = FORMULA_FUNCS[t];
        if (!fn) fail();
        next();
        const args = [];
        if (peek() !== ")") { args.push(expr()); while (peek() === ",") { next(); args.push(expr()); } }
        if (next() !== ")") fail();
        return r => fn(...args.map(a => a(r)));
      }
      if (!clockwork.find(t)) fail();
      return r => r(t);
    }
    fail();
  };
  let out;
  try { const f = expr(); if (i < toks.length) fail(); out = f; } catch { out = null; }
  if (formulaCache.size >= 500) formulaCache.clear(); // (rules come from anywhere: don't grow without end)
  formulaCache.set(text, out);
  return out;
}

// A value for a rule: as it is now (unset Global and Local values count as their default, else 0).
// ctx.then: an entry's seen ({ states, equipped }), to read those as they were.
function ruleRead(ctx, address) {
  if (ctx.then) {
    const st = /^item\.state\.(.+)$/.exec(address);
    if (st) return ctx.then.states?.[st[1]] ? 1 : 0;
    if (address === "item.equipped") return ctx.then.equipped ? 1 : 0;
  }
  const v = clockwork.get(ctx, address);
  if (v !== undefined) return v;
  const m = /^(?:global|local|char\.local)\.(.+)$/.exec(address);
  return m ? (activeSystem().values || []).find(d => d.name === m[1])?.default ?? 0 : undefined;
}
// The number a condition's or action's `to` means, for the value at address.
function ruleNumber(ctx, to, address) {
  if (typeof to === "number") return to;
  if (typeof to === "boolean") return +to;
  const s = String(to ?? "").trim();
  if (/^(on|yes|true)$/i.test(s)) return 1;
  if (/^(off|no|false)$/i.test(s)) return 0;
  const name = /^(?:global|local|char\.local)\.(.+)$/.exec(address || "")?.[1];
  const choices = name && (activeSystem().values || []).find(d => d.name === name)?.choices;
  const ci = choices ? choices.findIndex(c => c.toLowerCase() === s.toLowerCase()) : -1;
  if (ci >= 0) return ci;
  const f = compileFormula(s);
  if (!f) return NaN;
  try { const v = f(a => ruleRead(ctx, a) ?? 0); return Number.isFinite(v) ? v : NaN; } catch { return NaN; }
}

function conditionHolds(ctx, c) {
  const v = ruleRead(ctx, c.value);
  if (typeof v !== "number") return false;
  const to = ruleNumber(ctx, c.to, c.value);
  if (Number.isNaN(to)) return false;
  switch (c.op) {
    case "=": return Math.abs(v - to) < 1e-9;
    case "!=": return Math.abs(v - to) >= 1e-9;
    case "<": return v < to;
    case "<=": return v <= to;
    case ">": return v > to;
    case ">=": return v >= to;
    case "between": { const to2 = ruleNumber(ctx, c.to2, c.value); return v >= Math.min(to, to2) && v <= Math.max(to, to2); }
  }
  return false;
}
const allHold = (ctx, list) => (list || []).every(c => conditionHolds(ctx, c));

// ------------------------------------------------------------------ actions (a registry)

const ruleActions = new Map(); // name -> { key (its field), label, run(ctx, a) -> { warning?, message? }, words(a), check(a) }
clockwork.action = (name, def) => ruleActions.set(name, { name, ...def });
const actionOf = a => a && typeof a === "object" ? [...ruleActions.values()].find(d => d.key in a) : undefined;
// What a rule may change: an item's states and charges, and Local values.
// (Global values only from world rules, which run as the GM: clockwork.set refuses the rest.)
const RULE_SETTABLE = /^(item\.state\.[\w-]+|item\.charges|local\.[A-Za-z]\w*|char\.local\.[A-Za-z]\w*|global\.[A-Za-z]\w*)$/;

clockwork.action("set", { key: "set", label: "Set",
  check: a => typeof a.set === "string" && RULE_SETTABLE.test(a.set) && (typeof a.to === "number" || (typeof a.to === "string" && a.to !== "")),
  run: (ctx, a) => clockwork.set(ctx, a.set, a.set.startsWith("item.state.") ? !!ruleNumber(ctx, a.to, a.set) : ruleNumber(ctx, a.to, a.set), ctx.by || "rule"),
  words: a => a.set.startsWith("item.state.") ? `turn ${addressLabel(a.set)} ${ruleNumber({}, a.to) ? "on" : "off"}` : `set ${addressLabel(a.set)} to ${a.to}` });
clockwork.action("add", { key: "add", label: "Add",
  check: a => typeof a.add === "string" && RULE_SETTABLE.test(a.add) && !a.add.startsWith("item.state.") && (typeof a.by === "number" || (typeof a.by === "string" && a.by !== "")),
  run: (ctx, a) => clockwork.set(ctx, a.add, (ruleRead(ctx, a.add) ?? 0) + ruleNumber(ctx, a.by, a.add), ctx.by || "rule"),
  words: a => `${String(a.by).trim().startsWith("-") ? "take" : "add"} ${String(a.by).replace(/^\s*-/, "")} ${String(a.by).trim().startsWith("-") ? "from" : "to"} ${addressLabel(a.add)}` });
clockwork.action("change", { key: "change", label: "Change over time",
  check: a => typeof a.change === "string" && /^(local|char\.local|global)\.[A-Za-z]\w*$/.test(a.change) && Number.isFinite(a.rate) && a.rate !== 0,
  run: (ctx, a) => clockwork.set(ctx, a.change, { rate: a.rate, ...(typeof a.until === "number" ? { until: a.until } : {}) }, ctx.by || "rule"),
  words: a => `start ${addressLabel(a.change)} ${a.rate > 0 ? "rising" : "falling"} ${Math.abs(a.rate)} a second` + (typeof a.until === "number" ? ` to ${a.until}` : "") });
// Open or close a shop: a world rule's (the GM's device), as the GM's own switch does.
clockwork.action("shop", { key: "shop", label: "Open or close a shop", level: "world",
  check: a => typeof a.shop === "string" && a.shop !== "" && (a.open === 0 || a.open === 1),
  run: (ctx, a) => {
    const shop = ctx.by === "gm" && typeof shopStore !== "undefined" ? shopStore.find(a.shop) : null;
    if (!shop) return { ok: false };
    if (!!shop.open !== !!a.open) shopStore.save({ ...clone(shop), open: !!a.open }).catch(() => {});
    return { ok: true };
  },
  words: a => `${a.open ? "open" : "close"} ${(typeof shopStore !== "undefined" && shopStore.find(a.shop)?.name) || "a shop"}` });
// What only a press does (a button, a hotspot): they ask the person, or open something. Their
// press(ctx, a) runs on this device, on the entry as it is now, and may wait for a choice.
const pressNamed = x => `${entryName(x)}${x.qty > 1 ? ` ×${x.qty}` : ""}`;
const pickFrom = (title, list, row) => new Promise(done => {
  let close, picked = false;
  close = openModal(title, h("div", { class: "group move-to" }, list.map(x => h("button", { type: "button", class: "row row-main switch",
    onclick: () => { picked = true; close(); done(x); } }, row(x)))));
  const panel = close.panel, obs = new MutationObserver(() => { if (!panel.isConnected) { obs.disconnect(); if (!picked) done(null); } });
  obs.observe(document.body, { childList: true, subtree: true });
});
// { take: "random" | "choose" | "all", to?: "window" } (into a window, else straight into the inventory)
clockwork.action("take", { key: "take", label: "Take out of it", press: true,
  check: a => ["random", "choose", "all"].includes(a.take) && (a.to == null || a.to === "window" || a.to === "inventory"),
  words: a => (a.take === "random" ? "take one out at random" : a.take === "choose" ? "take one out (you choose)" : "take everything out") + (a.to === "window" ? " into a window" : ""),
  async press(ctx, a, label) {
    const char = store.char(), e = char.items.find(x => x.uid === ctx.entry.uid), inside = e ? takeable(char, e) : [];
    if (!e) return false;
    if (!inside.length) { toast(`The ${entryName(e)} is empty`); return false; }
    const toWindow = a.to === "window";
    if (a.take === "random" && toWindow) { openDraw(e.uid); return true; } // (the window takes it, and offers another)
    if (a.take === "choose") {
      const x = await pickFrom(label, inside, x => sealedHere(e) ? h("div", { class: "row-title" }, "Something")
        : [itemIcon(currentItem(x, char), "row-icon"), h("div", { class: "row-title" }, pressNamed(x))]);
      if (!x) return false;
      let got = null;
      commit((s, c) => { const holder = c.items.find(i => i.uid === e.uid), y = c.items.find(i => i.uid === x.uid); if (holder && y) got = takeOutOf(c, holder, y, 1); },
        toWindow ? null : `${label}: ${entryName(x)}`, true);
      if (toWindow && got) openDraw(e.uid, 1, [{ uid: got.uid, n: 1 }]);
      return true;
    }
    const got = [], taken = [];
    commit((s, c) => {
      const holder = c.items.find(i => i.uid === e.uid);
      if (!holder) return;
      if (a.take === "random") { const x = takeRandom(c, holder); if (x) { got.push(entryName(x)); taken.push({ uid: x.uid, n: 1 }); } }
      else for (const x of takeable(c, holder)) { const n = x.qty; got.push(pressNamed(x)); const y = takeOutOf(c, holder, x); if (y) taken.push({ uid: y.uid, n }); }
    }, null, true);
    if (toWindow) openDraw(e.uid, 1, taken);
    else toast(`${label}: ${got.join(", ") || "nothing"}`, null);
    return true;
  } });
clockwork.action("putIn", { key: "putIn", label: "Put things in", press: true,
  check: a => a.putIn === 1,
  words: () => "put something in",
  async press(ctx, a, label) {
    const char = store.char(), e = char.items.find(x => x.uid === ctx.entry.uid);
    if (!e) return false;
    const fits = char.items.filter(x => x.uid !== e.uid && x.parent !== e.uid && !inDeck(char, x) && !isDescendant(char, x.uid, e.uid)
      && !isDescendant(char, e.uid, x.uid) && containerAllows(e, x.item, x.srcId) && !hiddenFromMe(char, x));
    if (!fits.length) { toast(`Nothing you carry goes in the ${entryName(e)}`); return false; }
    const x = await pickFrom(label, fits, x => [itemIcon(currentItem(x, char), "row-icon"), h("div", { class: "row-title" }, pressNamed(x))]);
    if (!x) return false;
    moveEntry(x.uid, e.uid, false);
    return true;
  } });
clockwork.action("use", { key: "use", label: "Use some", press: true,
  check: a => Number.isFinite(a.use) && a.use !== 0 && Math.abs(a.use) <= 1000,
  words: a => a.use > 0 ? (a.use === 1 ? "use one" : `use ${a.use}`) : (a.use === -1 ? "add one" : `add ${-a.use}`),
  async press(ctx, a) {
    const e = store.char()?.items.find(x => x.uid === ctx.entry.uid);
    if (!e) return false;
    if (!canCount(e)) { toast("In Play mode only things like ammunition, rations and potions are counted"); return false; }
    setEntryQty(e, e.qty - a.use);
    return true;
  } });
clockwork.action("details", { key: "details", label: "Show its details", press: true,
  check: a => a.details === 1,
  words: () => "show its details",
  async press(ctx, a, label, env) {
    if (env?.panel?.classList.contains("icon-focus")) env.panel.querySelector(".icon-focus-switch input")?.click();
    else if (!env?.panel) openEntry(ctx.entry.uid);
    return true;
  } });
clockwork.action("press", { key: "press", label: "Use another of its actions", press: true,
  check: a => typeof a.press === "string" && a.press.trim() !== "" && a.press.length <= 40,
  words: a => `use “${a.press}”`,
  async press(ctx, a, label, env) { return pressAction(ctx.entry.uid, a.press, { ...env, depth: (env?.depth || 0) + 1 }); } });
clockwork.action("message", { key: "message", label: "Say",
  check: a => typeof a.message === "string" && a.message.trim() !== "",
  run: (ctx, a) => ({ ok: true, message: a.message }),
  words: a => `say “${a.message}”` });

// ------------------------------------------------------------------ rules

// A rule as saved (null for anything else).
const ruleOf = t => t && typeof t === "object" && t.when ? t : null;
// An item's rules, checked first: items come from trades, treasure, other devices and files, so
// their rules are cleaned as the editor's are (cached per list: a changed item gets a new one).
const rulesCache = new WeakMap();
function rulesOf(item) {
  const list = item?.triggers;
  if (!Array.isArray(list)) return [];
  let rules = rulesCache.get(list);
  if (!rules) rulesCache.set(list, rules = cleanTriggers(list).map(ruleOf).filter(Boolean));
  return rules;
}
// What tells one rule from another in entry.seen (edited conditions start afresh), and which event
// it's for (the most specific of rules for the same one run: clockwork.rulesFor).
const ruleKey = r => JSON.stringify([r.when, r.test || [], ...(r.button ? [r.button] : []), ...(r.signal ? [r.signal] : [])]);
// The rules an item carries apply to it (unless they say more: appliesTo).
clockwork.ruleSource("item", ctx => ctx.entry ? rulesOf(ctx.entry.item).map(rule => ({ rule, scope: { item: "self", ...(rule.appliesTo || {}) } })) : []);
// The campaign's rule book: in a party, the host's copy (every device, GMs too: a second GM's own
// campaign may differ); else this device's campaign. Checked as an item's rules are, once per list.
function bookRules() {
  const list = party.active ? party.campaign?.rules : store.campaign()?.rules;
  if (!Array.isArray(list)) return [];
  let rules = rulesCache.get(list);
  if (!rules) rulesCache.set(list, rules = cleanTriggers(list).map(ruleOf).filter(Boolean));
  return rules;
}
// A rule's level, from what it applies to: "control" (a panel or a control on it), "item",
// "character" or "world".
const ruleLevel = scope => !scope ? "world" : scope.panel || scope.control ? "control" : scope.item || scope.drawing ? "item" : scope.character ? "character" : "world";
const ctxLevel = ctx => ctx.panel ? "control" : ctx.entry ? "item" : ctx.char ? "character" : "world";
clockwork.ruleSource("book", ctx => bookRules().filter(r => ruleLevel(r.appliesTo) === ctxLevel(ctx)).map(rule => ({ rule, scope: rule.appliesTo || {} })));
// A set (a deck of cards) with no actions of its own: Draw a card (one at random) and Take all out.
clockwork.ruleSource("set", ctx => {
  if (!ctx.entry || !deckList(ctx.entry.item)) return []; // (most items: not a set, and no need to work out more)
  const it = currentItem(ctx.entry, ctx.char);
  if (!deckList(it) || rulesOf(it).some(r => r.when === "used")) return [];
  const noun = pieceNoun(it);
  return [{ rule: { when: "used", button: noun === "card" ? "Draw a card" : "Take one at random", do: [{ take: "random", to: "window" }] }, scope: { item: "self" } },
    { rule: { when: "used", button: "Take all out", do: [{ take: "all" }] }, scope: { item: "self" } }];
});
// The rules that run for an entry: from every source, the most specific for each event.
const entryRules = (char, e) => clockwork.rulesFor({ char, entry: e }, ruleKey).map(x => x.rule);

// ------------------------------------------------------------------ running them

const seenOf = (char, e) => ({ states: entryStates(char, e), equipped: !!e.equipped });

// Whether a rule's conditions held when the entry was last seen: kept, or for one with none kept
// (a rule just edited) as its states and equipped were then, the rest as they are now.
function heldBefore(char, e, r) {
  const kept = e.seen.rules?.[ruleKey(r)];
  if (typeof kept === "boolean") return kept;
  return allHold({ char, entry: e, then: e.seen }, r.test);
}

// Runaway rules (two undoing each other through values): a rule firing very often is held back.
const ruleFires = new Map(); // "charId/uid/key" -> [times]
function tooOften(id) {
  const now = Date.now(), list = (ruleFires.get(id) || []).filter(t => now - t < 5000);
  list.push(now);
  ruleFires.set(id, list);
  return list.length > 25;
}

// Do a rule's actions (if its `if` holds) for an object: an item (ctx { char, entry }), a character
// ({ char }) or the world ({ by: "gm" }). Returns the messages.
function fireRule(ctx, r) {
  const out = [], e = ctx.entry, who = e ? entryName(e) : ctx.char ? ctx.char.name : "";
  const say = m => out.push(who ? `${who}: ${m}` : m);
  if (!allHold(ctx, r.if)) return out;
  const id = `${ctx.char?.id || ctx.panel || "world"}/${e?.uid || ctx.control || ""}/${ruleKey(r)}`;
  if (tooOften(id)) {
    if (ruleFires.get(id).length === 26) say("a rule is firing too often, so it's held back");
    return out;
  }
  for (const a of r.do || []) {
    const d = actionOf(a);
    if (!d || !d.check(a) || d.press) continue; // (those wait for a press: pressAction)
    const res = d.run(ctx, a) || {};
    if (res.message) say(res.message);
    if (res.warning) say(res.warning);
  }
  if (r.message) say(r.message);
  return out;
}

// World rules run on the GM's device: outside a party, in the GM role; in one, on the one GM device
// the host chooses (runsWorld), so a rule doesn't run once per GM.
const runsWorldRules = () => clockworkOn() && isGmDevice() && (!party.active || party.runsWorld);
// The objects other than items that rules run for on this device: its characters, and the world.
function levelContexts() {
  const out = store.state.characters.map(c => ({ ctx: { char: c }, id: "char:" + c.id }));
  if (runsWorldRules()) out.push({ ctx: { by: "gm" }, id: "world" });
  return out;
}
// Character and world rules' "becomes": whether each held last time (kept in memory: the first
// look after the app starts is taken as it is, so nothing fires for what was already true).
const levelSeen = new Map(); // id -> { ruleKey: held }
function runLevelRules({ ctx, id }) {
  const rules = clockwork.rulesFor(ctx, ruleKey).map(x => x.rule).filter(r => r.when === "becomes");
  const before = levelSeen.get(id), now = {}, out = [];
  for (const r of rules) now[ruleKey(r)] = allHold(ctx, r.test);
  levelSeen.set(id, now);
  if (!before || !clockworkOn()) return out;
  for (const r of rules) if (now[ruleKey(r)] && before[ruleKey(r)] === false) out.push(...fireRule(ctx, r));
  return out;
}

// A GM panel's control was used: the rule book's rules for it ("A control is used", applying to its
// panel or to it; the most specific for each event), here, as the GM (so they can set Global values
// and open shops). value: its value after the change; signal: a picture's hotspot (rules naming no
// hotspot run for any).
function controlUsed(panelId, controlId, value, signal = "") {
  if (!clockworkOn() || !isGmDevice() || !panelId) return;
  const ctx = { by: "gm", panel: panelId, control: controlId, controlValue: typeof value === "number" ? value : undefined };
  const rules = clockwork.rulesFor(ctx, ruleKey).map(x => x.rule).filter(r => r.when === "control" && (!r.signal || r.signal === signal));
  if (!rules.length) return;
  const messages = rules.flatMap(r => fireRule(ctx, r));
  store.update(() => {});
  if (messages.length) toast(messages.join(" · "));
}

// Run the rules of one character's items. Returns { changed, fired, messages }.
function runCharTriggers(char) {
  let changed = false, fired = 0;
  const messages = [];
  for (const e of char.items) {
    for (let step = 0; step < RULE_STEPS; step++) {
      const rules = entryRules(char, e), ctx = { char, entry: e };
      const becomes = rules.filter(r => r.when === "becomes");
      const holds = Object.fromEntries(becomes.map(r => [ruleKey(r), allHold(ctx, r.test)]));
      let fire;
      if (!e.seen) fire = rules.filter(r => r.when === "acquired");
      else {
        const nowEq = !!e.equipped;
        fire = [
          ...becomes.filter(r => holds[ruleKey(r)] && !heldBefore(char, e, r)),
          ...(nowEq !== !!e.seen.equipped ? rules.filter(r => r.when === (nowEq ? "equipped" : "unequipped")) : []),
        ];
      }
      const next = { ...seenOf(char, e), ...(becomes.length ? { rules: holds } : {}) };
      if (JSON.stringify(next) !== JSON.stringify(e.seen)) changed = true;
      const isNew = !e.seen;
      e.seen = next;
      if (!fire.length && !isNew) break;
      if (!clockworkOn()) break; // switched off: kept up to date, but nothing fires
      for (const r of fire) messages.push(...fireRule({ char, entry: e }, r));
      fired += fire.length;
      if (!fire.length) break;
    }
  }
  return { changed, fired, messages };
}

// Every character on this device (in a party, the ones that are this device's own). Returns how
// many rules fired.
let triggersRunning = false;
function runTriggers() {
  if (triggersRunning || !store.data) return 0;
  triggersRunning = true;
  try {
    let changed = false, fired = 0;
    const messages = [];
    for (const c of store.state.characters) {
      const r = runCharTriggers(c);
      changed = changed || r.changed;
      fired += r.fired;
      messages.push(...r.messages);
    }
    for (const lc of levelContexts()) messages.push(...runLevelRules(lc));
    if (changed) store.save();
    if (messages.length) toast(messages.join(" · "));
    return fired;
  } finally {
    triggersRunning = false;
  }
}

// "While" rules, on the game tick (js/clockwork.js): each, every so often while it holds. After
// time away (asleep, hidden) one that's due runs once.
const whileLast = new Map(); // "charId/uid/key" -> when it last ran (ms)
function hasWhileRules() {
  return clockworkOn() && (store.state.characters.some(c => c.items.some(e => entryRules(c, e).some(r => r.when === "while")))
    || levelContexts().some(({ ctx }) => clockwork.rulesFor(ctx, ruleKey).some(x => x.rule.when === "while")));
}
function runWhileRules(now = Date.now()) {
  const messages = [];
  let ran = false;
  const due = [];
  for (const c of store.state.characters) for (const e of c.items) for (const r of entryRules(c, e)) due.push({ ctx: { char: c, entry: e }, r, id: `${c.id}/${e.uid}/${ruleKey(r)}` });
  for (const { ctx, id } of levelContexts()) for (const x of clockwork.rulesFor(ctx, ruleKey)) due.push({ ctx, r: x.rule, id: `${id}/${ruleKey(x.rule)}` });
  for (const { ctx, r, id } of due) {
    if (r.when !== "while") continue;
    if (!allHold(ctx, r.test)) { whileLast.delete(id); continue; }
    const every = Math.max(0.25, typeof r.every === "number" ? r.every : 1) * 1000;
    if (!whileLast.has(id)) { whileLast.set(id, now); continue; } // the first comes a full interval after it starts holding
    if (now - whileLast.get(id) < every - 20) continue;
    whileLast.set(id, now);
    ran = true;
    messages.push(...fireRule(ctx, r));
  }
  if (ran) store.update(() => {}); // save, and redraw (its changes can fire "becomes" rules)
  if (messages.length) toast(messages.join(" · "));
}

// ------------------------------------------------------------------ pressing an item's action

// An item's actions: its "used" rules (from every source, the most specific for each button), in
// order. [{ label, rule }]
function itemButtons(char, e) {
  const seen = new Set(), out = [];
  for (const r of entryRules(char, e)) if (r.when === "used" && !seen.has(r.button)) { seen.add(r.button); out.push({ label: r.button, rule: r }); }
  return out;
}
// What an action's icon is: a die for one at random, a bag for taking out, a plus for putting in.
function buttonIcon(r) {
  const a = (r.do || []).find(x => actionOf(x)?.press);
  return a?.take === "random" ? "dice" : a?.take ? "bag" : a?.putIn ? "plus" : "wand";
}
// Press one of an item's actions (a button), or a hotspot's signal: its rules' actions, in order,
// on this device. env: { panel (the details it was pressed in), depth (actions using actions) }.
// Returns whether anything ran.
async function pressAction(entryUid, button, env = {}, when = "used") {
  if ((env.depth || 0) > 5) return false;
  const char = store.char(), e = char?.items.find(x => x.uid === entryUid);
  if (!e) return false;
  const rules = entryRules(char, e).filter(r => r.when === when && (when === "used" ? r.button === button : r.signal === button));
  let ran = false;
  for (const r of rules) {
    if (!allHold({ char, entry: e }, r.if)) continue;
    for (const a of r.do || []) {
      const d = actionOf(a);
      if (!d || !d.check(a)) continue;
      const now = store.char(), x = now?.items.find(i => i.uid === entryUid);
      if (!x) return ran;
      if (d.press) {
        const ok = await d.press({ char: now, entry: x }, a, r.button || r.signal, env);
        ran = true;
        if (!ok && (a.take || a.putIn)) break; // (nothing to take, or nothing chosen: the rest waits)
        continue;
      }
      const said = [];
      store.update(s => {
        const c = s.characters.find(c => c.id === now.id), y = c?.items.find(i => i.uid === entryUid);
        if (y) { const res = d.run({ char: c, entry: y }, a) || {}; if (res.message) said.push(res.message); if (res.warning) said.push(res.warning); }
      });
      if (said.length) toast(said.join(" · "));
      ran = true;
    }
    if (r.message) toast(r.message);
  }
  return ran;
}

// ------------------------------------------------------------------ in words

// What an address is, for people: "Charges", "Attuned", "Local value heat".
function addressLabel(address) {
  const m = /^([\w.]+?)\.([^.]+)$/.exec(address || "");
  const st = m && stateByKey(m[2]);
  if (/^item\.state\./.test(address)) return st?.label || m[2];
  if (/^char\.count\./.test(address)) return `items ${(st?.label || m[2]).toLowerCase()}`;
  if (/^char\.limit\./.test(address)) return st?.limit?.label || `${st?.label || m[2]} limit`;
  if (/^char\.stat\./.test(address)) return m[2];
  if (/^global\./.test(address)) return `Global ${m[2]}`;
  if (/^char\.local\./.test(address)) return `the character's ${m[2]}`;
  if (/^local\./.test(address)) return m[2];
  return { "item.charges": "Charges", "item.qty": "How many", "item.equipped": "Equipped", "item.fill": "How full", "item.worth": "Worth",
    "item.weight": "Weight", "char.carried": "Weight carried" }[address] || address;
}
// On-or-off values (states, equipped) read as on / off; the rest as compared.
const isOnOff = c => (/^item\.state\./.test(c.value) || c.value === "item.equipped") && (c.op === "=" || c.op === "!=");
const onOffWords = c => {
  const on = !!ruleNumber({}, c.to) === (c.op === "=");
  return c.value === "item.equipped" ? (on ? "it's equipped" : "it isn't equipped") : `${addressLabel(c.value)} is ${on ? "on" : "off"}`;
};
const ruleCondWords = c => isOnOff(c) ? onOffWords(c)
  : `${addressLabel(c.value)} ${RULE_OPS.find(o => o[0] === c.op)?.[1] || c.op} ${c.to}` + (c.op === "between" ? ` and ${c.to2}` : "");
// How a condition turning true reads: "Charges reach 0", "heat reaches 5".
const BECOMES_WORDS = { "=": "reaches", "!=": "moves off", "<": "drops below", "<=": "drops to", ">": "rises above", ">=": "reaches", between: "comes between" };
// A rule in words: "When Charges reaches 0: turn Cursed on. “The wand crumbles.”"
function ruleWords(t) {
  try { return ruleWordsOf(ruleOf(t)); } catch { return "A rule that can't be read."; }
}
function ruleWordsOf(r) {
  const becomes = c => isOnOff(c) ? (c.value === "item.equipped" ? onOffWords(c).replace("it's", "it's now").replace("it isn't", "it's no longer")
      : `${addressLabel(c.value)} turns ${!!ruleNumber({}, c.to) === (c.op === "=") ? "on" : "off"}`)
    : `${addressLabel(c.value)} ${BECOMES_WORDS[c.op] || c.op} ${c.to}` + (c.op === "between" ? ` and ${c.to2}` : "") + (c.op === "<=" ? " or below" : "");
  const every = n => n === 1 ? "second" : `${n} seconds`;
  const when = r.when === "becomes" ? `When ${(r.test || []).map(becomes).join(" and ")}`
    : r.when === "while" ? `Every ${every(r.every ?? 1)} while ${(r.test || []).map(ruleCondWords).join(" and ")}`
    : r.when === "used" ? `When “${r.button}” is used`
    : r.when === "signal" ? `When the hotspot “${r.signal}” is used`
    : r.when === "control" ? (r.signal ? `When its hotspot “${r.signal}” is used` : "When the control is used")
    : "When " + ({ acquired: "it enters the inventory", equipped: "it's equipped", unequipped: "it's unequipped" }[r.when] || r.when);
  const cond = r.if?.length ? `, if ${r.if.map(ruleCondWords).join(" and ")}` : "";
  const acts = (r.do || []).map(a => actionOf(a)?.words(a)).filter(Boolean);
  const body = acts.join(", ") || "nothing";
  return `${when}${cond}: ${body}${/[.!?]”$/.test(body) ? "" : "."}` + (r.message ? ` “${r.message}”` : "");
}

// ------------------------------------------------------------------ editing rules

// The addresses offered while editing: [{ address, label }] (settable only: what actions change).
function ruleAddressChoices(settable = false) {
  const out = [];
  for (const st of systemStates()) out.push({ address: `item.state.${st.key}`, label: `${st.label}: 1 on, 0 off` });
  out.push({ address: "item.charges", label: "Charges left" });
  if (!settable) {
    out.push(...[["item.qty", "How many in the stack"], ["item.equipped", "1 when equipped"], ["item.fill", "How full, 0 to 1"],
      ["item.worth", "Worth"], ["item.weight", "Weight"], ["char.carried", "Weight carried"], ["control.value", "A control's value, as it's used"]].map(([address, label]) => ({ address, label })));
    for (const st of systemStates()) {
      out.push({ address: `char.count.${st.key}`, label: `Items ${st.label.toLowerCase()}` });
      if (st.limit) out.push({ address: `char.limit.${st.key}`, label: st.limit.label || `${st.label} limit` });
    }
  }
  for (const v of knownValues().values()) {
    if (v.scope === "local") out.push({ address: `local.${v.name}`, label: `Local value: the item's, else its character's` },
      { address: `char.local.${v.name}`, label: "Local value: the character's" });
    else if (!settable) out.push({ address: `global.${v.name}`, label: "Global value" });
  }
  return out;
}
let ruleListId = 0;
function addressInput(value, onChange, settable, label) {
  const id = "rule-addr-" + (++ruleListId);
  return [h("input", { type: "text", class: "rule-addr", list: id, value: value || "", "aria-label": label, spellcheck: "false",
    placeholder: settable ? "e.g. item.state.cursed or local.heat" : "e.g. item.charges or global.doom",
    onchange: ev => onChange(ev.target.value.trim()) }),
    h("datalist", { id }, ruleAddressChoices(settable).map(o => h("option", { value: o.address }, o.label)))];
}
// A number stays a number; anything else is kept as typed (on, a choice, a formula).
const ruleTo = s => /^\s*-?\d+(\.\d+)?\s*$/.test(s) ? +s : s.trim();

// Rules as saved: complete ones only.
// Also used on rules from elsewhere (rulesOf), so it takes nothing on trust: lists, strings and
// numbers are checked, and text is cut short.
function cleanTriggers(list) {
  const arr = x => Array.isArray(x) ? x.slice(0, 20) : [];
  const text = (x, n = 200) => String(x ?? "").slice(0, n);
  const num = x => typeof x === "number" && Number.isFinite(x);
  const toOf = x => num(x) ? x : text(x);
  const okCond = c => c && typeof c === "object" && typeof c.value === "string" && c.value.length <= 80 && clockwork.find(c.value)
    && RULE_OPS.some(o => o[0] === c.op) && (num(c.to) || (typeof c.to === "string" && c.to !== ""));
  const cond = c => ({ value: c.value, op: c.op, to: toOf(c.to), ...(c.op === "between" ? { to2: toOf(c.to2) } : {}) });
  const scopeOf = s => {
    if (!s || typeof s !== "object") return null;
    const o = {};
    for (const k of SCOPE_PARTS) if (typeof s[k] === "string" && s[k] && s[k].length <= 80) o[k] = s[k];
    if (o.control && !o.panel) delete o.control; // (a control is on a panel)
    return Object.keys(o).length ? o : null;
  };
  return (Array.isArray(list) ? list : []).slice(0, 30).map(t => {
    if (!t || typeof t !== "object" || !RULE_WHEN.some(w => w[0] === t.when)) return null;
    const watched = t.when === "becomes" || t.when === "while";
    const test = arr(t.test).filter(okCond).map(cond), guard = arr(t.if).filter(okCond).map(cond);
    const acts = arr(t.do).filter(a => actionOf(a)?.check(a)).map(a => {
      const d = actionOf(a);
      return d.key === "message" ? { message: text(a.message) }
        : d.key === "change" ? { change: a.change, rate: a.rate, ...(num(a.until) ? { until: a.until } : {}) }
        : d.key === "shop" ? { shop: text(a.shop, 40), open: a.open }
        : d.key === "take" ? { take: a.take, ...(a.to === "window" ? { to: "window" } : {}) } : d.key === "putIn" ? { putIn: 1 } : d.key === "use" ? { use: a.use } : d.key === "details" ? { details: 1 }
        : d.key === "press" ? { press: text(a.press, 40) }
        : { [d.key]: a[d.key], [d.key === "set" ? "to" : "by"]: toOf(a[d.key === "set" ? "to" : "by"]) };
    });
    if ((watched && !test.length) || (!acts.length && !t.message)) return null;
    const button = t.when === "used" ? text(t.button, 40).trim() : "", signal = t.when === "signal" || t.when === "control" ? text(t.signal, 40).trim() : "";
    if ((t.when === "used" && !button) || (t.when === "signal" && !signal)) return null;
    const scope = scopeOf(t.appliesTo);
    return { ...(typeof t.id === "string" && t.id ? { id: text(t.id, 40) } : {}), ...(typeof t.name === "string" && t.name.trim() ? { name: text(t.name.trim(), 80) } : {}),
      when: t.when, ...(button ? { button } : {}), ...(signal ? { signal } : {}), ...(watched ? { test } : {}), ...(guard.length ? { if: guard } : {}),
      ...(t.when === "while" ? { every: Math.min(86400, Math.max(0.25, +t.every || 1)) } : {}), do: acts,
      ...(t.message ? { message: text(t.message) } : {}), ...(scope ? { appliesTo: scope } : {}) };
  }).filter(Boolean);
}
