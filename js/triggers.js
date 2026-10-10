// Rules: an item's "when → do", Clockwork's way of making items react (docs/clockwork-plan.md, 4;
// values and addresses in js/clockwork.js, item states and layers in js/system.js).
//
//   item.triggers: [rule]   (the editor calls them rules)
//   rule: { when, test?, if?, every?, do: [action], message? }
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
const RULE_WHEN = [["becomes", "A condition becomes true"], ["while", "While a condition holds"], ["acquired", "It enters the inventory"],
  ["equipped", "It's equipped"], ["unequipped", "It's unequipped"]];

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
const RULE_SETTABLE = /^(item\.state\.[\w-]+|item\.charges|local\.[A-Za-z]\w*|char\.local\.[A-Za-z]\w*)$/;

clockwork.action("set", { key: "set", label: "Set",
  check: a => typeof a.set === "string" && RULE_SETTABLE.test(a.set) && (typeof a.to === "number" || (typeof a.to === "string" && a.to !== "")),
  run: (ctx, a) => clockwork.set(ctx, a.set, a.set.startsWith("item.state.") ? !!ruleNumber(ctx, a.to, a.set) : ruleNumber(ctx, a.to, a.set), "rule"),
  words: a => a.set.startsWith("item.state.") ? `turn ${addressLabel(a.set)} ${ruleNumber({}, a.to) ? "on" : "off"}` : `set ${addressLabel(a.set)} to ${a.to}` });
clockwork.action("add", { key: "add", label: "Add",
  check: a => typeof a.add === "string" && RULE_SETTABLE.test(a.add) && !a.add.startsWith("item.state.") && (typeof a.by === "number" || (typeof a.by === "string" && a.by !== "")),
  run: (ctx, a) => clockwork.set(ctx, a.add, (ruleRead(ctx, a.add) ?? 0) + ruleNumber(ctx, a.by, a.add), "rule"),
  words: a => `${String(a.by).trim().startsWith("-") ? "take" : "add"} ${String(a.by).replace(/^\s*-/, "")} ${String(a.by).trim().startsWith("-") ? "from" : "to"} ${addressLabel(a.add)}` });
clockwork.action("change", { key: "change", label: "Change over time",
  check: a => typeof a.change === "string" && /^(local|char\.local)\.[A-Za-z]\w*$/.test(a.change) && Number.isFinite(a.rate) && a.rate !== 0,
  run: (ctx, a) => clockwork.set(ctx, a.change, { rate: a.rate, ...(typeof a.until === "number" ? { until: a.until } : {}) }, "rule"),
  words: a => `start ${addressLabel(a.change)} ${a.rate > 0 ? "rising" : "falling"} ${Math.abs(a.rate)} a second` + (typeof a.until === "number" ? ` to ${a.until}` : "") });
