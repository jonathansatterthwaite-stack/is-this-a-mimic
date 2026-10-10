// An example game system, deliberately unlike D&D 5e, to show what a system package can be (and to
// check nothing 5e is left in the app). Slot Delve is a made-up old-school game:
// - what you carry is counted in slots, not pounds: you have as many as your STR score;
// - money is the silver standard and isn't decimal: 1 gold = 20 silver, 1 silver = 10 copper;
// - there's no Armor Class: worn armor gives armor points, and broken gear gives nothing;
// - the Referee can bless items (one blessing per adventurer, unless the Referee says otherwise).
// It comes with the app but isn't added unless you add it (Settings → Files → Game systems).
// See docs/system-packages.md for the format.

// ------------------------------------------------------------------ its panels (see js/panels.js)

// Shared by its panels: load, armor and attacks.
function slotDelveRules() {
  const has = (x, key) => x.features.includes(key);
  const broken = x => !!x.states.broken;
  // Slots: STR (10 by default); coins take a slot per 100 (the app counts that in `carried`).
  const load = state => {
    const cap = state.character.stats.str || 10;
    const used = state.totals.carried;
    return { used, cap, over: used > cap, label: used > cap ? "Over-burdened: half speed" : used > cap - 2 ? "Nearly full" : "" };
  };
  // Armor points from worn, unbroken protection; blessed armor gives one more.
  const armor = state => state.items.filter(x => x.equipped && has(x, "protection") && !broken(x))
    .reduce((s, x) => s + (x.item.armorPoints || 0) + (x.states.blessed ? 1 : 0), 0);
  window.SD = { has, broken, load, armor };
}

// The adventurer: load, armor, coins, STR and CON.
function slotDelveAdventurerPanel() {
  const { h, icon, request } = Mimic;
  const root = document.getElementById("root");
  const score = (state, label, key) => h("label", { class: "ability" }, h("span", null, label),
    h("input", { type: "number", min: 3, max: 18, value: state.character.stats[key] || 10,
      onchange: e => request("setStat", { key, value: Math.max(3, Math.min(18, Math.round(+e.target.value) || 10)) }) }));
  Mimic.on("state", state => {
    const l = SD.load(state), ap = SD.armor(state), t = state.totals;
    const unit = " slot" + (l.cap === 1 ? "" : "s");
    Mimic.render(root, h("div", { class: "stats" },
      h("div", { class: "stat" },
        h("div", { class: "stat-label" }, icon("weight"), "Load"),
        h("div", { class: "stat-value" }, +l.used.toFixed(1), h("small", null, " / " + l.cap + unit)),
        h("div", { class: "meter " + (l.over ? "over" : l.label ? "warn" : "ok") }, h("div", { style: { width: Math.min(100, l.used / l.cap * 100) + "%" } })),
        h("div", { class: "stat-sub" + (l.over ? " warn-text" : "") }, l.label || "Slots: one per point of STR")),
      h("div", { class: "stat" },
        h("div", { class: "stat-label" }, icon("shield"), "Armor"),
        h("div", { class: "stat-value" }, ap),
        h("div", { class: "stat-sub" }, "Points from worn, unbroken armor")),
      h("button", { class: "stat clickable", type: "button", onclick: () => request("openCoins") },
        h("div", { class: "stat-label" }, icon("coins"), "Purse"),
        h("div", { class: "coins" }, t.coins.map(c => h("span", { class: "coin " + c.key }, h("b", null, c.count.toLocaleString()), " ", c.key))),
        h("div", { class: "stat-sub" }, "Worth " + t.coinsWorth)),
      h("div", { class: "stat" },
        h("div", { class: "stat-label" }, icon("user"), "Scores"),
        h("div", { class: "abilities" }, score(state, "STR", "str"), score(state, "CON", "con")))));
    Mimic.summary([{ coins: true, closed: true }, { icon: "weight", text: +l.used.toFixed(1) + " / " + l.cap + unit, warn: l.over, closed: true }]);
  });
}

