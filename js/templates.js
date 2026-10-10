// Item templates, features and colours. The templates themselves come from the campaign's system
// package (js/system.js, js/systems/dnd5e.js) and its rule packages; here are the fields every
// item has, the features any item can have, and how templates become forms and colours.
//
// Field kinds: text, textarea, number, checkbox, select, tags, dice (and the special kinds the item
// form knows: icon, image, cost, markdown, picture, pieces, packContents).

// Every item has these, whatever its template: name, icon, image and cost first, then the
// template's own fields, then weight, the system's common fields, description and source.
const CORE_HEAD = [
  { key: "name", label: "Name", kind: "text", required: true },
  { key: "icon", label: "Icon", kind: "icon" },
  { key: "image", label: "Image", kind: "image" },
  { key: "cost", label: "Cost", kind: "cost" },
];
const WEIGHT_FIELD = { key: "weight", label: "Weight (lb)", kind: "number", step: 0.01 };
const CORE_TAIL = [
  { key: "description", label: "Description", kind: "textarea" },
  { key: "source", label: "Source", kind: "text", placeholder: "Homebrew" },
];
const CORE_FIELD_KEYS = new Set([...CORE_HEAD, WEIGHT_FIELD, ...CORE_TAIL].map(f => f.key));

// ------------------------------------------------------------------ features
// What an item can do, whatever its template: hold other items, hold liquid, unpack into items,
// hold cards, be written in… Each is a checkbox when editing an item, and its fields only show while
// it's ticked. A template says which features its items start with (a "main" one's fields show with
// the template's own); an item says only where it differs, in `features` ({ holds: true, deck: false }).
// See featureDefault in store.js. A feature with a `flag` is that yes/no field of the item itself
// (imageOnly; 5e's attunement). Two features that `exclude` each other can't both be ticked. Systems
// add features of their own (D&D 5e: Weapon, Armor, Ammunition, Attunement).
// A compartment's own options (as a container's: see compartmentsField in js/app.js).
const COMPARTMENT_FIELDS = [
  { key: "allows", label: "Holds", kind: "allows" },
  { key: "holdLimit", label: "How many it holds (counted)", kind: "number", placeholder: "20" },
  { key: "holdUnit", label: "Counted in (one)", kind: "text", placeholder: "arrow, sheet, coin…" },
  { key: "weightless", label: "Contents don't add weight", kind: "checkbox" },
  { key: "coinsApart", label: "Coins in it don't count in the Coins panel", kind: "checkbox" },
  { key: "contentsView", label: "Shows what's in it", kind: "select", options: ["inherit", "list", "details", "sealed"],
    labels: { inherit: "As the container does", list: "In the inventory (a section of the container's)", details: "Only in the container's details", sealed: "Sealed: hidden (only the GM sees)" } },
];

