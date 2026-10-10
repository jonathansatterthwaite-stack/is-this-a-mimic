// Builds js/starter-drawings.js: interactive drawings to start from (Catalog → Drawings, and the
// icon editor's Start from…). Each is made with svg-lay-tool's core, so it's a valid document.
//
//   node tools/build_starters.mjs [path to svg-lay-tool's dist/core.js]
//   (default: ../node/src/svg-lay-tool/dist/core.js beside this project)
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const corePath = resolve(process.argv[2] || join(here, "..", "..", "node", "src", "svg-lay-tool", "dist", "core.js"));
const T = await import(pathToFileURL(corePath).href);

let n = 0;
const id = p => `${p}${++n}`;
const bind = (target, expression, anchor) => ({ id: id("b"), target, expression, enabled: true, ...(anchor ? { anchor } : {}) });
const tap = (...actions) => T.createGesture("tap", { id: id("g"), actions });
const act = a => ({ id: id("a"), ...a });
const v = (name, value, min, max, step = 1) => T.createVariable({ id: id("v"), name, value, min, max, step });
const shape = init => T.createShapeLayer({ id: id("l"), ...init });
const group = init => T.createGroupLayer({ id: id("l"), ...init });
const doc = (layers, variables = []) => {
  let d = T.createDocument({ width: 256, height: 256, background: null });
  for (const x of variables) d = T.upsertVariable(d, x);
  for (const l of layers) d = T.insertLayer(d, l);
  return d;
};
// An outline only: no fill, a stroke of width w.
const outline = (w = 8) => [T.createModifier("fill", { fill: { type: "none" } }), T.createModifier("stroke", { color: null, width: w })];
const BIG = 1e13;

const starters = [];

// --- Abacus: three rods of five beads; drag along a rod to count (the rightmost beads slide over first).
{
  const layers = [
    shape({ shape: "rect", name: "Top bar", x: 128, y: 44, width: 220, height: 14 }),
    shape({ shape: "rect", name: "Bottom bar", x: 128, y: 212, width: 220, height: 14 }),
    shape({ shape: "rect", name: "Left post", x: 24, y: 128, width: 12, height: 182 }),
    shape({ shape: "rect", name: "Right post", x: 232, y: 128, width: 12, height: 182 }),
  ];
  const vars = [];
  [84, 128, 172].forEach((y, r) => {
    const name = `local_row${r + 1}`;
    vars.push(v(name, 0, 0, 5));
    layers.push(shape({ shape: "rect", name: `Rod ${r + 1}`, x: 128, y, width: 196, height: 4 }));
    for (let i = 0; i < 5; i++) {
      layers.push(shape({ shape: "ellipse", name: `Bead ${r + 1}.${i + 1}`, x: 44 + i * 22, y, width: 20, height: 26,
        bindings: [bind("x", `${name} > ${4 - i} ? ${212 - (4 - i) * 22} : ${44 + i * 22}`)] }));
    }
    layers.push(shape({ shape: "rect", name: `Rod ${r + 1} (touch)`, x: 128, y, width: 200, height: 36,
      hotspot: T.createHotspot({ hidden: true, gestures: [T.createGesture("drag", { id: id("g"), axis: "x", actions: [act({ do: "drag", var: name, from: 0, to: 5, step: 1 })] })] }) }));
  });
  starters.push({ id: "starter-abacus", name: "Abacus", hint: "Drag along a rod to count (0 to 5 on each). The counts are the item's own Local values (row1, row2, row3).", doc: doc(layers, vars) });
}

