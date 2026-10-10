// The first character's things (Kanban #1): a new install's Adventurer starts with a few items
// that show what the app can do, none of them tied to a game system's rules:
//   a backpack whose picture fills as it's loaded, with two stacks in it whose pictures count
//   them (arrows, rations); a compass pointing from the party to the goal on the GM's map, and a
//   totem that wiggles near it; a pocket watch keeping the real time; a deck of playing cards.
// The GM gets the map they follow (GM tab → Controls → Map: a board with two pins setting the
// Global values party_x, party_y, goal_x and goal_y: the party's tent on its own layer, the goal's
// chest on a layer that starts locked, each pictured, with its exact spot shown).
// They're added once, at a new install's first start (store.data.showcase === "pending", set by
// defaultData), unless the game system says `showcase: false`. Showcase entries (e.showcase)
// still leave the Adventurer counting as untouched (isBlankCharacter).

const SHOWCASE_MAP = { party: [30, 70], goal: [70, 30] }; // where the pins start (0 to 100)

const SHOWCASE_CARDS = [...["Spades", "Hearts", "Diamonds", "Clubs"].flatMap(s =>
  ["Ace", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Jack", "Queen", "King"].map(r => `${r} of ${s}`)),
  "Red Joker", "Black Joker"];

// The first of these templates the game system has (its general gear template otherwise).
function showcaseTemplate(...ids) {
  for (const id of ids) { const t = systemIndex().templates.get(id); if (t) return t; }
  return itemTemplate({});
}

// A showcase item: from a template, with a starter drawing (js/starter-drawings.js) as its icon.
function showcaseItem(id, tplIds, fields, starter) {
  const s = STARTER_DRAWINGS.find(d => d.id === starter);
  const doc = clone(s.doc);
  return { ...newItemFrom(showcaseTemplate(...tplIds)), ...fields, id, iconDoc: doc, iconSvg: drawingSvg(doc) };
}

// The GM's map: a blank board with the party and the goal on it, each on a layer of its own (the
// goal's starts locked: the Layers button, expanded, unlocks it), pictured, sitting on its spot.
function showcaseMap() {
  const g = { scope: "party", target: "" }, party = "l" + uid(), goal = "l" + uid();
  const look = (icon, anchor) => ({ look: "picture", icon, size: "l", anchor, spot: true });
  return { id: "gc" + uid(), kind: "panel", name: "Map", cols: 6, rows: 6, controls: [
    { id: "c" + uid(), type: "board", x: 0, y: 0, w: 6, h: 6, label: "Map", board: {
      layers: [{ id: party, name: "Party", kind: "pins" }, { id: goal, name: "Goal", kind: "pins", locked: true }],
      pins: [
        { id: "p" + uid(), label: "Party", color: "#2e86de", xVar: "party_x", yVar: "party_y", ...g, xRange: [0, 100], yRange: [0, 100], layer: party, ...look("tent", [0.5, 1]) },
        { id: "p" + uid(), label: "Goal", color: "#c0392b", xVar: "goal_x", yVar: "goal_y", ...g, xRange: [0, 100], yRange: [0, 100], layer: goal, ...look("treasure-chest", [0.5, 0.5]) },
      ] } },
  ] };
}

async function addShowcase() {
  if (store.data.showcase !== "pending") return;
  const skip = party.active || activeSystem().showcase === false;
  if (!skip) {
    try { await loadSvgLay(); } catch { return; } // (offline before the editor library was cached: next time)
  }
  commit((s, char) => {
    delete store.data.showcase;
    if (skip || !char || !isBlankCharacter(char)) return;
    const put = (item, qty = 1, parent = null) => {
      const e = addToInventory(char, item, qty, parent);
      e.showcase = true;
      return e;
    };
    const pack = put(showcaseItem("showcase-backpack", ["container", "gear"], { name: "Backpack", weight: 5, capacityLb: 30, features: { holds: true },
      description: "Its picture fills up as it's loaded: take something out, or put more in, and watch it change." }, "starter-backpack"));
    put(showcaseItem("showcase-rations", ["consumable", "gear"], { name: "Rations (1 day)", weight: 2,
      description: "A stack: its picture shows a bundle for each you have (up to six). Use one and see." }, "starter-rations"), 4, pack.uid);
    put(showcaseItem("showcase-arrows", ["ammunition", "gear"], { name: "Arrows", weight: 0.05,
      description: "A stack: its picture shows an arrow for each you have (up to ten)." }, "starter-arrows"), 7, pack.uid);
    put(showcaseItem("showcase-compass", ["gear"], { name: "Compass", weight: 0.5,
      description: "Points from the party to the goal on the GM's map (GM tab → Controls → Map). Take the GM role (Settings → This device) and drag the party's tent to see it turn; the goal's layer starts locked (expand the map: Layers)." }, "starter-compass"));
    put(showcaseItem("showcase-totem", ["gear"], { name: "Totem", weight: 1,
      description: "Wiggles and glows when the party is near the goal on the GM's map. Drag the party's tent close to the chest (GM role) to wake it." }, "starter-totem"));
    put(showcaseItem("showcase-watch", ["gear"], { name: "Pocket watch", weight: 0.25,
      description: "Keeps the real time. Drawn icons can follow the clock, and items' values." }, "starter-watch"));
    put(showcaseItem("showcase-cards", ["tool", "gear"], { name: "Playing cards", weight: 0, deckCards: SHOWCASE_CARDS,
      description: "A deck: draw cards from it (its details, or tap its picture with Use in its menu), and put them back." }, "starter-deck"));
    for (const e of char.items) e.showcase = true; // (the deck's cards too)
    // The GM's map, and where its pins start.
    if (!s.gmControls.some(p => p.name === "Map")) s.gmControls.push(showcaseMap());
    s.gmValues.party ||= {};
    for (const [k, [x, y]] of Object.entries(SHOWCASE_MAP)) {
      s.gmValues.party[valueKey(`${k}_x`)] ??= x;
      s.gmValues.party[valueKey(`${k}_y`)] ??= y;
    }
  }, null);
}
