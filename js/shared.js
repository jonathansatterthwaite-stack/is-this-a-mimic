// Shared screens (docs/gm-puzzles-plan.md, step 1; the mock-up is mockups/shared-screens.html):
// what a device shows to others in a party. An item (party.shares, kind "item": js/party-ui.js), a
// trade (kind "trade", a live trade window: js/party-ui.js), a GM's panel (kind "panel": see Panels
// below, and js/control-panels.js) and treasure (party.treasure, with its own calls: js/treasure.js). Each
// opens once by itself for those it's shared with; on a wide screen it docks beside the view, on a
// phone it fills the screen. Minimised (its — or closing it) it waits in the Shared tray: the top
// bar's Shared button and, on a phone, chips above the tabs. It stays until whoever shared it ends it.

// Who on this device an item share is for: its characters it's shared with, and "gm" (shared with
// the GM, on a GM's device).
const shareViewers = s => [...(s.to || []).filter(id => party.isLinked(id)), ...(s.gm && party.isGm() ? ["gm"] : [])];
// Opened here: seen, for each of its viewers on this device (once each: a screen redraws often).
const seenSent = new Set();
function markShareSeen(s) {
  for (const w of shareViewers(s)) {
    if ((s.seen || []).includes(w) || seenSent.has(s.id + "|" + w)) continue;
    seenSent.add(s.id + "|" + w);
    party.api("POST", `api/share/${s.id}/seen`, { character: w }).catch(() => seenSent.delete(s.id + "|" + w));
  }
}

// Everything shared that this device takes part in, newest first:
// [{ id, kind, title, fromName, mine (this device shared it), fresh (not opened yet), share | treasure }]
function sharedList() {
  if (!party.active) return [];
  const out = [];
  for (const s of party.shares || []) {
    const viewers = shareViewers(s);
    if (!viewers.length && !s.fromMine) continue;
    const trade = s.kind === "trade";
    out.push({ id: "share:" + s.id, kind: s.kind || "item", title: trade ? `Trade: ${s.fromName} ⇄ ${s.withName}` : s.kind === "item" || !s.kind ? entryName(s.item) : s.title || "Shared",
      fromName: s.fromName, mine: !!s.fromMine && !viewers.length, at: s.at, share: s,
      // (a trade: also when it's changed since this device last had it open)
      fresh: viewers.some(w => !(s.seen || []).includes(w)) || (trade && tradeSeen.has(s.id) && tradeSeen.get(s.id) !== tradeSig(s)) });
  }
  for (const t of typeof showings === "function" ? showings() : []) {
    const forMe = t.players.some(id => party.isLinked(id)), mine = isGmDevice() && !forMe;
    if (!forMe && !mine) continue;
    out.push({ id: "treasure:" + t.id, kind: "treasure", title: t.name, fromName: `The ${term("gm")}`, mine, at: t.at || 0, treasure: t,
      fresh: forMe && t.status === "picking" && !treasureSeen.has(t.id) });
  }
  return out.sort((a, b) => (b.at || 0) - (a.at || 0));
}

const SHARE_KINDS = { item: ["Item", "eye"], treasure: ["Treasure", "coins"], trade: ["Trade", "move"], panel: ["Panel", "grid"] };
// What a share says about itself in the tray: "Item · Bramble", "Item · shown to Thistle".
function sharedSub(x) {
  const [kind] = SHARE_KINDS[x.kind] || ["Shared"];
  if (x.kind === "trade") return `${kind} · with ${x.mine ? x.share.withName : x.fromName}`;
  if (!x.mine) return `${kind} · ${x.fromName}`;
  if (x.share) return `${kind} · shown to ${[...x.share.to.map(id => party.chars.find(c => c.id === id)?.name || "someone"), x.share.gm && `the ${term("gm")}`].filter(Boolean).join(", ")}`;
  return `${kind} · yours`;
}

// The shared screen open now (one at a time): { id, close }.
let sharedOpen = null;
const sharedIsOpen = id => !!sharedOpen && sharedOpen.id === id && sharedOpen.close.panel?.isConnected;