// --- Hourglass: tap (or swipe) to flip it; a minute of sand runs down, wherever it was when flipped.
{
  const top = "clamp(local_top - since(local_flippedAt) / 60, 0, 1)"; // the sand in the top chamber (on screen)
  // The glass turns over; the sand stays still (it always falls down the screen), hidden while it turns.
  const settled = "local_flips == 0 || since(local_flippedAt) >= 0.5";
  const flip = [
    act({ do: "set", var: "local_top", to: `1 - ${top}` }),
    act({ do: "mark", var: "local_flippedAt" }),
    act({ do: "add", var: "local_flips", by: "1" }),
    act({ do: "sound", sound: "whoosh", volume: 0.5 }),
  ];
  const glass = group({ name: "Hourglass", x: 128, y: 128, children: [
    shape({ shape: "rect", name: "Top", x: 0, y: -100, width: 140, height: 14 }),
    shape({ shape: "rect", name: "Bottom", x: 0, y: 100, width: 140, height: 14 }),
    shape({ shape: "polygon", name: "Upper glass", x: 0, y: -46, width: 110, height: 94, params: { sides: 3 }, flipY: true, modifiers: outline(6) }),
    shape({ shape: "polygon", name: "Lower glass", x: 0, y: 46, width: 110, height: 94, params: { sides: 3 }, modifiers: outline(6) }),
  ], bindings: [bind("rotation", "180 * (local_flips - 1 + ease(clamp(since(local_flippedAt) / 0.5, 0, 1)))")],
    hotspot: T.createHotspot({ gestures: [tap(...flip), T.createGesture("swipe", { id: id("g"), dir: "any", actions: flip.map(a => ({ ...a, id: id("a") })) })] }) });
  starters.push({ id: "starter-hourglass", name: "Hourglass", hint: "Tap or swipe to flip it: a minute of sand runs down, and flipping part-way turns over what's left. It keeps running with the details closed.",
    doc: doc([glass,
      shape({ shape: "polygon", name: "Upper sand", x: 128, y: 87, width: 86, height: 74, params: { sides: 3 }, flipY: true,
        // What's left rests at the neck: it shrinks towards its point. (Anchors are in the shape's
        // own frame, before its flip: its point at the neck is y 0.)
        bindings: [bind("width", `86 * ${top}`, { x: 0.5, y: 0 }), bind("height", `74 * ${top}`, { x: 0.5, y: 0 }), bind("visible", settled)] }),
      shape({ shape: "polygon", name: "Lower sand", x: 128, y: 178, width: 86, height: 74, params: { sides: 3 },
        bindings: [bind("width", `86 * (1 - ${top})`, { x: 0.5, y: 1 }), bind("height", `74 * (1 - ${top})`, { x: 0.5, y: 1 }), bind("visible", settled)] }),
    ], [v("local_top", 0, 0, 1, 0.01), v("local_flippedAt", 0, 0, BIG), v("local_flips", 0, 0, BIG)]) });
}

// --- Lantern: tap to light it; the flame flickers. (Rules on the item can burn its oil down.)
{
  const layers = [
    shape({ shape: "ellipse", name: "Glow", x: 128, y: 140, width: 230, height: 230, opacity: 0.2, bindings: [bind("visible", "local_lit")] }),
    shape({ shape: "ellipse", name: "Ring", x: 128, y: 34, width: 40, height: 30, params: { hole: 55 } }),
    shape({ shape: "polygon", name: "Cap", x: 128, y: 62, width: 120, height: 34, params: { sides: 4 }, modifiers: [T.createModifier("deform", { top: 40, bottom: 100, skew: 0 })] }),
    shape({ shape: "rect", name: "Glass", x: 128, y: 138, width: 100, height: 118, modifiers: outline(8) }),
    shape({ shape: "rect", name: "Base", x: 128, y: 210, width: 130, height: 26 }),
    shape({ shape: "teardrop", name: "Flame", x: 128, y: 150, width: 40, height: 62,
      bindings: [bind("visible", "local_lit"), bind("height", "62 * (0.88 + 0.12 * sin(t * 11) * sin(t * 7))", { x: 0.5, y: 1 })] }),
    shape({ shape: "rect", name: "Wick", x: 128, y: 184, width: 6, height: 12 }),
    shape({ shape: "rect", name: "Lantern (touch)", x: 128, y: 130, width: 150, height: 210,
      hotspot: T.createHotspot({ hidden: true, gestures: [tap(act({ do: "set", var: "local_lit", to: "1 - local_lit" }), act({ do: "sound", sound: "click" }))] }) }),
  ];
  starters.push({ id: "starter-lantern", name: "Lantern", hint: "Tap to light it and put it out (its Local value lit). Give the item rules to burn its oil down while lit: when lit becomes 1, change oil at -1 an hour; when oil reaches 0, set lit to 0.",
    doc: doc(layers, [v("local_lit", 0, 0, 1)]) });
}

// --- Drum: tap the skin for a beat (and a wobble, and a buzz on phones).
{
  const wobble = "1 + 0.22 * exp(-since(hitAt) * 7) * sin(since(hitAt) * 42)";
  const layers = [
    shape({ shape: "rect", name: "Shell", x: 128, y: 160, width: 180, height: 100 }),
    shape({ shape: "ellipse", name: "Bottom rim", x: 128, y: 210, width: 180, height: 44 }),
    shape({ shape: "rect", name: "Stick 1", x: 96, y: 52, width: 10, height: 120, rotation: -35 }),
    shape({ shape: "rect", name: "Stick 2", x: 160, y: 52, width: 10, height: 120, rotation: 35 }),
    shape({ shape: "ellipse", name: "Skin", x: 128, y: 110, width: 180, height: 56, modifiers: outline(10),
      bindings: [bind("height", `56 * (${wobble})`)],
      hotspot: T.createHotspot({ gestures: [tap(act({ do: "sound", sound: "drum" }), act({ do: "mark", var: "hitAt" }), act({ do: "vibrate", ms: 15 }))] }) }),
  ];
  starters.push({ id: "starter-drum", name: "Drum", hint: "Tap the skin for a beat. The wobble lasts while the details are open (hitAt isn't kept).", doc: doc(layers, [v("hitAt", 0, 0, BIG)]) });
}