const CORE_FEATURES = [
  { key: "holds", label: "Container", hint: "Other items go inside it. Set how much it holds, that it only holds certain things, and its compartments (pockets, its outside for strapped gear).", fields: [
    { key: "capacity", label: "Capacity (text)", kind: "text", placeholder: "1 cubic foot/30 pounds of gear" },
    { key: "capacityLb", label: "Capacity (lb)", kind: "number" },
    { key: "weightless", label: "Contents don't add weight (e.g. Bag of Holding)", kind: "checkbox" },
    { key: "allows", label: "Holds", kind: "allows" },
    { key: "holdLimit", label: "How many it holds (counted)", kind: "number", placeholder: "20" },
    { key: "holdUnit", label: "Counted in (one)", kind: "text", placeholder: "arrow, sheet, coin…" },
    { key: "coinsApart", label: "Coins in it don't count in the Coins panel (a piggy bank)", kind: "checkbox" },
    { key: "contentsView", label: "Shows what's in it", kind: "select", options: ["list", "details", "sealed"],
      labels: { list: "In the inventory (a section of its own)", details: "Only in its details (like a deck of cards)", sealed: "Sealed: hidden (only the GM sees)" } },
    { key: "compartments", label: "Compartments", kind: "compartments" },
    { key: "actions", label: "Actions", kind: "actions" },
  ] },
  { key: "liquid", label: "Liquid", hint: "Holds a liquid: record what's in it and how much.", fields: [
    { key: "liquidPints", label: "Liquid capacity (pints)", kind: "number", step: "any" },
  ] },
  { key: "deck", label: "Set", hint: "Made of pieces kept together, like the cards of a deck or the pieces of a chess set. They don't clutter the inventory; take them out (or draw one at random) and put them back.", fields: [
    { key: "pieceName", label: "One piece is called", kind: "text", placeholder: "card, piece, tile…" },
    { key: "deckCards", label: "Pieces", kind: "pieces" },
    { key: "actions", label: "Actions", kind: "actions" },
  ] },
  { key: "pack", label: "Pack", hint: "An equipment pack: unpacks into the items listed, packed the way you choose.", fields: [
    { key: "contents", label: "Contents", kind: "packContents" },
  ] },
  { key: "writable", label: "Writing", hint: "Can be written in and read: paper, books, letters, journals.", excludes: "picture", fields: [
    { key: "author", label: "Author / from", kind: "text", placeholder: "e.g. Captain Varra" },
    { key: "body", label: "Text", kind: "markdown" },
  ] },
  { key: "picture", label: "Picture", hint: "Just an image (a map, a portrait, a sketch), viewed full screen with zoom.", flag: "imageOnly", excludes: "writable", fields: [
    { key: "body", label: "Picture", kind: "picture" },
  ] },
  { key: "equippable", label: "Equippable", hint: "Can be equipped, or worn.", fields: [] },
  { key: "stacks", label: "Stacks", hint: "Identical copies share one row with a count (5 rations), rather than a row each.", fields: [
    { key: "countInPlay", label: "Counts up and down in Play mode (ammunition, rations, potions…)", kind: "checkbox" },
  ] },
  { key: "charges", label: "Charges", hint: "Has charges that get used up and recharge.", fields: [
    { key: "maxCharges", label: "Max charges", kind: "number" },
    { key: "recharge", label: "Recharge", kind: "text", placeholder: "1d6+1 at dawn" },
  ] },
  { key: "bundle", label: "Bundle", hint: "Sold in bundles (like 20 arrows): cost and weight are per bundle.", fields: [
    { key: "bundle", label: "Bundle size", kind: "number", min: 1 },
  ] },
];

// Every field that belongs to a feature (the item form shows them with it).
const featureFieldKeys = () => new Set(allFeatures().flatMap(f => f.fields.map(x => x.key)));

// The features a template's items start with, and the "main" ones (their fields show in the form itself).
const templateFeatureDefaults = tpl => tpl?.features || {};
const mainFeatures = tpl => Object.entries(templateFeatureDefaults(tpl)).filter(([, v]) => v === "main").map(([k]) => k);

// ------------------------------------------------------------------ forms

// A template's category list as a field.
function categoryField(tpl) {
  if (!tpl.categories?.length) return null;
  return { key: "category", label: tpl.categoryLabel || "Category", kind: "select", options: tpl.categories, segmented: !!tpl.categorySegmented };
}

// Every field of an item made with a template, in order: name, icon, image and cost; its category;
// its main features' fields; its own fields; weight; the system's common fields; description, source.
function templateFields(tpl) {
  const main = mainFeatures(tpl).flatMap(k => featureByKey(k)?.fields || []);
  // Fields of the other features show with their feature (under Features), not here.
  const seen = new Set([...featureFieldKeys()].filter(k => !main.some(f => f.key === k)));
  const tail = CORE_TAIL.filter(f => !(tpl.hide || []).includes(f.key));
  return [...CORE_HEAD, categoryField(tpl), ...main, ...(tpl.fields || []), WEIGHT_FIELD, ...(activeSystem().commonFields || []), ...tail]
    .filter(f => f && !seen.has(f.key) && seen.add(f.key));
}

// A field's label, in the system's weight unit ("Weight (lb)", "Capacity (kg)").
function fieldLabel(f) {
  return f.label.replace("(lb)", `(${weightUnit()})`);
}

// ------------------------------------------------------------------ the tree's colours
// Each top template has a hue (any template can have one of its own); the templates under it, and
// its categories, are shades of it (Light / Medium / Heavy armor; Gear & Tools' gear, tools, packs).

