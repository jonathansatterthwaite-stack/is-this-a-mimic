// The item menu: press and hold an item's tile or row and a ring of what can be done with it opens
// around it (Details among them). Slide to an option and let go to choose it; let go in the middle,
// or outside, to cancel. A tap is still its details. + and − (when it counts up and down) are always
// straight above and below; the rest share the sides (only the side away from the edge, at an edge).
// With a mouse or the keyboard, the context menu (right-click, the menu key) opens it to click.
//
// A list (a storage: see storageTree) gives the options: menu(e) for its own, else the buttons its
// extras(e) would show; and setQty / canCount for − and +.

const RADIAL_PRESS_MS = 260;   // a press this long, without moving, opens the menu
const RADIAL_SLOP = 10;        // moving further first is a scroll or a drag instead

let radialOpen = null;         // the menu showing: { root, close, ... }

// An item's options: [{ icon, label, run, danger }], and whether it counts (− / +).
function entryMenu(st, e) {
  const side = [{ icon: "eye", label: "Details", run: () => st.open(e) }, ...(st.menu ? st.menu(e) : menuFromButtons(st.extras?.(e)))];
  // − and +: for what stacks (or is more than one), where it can be counted now.
  const counts = !!st.setQty && (st.canCount?.(e) ?? true) && (e.qty > 1 || stacks(currentItem(e, st.char), e.srcId));
  // (From the count as it is when chosen: the app may have redrawn since the menu opened.)
  const now = () => st.current?.(e) || st.char.items.find(x => x.uid === e.uid) || e;
  return {
    side: side.filter(Boolean),
    plus: counts && { icon: "plus", label: "Add one", run: () => { const x = now(); st.setQty(x, x.qty + 1); } },
    minus: counts && { icon: "minus", label: e.qty > 1 ? "Use one" : "Use the last one", run: () => { const x = now(); st.setQty(x, x.qty - 1); } },
  };
}

// A list's extra buttons as menu options (their own icon and label; choosing one clicks it).
function menuFromButtons(...els) {
  return els.flat(Infinity).filter(b => b instanceof HTMLElement && b.matches("button"))
    .map(b => ({ icon: b.querySelector("svg")?.cloneNode(true) || "more", label: b.getAttribute("aria-label") || b.title || b.textContent.trim(), run: () => b.click() }));
}

// Press-and-hold (touch and pen) and the context menu (mouse, keyboard) on an item's tile or row.
// el: what's pressed; target: what the ring goes round (the tile, or the row at the press).
function attachItemMenu(el, st, e) {
  const options = () => entryMenu(st, e);
  el.addEventListener("pointerdown", ev => {
    if (ev.pointerType === "mouse" || !ev.isPrimary || radialOpen) return;
    // Not from the row's own controls (− / +, the number, buttons): those work as they are.
    if (ev.target.closest("input, select, textarea, a, .qty, .icon-btn, .cw-cog, .btn") && !ev.target.closest(".row-main")) return;
    const id = ev.pointerId, x0 = ev.clientX, y0 = ev.clientY;
    let timer = setTimeout(() => {
      timer = null;
      openRadial(el, options(), { x: x0, y: y0, row: !el.classList.contains("tile"), drag: true });
    }, RADIAL_PRESS_MS);
    const move = m => {
      if (m.pointerId !== id) return;
      if (timer && Math.hypot(m.clientX - x0, m.clientY - y0) > RADIAL_SLOP) done();
      else radialOpen?.track(m.clientX, m.clientY);
    };
    const up = u => {
      if (u.pointerId !== id) return;
      if (radialOpen?.drag) { radialOpen.release(u.clientX, u.clientY); swallowClick(el); }
      done();
    };
    const cancel = c => { if (c.pointerId === id) { radialOpen?.drag && radialOpen.close(); done(); } };
    const done = () => {
      clearTimeout(timer); timer = null;
      removeEventListener("pointermove", move); removeEventListener("pointerup", up); removeEventListener("pointercancel", cancel);
    };
    addEventListener("pointermove", move); addEventListener("pointerup", up); addEventListener("pointercancel", cancel);
  });
  el.addEventListener("contextmenu", ev => {
    ev.preventDefault();
    if (radialOpen) return; // (a touch press already opened it; phones also send this)
    const keyboard = !ev.clientX && !ev.clientY;
    openRadial(el, options(), { x: keyboard ? null : ev.clientX, y: keyboard ? null : ev.clientY, row: !el.classList.contains("tile"), drag: false });
  });
  // Dragging (to move it between containers) doesn't start from a press that opened the menu.
  el.addEventListener("dragstart", ev => { if (radialOpen) ev.preventDefault(); });
}