// --- Die: tap to roll (1 to 6, kept as the item's face), with a rattle and a shake.
{
  const pip = (name, x, y, when) => shape({ shape: "ellipse", name, x, y, width: 32, height: 32, bindings: [bind("visible", when)] });
  const die = group({ name: "Die", x: 128, y: 128, children: [
    shape({ shape: "rect", name: "Face", x: 0, y: 0, width: 190, height: 190, modifiers: [T.createModifier("round", { radius: 18 }), ...outline(12)] }),
    pip("Top left", -52, -52, "local_face >= 2"), pip("Bottom right", 52, 52, "local_face >= 2"),
    pip("Top right", 52, -52, "local_face >= 4"), pip("Bottom left", -52, 52, "local_face >= 4"),
    pip("Middle left", -52, 0, "local_face == 6"), pip("Middle right", 52, 0, "local_face == 6"),
    pip("Middle", 0, 0, "mod(local_face, 2) == 1"),
  ], bindings: [bind("rotation", "24 * exp(-since(rolledAt) * 6) * sin(since(rolledAt) * 34)")],
    hotspot: T.createHotspot({ gestures: [tap(act({ do: "random", var: "local_face", from: 1, to: 6, step: 1 }), act({ do: "mark", var: "rolledAt" }), act({ do: "sound", sound: "dice" }))] }) });
  starters.push({ id: "starter-die", name: "Die", hint: "Tap to roll: a face from 1 to 6, kept as the item's Local value face.", doc: doc([die], [v("local_face", 1, 1, 6), v("rolledAt", 0, 0, BIG)]) });
}

// --- Card deck: tap to draw a card (on a set, e.g. a deck of cards); the stack shrinks as cards are drawn.
{
  const card = (name, dx, dy, when) => shape({ shape: "rect", name, x: 128 + dx, y: 128 + dy, width: 130, height: 180,
    modifiers: [T.createModifier("round", { radius: 14 }), ...outline(7)], bindings: when ? [bind("visible", when)] : [] });
  const layers = [
    card("Bottom card", 16, 16, "pieces > 2"),
    card("Middle card", 8, 8, "pieces > 1"),
    card("Top card", 0, 0, "pieces > 0"),
    shape({ shape: "crescent", name: "Mark", x: 128, y: 128, width: 50, height: 60, bindings: [bind("visible", "pieces > 0")] }),
    shape({ shape: "rect", name: "Deck (touch)", x: 136, y: 136, width: 160, height: 210,
      hotspot: T.createHotspot({ hidden: true, gestures: [tap(act({ do: "app", app: "draw" }), act({ do: "sound", sound: "whoosh", volume: 0.4 }))] }) }),
  ];
  starters.push({ id: "starter-deck", name: "Card deck", hint: "For a set (a deck of cards): tap to draw a card. The stack shows how many are left (the app's value pieces).", doc: doc(layers, [v("pieces", 3, 0, 60)]) });
}

// ---- Live drawings for the first character's items (see js/showcase.js): they follow the app's
// item values (fill, qty), the GM's map (Global values party_x, party_y, goal_x, goal_y, 0 to 100) and the time.

// --- Backpack: the inside fills up as it's loaded (fill: 0 empty, 1 full).
{
  const layers = [
    shape({ shape: "rect", name: "Load", x: 128, y: 158, width: 150, height: 140, bindings: [bind("height", "140 * clamp(fill, 0, 1)", { x: 0.5, y: 1 })] }),
    shape({ shape: "rect", name: "Inside", x: 128, y: 158, width: 132, height: 128, modifiers: [T.createModifier("round", { radius: 18 }), T.createMaskModifier({ mode: "clip" })] }),
    shape({ shape: "rect", name: "Bag", x: 128, y: 158, width: 156, height: 152, modifiers: [T.createModifier("round", { radius: 26 }), ...outline(12)] }),
    shape({ shape: "rect", name: "Flap", x: 128, y: 92, width: 132, height: 44, modifiers: [T.createModifier("round", { radius: 14 }), ...outline(10)] }),
    shape({ shape: "ellipse", name: "Handle", x: 128, y: 52, width: 56, height: 40, params: { hole: 62 } }),
    shape({ shape: "rect", name: "Buckle", x: 128, y: 116, width: 26, height: 22 }),
  ];
  starters.push({ id: "starter-backpack", name: "Backpack", hint: "A container whose picture fills up as you load it (the app's value fill: 0 empty, 1 full).", doc: doc(layers, [v("fill", 0.4, 0, 1, 0.01)]) });
}