// A hue chosen in the app (Catalog → Templates → Colour).
function chosenHue(id) {
  const hues = typeof store !== "undefined" ? store.state?.settings?.templateHues : null;
  return hues && Object.hasOwn(hues, id) ? hues[id] : undefined;
}
const ownHue = tpl => chosenHue(tpl.id) ?? tpl.hue;
// The template whose colour a template shows: the nearest of it and those above it with a hue of
// its own (else the top one).
const colourSource = tpl => templateLineage(tpl).find(t => ownHue(t) != null) || topTemplate(tpl);
const templateHue = tpl => ownHue(colourSource(tpl)) ?? 0;

// The built-in template an item comes from (copies count as their original).
const itemRootId = it => rootTemplate(itemTemplate(it))?.id;

// A template's kinds, as sub-filters (each a shade of its colour): the templates under it (each
// with its own kinds, a level down), and its own items (not abstract ones); else its categories.
function subcategories(tpl) {
  if (typeof tpl === "string") tpl = templateById(tpl);
  if (!tpl) return [];
  const kids = childTemplates(tpl);
  if (!kids.length) return templateSubcategories(tpl);
  const subs = kids.map(t => ({ key: t.id, label: templatePlural(t), match: it => inTemplate(it, t.id) }));
  // Its own items: by its categories (Simple, Martial…), else all together.
  if (!tpl.abstract) {
    const own = it => inTemplate(it, tpl.id) && !kids.some(k => inTemplate(it, k.id));
    const cats = templateSubcategories(tpl);
    subs.push(...(cats.length ? cats.map(c => ({ ...c, match: it => own(it) && c.match(it) }))
      : [{ key: `${tpl.id}:self`, label: `Other ${templatePlural(tpl).toLowerCase()}`, match: own }]));
  }
  return subs;
}

// A template's categories as subcategories (shades of its colour).
function templateSubcategories(tpl) {
  return (tpl.categories || []).filter(Boolean).map(c => ({ key: c, label: c, match: it => it.category === c }));
}

// Shade i of n. Neighbours contrast rather than forming a gradient: lightness levels are dealt
// out alternately from the lighter and darker halves (for 4: 2nd lightest, darkest, lightest,
// 2nd darkest), saturation alternates high/low, and the hue leans a few degrees either way.
// Lightness stays between 34% and 66% so icons read in light and dark mode.
function shadeLevels(n) {
  const half = Math.ceil(n / 2), order = [];
  for (let k = 0; k < half; k++) {
    order.push(half - 1 - k);
    if (n - 1 - k >= half) order.push(n - 1 - k);
  }
  return order;
}

function shade(hue, i = -1, n = 1, j = -1, m = 1) {
  if (i < 0 || n < 2) return j < 0 ? `hsl(${hue} 62% 50%)` : shade(hue, j, m);
  const level = shadeLevels(n)[i];
  let l = 66 - level * (32 / (n - 1));
  const s = i % 2 ? 46 : 76;
  const h = (hue + (i % 2 ? 7 : -7) + 360) % 360;
  // A kind's own kinds (Tools' Artisan's Tools, Gaming Set…): a little lighter or darker within its shade.
  if (j >= 0 && m > 1) l = Math.min(70, Math.max(30, l + (j - (m - 1) / 2) * Math.min(5, 14 / (m - 1))));
  return `hsl(${h} ${s}% ${Math.round(l)}%)`;
}

// Sort position of an item: its template's place in the tree.
function templateOrder(item) {
  const list = treeTemplates(), i = list.indexOf(itemTemplate(item));
  return i < 0 ? list.length : i;
}

// A template's colour: its own hue, or its shade of the colour of the template above it that it
// shows (by which of that one's kinds it is).
function templateColor(tpl) {
  const src = colourSource(tpl);
  if (src === tpl) return shade(templateHue(tpl));
  const line = templateLineage(tpl), under = line[line.indexOf(src) - 1] || tpl;
  const subs = subcategories(src);
  return shade(templateHue(src), subs.findIndex(s => s.key === under.id), subs.length);
}

// The colour an item shows (icon, tile edge): the colour its template shows, in the shade of its
// kind (and of its kind's own kind: a tool's category).
function itemColor(item) {
  const src = colourSource(itemTemplate(item));
  const subs = subcategories(src), i = subs.findIndex(s => s.match(item));
  const kind = i >= 0 && templateById(subs[i].key) !== src && colourSource(templateById(subs[i].key) || src) === src ? templateById(subs[i].key) : null;
  const inner = kind ? subcategories(kind) : [];
  return shade(templateHue(src), i, subs.length, inner.findIndex(s => s.match(item)), inner.length);
}
