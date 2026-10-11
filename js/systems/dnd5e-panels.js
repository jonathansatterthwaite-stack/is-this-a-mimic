// The D&D 5e system's panels: Character and Combat above the inventory, and the summary on the
// GM's player cards. Panels are HTML the system package carries (see js/panels.js): each runs in a
// sandboxed frame and only sees what the app sends it (Mimic.on("state")), asking for changes
// with Mimic.request(…). These are written as functions so they can be read and checked here;
// the package carries their source text, as any other system's would.

// Shared by every 5e panel (the package's `panelLib`): the rules for Armor Class, carrying and attacks.
function dnd5eRules() {
  const mod = score => Math.floor(((score || 10) - 10) / 2);
  const fmtMod = Mimic.fmtMod;
  const has = (x, key) => x.features.includes(key);
  const isMain = (x, key) => x.main.includes(key);

  function armorClass(state) {
    const st = state.character.stats, dex = mod(st.dex);
    const worn = state.items.filter(x => x.equipped);
    const armor = worn.find(x => has(x, "armor") && x.item.category !== "Shield");
    const shield = worn.find(x => has(x, "armor") && x.item.category === "Shield");
    let ac = 10 + dex, parts = ["10 + Dex " + fmtMod(dex)];
    if (armor) {
      // How much Dex it lets count (an armor without it set: by its category, light armor's all of it).
      const a = armor.item, rule = a.dex || { Medium: "max2", Heavy: "none" }[a.category] || "full";
      const d = rule === "full" ? dex : rule === "max2" ? Math.min(dex, 2) : 0;
      ac = (a.ac || 10) + d + (a.bonus || 0);
      parts = [armor.name + " " + ((a.ac || 10) + (a.bonus || 0))];
      if (rule !== "none") parts.push("Dex " + fmtMod(d));
    }
    if (shield) {
      const b = (shield.item.ac || 2) + (shield.item.bonus || 0);
      ac += b; parts.push("Shield +" + b);
    }
    for (const x of worn) {
      if (x.item.acBonus && has(x, "worn") && (!x.item.attunement || x.states.attuned)) {
        ac += x.item.acBonus;
        parts.push(x.name + " " + fmtMod(x.item.acBonus));
      }
    }
    return {
      ac, breakdown: parts.join(" + ").replace(/\+ -/g, "- "),
      strPenalty: !!(armor && armor.item.strength && (st.str || 10) < armor.item.strength),
      stealth: worn.some(x => x.item.stealthDisadvantage),
    };
  }

  // Carrying capacity: Strength × 15 (× the size multiplier); the variant rule slows you sooner.
  function encumbrance(state) {
    const st = state.character.stats, rule = state.settings.encumbrance;
    const str = st.str || 10, mult = st.carryMultiplier || 1, weight = state.totals.carried;
    const capacity = str * 15 * mult;
    let status = "ok", label = "Unencumbered";
    if (rule === "variant") {
      if (weight > str * 10 * mult) { status = "heavy"; label = "Heavily encumbered (-20 ft, disadv.)"; }
      else if (weight > str * 5 * mult) { status = "warn"; label = "Encumbered (-10 ft speed)"; }
    }
    if (weight > capacity) { status = "over"; label = "Over carrying capacity"; }
    return { weight, capacity, status, label, off: rule === "off" };
  }

  const hasProp = (it, name) => (it.properties || []).some(p => p.toLowerCase().startsWith(name));
  const propArg = (it, name) => {
    const p = (it.properties || []).find(p => p.toLowerCase().startsWith(name));
    const m = p && p.match(/\(([^)]*)\)/);
    return m ? m[1] : undefined;
  };

  // Simple or martial: a weapon template's category (spiked armor's category is its armor's).
  const weaponCategory = x => isMain(x, "weapon") ? x.item.category : null;
  const proficient = (state, x) => (state.character.stats.weaponProfs || ["Simple", "Martial"]).includes(weaponCategory(x) || "Simple");

  // "1d8" + 3 -> "1d8 + 3"; "1" + 3 -> "4"
  function damageText(dice, bonus) {
    if (!dice) return "—";
    if (/^\d+$/.test(dice)) return String(Math.max(0, +dice + bonus));
    return bonus ? dice + " " + (bonus > 0 ? "+" : "−") + " " + Math.abs(bonus) : dice;
  }

  // Everything needed to attack with a weapon: to-hit, damage, reach or range.
  function weaponAttack(state, x) {
    const st = state.character.stats, it = x.item;
    const str = mod(st.str), dex = mod(st.dex);
    // Finesse uses the better of Str and Dex; ranged weapons use Dex, melee (and thrown melee) Str.
    const ability = hasProp(it, "finesse") ? (dex > str ? "dex" : "str") : it.kind === "Ranged" ? "dex" : "str";
    const abil = ability === "dex" ? dex : str;
    const magic = it.bonus || 0;
    const prof = proficient(state, x);
    const range = propArg(it, "range") || (propArg(it, "ammunition") || "").replace(/^range\s*/i, "");
    const thrown = propArg(it, "thrown");
    const reach = it.kind === "Ranged" ? null : hasProp(it, "reach") ? 10 : 5;
    const versatile = propArg(it, "versatile");
    const both = !!(versatile && x.states?.twoHanded); // held two-handed: its versatile damage
    return {
      ability, abil, prof, toHit: abil + (prof ? (st.prof ?? 2) : 0) + magic,
      damage: damageText(both ? versatile : it.damage, abil + magic), type: it.damageType || "", both,
      twoHanded: !both && versatile && damageText(versatile, abil + magic),
      // Off-hand (two-weapon fighting): no ability bonus to damage unless it's negative.
      offHand: hasProp(it, "light") && damageText(it.damage, Math.min(0, abil) + magic),
      reach: reach && reach + " ft",
      range: (range || thrown) && (range || thrown).trim() + " ft",
      thrown: !!thrown, ammo: hasProp(it, "ammunition"), loading: hasProp(it, "loading"),
    };
  }

  // Which ammunition a weapon fires (by name); unknown launchers accept any ammunition.
  const AMMO_FOR = [[/crossbow/, /bolt/], [/blowgun/, /needle/], [/sling/, /sling|bullet/], [/bow/, /arrow/],
    [/pistol|musket|rifle|gun|revolver/, /bullet|cartridge|shot/]];
  function ammoFor(state, weapon) {
    const rule = AMMO_FOR.find(([w]) => w.test(weapon.item.name.toLowerCase()));
    return state.items.filter(x => has(x, "ammunition") && (!rule || rule[1].test(x.item.name.toLowerCase())))
      .sort((a, b) => b.inHolder - a.inHolder); // quivers and cases first: that's what you shoot from
  }

  window.DnD = { mod, armorClass, encumbrance, weaponAttack, ammoFor, has };
}