// The click a press-and-release sends to the tile or row (its details) is the menu's, not theirs.
function swallowClick(el) {
  const stop = ev => { if (!el.contains(ev.target)) return; ev.stopPropagation(); ev.preventDefault(); off(); };
  const off = () => removeEventListener("click", stop, { capture: true });
  addEventListener("click", stop, { capture: true });
  setTimeout(off, 400);
}

// While the menu follows a finger, the page doesn't scroll.
addEventListener("touchmove", ev => { if (radialOpen?.drag) ev.preventDefault(); }, { passive: false });

// Where each option goes: + above and − below; the rest spaced evenly round the free arcs (the sides
// between − and +, or the whole circle), keeping to the screen. Neighbours are always at least GAP
// apart: each arc takes only as many as fit (shared out by how many each holds), and the ring grows
// when they don't. Near the edge of the screen an arc stops short of it by half a gap, so the two
// options either side of the part that's off screen are a gap apart too.
function radialLayout(cx, cy, n, counts) {
  const W = innerWidth, H = innerHeight, deg = Math.PI / 180, edge = 28, GAP = 60, TAU = 2 * Math.PI;
  const onScreen = (a, r) => { const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r; return x > edge && x < W - edge && y > edge && y < H - edge; };
  const apart = (a, b) => { const d = Math.abs(a - b) % TAU; return Math.min(d, TAU - d); };
  const at = i => (i - 90) * deg; // whole degrees, from the top
  let r = Math.max(84, GAP * (n + (counts ? 2 : 0)) / TAU), result;
  const cy0 = cy;
  for (;;) {
    // With − and +, the ring moves up or down (off the item's middle) as far as it must to keep them on screen.
    if (counts) cy = Math.min(Math.max(cy0, edge + 26 + r), Math.max(edge + 26 + r, H - edge - 26 - r));
    const g = 2 * Math.asin(Math.min(1, GAP / (2 * r))), half = Math.ceil(g / 2 / deg);
    const seen = [...Array(360)].map((_, i) => onScreen(at(i), r));
    const free = seen.map((_, i) => {
      for (let j = -half; j <= half; j++) if (!seen[(i + j + 360) % 360]) return false;
      return !counts || (apart(at(i), -90 * deg) >= g - 1e-6 && apart(at(i), 90 * deg) >= g - 1e-6);
    });
    // The free arcs: [first, last] in degrees (one may wrap past the top), or the whole circle.
    let arcs;
    if (free.every(Boolean)) arcs = [{ whole: true }];
    else {
      arcs = [];
      const s0 = free.indexOf(false);
      let run = null;
      for (let j = 1; j <= 360; j++) {
        const i = s0 + j;
        if (free[i % 360]) run = run ? [run[0], i] : [i, i];
        else if (run) { arcs.push({ a0: at(run[0]), a1: at(run[1]) }); run = null; }
      }
    }
    for (const arc of arcs) arc.cap = arc.whole ? Math.floor(TAU / g + 1e-9) : Math.floor((arc.a1 - arc.a0) / g + 1e-9) + 1;
    const cap = arcs.reduce((s, x) => s + x.cap, 0);
    if (cap >= n || r >= 170) {
      // Shared out by how many each holds (the largest remainders first), never over (unless nowhere fits).
      const k = arcs.map(x => Math.floor(n * x.cap / Math.max(1, cap)));
      let left = n - k.reduce((s, x) => s + x, 0);
      const frac = i => (n * arcs[i].cap / Math.max(1, cap)) % 1;
      const order = arcs.map((x, i) => i).sort((i, j) => frac(j) - frac(i));
      for (let pass = 0; pass < 2 && left > 0; pass++)
        for (const i of order) if (left > 0 && (k[i] < arcs[i].cap || (pass && cap < n))) { k[i]++; left--; }
      const angles = [];
      arcs.forEach((arc, i) => {
        for (let j = 0; j < k[i]; j++) angles.push(arc.whole ? -90 * deg + TAU * j / k[i]
          : k[i] === 1 ? (arc.a0 + arc.a1) / 2 : arc.a0 + (arc.a1 - arc.a0) * j / (k[i] - 1));
      });
      while (angles.length < n) angles.push(-90 * deg + TAU * angles.length / n); // (nothing free at all)
      // Round the ring from the top, so the options keep their order clockwise.
      const fromTop = a => ((a + 90 * deg) % TAU + TAU) % TAU;
      angles.sort((x, y) => fromTop(x) - fromTop(y));
      result = { r, cx, cy, side: angles.map(a => [cx + Math.cos(a) * r, cy + Math.sin(a) * r]), plus: [cx, cy - r], minus: [cx, cy + r] };
      break;
    }
    r += 8;
  }
  return result;
}