// --- Arrows: a quiver showing up to ten arrows, one for each in the stack (qty).
{
  const layers = [];
  const order = [4, 5, 3, 6, 2, 7, 1, 8, 0, 9]; // the middle ones first
  const pivot = { x: 128, y: 230 };
  const at = (deg, d) => ({ x: pivot.x + Math.sin(deg * Math.PI / 180) * d, y: pivot.y - Math.cos(deg * Math.PI / 180) * d });
  for (let k = 0; k < 10; k++) {
    const deg = -27 + k * 6, n = order.indexOf(k) + 1;
    const shaft = at(deg, 92), tip = at(deg, 190);
    layers.push(shape({ shape: "rect", name: `Arrow ${n}`, x: shaft.x, y: shaft.y, width: 6, height: 184, rotation: deg, bindings: [bind("visible", `qty >= ${n}`)] }));
    layers.push(shape({ shape: "polygon", name: `Head ${n}`, x: tip.x, y: tip.y, width: 18, height: 24, params: { sides: 3 }, rotation: deg, bindings: [bind("visible", `qty >= ${n}`)] }));
  }
  layers.push(shape({ shape: "rect", name: "Quiver", x: 128, y: 186, width: 92, height: 120, modifiers: [T.createModifier("round", { radius: 12 })] }));
  starters.push({ id: "starter-arrows", name: "Arrows", hint: "A stack's picture: one arrow for each in the stack, up to ten (the app's value qty).", doc: doc(layers, [v("qty", 6, 0, 20)]) });
}

// --- Rations: a pile of up to six bundles, one for each in the stack (qty).
{
  const spots = [[52, 206], [128, 206], [204, 206], [90, 146], [166, 146], [128, 86]];
  const layers = spots.map(([x, y], i) => shape({ shape: "rect", name: `Bundle ${i + 1}`, x, y, width: 70, height: 52,
    modifiers: [T.createModifier("round", { radius: 16 }), ...outline(9)], bindings: [bind("visible", `qty >= ${i + 1}`)] }));
  spots.forEach(([x, y], i) => layers.push(shape({ shape: "rect", name: `String ${i + 1}`, x, y, width: 7, height: 52, bindings: [bind("visible", `qty >= ${i + 1}`)] })));
  starters.push({ id: "starter-rations", name: "Rations", hint: "A stack's picture: one bundle for each in the stack, up to six (the app's value qty).", doc: doc(layers, [v("qty", 4, 0, 10)]) });
}

const MAP_VARS = () => [v("global_party_x", 30, 0, 100), v("global_party_y", 70, 0, 100), v("global_goal_x", 70, 0, 100), v("global_goal_y", 30, 0, 100)];

// --- Compass: the needle points from the party to the goal on the GM's map.
{
  const layers = [
    shape({ shape: "ellipse", name: "Case", x: 128, y: 128, width: 216, height: 216, modifiers: outline(14) }),
    shape({ shape: "polygon", name: "North", x: 128, y: 44, width: 22, height: 18, params: { sides: 3 } }),
    ...[90, 180, 270].map(a => shape({ shape: "rect", name: `Tick ${a}`, x: 128 + Math.sin(a * Math.PI / 180) * 86, y: 128 - Math.cos(a * Math.PI / 180) * 86,
      width: 6, height: 18, rotation: a })),
    group({ name: "Needle", x: 128, y: 128, children: [
      shape({ shape: "polygon", name: "Point", x: 0, y: -40, width: 30, height: 80, params: { sides: 3 } }),
      shape({ shape: "polygon", name: "Tail", x: 0, y: 40, width: 30, height: 80, params: { sides: 3 }, flipY: true, modifiers: outline(6) }),
    ], bindings: [bind("rotation", "deg(atan2(global_goal_x - global_party_x, global_party_y - global_goal_y))")] }),
    shape({ shape: "ellipse", name: "Pin", x: 128, y: 128, width: 18, height: 18 }),
  ];
  starters.push({ id: "starter-compass", name: "Compass", hint: "Points from the party to the goal on the GM's map: Global values party_x, party_y and goal_x, goal_y (a board's pins set them).", doc: doc(layers, MAP_VARS()) });
}