// Character: Armor Class, carrying, coins and abilities. Closed, it shows the coins and the load.
function dnd5eCharacterPanel() {
  const { h, icon, request, fmtMod } = Mimic;
  const root = document.getElementById("root");

  // An ability score: saved as it's typed (after a pause) and when it's left, so Armor Class and
  // the rest follow at once (the field being typed in stays put while the panel redraws).
  let typing = null;
  const ability = (state, label, key) => {
    const v = state.character.stats[key] || 10;
    const save = e => { clearTimeout(typing); const n = Math.round(+e.target.value);
      if (n >= 1 && n <= 30 && n !== (Mimic.state.character.stats[key] || 10)) request("setStat", { key, value: n }); };
    return h("label", { class: "ability" }, h("span", null, label),
      h("input", { type: "number", inputmode: "numeric", min: 1, max: 30, value: v, "aria-label": label,
        oninput: e => { clearTimeout(typing); typing = setTimeout(() => save(e), 350); },
        onchange: e => { save(e); if (!(Math.round(+e.target.value) >= 1)) e.target.value = Mimic.state.character.stats[key] || 10; } }),
      h("small", null, fmtMod(DnD.mod(v))));
  };

  // How much a character can carry for their size (×1 Small or Medium).
  const CARRY = [[0.5, "×½", "Tiny"], [1, "×1", "Medium"], [2, "×2", "Large"], [4, "×4", "Huge"], [8, "×8", "Gargantuan"]];
  const carry = state => {
    const v = state.character.stats.carryMultiplier || 1, size = (CARRY.find(c => c[0] === v) || CARRY[1])[2];
    return h("label", { class: "ability carry", title: "Carry multiplier: ×½ Tiny, ×1 Small or Medium, ×2 Large or Powerful Build, ×4 Huge, ×8 Gargantuan" },
      h("span", null, "CARRY"),
      h("select", { "aria-label": "Carry multiplier", onchange: e => request("setStat", { key: "carryMultiplier", value: +e.target.value }) },
        CARRY.map(([m, label, name]) => h("option", { value: m, selected: m === v, title: name }, label))),
      h("small", null, size));
  };

  Mimic.on("state", state => {
    const ac = DnD.armorClass(state), enc = DnD.encumbrance(state), t = state.totals;
    const att = state.limits.attuned || { count: 0, limit: 3 };
    const pct = Math.min(100, enc.weight / enc.capacity * 100);
    const load = (+enc.weight.toFixed(1)) + " / " + enc.capacity + " lb";
    Mimic.render(root, h("div", { class: "stats" },
      h("div", { class: "stat", title: ac.breakdown },
        h("div", { class: "stat-label" }, icon("shield"), "Armor Class"),
        h("div", { class: "stat-value" }, ac.ac),
        h("div", { class: "stat-sub" }, ac.breakdown),
        ac.strPenalty && h("div", { class: "stat-warn" }, "Str too low: -10 ft speed"),
        ac.stealth && h("div", { class: "stat-sub" }, "Disadvantage on Stealth")),
      !enc.off && h("div", { class: "stat" },
        h("div", { class: "stat-label" }, icon("weight"), "Carried"),
        h("div", { class: "stat-value" }, +enc.weight.toFixed(1), h("small", null, " / " + enc.capacity + " lb")),
        h("div", { class: "meter " + enc.status }, h("div", { style: { width: pct + "%" } })),
        h("div", { class: "stat-sub" + (enc.status !== "ok" ? " warn-text" : "") }, enc.label)),
      h("button", { class: "stat clickable", type: "button", onclick: () => request("openCoins") },
        h("div", { class: "stat-label" }, icon("coins"), "Coins"),
        h("div", { class: "coins" }, t.coins.map(c => h("span", { class: "coin " + c.key }, h("b", null, c.count.toLocaleString()), " ", c.key))),
        h("div", { class: "stat-sub" }, "Worth " + t.coinsWorth + " · gear " + t.gearWorth)),
      h("div", { class: "stat" },
        h("div", { class: "stat-label" }, icon("user"), "Abilities"),
        h("div", { class: "abilities" }, ability(state, "STR", "str"), ability(state, "DEX", "dex"), !enc.off && carry(state)),
        h("div", { class: "stat-sub" + (att.limit != null && att.count > att.limit ? " warn-text" : "") }, "Attuned " + att.count + " / " + att.limit))));
    Mimic.summary([{ coins: true, closed: true },
      !enc.off && { icon: "weight", text: load, title: enc.label, warn: enc.status !== "ok", closed: true }]);
  });
}