// Weapons at hand: what's equipped, its damage, and whether it's broken.
function slotDelveWeaponsPanel() {
  const { h, markup, request } = Mimic;
  const root = document.getElementById("root");
  Mimic.on("state", state => {
    const weapons = state.items.filter(x => SD.has(x, "attack"));
    const ready = weapons.filter(x => x.equipped);
    Mimic.render(root, h("div", { class: "attack-grid" },
      (ready.length ? ready : weapons).map(x => h("div", { class: "attack" + (x.equipped ? "" : " idle") },
        h("div", { class: "attack-head" }, markup(x.icon, "attack-icon"),
          h("button", { class: "attack-name", type: "button", onclick: () => request("openItem", { uid: x.uid }) }, x.name)),
        h("div", { class: "attack-dmg" }, h("b", null, SD.broken(x) ? "—" : x.item.damage || "d6"), SD.broken(x) ? " broken" : " damage"),
        h("div", { class: "attack-meta" }, (x.item.hands === "2" ? "Two hands" : "One hand") + (x.states.blessed ? " · blessed: +1 to hit" : "")))),
      !weapons.length && h("p", { class: "muted small pad" }, "No weapons carried.")));
    Mimic.summary([{ text: ready.length ? ready.map(x => x.name).join(", ") : weapons.length ? "None in hand" : "Empty-handed" }]);
  });
}

// The Referee's view of an adventurer.
function slotDelveRefereePanel() {
  Mimic.on("compute", state => {
    const l = SD.load(state);
    const broken = state.items.filter(x => SD.broken(x));
    return {
      stats: [
        { label: "Load", value: +l.used.toFixed(1) + " / " + l.cap, warn: l.over, sub: l.over ? l.label : "" },
        { label: "Armor", value: String(SD.armor(state)) },
        { label: "STR / CON", value: (state.character.stats.str || 10) + " / " + (state.character.stats.con || 10) },
      ],
      chips: broken.map(x => x.name + " (broken)"),
      notes: [],
    };
  });
}

const sdPage = fn => '<div id="root"></div><script>(' + fn + ")();</" + "script>";

// ------------------------------------------------------------------ the package