// Open a share's screen (or, for the GM's own treasure, the Treasure tab, where it's settled).
function openShared(x) {
  if (x.kind === "treasure") {
    if (x.mine) { go("treasure"); return; } // (the Items tab's Treasure, where it's settled)
    return openTreasurePopup(x.treasure.id);
  }
  if (x.kind === "item") return openItemShare(x.share);
  if (x.kind === "trade") return openTradeShare(x.share);
  if (x.kind === "panel") {
    if (x.mine) { ui.gmTab = "controls"; ui.gmControlsTab = "panels"; go("gm"); return; } // (the GM's own: on its card)
    return openPanelShare(x.share);
  }
}

// A shared screen: docked on a wide screen, a window filling a phone's screen. Its — (and ×)
// minimise it to the tray; footer: its own buttons; redraw: called as the party changes (not
// while something in it is being typed in). Returns close (close.panel: the screen).
// targets(e): where an item at hand can go on it ([{ label, run }]: see openAtHandItem); while it
// covers the top bar (not docked), its header has an At hand button.
function sharedScreen(id, title, body, { footer = null, head = null, redraw = null, targets = null } = {}) {
  if (sharedOpen && sharedOpen.id !== id && sharedOpen.close.panel?.isConnected) sharedOpen.close(); // (one at a time: the other waits in the tray)
  const handBtn = targets && !wideLayout() ? iconBtn("star", "At hand", () => atHandOpen ? closeAtHand() : openAtHand()) : null;
  if (handBtn) handBtn.classList.add("at-hand-open");
  const close = openModal(title, body, { wide: true, dock: true, minimise: true, footer, head: handBtn ? [handBtn, head].filter(Boolean) : head,
    onClose: () => { if (sharedOpen?.close === close) { sharedOpen = null; setTimeout(render); } } });
  close.panel.classList.add("shared-screen");
  sharedOpen = { id, close, redraw, targets };
  setTimeout(render); // (the tray and its chips)
  return close;
}

// End something this device shared (an item; treasure is ended in the Treasure tab).
async function endShare(s) {
  try { await party.api("DELETE", `api/share/${s.id}`); if (s.kind !== "trade") toast(`Stopped showing ${s.kind === "item" ? entryName(s.item) : s.title || "it"}`); }
  catch (e) { toast(e.message); }
}

// ------------------------------------------------------------------ the tray

// The top bar's Shared button: how many, marked while something new waits.
function drawSharedButton() {
  const btn = document.getElementById("shared-btn");
  if (!btn) return;
  const list = sharedList();
  btn.hidden = !list.length;
  if (!list.length) return;
  btn.classList.toggle("fresh", list.some(x => x.fresh && !sharedIsOpen(x.id)));
  btn.setAttribute("aria-label", `Shared: ${list.length}`);
  btn.title = "What's shared with you, and what you're sharing";
  setChildren(btn, icon("eye"), h("span", { class: "mode-word" }, "Shared"), h("span", { class: "shared-n" }, String(list.length)));
  btn.onclick = openSharedTray;
}

function openSharedTray() {
  const list = sharedList();
  let close;
  const row = x => h("div", { class: "row shared-row" + (x.fresh ? " fresh" : "") + (sharedIsOpen(x.id) ? " on" : "") },
    h("button", { type: "button", class: "row-main", onclick: () => { close(); openShared(x); } },
      h("span", { class: `shared-kind k-${x.kind}` }, icon((SHARE_KINDS[x.kind] || [])[1] || "eye")),
      h("span", { class: "grow" }, h("span", { class: "row-sub" }, sharedSub(x)), h("span", { class: "row-title" }, x.title)),
      x.fresh && h("span", { class: "tag on" }, "new")),
    x.mine && x.share && h("button", { class: "btn", onclick: () => { close(); endShare(x.share); } }, x.kind === "trade" ? "Walk away" : "End"));
  const withMe = list.filter(x => !x.mine), mine = list.filter(x => x.mine);
  close = openModal("Shared", h("div", { class: "shared-tray" },
    withMe.length > 0 && [h("h4", null, "Shared with you"), h("div", { class: "group" }, withMe.map(row))],
    mine.length > 0 && [h("h4", null, "Yours"), h("div", { class: "group" }, mine.map(row))],
    !list.length && h("p", { class: "muted" }, "Nothing's shared right now."),
    h("p", { class: "muted small" }, "Anything shown to you waits here until whoever showed it ends it. Close one (—) and it comes back here.")));
}

