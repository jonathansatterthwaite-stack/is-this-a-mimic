// Builds js/parts-library.js: the app's library for the icon editor (svg-lay-tool's `libraries`
// option): Parts (kits of a sword, an axe, a potion, a shield, a bag, a bow, a staff: parts in
// slots, each drawn where it belongs in its kit's 100 × 100 box) and Symbols (dice, suits, marks,
// elements: loose, each going in on its own). Outlines are written in the box's coordinates and
// made into Path layers with svg-lay-tool's core, so they're valid documents' layers.
//
//   node tools/build_parts.mjs [path to svg-lay-tool's dist/core.js]
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const corePath = resolve(process.argv[2] || join(here, "..", "..", "node", "src", "svg-lay-tool", "dist", "core.js"));
const T = await import(pathToFileURL(corePath).href);

let n = 0;
const id = p => `${p}${++n}`;
// A Path layer from an outline drawn in the kit's box: placed and sized by the outline's bounds.
function path(name, d, color, extra = {}) {
  const b = T.polygonsBounds(T.flattenPath(d, 0.5));
  const w = Math.max(b.width, 0.5), h = Math.max(b.height, 0.5), cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  const geometry = T.transformPathData(d, 100 / w, 100 / h, -cx * 100 / w, -cy * 100 / h);
  return T.createShapeLayer({ id: id("l"), shape: "path", name, geometry, x: r(cx), y: r(cy), width: r(w), height: r(h), color, ...extra });
}
const r = v => Math.round(v * 100) / 100;
const part = (pid, name, ...layers) => ({ id: pid, name, layers: layers.flat() });
const slot = (sid, name, ...parts) => ({ id: sid, name, parts });
const kit = (kid, name, slots, extra = {}) => ({ id: kid, name, size: 100, slots, ...extra });
// Shapes made of points.
const poly = (...pts) => "M" + pts.map(p => p.join(" ")).join(" L") + " Z";
const rect = (x, y, w, h, rr = 0) => rr ? `M${x + rr} ${y} H${x + w - rr} A${rr} ${rr} 0 0 1 ${x + w} ${y + rr} V${y + h - rr} A${rr} ${rr} 0 0 1 ${x + w - rr} ${y + h} H${x + rr} A${rr} ${rr} 0 0 1 ${x} ${y + h - rr} V${y + rr} A${rr} ${rr} 0 0 1 ${x + rr} ${y} Z` : `M${x} ${y} H${x + w} V${y + h} H${x} Z`;
const circle = (cx, cy, rad) => `M${cx - rad} ${cy} A${rad} ${rad} 0 1 0 ${cx + rad} ${cy} A${rad} ${rad} 0 1 0 ${cx - rad} ${cy} Z`;
const ellipse = (cx, cy, rx, ry) => `M${cx - rx} ${cy} A${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
const star = (cx, cy, ro, ri, k = 5, turn = -90) => poly(...Array.from({ length: k * 2 }, (_, i) => {
  const a = (turn + i * 180 / k) * Math.PI / 180, rad = i % 2 ? ri : ro;
  return [r(cx + Math.cos(a) * rad), r(cy + Math.sin(a) * rad)];
}));
const regular = (cx, cy, rad, k, turn = -90) => poly(...Array.from({ length: k }, (_, i) => {
  const a = (turn + i * 360 / k) * Math.PI / 180;
  return [r(cx + Math.cos(a) * rad), r(cy + Math.sin(a) * rad)];
}));

// Colours: steel, gold, leather, wood, glass, red.
const STEEL = "#cfd6dd", GOLD = "#c9a227", LEATHER = "#7a5230", WOOD = "#9b6b3c", DARK = "#4a3a2a", GLASS = "#bfe3f2", RED = "#c0392b", BLUE = "#2e86de", CLOTH = "#a8743f";

const kits = [];

// --- Sword: point at the top, pommel at the foot.
kits.push(kit("sword", "Sword", [
  slot("blade", "Blades",
    part("long", "Long", path("Blade", poly([50, 4], [57, 14], [57, 64], [43, 64], [43, 14]), STEEL)),
    part("broad", "Broad", path("Blade", poly([50, 6], [61, 18], [59, 64], [41, 64], [39, 18]), STEEL)),
    part("short", "Short", path("Blade", poly([50, 28], [56, 36], [56, 64], [44, 64], [44, 36]), STEEL)),
    part("leaf", "Leaf", path("Blade", "M50 14 Q62 32 56 64 L44 64 Q38 32 50 14 Z", STEEL)),
    part("curved", "Curved", path("Blade", "M44 64 C42 40 47 20 64 5 C61 26 60 46 57 64 Z", STEEL)),
    part("wavy", "Wavy", path("Blade", "M50 4 L55 12 Q60 20 55 28 Q50 36 55 44 Q60 52 56 64 L44 64 Q40 52 45 44 Q50 36 45 28 Q40 20 45 12 Z", STEEL)),
    part("rapier", "Thin", path("Blade", poly([50, 2], [53, 9], [52.5, 64], [47.5, 64], [47, 9]), STEEL))),
  slot("guard", "Guards",
    part("bar", "Bar", path("Guard", rect(30, 61, 40, 6, 3), GOLD)),
    part("curved", "Curved", path("Guard", "M28 57 Q34 67 50 65 Q66 67 72 57 L72 63 Q66 73 50 71 Q34 73 28 63 Z", GOLD)),
    part("swept", "Swept", path("Guard", "M26 55 Q36 66 50 63 Q64 66 74 55 Q70 70 50 70 Q30 70 26 55 Z", GOLD)),
    part("wings", "Wings", path("Guard", poly([25, 58], [44, 63], [56, 63], [75, 58], [67, 70], [33, 70]), GOLD)),
    part("disc", "Disc", path("Guard", ellipse(50, 66, 11, 5), GOLD))),
  slot("grip", "Grips",
    part("plain", "Plain", path("Grip", rect(45.5, 68, 9, 20, 2), LEATHER)),
    part("wrapped", "Wrapped", path("Grip", rect(45.5, 68, 9, 20, 2), LEATHER),
      path("Wrapping", [0, 1, 2, 3].map(i => poly([45.5, 70 + i * 4.5], [54.5, 72 + i * 4.5], [54.5, 73.5 + i * 4.5], [45.5, 71.5 + i * 4.5])).join(" "), DARK)),
    part("long", "Long", path("Grip", rect(45.5, 68, 9, 26, 2), LEATHER))),
  slot("pommel", "Pommels",
    part("round", "Round", path("Pommel", circle(50, 92, 5.5), GOLD)),
    part("gem", "Gem", path("Pommel", poly([50, 85.5], [56.5, 92], [50, 98.5], [43.5, 92]), RED)),
    part("disc", "Disc", path("Pommel", rect(42, 88.5, 16, 7, 3.5), GOLD)),
    part("tail", "Fishtail", path("Pommel", poly([44, 88], [56, 88], [59, 97], [50, 93.5], [41, 97]), GOLD))),
]));

// --- Axe: the head at the top of the haft.
kits.push(kit("axe", "Axe", [
  slot("haft", "Hafts",
    part("short", "Short", path("Haft", rect(47, 14, 6, 80, 3), WOOD)),
    part("long", "Long", path("Haft", rect(47, 4, 6, 92, 3), WOOD))),
  slot("head", "Heads",
    part("single", "Single", path("Head", "M47 14 H60 Q70 12 80 4 Q90 26 83 50 Q72 41 60 40 H47 Z", STEEL)),
    part("double", "Double", path("Head", "M47 14 H60 Q70 12 80 4 Q90 26 83 50 Q72 41 60 40 H40 Q28 41 17 50 Q10 26 20 4 Q30 12 40 14 Z", STEEL)),
    part("bearded", "Bearded", path("Head", "M47 13 H57 Q63 13 70 7 L76 52 Q66 57 60 46 Q58 41 47 41 Z", STEEL)),
    part("pick", "Pick", path("Head", "M40 18 H60 Q78 22 92 34 Q76 30 60 30 H40 Q30 30 22 26 Q30 20 40 18 Z", STEEL))),
  slot("band", "Bands",
    part("leather", "Leather", path("Band", rect(46, 62, 8, 14, 2), DARK)),
    part("none", "None", [])),
]));

// --- Potion: a bottle (glass and its liquid) and a stopper.
const liquid = (name, d) => path(name, d, RED);
kits.push(kit("potion", "Potion", [
  slot("bottle", "Bottles",
    part("flask", "Round flask", path("Glass", "M43 28 H57 V43 Q79 51 79 70 A29 26 0 0 1 21 70 Q21 51 43 43 Z", GLASS),
      liquid("Liquid", "M24 66 H76 Q77 70 76 74 A27 22 0 0 1 24 74 Q23 70 24 66 Z")),
    part("vial", "Vial", path("Glass", "M41 24 H59 V84 Q59 95 50 95 Q41 95 41 84 Z", GLASS),
      liquid("Liquid", "M44 52 H56 V84 Q56 92 50 92 Q44 92 44 84 Z")),
    part("square", "Square", path("Glass", "M43 28 H57 V39 H70 Q76 39 76 45 V88 Q76 94 70 94 H30 Q24 94 24 88 V45 Q24 39 30 39 H43 Z", GLASS),
      liquid("Liquid", "M27 62 H73 V87 Q73 91 69 91 H31 Q27 91 27 87 Z")),
    part("heart", "Heart", path("Glass", "M44 30 H56 V42 Q60 41 64 41 C82 43 82 74 50 94 C18 74 18 43 36 41 Q40 41 44 42 Z", GLASS),
      liquid("Liquid", "M24 60 H76 C74 72 66 82 50 90 C34 82 26 72 24 60 Z"))),
  slot("stopper", "Stoppers",
    part("cork", "Cork", path("Stopper", poly([42, 14], [58, 14], [57, 29], [43, 29]), WOOD)),
    part("crystal", "Crystal", path("Stopper", poly([50, 4], [58, 15], [55, 29], [45, 29], [42, 15]), "#9b59b6")),
    part("wax", "Wax seal", path("Stopper", "M41 22 Q50 13 59 22 L59 30 H41 Z", RED)),
    part("ring", "Ring", path("Stopper", poly([43, 18], [57, 18], [57, 29], [43, 29]), WOOD), path("Ring", circle(50, 12, 6) + " " + circle(50, 12, 3.5), GOLD))),
]));

// --- Shield: a body, an emblem on it, a boss.
kits.push(kit("shield", "Shield", [
  slot("body", "Bodies",
    part("heater", "Heater", path("Body", "M50 7 L87 18 Q87 60 50 93 Q13 60 13 18 Z", BLUE)),
    part("round", "Round", path("Body", circle(50, 50, 42), BLUE)),
    part("kite", "Kite", path("Body", "M50 5 Q81 11 81 34 Q79 66 50 97 Q21 66 19 34 Q19 11 50 5 Z", BLUE)),
    part("tower", "Tower", path("Body", rect(19, 6, 62, 88, 7), BLUE))),
  slot("emblem", "Emblems",
    part("cross", "Cross", path("Emblem", poly([45, 16], [55, 16], [55, 38], [76, 38], [76, 48], [55, 48], [55, 82], [45, 82], [45, 48], [24, 48], [24, 38], [45, 38]), "#f5d36b")),
    part("chevron", "Chevron", path("Emblem", poly([20, 46], [50, 64], [80, 46], [80, 58], [50, 76], [20, 58]), "#f5d36b")),
    part("star", "Star", path("Emblem", star(50, 46, 20, 8), "#f5d36b")),
    part("sun", "Sun", path("Emblem", star(50, 46, 22, 13, 12) + " " + circle(50, 46, 9), "#f5d36b")),
    part("none", "None", [])),
  slot("boss", "Bosses",
    part("round", "Round", path("Boss", circle(50, 46, 7), "#9aa3ad")),
    part("spike", "Spike", path("Boss", regular(50, 46, 8, 4, 0), "#9aa3ad")),
    part("none", "None", [])),
]));

// --- Bag: a body, a flap, a buckle, a handle.
kits.push(kit("bag", "Bag", [
  slot("body", "Bodies",
    part("pack", "Backpack", path("Body", rect(20, 30, 60, 64, 9), CLOTH)),
    part("sack", "Sack", path("Body", "M36 24 Q50 32 64 24 L62 34 Q86 50 82 76 Q78 96 50 96 Q22 96 18 76 Q14 50 38 34 Z", CLOTH)),
    part("pouch", "Pouch", path("Body", "M26 40 Q50 32 74 40 Q82 70 69 88 Q50 97 31 88 Q18 70 26 40 Z", CLOTH))),
  slot("flap", "Flaps",
    part("square", "Square", path("Flap", "M22 32 H78 V54 Q50 64 22 54 Z", "#8a5a2a")),
    part("pointed", "Pointed", path("Flap", poly([22, 32], [78, 32], [78, 46], [50, 64], [22, 46]), "#8a5a2a")),
    part("tie", "Drawstring", path("Tie", "M34 30 Q50 38 66 30 L66 34 Q50 42 34 34 Z", DARK)),
    part("none", "None", [])),
  slot("buckle", "Buckles",
    part("square", "Square", path("Buckle", rect(44, 50, 12, 12, 2) + " " + rect(47, 53, 6, 6, 1), GOLD)),
    part("round", "Round", path("Buckle", circle(50, 56, 6) + " " + circle(50, 56, 3), GOLD)),
    part("none", "None", [])),
  slot("handle", "Handles",
    part("loop", "Loop", path("Handle", "M36 32 Q36 12 50 12 Q64 12 64 32 L60 32 Q60 16 50 16 Q40 16 40 32 Z", DARK)),
    part("straps", "Straps", path("Straps", rect(26, 26, 7, 70, 2) + " " + rect(67, 26, 7, 70, 2), DARK)),
    part("none", "None", [])),
]));

// --- Bow: the bow, its string, an arrow on it.
kits.push(kit("bow", "Bow", [
  slot("bow", "Bows",
    part("short", "Short", path("Bow", "M40 12 Q76 50 40 88 L45 88 Q82 50 45 12 Z", WOOD)),
    part("long", "Long", path("Bow", "M38 3 Q80 50 38 97 L43 97 Q86 50 43 3 Z", WOOD)),
    part("recurve", "Recurve", path("Bow", "M34 8 Q44 12 44 20 Q76 50 44 80 Q44 88 34 92 L36 95 Q49 90 49 80 Q81 50 49 20 Q49 10 36 5 Z", WOOD))),
  slot("string", "Strings",
    part("plain", "Plain", path("String", rect(39.4, 8, 1.2, 84), "#5a4a3a"))),
  slot("arrow", "Arrows",
    part("nocked", "Nocked", path("Arrow", poly([30, 49.2], [76, 49.2], [76, 47], [86, 50], [76, 53], [76, 50.8], [30, 50.8]), DARK), path("Fletching", poly([28, 46], [36, 49], [36, 51], [28, 54], [31, 50]), RED)),
    part("none", "None", [])),
]));

// --- Staff: a shaft and a head.
kits.push(kit("staff", "Staff", [
  slot("shaft", "Shafts",
    part("straight", "Straight", path("Shaft", rect(47, 22, 6, 76, 3), WOOD)),
    part("gnarled", "Gnarled", path("Shaft", "M47 22 Q44 40 48 56 Q51 70 47 84 Q46 92 48 98 H53 Q54 90 53 84 Q57 70 54 56 Q50 40 53 22 Z", WOOD))),
  slot("head", "Heads",
    part("orb", "Orb", path("Cradle", "M40 14 Q42 28 50 28 Q58 28 60 14 L56 14 Q55 24 50 24 Q45 24 44 14 Z", GOLD), path("Orb", circle(50, 14, 9), "#9b59b6")),
    part("crystal", "Crystal", path("Crystal", poly([50, 2], [58, 12], [55, 26], [45, 26], [42, 12]), "#5fb3e8")),
    part("crook", "Crook", path("Crook", "M47 30 V14 Q47 4 57 4 Q67 4 67 14 Q67 22 60 22 L60 18 Q63 18 63 14 Q63 8 57 8 Q51 8 51 14 V30 Z", WOOD)),
    part("ring", "Ring", path("Ring", circle(50, 14, 11) + " " + circle(50, 14, 7), GOLD))),
]));

// --- Symbols: loose (each on its own).
const SYM = "#2b2118";
const symbol = (pid, name, d) => part(pid, name, path(name, d, SYM));
const symKit = (kid, name, ...parts) => kit(kid, name, [slot(kid, name, ...parts)], { loose: true });
const pips = (...pts) => pts.map(([x, y]) => circle(x, y, 6)).join(" ");
const symbols = [
  symKit("dice", "Dice",
    symbol("d4", "d4", poly([50, 8], [92, 86], [8, 86]) + " " + poly([50, 34], [68, 72], [32, 72])),
    symbol("d6", "d6", rect(12, 12, 76, 76, 12) + " " + pips([32, 32], [50, 50], [68, 68])),
    symbol("d8", "d8", poly([50, 4], [90, 50], [50, 96], [10, 50]) + " " + poly([50, 26], [70, 60], [30, 60])),
    symbol("d10", "d10", poly([50, 4], [92, 44], [50, 96], [8, 44]) + " " + poly([50, 22], [66, 50], [50, 62], [34, 50])),
    symbol("d12", "d12", regular(50, 52, 44, 5) + " " + regular(50, 54, 22, 5)),
    symbol("d20", "d20", regular(50, 50, 46, 6, -90) + " " + poly([50, 22], [72, 64], [28, 64]))),
  symKit("suits", "Suits",
    symbol("spade", "Spade", "M50 6 C30 30 10 44 18 64 C24 78 42 74 46 66 Q44 82 36 92 H64 Q56 82 54 66 C58 74 76 78 82 64 C90 44 70 30 50 6 Z"),
    symbol("heart", "Heart", "M50 88 C12 62 8 30 28 20 C40 14 48 22 50 30 C52 22 60 14 72 20 C92 30 88 62 50 88 Z"),
    symbol("diamond", "Diamond", poly([50, 4], [84, 50], [50, 96], [16, 50])),
    symbol("club", "Club", circle(50, 28, 17) + " " + circle(29, 58, 17) + " " + circle(71, 58, 17) + " M46 60 Q46 82 36 94 H64 Q54 82 54 60 Z")),
  symKit("marks", "Marks",
    symbol("skull", "Skull", "M50 8 C24 8 14 28 16 48 C17 60 24 64 30 66 L32 84 H68 L70 66 C76 64 83 60 84 48 C86 28 76 8 50 8 Z " + circle(36, 44, 9) + " " + circle(64, 44, 9) + " " + poly([50, 54], [44, 66], [56, 66])),
    symbol("swords", "Crossed swords", poly([14, 8], [22, 8], [84, 70], [92, 66], [94, 72], [80, 82], [76, 80], [80, 74]) + " " + poly([86, 8], [78, 8], [16, 70], [8, 66], [6, 72], [20, 82], [24, 80], [20, 74])),
    symbol("coin", "Coin", circle(50, 50, 42) + " " + circle(50, 50, 33) + " " + circle(50, 50, 24)),
    symbol("crown", "Crown", poly([10, 30], [30, 52], [50, 18], [70, 52], [90, 30], [82, 80], [18, 80]) + " " + rect(18, 84, 64, 8, 2)),
    symbol("star", "Star", star(50, 52, 46, 19)),
    symbol("shield", "Shield", "M50 6 L88 18 Q88 62 50 94 Q12 62 12 18 Z"),
    symbol("key", "Key", circle(30, 50, 20) + " " + circle(30, 50, 9) + " " + poly([48, 46], [92, 46], [92, 62], [84, 62], [84, 54], [76, 54], [76, 62], [68, 62], [68, 54], [48, 54]))),
  symKit("elements", "Elements",
    symbol("flame", "Flame", "M50 94 C24 94 18 68 30 50 C32 62 40 64 42 56 C40 38 50 24 58 8 C64 30 82 44 80 66 C79 84 66 94 50 94 Z"),
    symbol("drop", "Water", "M50 6 C50 6 18 46 18 64 A32 32 0 0 0 82 64 C82 46 50 6 50 6 Z"),
    symbol("leaf", "Leaf", "M14 88 C14 40 44 12 90 10 C88 56 62 86 14 88 Z M20 84 Q48 54 78 20 L80 22 Q50 58 22 86 Z"),
    symbol("bolt", "Lightning", poly([58, 4], [22, 54], [46, 54], [36, 96], [78, 40], [54, 40], [66, 4])),
    symbol("snow", "Frost", [0, 60, 120].map(a => { const t = a * Math.PI / 180, c = Math.cos(t), s = Math.sin(t); return poly([r(50 - 44 * c - 3 * s), r(50 - 44 * s + 3 * c)], [r(50 + 44 * c - 3 * s), r(50 + 44 * s + 3 * c)], [r(50 + 44 * c + 3 * s), r(50 + 44 * s - 3 * c)], [r(50 - 44 * c + 3 * s), r(50 - 44 * s - 3 * c)]); }).join(" ")),
    symbol("sun", "Sun", star(50, 50, 46, 30, 12) + " " + circle(50, 50, 22)),
    symbol("moon", "Moon", "M62 8 A42 42 0 1 0 92 70 A34 34 0 1 1 62 8 Z"),
    symbol("wind", "Wind", "M8 36 H60 Q74 36 74 26 Q74 16 64 16 Q56 16 56 24 H48 Q48 8 64 8 Q82 8 82 26 Q82 44 60 44 H8 Z M8 56 H70 Q90 56 90 74 Q90 92 72 92 Q56 92 56 76 H64 Q64 84 72 84 Q82 84 82 74 Q82 64 70 64 H8 Z")),
];

const sources = [
  { id: "mimic-parts", name: "Parts", kits },
  { id: "mimic-symbols", name: "Symbols", kits: symbols },
];
const json = JSON.stringify(sources, (k, v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v));
const out = `// Generated by tools/build_parts.mjs (svg-lay-tool library sources): the icon editor's Parts and
// Symbols. Rebuild it rather than editing.
var PARTS_LIBRARY = ${json};
`;
writeFileSync(join(here, "..", "js", "parts-library.js"), out);
const count = list => list.reduce((s, k) => s + k.slots.reduce((t, sl) => t + sl.parts.length, 0), 0);
console.log(`Wrote js/parts-library.js: ${kits.length} kits (${count(kits)} parts), ${symbols.length} symbol sets (${count(symbols)}) (${Math.round(out.length / 1024)} KB)`);