// --- Totem: wiggles (and glows) when the party is near the goal on the GM's map.
{
  const near = "(hypot(global_goal_x - global_party_x, global_goal_y - global_party_y) < 15)";
  const totem = group({ name: "Totem", x: 128, y: 128, children: [
    shape({ shape: "ellipse", name: "Head", x: 0, y: -62, width: 92, height: 80, modifiers: outline(10) }),
    shape({ shape: "ellipse", name: "Left eye", x: -18, y: -68, width: 16, height: 16 }),
    shape({ shape: "ellipse", name: "Right eye", x: 18, y: -68, width: 16, height: 16 }),
    shape({ shape: "polygon", name: "Beak", x: 0, y: -44, width: 20, height: 18, params: { sides: 3 }, flipY: true }),
    shape({ shape: "polygon", name: "Left wing", x: -70, y: 0, width: 56, height: 40, params: { sides: 3 }, rotation: -90 }),
    shape({ shape: "polygon", name: "Right wing", x: 70, y: 0, width: 56, height: 40, params: { sides: 3 }, rotation: 90 }),
    shape({ shape: "rect", name: "Body", x: 0, y: 30, width: 64, height: 110, modifiers: [T.createModifier("round", { radius: 8 }), ...outline(10)] }),
    shape({ shape: "rect", name: "Band", x: 0, y: 30, width: 64, height: 10 }),
    shape({ shape: "rect", name: "Base", x: 0, y: 96, width: 116, height: 22 }),
  ], bindings: [bind("rotation", `${near} * 9 * sin(t * 14)`, { x: 0.5, y: 1 })] });
  const layers = [
    shape({ shape: "ellipse", name: "Glow", x: 128, y: 128, width: 236, height: 236, opacity: 0.18, bindings: [bind("visible", near)] }),
    totem,
  ];
  starters.push({ id: "starter-totem", name: "Totem", hint: "Wiggles and glows when the party is near the goal on the GM's map (Global values party_x, party_y, goal_x, goal_y: within 15).", doc: doc(layers, MAP_VARS()) });
}

// --- Pocket watch: the real time, with a second hand.
{
  const hand = (name, w, len, expr) => shape({ shape: "rect", name, x: 128, y: 144 - len / 2, width: w, height: len, bindings: [bind("rotation", expr, { x: 0.5, y: 1 })] });
  const layers = [
    shape({ shape: "ellipse", name: "Bow", x: 128, y: 20, width: 40, height: 30, params: { hole: 55 } }),
    shape({ shape: "rect", name: "Crown", x: 128, y: 40, width: 26, height: 18, modifiers: [T.createModifier("round", { radius: 4 })] }),
    shape({ shape: "ellipse", name: "Case", x: 128, y: 144, width: 196, height: 196, modifiers: outline(14) }),
    ...Array.from({ length: 12 }, (_, i) => shape({ shape: "rect", name: `Hour ${i || 12}`, x: 128 + Math.sin(i * Math.PI / 6) * 74, y: 144 - Math.cos(i * Math.PI / 6) * 74,
      width: i % 3 ? 4 : 8, height: i % 3 ? 10 : 16, rotation: i * 30 })),
    hand("Hour hand", 10, 50, "(hours12 + minutes / 60) * 30"),
    hand("Minute hand", 7, 72, "(minutes + seconds / 60) * 6"),
    hand("Second hand", 3, 78, "seconds * 6"),
    shape({ shape: "ellipse", name: "Pin", x: 128, y: 144, width: 16, height: 16 }),
  ];
  starters.push({ id: "starter-watch", name: "Pocket watch", hint: "Keeps the real time: its hands follow the clock (hours12, minutes, seconds).", doc: doc(layers) });
}

const out = `// Generated by tools/build_starters.mjs (svg-lay-tool documents): interactive drawings to start
// from, offered in Catalog → Drawings and the icon editor's Start from…. Rebuild it rather than editing.
const STARTER_DRAWINGS = ${JSON.stringify(starters.map(s => ({ ...s, doc: T.normalizeDocument(s.doc) })))};
`;
writeFileSync(join(here, "..", "js", "starter-drawings.js"), out);
console.log(`Wrote js/starter-drawings.js: ${starters.map(s => s.name).join(", ")} (${Math.round(out.length / 1024)} KB)`);