// On a phone: chips above the tabs for what's shared (not the one open).
function drawSharedChips() {
  const box = document.getElementById("shared-chips");
  if (!box) return;
  const list = wideLayout() ? [] : sharedList().filter(x => !sharedIsOpen(x.id));
  box.hidden = !list.length;
  document.body.classList.toggle("has-shared-chips", list.length > 0);
  setChildren(box, list.map(x => h("button", { type: "button", class: "shared-chip" + (x.fresh ? " fresh" : ""), title: sharedSub(x), onclick: () => openShared(x) },
    h("span", { class: `shared-kind k-${x.kind}` }, icon((SHARE_KINDS[x.kind] || [])[1] || "eye")), h("span", null, x.title))));
}

// May something new open by itself now? Not in place of a shared screen open now, nor of anything
// else docked (an item's details, the rule editor: it would be lost) or, on a phone, over another
// window. Otherwise it waits in the tray (the Shared button glows).
function sharedMayOpen() {
  if (sharedOpen && sharedOpen.close.panel?.isConnected) return false;
  if (wideLayout()) return !document.getElementById("dock")?.children.length;
  return !document.querySelector("#modal-root .overlay");
}
// Called on every render: the button and chips; something new opens once by itself (sharedMayOpen).
const sharedAuto = new Set();
function syncShared() {
  // Ended by whoever shared it (or left): its screen goes too. (Treasure's says what arrived itself.)
  if (sharedOpen?.id.startsWith("share:") && sharedOpen.close.panel?.isConnected && !sharedList().some(x => x.id === sharedOpen.id)) {
    const wasTrade = sharedOpen.close.panel.querySelector(".trade-live");
    sharedOpen.close();
    if (!wasTrade) toast("That's no longer being shown"); // (a trade says how it went: js/party.js)
  } else if (sharedOpen?.redraw && sharedOpen.close.panel?.isConnected) {
    const typing = document.activeElement?.matches?.("input, textarea") && sharedOpen.close.panel.contains(document.activeElement);
    if (!typing) sharedOpen.redraw();
  }
  drawSharedButton();
  drawSharedChips();
  drawAtHandTab();
  if (!party.active) return;
  takePanelUses(); sendPanelChanges(); keepSharedPending();
  const next = sharedList().find(x => x.fresh && !x.mine && (x.kind === "item" || x.kind === "trade" || x.kind === "panel") && !sharedAuto.has(x.id));
  if (!next || !sharedMayOpen()) return;
  sharedAuto.add(next.id);
  openShared(next);
}

// ------------------------------------------------------------------ panels
// A GM's panel shown to players (js/control-panels.js: openShowPanel). On a player's device it's a
// shared screen: the panel, used as on the GM's (hidden controls gone, locked ones greyed); each
// change and use goes to the host (sharedPanelSet, sharedPanelUse), and the GM's device that showed
// it makes them, as the GM, and runs the controls' rules (takePanelUses). That device also sends
// the panel again when it's changed (sendPanelChanges).

// The character of this device's a panel's shown to (who its uses are by).
const panelShareChar = s => (s.to || []).find(id => party.isLinked(id)) || null;