clockwork.action("message", { key: "message", label: "Message",
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
// What tells one rule from another in entry.seen (edited conditions start afresh).
const ruleKey = r => JSON.stringify([r.when, r.test || []]);

// The addresses a rule reads (its conditions) and writes (its actions).
function ruleAddresses(r) {
  const reads = new Set(), writes = new Set();
  for (const c of [...(r.test || []), ...(r.if || [])]) {
    reads.add(c.value);
    for (const t of [c.to, c.to2]) if (typeof t === "string") for (const m of t.matchAll(/[A-Za-z_]\w*(?:\.\w+)+/g)) if (clockwork.find(m[0])) reads.add(m[0]);
  }
  for (const a of r.do || []) { const d = actionOf(a); if (d && d.key !== "message") writes.add(a[d.key]); }
  return { reads: [...reads], writes: [...writes] };
}

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

// Do a rule's actions (if its `if` holds): returns the messages.
function fireRule(char, e, r) {
  const ctx = { char, entry: e }, out = [];
  if (!allHold(ctx, r.if)) return out;
  const id = `${char.id}/${e.uid}/${ruleKey(r)}`;
  if (tooOften(id)) {
    if (ruleFires.get(id).length === 26) out.push(`${entryName(e)}: a rule is firing too often, so it's held back`);
    return out;
  }
  for (const a of r.do || []) {
    const d = actionOf(a);
    if (!d || !d.check(a)) continue;
    const res = d.run(ctx, a) || {};
    if (res.message) out.push(`${entryName(e)}: ${res.message}`);
    if (res.warning) out.push(`${entryName(e)}: ${res.warning}`);
  }
  if (r.message) out.push(`${entryName(e)}: ${r.message}`);
  return out;
}

// Run the rules of one character's items. Returns { changed, fired, messages }.
function runCharTriggers(char) {
  let changed = false, fired = 0;
  const messages = [];
  for (const e of char.items) {
    for (let step = 0; step < RULE_STEPS; step++) {
      const rules = rulesOf(e.item), ctx = { char, entry: e };
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
      for (const r of fire) messages.push(...fireRule(char, e, r));
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
  return clockworkOn() && store.state.characters.some(c => c.items.some(e => rulesOf(e.item).some(r => r.when === "while")));
}
function runWhileRules(now = Date.now()) {
  const messages = [];
  let ran = false;
  for (const c of store.state.characters) for (const e of c.items) for (const r of rulesOf(e.item)) {
    if (r.when !== "while") continue;
    const id = `${c.id}/${e.uid}/${ruleKey(r)}`;
    if (!allHold({ char: c, entry: e }, r.test)) { whileLast.delete(id); continue; }
    const every = Math.max(0.25, typeof r.every === "number" ? r.every : 1) * 1000;
    if (!whileLast.has(id)) { whileLast.set(id, now); continue; } // the first comes a full interval after it starts holding
    if (now - whileLast.get(id) < every - 20) continue;
    whileLast.set(id, now);
    ran = true;
    messages.push(...fireRule(c, e, r));
  }
  if (ran) store.update(() => {}); // save, and redraw (its changes can fire "becomes" rules)
  if (messages.length) toast(messages.join(" · "));
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
      ["item.worth", "Worth"], ["item.weight", "Weight"], ["char.carried", "Weight carried"]].map(([address, label]) => ({ address, label })));
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

// A list of rules (an item's or a template's), edited in place in `owner.triggers`.
function triggersEditor(owner) {
  owner.triggers = (owner.triggers || []).map(ruleOf).filter(Boolean).map(clone);
  const box = h("div", { class: "triggers-edit" });
  const states = systemStates();
  const condRows = (list, label) => h("div", { class: "rule-conds" }, list.map((c, i) => h("div", { class: "trigger-line rule-cond" },
    addressInput(c.value, v => { c.value = v; }, false, `${label}: which value`),
    h("select", { "aria-label": "Compared how", onchange: ev => { c.op = ev.target.value; draw(); } },
      RULE_OPS.map(([op, words]) => h("option", { value: op, selected: c.op === op }, words))),
    h("input", { type: "text", class: "rule-to", value: c.to ?? "", "aria-label": "To", placeholder: "1, on, a choice or a formula",
      onchange: ev => { c.to = ruleTo(ev.target.value); } }),
    c.op === "between" && h("input", { type: "text", class: "rule-to", value: c.to2 ?? "", "aria-label": "And", placeholder: "and",
      onchange: ev => { c.to2 = ruleTo(ev.target.value); } }),
    iconBtn("x", "Remove this condition", () => { list.splice(i, 1); draw(); }))));
  const firstState = () => states[0] ? `item.state.${states[0].key}` : "item.charges";
  const actionRow = (r, a, i) => {
    const d = actionOf(a);
    const kind = h("select", { "aria-label": "Do what", onchange: ev => {
      const k = ev.target.value, target = a.set || a.add || a.change || firstState();
      r.do[i] = k === "set" ? { set: target, to: 1 } : k === "add" ? { add: target.startsWith("item.state.") ? "item.charges" : target, by: 1 }
        : k === "change" ? { change: /^(local|char\.local)\./.test(target) ? target : "local.heat", rate: 1 } : { message: "" };
      draw();
    } }, [...ruleActions.values()].map(x => h("option", { value: x.name, selected: d === x }, x.label)));
    const fields = !d ? [] : d.key === "message"
      ? [h("input", { type: "text", class: "rule-msg", value: a.message, maxlength: 200, "aria-label": "Message", placeholder: "e.g. The wand crumbles to dust.",
          oninput: ev => { a.message = ev.target.value; } })]
      : d.key === "change"
      ? [addressInput(a.change, v => { a.change = v; }, true, "Which value"),
         h("input", { type: "number", step: "any", class: "rule-num", value: a.rate, "aria-label": "How much a second", title: "How much a second (negative to go down)",
           onchange: ev => { a.rate = +ev.target.value; } }), h("span", { class: "muted small" }, "a second, to"),
         h("input", { type: "number", step: "any", class: "rule-num", value: a.until ?? "", "aria-label": "Stops at", placeholder: "never",
           onchange: ev => { if (ev.target.value === "") delete a.until; else a.until = +ev.target.value; } })]
      : [addressInput(a[d.key], v => { a[d.key] = v; }, true, "Which value"), h("span", { class: "muted small" }, d.key === "set" ? "to" : "by"),
         h("input", { type: "text", class: "rule-to", value: a[d.key === "set" ? "to" : "by"] ?? "", "aria-label": d.key === "set" ? "To" : "By",
           placeholder: d.key === "set" ? "1, on, or a formula" : "1, -1, or a formula", onchange: ev => { a[d.key === "set" ? "to" : "by"] = ruleTo(ev.target.value); } })];
    return h("div", { class: "trigger-line rule-action" }, kind, fields, iconBtn("x", "Remove this action", () => { r.do.splice(i, 1); draw(); }));
  };
  const draw = () => setChildren(box,
    owner.triggers.map((r, i) => {
      const watched = r.when === "becomes" || r.when === "while";
      return h("div", { class: "trigger-row" },
        h("div", { class: "trigger-line" }, h("b", null, "When"),
          h("select", { "aria-label": "When", onchange: ev => {
            r.when = ev.target.value;
            if ((r.when === "becomes" || r.when === "while") && !r.test?.length) r.test = [{ value: "item.charges", op: "=", to: 0 }];
            if (r.when !== "becomes" && r.when !== "while") delete r.test;
            if (r.when === "while") r.every ??= 1; else delete r.every;
            draw();
          } }, RULE_WHEN.map(([k, l]) => h("option", { value: k, selected: r.when === k }, l)))),
        watched && condRows(r.test, "Condition"),
        watched && h("div", { class: "trigger-line" },
          h("button", { class: "btn", type: "button", onclick: () => { r.test.push({ value: "item.charges", op: "=", to: 0 }); draw(); } }, icon("plus"), "And"),
          r.when === "while" && [h("span", { class: "muted small" }, "every"),
            h("input", { type: "number", min: 0.25, step: "any", class: "rule-num", value: r.every ?? 1, "aria-label": "Every how many seconds",
              onchange: ev => { r.every = Math.max(0.25, +ev.target.value || 1); } }), h("span", { class: "muted small" }, "seconds")]),
        r.if?.length > 0 && [h("div", { class: "trigger-line" }, h("b", null, "Only if")), condRows(r.if, "Only if")],
        h("div", { class: "trigger-line" }, h("b", null, "Then")),
        (r.do || []).map((a, j) => actionRow(r, a, j)),
        h("div", { class: "trigger-line" },
          h("button", { class: "btn", type: "button", onclick: () => { (r.do ||= []).push({ set: firstState(), to: 1 }); draw(); } }, icon("plus"), "Action"),
          !r.if?.length && h("button", { class: "btn", type: "button", onclick: () => { r.if = [{ value: firstState(), op: "=", to: 1 }]; draw(); } }, icon("plus"), "Only if")),
        h("label", { class: "field full" }, h("span", null, "Message to the player (optional)"),
          h("input", { type: "text", value: r.message || "", maxlength: 200, placeholder: "e.g. The ring tightens on your finger.",
            oninput: ev => { if (ev.target.value.trim()) r.message = ev.target.value; else delete r.message; } })),
        h("p", { class: "muted small rule-words", "data-rule": i }, ruleWords(r)),
        iconBtn("trash", "Remove this rule", () => { owner.triggers.splice(i, 1); draw(); }, "danger-hover"));
    }),
    h("button", { class: "btn", type: "button", onclick: () => {
      owner.triggers.push({ when: "acquired", do: states[0] ? [{ set: `item.state.${states[0].key}`, to: 1 }] : [{ message: "" }] });
      draw();
    } }, icon("plus"), "Add a rule"),
    h("details", { class: "muted small rule-help" }, h("summary", null, "Values, conditions and formulas"),
      h("p", null, "A value is named by where it is: ", h("code", null, "item.charges"), ", ", h("code", null, "item.state.cursed"), " (1 on, 0 off), ",
        h("code", null, "local.heat"), " (the item's Local value, else its character's), ", h("code", null, "char.local.luck"), ", ", h("code", null, "global.doom"),
        ". Suggestions appear as you type."),
      h("p", null, "Compare with a number, on or off, one of the value's choices by name, or a formula: ", h("code", null, "local.heat / 2 + 1"),
        ", with + − × ÷ (", h("code", null, "* /"), "), ", h("code", null, "min max clamp abs round floor ceil sqrt"), "."),
      h("p", null, "Rules can change the item's states and charges, and Local values. Global values are the GM's.")));
  // Each rule in words, kept up to date as it's edited.
  const reword = () => box.querySelectorAll(".rule-words").forEach(p => { const r = owner.triggers[+p.dataset.rule]; if (r) p.textContent = ruleWords(r); });
  box.addEventListener("change", reword);
  box.addEventListener("input", reword);
  draw();
  return box;
}

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
  return (Array.isArray(list) ? list : []).slice(0, 30).map(t => {
    if (!t || typeof t !== "object" || !RULE_WHEN.some(w => w[0] === t.when)) return null;
    const watched = t.when === "becomes" || t.when === "while";
    const test = arr(t.test).filter(okCond).map(cond), guard = arr(t.if).filter(okCond).map(cond);
    const acts = arr(t.do).filter(a => actionOf(a)?.check(a)).map(a => {
      const d = actionOf(a);
      return d.key === "message" ? { message: text(a.message) }
        : d.key === "change" ? { change: a.change, rate: a.rate, ...(num(a.until) ? { until: a.until } : {}) }
        : { [d.key]: a[d.key], [d.key === "set" ? "to" : "by"]: toOf(a[d.key === "set" ? "to" : "by"]) };
    });
    if ((watched && !test.length) || (!acts.length && !t.message)) return null;
    return { when: t.when, ...(watched ? { test } : {}), ...(guard.length ? { if: guard } : {}),
      ...(t.when === "while" ? { every: Math.min(86400, Math.max(0.25, +t.every || 1)) } : {}), do: acts,
      ...(t.message ? { message: text(t.message) } : {}) };
  }).filter(Boolean);
}