// Combat: the equipped weapons ready to use, with to-hit, damage, range and ammunition.
// The Equipment panel: the equipment slots and what's in them, then the attacks.
function dnd5eEquipmentPanel() {
  const { h, icon, markup, request, fmtMod } = Mimic;
  const root = document.getElementById("root");

  // Each slot: how full it is, and what's in it (tap a name for its details).
  const slotsBox = state => {
    const byUid = Object.fromEntries(state.items.map(x => [x.uid, x]));
    return h("div", { class: "equip-slots" }, state.slots.map(s => {
      const held = s.items.map(si => ({ ...si, x: byUid[si.uid] })).filter(si => si.x);
      return h("div", { class: "equip-slot" + (s.used > s.count ? " over" : s.used >= s.count ? " full" : "") },
        h("div", { class: "equip-slot-head" }, h("b", null, s.label), h("span", { class: "equip-slot-count" }, s.used + " / " + s.count)),
        held.length ? held.map(si => h("button", { class: "equip-item", type: "button", title: "Details", onclick: () => request("openItem", { uid: si.uid }) },
          si.x.icon ? markup(si.x.icon, "equip-icon") : h("span", { class: "equip-icon" }), h("span", { class: "equip-name" }, si.x.name),
          si.size > 1 && h("span", { class: "muted small" }, "×" + si.size)))
          : h("div", { class: "muted small equip-empty" }, "Empty"));
    }));
  };

  // Weapon properties as chips, each with its rule as a tooltip.
  const propertyChips = props => props.map(p => {
    const key = Object.keys(Mimic.glossary).find(k => p.toLowerCase().startsWith(k.toLowerCase()));
    return h("span", { class: "chip", title: key ? Mimic.glossary[key] : "" }, p);
  });

  const ammoLine = (state, weapon) => {
    const stacks = DnD.ammoFor(state, weapon);
    if (!stacks.length) return h("div", { class: "ammo out" }, "No ammunition — add some from the catalog.");
    return h("div", { class: "ammo" }, stacks.map(s => h("div", { class: "ammo-row" },
      markup(s.icon, "ammo-icon"),
      h("span", { class: "ammo-count" }, h("b", null, s.qty.toLocaleString()), " ", s.name),
      h("span", { class: "muted small ammo-where" }, s.location || "on person"),
      h("button", { class: "icon-btn", type: "button", title: "Use one " + s.name, onclick: () => request("changeQty", { uid: s.uid, delta: -1 }) }, icon("minus")),
      h("button", { class: "icon-btn", type: "button", title: "Recover one " + s.name, onclick: () => request("changeQty", { uid: s.uid, delta: 1 }) }, icon("plus")))));
  };

  const attackCard = (state, x) => {
    const it = x.item, a = DnD.weaponAttack(state, x), prof = state.character.stats.prof ?? 2;
    const hitWhy = [a.ability.toUpperCase() + " " + fmtMod(a.abil), a.prof ? "proficiency " + fmtMod(prof) : "not proficient",
      it.bonus && "magic " + fmtMod(it.bonus)].filter(Boolean).join(", ");
    const where = [a.reach && "Reach " + a.reach, a.range && (a.thrown ? "Thrown " : "Range ") + a.range].filter(Boolean).join(" · ");
    const otherProps = (it.properties || []).filter(p => !/^(range|ammunition)/i.test(p));
    return h("div", { class: "attack" + (x.equipped ? "" : " idle") },
      h("div", { class: "attack-head" },
        markup(x.icon, "attack-icon"),
        h("button", { class: "attack-name", type: "button", title: "Details", onclick: () => request("openItem", { uid: x.uid }) },
          x.name, x.qty > 1 && h("span", { class: "tag" }, "×" + x.qty)),
        h("div", { class: "to-hit", title: hitWhy }, h("b", null, fmtMod(a.toHit)), h("small", null, "to hit"))),
      h("div", { class: "attack-dmg" }, h("b", null, a.damage), a.type && " " + a.type,
        a.twoHanded && h("span", { class: "muted" }, " · two hands " + a.twoHanded), a.both && h("span", { class: "muted" }, " · two-handed")),
      h("div", { class: "attack-meta" }, [where, a.ability.toUpperCase(), !a.prof && "not proficient"].filter(Boolean).join(" · ")),
      // Range and ammunition are spelt out above; the other properties keep their rules as tooltips.
      otherProps.length > 0 && h("div", { class: "attack-props" }, propertyChips(otherProps)),
      a.offHand && h("div", { class: "attack-note" }, "Off-hand attack (bonus action): " + a.offHand + (a.type ? " " + a.type : "")),
      a.loading && h("div", { class: "attack-note" }, "Loading: one shot per action, bonus action or reaction."),
      a.range && h("div", { class: "attack-note" }, "Beyond the first range: disadvantage. Can't reach past the second."),
      a.ammo && ammoLine(state, x));
  };

  const unarmedCard = state => {
    const st = state.character.stats, str = DnD.mod(st.str), prof = st.prof ?? 2;
    return h("div", { class: "attack idle" },
      h("div", { class: "attack-head" },
        h("span", { class: "attack-icon unarmed" }, icon("user")),
        h("span", { class: "attack-name static" }, "Unarmed strike"),
        h("div", { class: "to-hit", title: "STR " + fmtMod(str) + ", proficiency " + fmtMod(prof) }, h("b", null, fmtMod(str + prof)), h("small", null, "to hit"))),
      h("div", { class: "attack-dmg" }, h("b", null, String(Math.max(0, 1 + str))), " bludgeoning"),
      h("div", { class: "attack-meta" }, "Reach 5 ft · STR"));
  };

  Mimic.on("state", state => {
    const st = state.character.stats;
    const weapons = state.items.filter(x => DnD.has(x, "weapon"));
    const ready = weapons.filter(x => x.equipped);
    // Nothing equipped yet: show every weapon so the panel is still useful.
    const shown = ready.length ? ready : weapons;
    const others = ready.length ? weapons.filter(x => !x.equipped) : [];
    const profs = st.weaponProfs || ["Simple", "Martial"];
    const setProf = (cat, on) => request("setStat", { key: "weaponProfs", value: on ? [...new Set([...profs, cat])] : profs.filter(p => p !== cat) });
    Mimic.render(root,
      state.slots.length > 0 && slotsBox(state),
      h("div", { class: "combat-settings" },
        h("label", { class: "prof-field" }, "Proficiency bonus",
          h("input", { type: "number", inputmode: "numeric", min: 0, max: 10, value: st.prof ?? 2, "aria-label": "Proficiency bonus",
            onchange: e => request("setStat", { key: "prof", value: Math.max(0, Math.min(10, Math.floor(+e.target.value || 0))) }) })),
        h("span", { class: "muted small" }, "Proficient with"),
        ["Simple", "Martial"].map(cat => h("label", { class: "check" },
          h("input", { type: "checkbox", checked: profs.includes(cat), onchange: e => setProf(cat, e.target.checked) }), " ", cat))),
      h("div", { class: "attack-grid" }, shown.map(x => attackCard(state, x)), unarmedCard(state)),
      !weapons.length && h("p", { class: "muted small pad" }, "Add weapons from the catalog and equip them to see them here."),
      !ready.length && weapons.length > 0 && h("p", { class: "muted small pad" }, "Equip weapons (the sword button on an item) to keep just those here."),
      others.length > 0 && h("div", { class: "combat-others muted small" }, "Also carried: ",
        others.map((x, i) => [i > 0 && ", ", h("button", { class: "link", type: "button", title: "Equip", onclick: () => request("equip", { uid: x.uid, on: true }) },
          x.name + (x.qty > 1 ? " ×" + x.qty : ""))])));
    Mimic.summary([
      state.slots.length > 0 && { icon: "shield", text: state.slots.map(s => s.label + " " + s.used + "/" + s.count).join(" · "),
        warn: state.slots.some(s => s.used > s.count), title: "Equipment slots" },
      { text: ready.length ? ready.map(x => x.name).join(", ")
        : weapons.length ? weapons.length + " weapon" + (weapons.length === 1 ? "" : "s") + ", none equipped" : "Unarmed" }]);
  });
}