function openPanelShare(s0) {
  const id = "share:" + s0.id, box = h("div", { class: "shared-panel" });
  let targets = () => [];
  const draw = () => {
    const s = (party.shares || []).find(x => x.id === s0.id);
    if (!s) return;
    markShareSeen(s);
    const panel = { ...s.panel, sharedId: s.id, sharedChar: panelShareChar(s) };
    const me = store.state.characters.find(c => c.id === panel.sharedChar);
    // Where something at hand can go: an empty socket that can be used.
    const sockets = e => (panel.controls || []).filter(c => c.type === "socket" && controlShown(c) && !controlLocked(c) && !socketHeld(panel, c)?.items?.length && showing(panel, c))
      .map(c => ({ label: `Put it in ${controlName(c)}`, run: async () => {
        try { await party.put(me.id); await party.api("POST", `api/share/${s.id}/socket`, { character: me.id, control: c.id, uid: e.uid }); } catch (err) { toast(err.message); }
      } }));
    setChildren(box, !controlShown(panel) ? h("p", { class: "muted pad" }, "Not here right now.")
      : panelGrid(panel, false),
      panelLook(panel).notes && h("p", { class: "muted small" }, `What you do here goes to the ${term("gm")}'s device, which makes it happen.`));
    close?.panel?.classList.toggle("no-title", !panelLook(panel).title); // (its look: no name on the window)
    targets = e => me && isAtHand(me, e) ? sockets(e) : [];
  };
  let close = null;
  close = sharedScreen(id, s0.title || "Panel", box, { redraw: draw, targets: e => targets(e) });
  draw();
  return close;
}

// A use of a shown panel's control (its rules run on the GM's device).
function sharedPanelUse(panel, use) {
  return party.api("POST", `api/share/${panel.sharedId}/use`, { character: panel.sharedChar, ...use }).catch(e => toast(e.message));
}
// One of its values set (name, as the control names it; scope/target, where it's kept): it shows at
// once here (a preview), and the promise settles once the GM's device has made it (or after a while).
const sharedPending = []; // [{ scope, target, key, value, done, until }]
function sharedPanelSet(panel, ctlId, name, value, scope, target) {
  const plain = String(name).replace(/^(global|local|gm)_/, "");
  return sharedPanelUse(panel, { type: "set", control: ctlId, name, value }).then(() => new Promise(done => {
    sharedPending.push({ scope, target, key: valueKey(plain), value, done, until: Date.now() + 4000 });
    keepSharedPending();
  }));
}
// The values waiting to be made: each, once the party has it (or it's waited long enough), is done.
// (Checked on every render, and every 300 ms while any wait: one timer.)
let sharedPendingTimer = null;
function keepSharedPending() {
  clearTimeout(sharedPendingTimer);
  sharedPendingTimer = null;
  for (let i = sharedPending.length - 1; i >= 0; i--) {
    const p = sharedPending[i], g = party.gm || {};
    const bucket = p.scope === "party" ? g.party : p.scope === "item" ? g.items?.[p.target] : g.characters?.[p.target];
    const has = bucket && p.key in bucket && Math.abs(valueNow(bucket[p.key]) - p.value) < 1e-9;
    if (has || Date.now() > p.until) { sharedPending.splice(i, 1); p.done(); }
  }
  if (sharedPending.length) sharedPendingTimer = setTimeout(keepSharedPending, 300);
}