// Open the menu round el. o: { x, y } (where it was pressed; else el's middle), row (centred on the
// press, along the row), drag (following a finger; else to click).
function openRadial(el, menu, o = {}) {
  radialOpen?.close();
  const box = el.getBoundingClientRect();
  const cx = o.row && o.x != null ? Math.min(Math.max(o.x, box.left + 40), box.right - 40) : box.left + box.width / 2;
  let cy = box.top + box.height / 2;
  const opts = [...menu.side];
  const lay = radialLayout(cx, cy, opts.length, !!menu.plus);
  const px = cx, py = cy; // where it was pressed (letting go there, too, does nothing)
  cy = lay.cy;
  const all = opts.map((op, i) => ({ ...op, pos: lay.side[i] }));
  if (menu.plus) all.push({ ...menu.plus, pos: lay.plus }, { ...menu.minus, pos: lay.minus });

  const root = h("div", { class: "radial" + (o.drag ? " following" : ""), role: "menu", "aria-label": `${el.getAttribute("aria-label") || "Item"}: what to do` });
  const lift = h("div", { class: "radial-lift" });
  Object.assign(lift.style, { left: box.left + "px", top: box.top + "px", width: box.width + "px", height: box.height + "px" });
  // The middle: letting go there does nothing; it names the option under the finger.
  const label = h("button", { type: "button", class: "radial-label", "aria-label": "Close the menu", onclick: () => close(true) }, "Close");
  label.style.left = cx + "px"; label.style.top = cy + "px";
  const trail = h("div", { class: "radial-trail" });
  const btns = all.map(op => {
    const b = h("button", { type: "button", class: "radial-opt" + (op.danger ? " danger" : ""), role: "menuitem", "aria-label": op.label, title: op.label,
      onclick: () => choose(op), onpointerenter: () => !o.drag && hot(op), onfocus: () => hot(op) },
      typeof op.icon === "string" ? icon(op.icon) : op.icon);
    b.style.left = op.pos[0] + "px"; b.style.top = op.pos[1] + "px";
    op.el = b;
    return b;
  });
  root.append(lift, trail, ...btns, label);
  root.addEventListener("pointerdown", ev => { if (!o.drag && ev.target === root) close(true); });
  document.body.append(root);
  requestAnimationFrame(() => root.classList.add("shown"));
  if (o.drag && navigator.vibrate) try { navigator.vibrate(8); } catch {}

  let current = null;
  function hot(op) {
    current = op;
    for (const x of all) x.el.classList.toggle("hot", x === op);
    label.textContent = op ? op.label : o.drag ? "Let go here: cancel" : "Close";
    if (op) {
      const [x, y] = op.pos, len = Math.hypot(x - cx, y - cy) - 30;
      Object.assign(trail.style, { left: cx + "px", top: cy + "px", width: Math.max(0, len) + "px", transform: `rotate(${Math.atan2(y - cy, x - cx)}rad)`, display: "block" });
    } else trail.style.display = "none";
  }
  hot(null);
  // Following a finger: the option nearest it (within reach), the middle, or nothing (outside).
  function track(x, y) {
    const d = Math.hypot(x - cx, y - cy);
    if (d < 34 || Math.hypot(x - px, y - py) < 34 || d > lay.r + 60) return hot(null); // the middle (or the press), or outside: nothing
    let best = null, bd = Infinity;
    for (const op of all) { const dd = Math.hypot(x - op.pos[0], y - op.pos[1]); if (dd < bd) { bd = dd; best = op; } }
    hot(bd < 52 || d > lay.r * 0.55 ? best : null);
  }
  function release(x, y) { track(x, y); choose(current); }
  function choose(op) {
    close();
    op?.run?.();
  }
  const onKey = ev => {
    if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); close(true); return; }
    // Arrows go round the ring (and the middle, Close).
    if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(ev.key)) {
      ev.preventDefault();
      const list = [label, ...btns], i = list.indexOf(document.activeElement);
      list[(i + (ev.key === "ArrowRight" || ev.key === "ArrowDown" ? 1 : list.length - 1)) % list.length].focus();
    }
  };
  document.addEventListener("keydown", onKey, true);
  // Scrolling or resizing (a phone turned) leaves it where it was: close it.
  const onScroll = () => close();
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onScroll);
  // refocus: closed without choosing (Escape, the middle, outside), so the keyboard goes back to the item.
  function close(refocus = false) {
    if (radialOpen !== api) return;
    radialOpen = null;
    document.removeEventListener("keydown", onKey, true);
    removeEventListener("scroll", onScroll);
    removeEventListener("resize", onScroll);
    root.remove();
    if (refocus && !o.drag && el.isConnected) (el.matches("button") ? el : el.querySelector(".row-main"))?.focus({ preventScroll: true });
  }
  const api = { root, close, track, release, drag: !!o.drag };
  radialOpen = api;
  if (!o.drag) (btns[0] || label).focus({ preventScroll: true });
  return api;
}