const SLOT_DELVE_SYSTEM = {
  mimic: "system",
  id: "slot-delve",
  name: "Slot Delve (example)",
  version: 1,
  optional: true, // comes with the app, but isn't added unless you add it
  description: "An example system unlike D&D 5e: inventory slots instead of pounds, the silver standard, armor points instead of Armor Class.",

  templates: [
    { id: "arms", name: "Arms & Armor", plural: "Arms & Armor", hue: 5, icon: "swords", abstract: true },
    { id: "sd-weapon", name: "Weapon", plural: "Weapons", parent: "arms", icon: "swords", features: { attack: "main", equippable: true, stacks: false } },
    { id: "sd-armor", name: "Armor", plural: "Armor", parent: "arms", icon: "armor-breastplate", features: { protection: "main", equippable: true, stacks: false } },
    { id: "kit", name: "Kit", plural: "Kit", hue: 95, icon: "sack", abstract: true },
    { id: "sd-gear", name: "Gear", plural: "Gear", parent: "kit", icon: "sack" },
    { id: "sd-light", name: "Light", plural: "Lights", parent: "kit", icon: "torch",
      fields: [{ key: "burns", label: "Burns for", kind: "text", placeholder: "1 hour" }], defaults: { countInPlay: true } },
    { id: "sd-container", name: "Container", plural: "Containers", parent: "kit", icon: "backpack", features: { holds: true, stacks: false } },
    { id: "sd-provision", name: "Provision", plural: "Provisions", hue: 268, icon: "potion", categories: ["Food", "Drink", "Medicine"], defaults: { countInPlay: true } },
    { id: "sd-loot", name: "Loot", plural: "Loot", hue: 48, icon: "gem", categories: ["Curio", "Gem", "Art"] },
  ],
  features: [
    { key: "attack", label: "Weapon", equip: "wielded", hint: "Used to fight: shows in the Weapons panel.", fields: [
      { key: "damage", label: "Damage", kind: "dice", placeholder: "d6" },
      { key: "hands", label: "Hands", kind: "select", options: ["1", "2"], segmented: true },
    ] },
    { key: "protection", label: "Armor", equip: "worn", hint: "Worn for armor points.", fields: [
      { key: "armorPoints", label: "Armor points", kind: "number", min: 0 },
    ] },
  ],
  commonFields: [],
  states: [
    { key: "broken", label: "Broken", who: "player" },
    { key: "blessed", label: "Blessed", who: "gm", limit: { value: "blessings", default: 1, mode: "block", text: "Only {limit} blessed item per adventurer", label: "Blessings" } },
  ],
  stats: { str: 10, con: 10 },
  campaignSettings: [],
  terminology: { character: "adventurer", characters: "adventurers", gm: "Referee", gameMaster: "Referee", rollTable: "Roll a curio", rollTitle: "Roll a curio" },
  currency: {
    coins: [{ key: "gp", name: "gold", value: 200 }, { key: "sp", name: "silver", value: 10 }, { key: "cp", name: "copper", value: 1 }],
    change: ["sp", "cp"], show: "sp", perWeight: 100,
  },
  weight: { unit: "slots", one: "slot" },
  starterTemplates: [],

  panels: [
    { id: "adventurer", slot: "inventory", title: "Adventurer", html: sdPage(slotDelveAdventurerPanel) },
    { id: "weapons", slot: "inventory", title: "Weapons", html: sdPage(slotDelveWeaponsPanel) },
    { id: "referee", slot: "gm-player", title: "Referee", html: sdPage(slotDelveRefereePanel) },
  ],
  panelLib: "(" + slotDelveRules + ")();",

  // Prices in copper (10 cp = 1 sp); weights in slots.
  catalog: [
    { id: "sd-dagger", type: "sd-weapon", name: "Dagger", damage: "d4", hands: "1", cost: 50, weight: 0.5 },
    { id: "sd-sword", type: "sd-weapon", name: "Sword", damage: "d8", hands: "1", cost: 200, weight: 1 },
    { id: "sd-polearm", type: "sd-weapon", name: "Polearm", damage: "d10", hands: "2", cost: 150, weight: 2 },
    { id: "sd-gambeson", type: "sd-armor", name: "Gambeson", armorPoints: 1, cost: 150, weight: 1 },
    { id: "sd-mail", type: "sd-armor", name: "Mail shirt", armorPoints: 2, cost: 600, weight: 2 },
    { id: "sd-shield", type: "sd-armor", name: "Shield", armorPoints: 1, cost: 100, weight: 1 },
    { id: "sd-rope", type: "sd-gear", name: "Rope, 50 ft", cost: 10, weight: 1 },
    { id: "sd-chalk", type: "sd-gear", name: "Chalk", cost: 1, weight: 0.1 },
    { id: "sd-torch", type: "sd-light", name: "Torch", burns: "1 hour", cost: 1, weight: 1 },
    { id: "sd-lantern", type: "sd-light", name: "Lantern", burns: "4 hours a flask", cost: 100, weight: 1 },
    { id: "sd-sack", type: "sd-container", name: "Sack", capacityLb: 4, cost: 5, weight: 0 },
    { id: "sd-pack", type: "sd-container", name: "Pack", capacityLb: 6, straps: true, cost: 20, weight: 0 },
    { id: "sd-rations", type: "sd-provision", name: "Rations, 1 day", category: "Food", cost: 5, weight: 0.5 },
    { id: "sd-waterskin", type: "sd-provision", name: "Waterskin", category: "Drink", cost: 10, weight: 0.5, features: { liquid: true }, liquidPints: 4 },
    { id: "sd-curio-1", type: "sd-loot", name: "A glass eye that blinks", category: "Curio", cost: 0, weight: 0.1 },
    { id: "sd-curio-2", type: "sd-loot", name: "A map of a town that isn't there", category: "Curio", cost: 0, weight: 0.1 },
    { id: "sd-curio-3", type: "sd-loot", name: "A whistle no one can hear", category: "Curio", cost: 0, weight: 0.1 },
    { id: "sd-curio-4", type: "sd-loot", name: "A coin with two tails", category: "Curio", cost: 0, weight: 0.1 },
    { id: "sd-garnet", type: "sd-loot", name: "Garnet", category: "Gem", cost: 500, weight: 0.1 },
  ],
  tables: [{ id: "sd-curios", name: "Curios", die: "d4", book: "Slot Delve", entries: [
    { roll: 1, id: "sd-curio-1" }, { roll: 2, id: "sd-curio-2" }, { roll: 3, id: "sd-curio-3" }, { roll: 4, id: "sd-curio-4" }] }],
  glossary: {},
};