// On the GM's device that showed a panel: its players' uses, made in order, as the GM (only what a
// control sets; nothing from a hidden or locked control), each then taken off the host's queue.
const panelUsesTaken = new Set();
let panelUsesQueue = Promise.resolve();
const panelUseLog = new Map(); // panelId -> ["Thistle used Bell", …] (the card shows the last few)
function takePanelUses() {
  for (const s of party.shares || []) {
    if (s.kind !== "panel" || !s.fromMine) continue;
    for (const u of s.uses || []) {
      if (panelUsesTaken.has(u.id)) continue;
      panelUsesTaken.add(u.id);
      panelUsesQueue = panelUsesQueue.then(() => makePanelUse(s, u)).catch(() => {});
    }
  }
}
async function makePanelUse(s, u) {
  const panel = gmControls().find(p => p.id === s.panelId), ctl = panel?.controls?.find(c => c.id === u.control);
  const who = party.chars.find(c => c.id === u.character)?.name || "A player";
  const log = text => { const l = panelUseLog.get(panel.id) || []; l.push(text); panelUseLog.set(panel.id, l.slice(-10)); };
  // (real, even while this device practises with a panel's preview: clockwork.practice.outside)
  const real = fn => clockwork.practice.outside(fn);
  try {
    // (a socket's use is made already, on the host: its rules still run)
    if (!panel || !ctl || (real(() => !controlShown(panel) || !controlShown(ctl) || controlLocked(ctl)) && !u.socket)) return;
    if (u.type === "set") {
      const at = panelUseAddress(panel, ctl, u.name);
      if (at) { await real(() => clockwork.change(...at, u.value, "gm")).done; log(`${who} set ${String(u.name).replace(/^(global|local|gm)_/, "")} to ${fmtNum(u.value)}`); }
    } else if (u.socket) {
      // (the host has moved the item already: its rules see what, and whether it holds something now)
      real(() => controlUsed(panel.id, ctl.id, undefined, "", { item: socketItemFacts(u.entry, u.contents), has: u.socket === "put" }));
      const what = u.entry ? entryName(u.entry) : "something";
      log(u.byGm ? `The ${term("gm")} gave ${what} back to ${who}` : `${who} ${u.socket === "put" ? "put" : "took"} ${what} ${u.socket === "put" ? "in" : "from"} ${controlName(ctl)}`);
    } else {
      real(() => controlUsed(panel.id, ctl.id, typeof u.value === "number" ? u.value : undefined, u.signal || ""));
      log(`${who} used ${controlName(ctl)}${u.signal ? ` (${u.signal})` : ""}`);
    }
  } finally {
    await party.api("DELETE", `api/share/${s.id}/use/${u.id}`).catch(() => {});
    render();
  }
}
// Where a player's use of a control sets a value: only a value that control sets (a board's pins'
// values, a picture's variables, else its own), in its own scope; null for anything else.
function panelUseAddress(panel, ctl, name) {
  if (ctl.type === "board") {
    const p = pinSetters(ctl.board || {}).find(p => p.xVar === name || p.yVar === name);
    return p ? clockwork.at(p.scope, p.target, name) : null;
  }
  if (ctl.type === "icon") {
    const r = ctl.iconDoc && drawingValueRefs(ctl.iconDoc).get(name);
    if (!r) return null;
    if (r.scope === "global") return clockwork.at("party", "", r.name);
    const [c, u] = pictureWhose(panel, ctl);
    return c ? clockwork.at(u ? "item" : "character", u ? `${c}/${u}` : c, r.name) : null;
  }
  const names = ctl.type === "polygon" ? (ctl.vertices || []).map(v => v.name) : [ctl.name, ctl.name2];
  if (!names.filter(Boolean).includes(name)) return null;
  const c = forChosen(panel, ctl);
  return clockwork.at(c.scope, c.target, name);
}

// On the GM's device: a shown panel follows its changes (sent again, pictures too); a deleted one ends.
const panelSending = new Set();
const panelChecked = new Map(); // share id -> [store.rev, its panel as the host has it] when last compared
function sendPanelChanges() {
  for (const s of party.shares || []) {
    if (s.kind !== "panel" || !s.fromMine || panelSending.has(s.id)) continue;
    const was = panelChecked.get(s.id);
    if (was && was[0] === store.rev && was[1] === s.panel) continue; // (nothing new to compare: every render calls this)
    panelChecked.set(s.id, [store.rev, s.panel]);
    const panel = gmControls().find(p => p.id === s.panelId);
    if (!panel) { panelSending.add(s.id); endShare(s).finally(() => panelSending.delete(s.id)); continue; }
    const now = panelForPlayers(panel);
    if (JSON.stringify(now) === JSON.stringify(s.panel) && s.title === panel.name) continue;
    panelSending.add(s.id);
    uploadPanelImages(panel).then(() => party.api("POST", `api/share/${s.id}/panel`, { title: panel.name, panel: now }))
      .catch(e => toast(e.message)).finally(() => setTimeout(() => { panelSending.delete(s.id); panelChecked.delete(s.id); }, 500));
  }
}