// ------------------------------------------------------------------ this device's inventory's options

// What can be done with one of this device's inventory items, around the ring (− and + aside).
function inventoryMenu(e) {
  const char = store.char();
  return [
    // An interactive drawing: straight to the picture, to use it.
    drawingIsInteractive(currentItem(e, char)?.iconDoc) && { icon: "image", label: "Use", run: () => openEntry(e.uid, { use: true }) },
    ...menuFromButtons(writingButton(e)),
    isEquipable(e) && { icon: equipKind(e) === "wielded" ? "sword" : "shield", label: e.equipped ? "Unequip" : "Equip", run: () => toggleEquip(e.uid) },
    // The player's states (Attuned…), unless only the GM can change them now.
    ...statesFor(e).filter(s => s.who === "player" && (canPlayerSet(char, e, s.key) || isGmDevice())).map(s => {
      const on = stateOn(char, e, s.key);
      return { icon: "wand", label: `${s.label}: turn ${on ? "off" : "on"}`, run: () => {
        const c = store.char(), x = c?.items.find(i => i.uid === e.uid);
        if (x) playerSetState(e.uid, s.key, !stateOn(c, x, s.key));
      } };
    }),
    // The item's own actions (a container's: its words, its effect).
    ...itemActions(currentItem(e, char)).map((a, i) => ({ icon: a.effect === "fill" ? "plus" : a.effect === "random" ? "dice" : "bag", label: a.label, run: () => runItemAction(e.uid, i) })),
    editing() && { icon: "edit", label: "Edit", run: () => openItemForm(e.item, { entryUid: e.uid }) },
    { icon: "move", label: "Move to…", run: () => openMoveTo(e.uid) },
    !e.purse && { icon: "coins", label: "Sell", run: () => openSell(e.uid) },
    !e.purse && party.active && party.others().length > 0 && { icon: "users", label: "Trade", run: () => openTradeBuilder(null, e.uid) },
    party.active && { icon: "eye", label: "Show…", run: () => openShowItem(e.uid) },
    !e.purse && { icon: "trash", label: discarding(char) ? "Discard" : "Remove", danger: true, run: () => confirmRemoveEntry(e.uid) },
  ].filter(Boolean);
}

// Move to…: where it goes (on person, into a container, strapped to one), as a list to tap.
function openMoveTo(entryUid) {
  const char = store.char(), e = char.items.find(x => x.uid === entryUid);
  if (!e) return;
  const here = locationValue(e);
  let close;
  const rows = containerOptions(char, e.uid).map(opt => {
    const value = opt.value, current = value === here;
    return h("button", { type: "button", class: "row row-main switch" + (current ? " equipped" : ""), disabled: current,
      onclick: () => { close(); const loc = parseLocation(value); moveEntry(e.uid, loc.parent, loc.compartment); } },
      icon(value ? (value.endsWith(":c:" + OUTSIDE) ? "link" : "bag") : "user"),
      h("div", null, h("div", { class: "row-title" }, opt.textContent), current && h("div", { class: "row-sub" }, "Where it is now")));
  });
  close = openModal(`Move ${entryName(e)}`, h("div", { class: "group move-to" }, rows));
}

// In a party, a character's items are discarded (to the GM) rather than removed (js/party-ui.js).
const discarding = char => party.active && !!char && party.isLinked(char.id);

// Removing an item asks first (Undo still works after).
function confirmRemoveEntry(entryUid, after) {
  const char = store.char(), e = char?.items.find(x => x.uid === entryUid);
  if (!e) return;
  if (e.purse) return toast("The coin purse stays (move its coins elsewhere instead)");
  if (discarding(char)) return discardEntry(entryUid, after);
  const name = entryName(e) + (e.qty > 1 ? ` (×${e.qty.toLocaleString()})` : "");
  const inside = holdsItems(char, e) && char.items.some(x => x.parent === e.uid);
  confirmDialog(`Remove ${name} from ${char.name}'s inventory?${inside ? " What's in it stays where it was." : ""}`, "Remove", () => {
    after?.();
    commit((s, c) => removeEntry(c, e.uid), `Removed ${entryName(e)}`, true);
  });
}