// The GM's player cards: AC, load, attunement, abilities and attacks, worked out for each character.
function dnd5eGmPlayerPanel() {
  const fmtMod = Mimic.fmtMod;
  Mimic.on("compute", state => {
    const ac = DnD.armorClass(state), enc = DnD.encumbrance(state), st = state.character.stats;
    return {
      stats: [
        { label: "AC", value: String(ac.ac), title: ac.breakdown },
        !enc.off && { label: "Carried", value: (+enc.weight.toFixed(1)) + " / " + enc.capacity + " lb", title: enc.label,
          warn: enc.status !== "ok", sub: enc.status !== "ok" ? enc.label : "" },
        { label: "Attuned", value: (state.limits.attuned || {}).count + " / " + (state.limits.attuned || {}).limit,
          warn: (state.limits.attuned || {}).count > (state.limits.attuned || {}).limit },
        { label: "STR / DEX", value: (st.str || 10) + " / " + (st.dex || 10) },
      ].filter(Boolean),
      chips: state.items.filter(x => x.equipped && DnD.has(x, "weapon")).map(x => {
        const a = DnD.weaponAttack(state, x);
        return x.name + " " + fmtMod(a.toHit) + " · " + a.damage + (a.type ? " " + a.type : "");
      }),
      notes: [ac.strPenalty && "Strength too low for their armour (−10 ft speed)."].filter(Boolean),
    };
  });
}

// A panel's page: its styles (the app's are there already), a root element and its script.
const panelPage = (fn, css = "") => (css ? "<style>" + css + "</style>" : "") + '<div id="root"></div><script>(' + fn + ")();</" + "script>";

const DND5E_PANELS = {
  // The 5e character stats panels use, with their starting values.
  stats: { str: 10, dex: 10, prof: 2, carryMultiplier: 1, weaponProfs: ["Simple", "Martial"] },
  lib: "(" + dnd5eRules + ")();",
  panels: [
    { id: "character", slot: "inventory", title: "Character", html: panelPage(dnd5eCharacterPanel, ".stats { padding: 10px; } .stat { box-shadow: none; }") },
    { id: "equipment", slot: "inventory", title: "Equipment", html: panelPage(dnd5eEquipmentPanel), shows: ["slots"] },
    { id: "gm-player", slot: "gm-player", title: "Player summary", html: panelPage(dnd5eGmPlayerPanel) },
  ],
};