// ------------------------------------------------------------------ at hand
// Up to five of a character's items kept at hand (char.atHand: their uids; bookmarks: the items stay
// where they are), always a tap away: the At hand tab sticks out of the top bar's middle (on a
// phone, up from the bottom bar) and opens them as tiles. A tile drags (onto a trade's side or a
// socket, on a wide screen); tapped, it opens the item, or, on a shared screen with somewhere for it
// (sharedScreen's targets: a trade's side, a socket), offers those too. Pressed and held: the item's menu.
const AT_HAND_MAX = 5;
const atHand = c => (c?.atHand || []).map(uid => c.items.find(e => e.uid === uid)).filter(Boolean).slice(0, AT_HAND_MAX);
const isAtHand = (c, e) => !!c?.atHand?.includes(e.uid);
function toggleAtHand(uid, charId = store.char()?.id) {
  const c = store.state.characters.find(x => x.id === charId);
  if (!c) return;
  const on = isAtHand(c, { uid });
  if (!on && atHand(c).length >= AT_HAND_MAX) return toast(`At most ${AT_HAND_MAX} at hand: take one off first`);
  commit(s => {
    const ch = s.characters.find(x => x.id === charId);
    ch.atHand = on ? atHand(ch).map(e => e.uid).filter(u => u !== uid) : [...atHand(ch).map(e => e.uid), uid];
    if (!ch.atHand.length) delete ch.atHand;
  }, on ? "No longer at hand" : "Kept at hand: the At hand tab has it");
}

// Where an item can go on the shared screen open now: [{ label, run }].
const atHandTargets = e => sharedOpen?.targets && sharedOpen.close.panel?.isConnected ? sharedOpen.targets(e) : [];
// The drawer: its tab pulls it out of the top bar (on a phone, up out of the bottom bar, a second bar
// above it) and back. It stays out until its tab puts it away: through other tabs and windows, and
// next time (kept on this device). Out, it opens over the view (on a phone it takes its room, the
// view ending above it), and a window over everything leaves it clear (the drawer then sits at the screen's edge).
let atHandOpen = null; // (read from the device's settings once they're loaded)
const AT_HAND_KEY = "mimic-at-hand";
function setAtHandOpen(open) {
  atHandOpen = open;
  kv.set(AT_HAND_KEY, open ? "open" : "");
  drawAtHandTab();
}
const openAtHand = () => setAtHandOpen(true), closeAtHand = () => setAtHandOpen(false);
// Called on every render: the tab, the drawer (redrawn only when what's in it changed), its place.
const AT_HAND_SHOW = { tiles: { details: false, tags: false, worth: false, weight: false } };
function drawAtHandTab() {
  const box = document.getElementById("at-hand");
  if (!box) return;
  if (atHandOpen === null) atHandOpen = kv.get(AT_HAND_KEY) === "open";
  const c = store.char(), tab = document.getElementById("at-hand-tab"), pop = document.getElementById("at-hand-pop"), root = document.documentElement.style;
  box.hidden = !c;
  document.body.classList.toggle("has-at-hand-tab", !!c);
  const open = !!c && atHandOpen;
  document.body.classList.toggle("at-hand-open", open);
  box.classList.toggle("open", open);
  if (!c) { for (const v of ["--ah-push", "--ah-over-top", "--ah-over-bottom"]) root.removeProperty(v); return; }
  if (!tab.firstChild) tab.append(icon("star"));
  tab.setAttribute("aria-expanded", String(open));
  tab.setAttribute("aria-label", open ? "Put away what's at hand" : "At hand");
  tab.title = open ? "Put it away" : "At hand: what you keep to hand";
  // (an item's details open: on a phone, no handle, so they sit right on the drawer: css)
  box.classList.toggle("no-handle", !!document.querySelector(".modal.item-details"));
  tab.onclick = () => setAtHandOpen(!atHandOpen);
  box.classList.toggle("covered", !!document.querySelector("#modal-root .overlay"));
  // What's in it: five places, the items as square tiles (a tile may be mid-drag: redrawn only on a
  // change; put away, not until it's pulled out again: every render calls this).
  const list = open ? atHand(c) : null, sig = open && JSON.stringify([c.id, list.map(e => [e.uid, e.qty, entryName(e), e.charges, currentItem(e, c).icon])]);
  if (open && pop.dataset.sig !== sig) {
    pop.dataset.sig = sig;
    const st = { char: c, id: "inv", move: true, atHandList: true, prefs: { show: AT_HAND_SHOW }, open: e => openAtHandItem(c, e) };
    setChildren(pop, h("div", { class: "at-hand-inner" },
      h("div", { class: "at-hand-grid tiles detail-minimal" }, list.map(e => entryTile(st, e)),
        Array.from({ length: AT_HAND_MAX - list.length }, () => h("span", { class: "at-hand-empty", "aria-hidden": "true" }))),
      !list.length && h("p", { class: "muted small" }, `Keep up to ${AT_HAND_MAX} things at hand: Keep at hand, in an item's menu or details.`)));
    setTimeout(() => fitTileNames(pop));
  }
  // (its place measured once the page is laid out: not in the middle of a render)
  if (!atHandPlacing) atHandPlacing = requestAnimationFrame(placeAtHand);
}
// Where it goes: against the top bar (a phone: on the bottom bar, or the shared chips above it); with
// a window over everything, at the screen's edge. And the room it takes, out (its full height, not
// as it slides; on a phone only: elsewhere it opens over the view): kept while a window covers it, so
// what's behind doesn't jump.
let atHandPlacing = 0;
// (the window resized, a phone turned: placed again, the next frame)
addEventListener("resize", () => { if (!atHandPlacing) atHandPlacing = requestAnimationFrame(placeAtHand); });
function placeAtHand() {
  atHandPlacing = 0;
  const box = document.getElementById("at-hand"), root = document.documentElement.style;
  if (box.hidden) return;
  const phone = matchMedia("(max-width: 720px)").matches, covered = box.classList.contains("covered"), open = box.classList.contains("open");
  if (phone) {
    const chips = document.getElementById("shared-chips"), under = (!chips.hidden ? chips : document.getElementById("nav")).getBoundingClientRect();
    box.style.top = ""; box.style.bottom = covered ? "0px" : Math.round(innerHeight - under.top) + "px";
  } else {
    box.style.bottom = ""; box.style.top = covered ? "0px" : Math.round(document.querySelector(".topbar").getBoundingClientRect().bottom) + "px";
  }
  const room = open ? Math.ceil(document.querySelector("#at-hand-pop > .at-hand-inner")?.offsetHeight || 0) + 1 : 0;
  const tabH = document.getElementById("at-hand-tab").offsetHeight; // (0 while it steps aside)
  root.setProperty("--ah-push", (phone ? room : 0) + "px"); // (a phone's second bottom bar takes its room; on a wide screen it opens over the view)
  root.setProperty("--ah-over-top", (open && covered && !phone ? room + tabH : 0) + "px");
  root.setProperty("--ah-over-bottom", (open && covered && phone ? room + tabH : 0) + "px");
}
// A window opening or closing moves it (to the screen's edge, over the window, and back): windows
// open without a render.
{ const moved = new MutationObserver(() => drawAtHandTab());
  moved.observe(document.getElementById("modal-root"), { childList: true });
  moved.observe(document.getElementById("dock"), { childList: true }); } // (docked details: the handle steps aside)
// A tile tapped: the item; on a shared screen with somewhere for it, where it can go too. (The
// drawer stays out.)
function openAtHandItem(c, e) {
  const here = atHandTargets(e);
  if (!here.length) return openEntry(e.uid);
  let close;
  const go = run => () => { close(); run(); };
  const row = (ic, label, run) => h("button", { type: "button", class: "row row-main switch", onclick: go(run) }, icon(ic), h("span", { class: "grow" }, label));
  close = openModal(entryName(e), h("div", { class: "group move-to" },
    here.map(t => row("move", t.label, t.run)),
    row("eye", "Details", () => openEntry(e.uid)),
    row("x", "Take it off at hand", () => toggleAtHand(e.uid, c.id))));
}
