// Party-mode screens: joining, the Party tab, and trading. Uses the helpers
// from app.js (h, icon, openModal, commit, toast...) at call time.

function onlineDot(online) {
  return h("span", { class: "online-dot" + (online ? " on" : ""), title: online ? "Online" : "Offline" });
}

function copyText(text) {
  const done = () => toast("Copied " + text);
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(done, () => toast(text));
  const ta = h("textarea", { style: { position: "fixed", opacity: "0" } }, text);
  document.body.append(ta);
  ta.select();
  try { document.execCommand("copy"); done(); } catch { toast(text); }
  ta.remove();
}

// QR code as an SVG. Always dark-on-white with a quiet zone so phone cameras can read it.
function qrSvg(text, size = 168) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), q = 4, total = n + q * 2;
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + q} ${r + q}h1v1h-1z`;
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${total} ${total}`);
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("class", "qr");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "QR code for " + text);
  svg.setAttribute("shape-rendering", "crispEdges");
  const bg = document.createElementNS(svg.namespaceURI, "rect");
  bg.setAttribute("width", total);
  bg.setAttribute("height", total);
  bg.setAttribute("fill", "#fff");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#000");
  svg.append(bg, path);
  return svg;
}

function showBigQr(url) {
  openModal("Scan to join", h("div", { class: "qr-big" }, qrSvg(url, 320), h("code", null, url),
    h("p", { class: "muted small" }, "Point a phone camera at the code, then tap the link it shows.")));
}

function joinAddresses() {
  return h("div", { class: "join-urls" }, party.joinUrls().map(url =>
    h("div", { class: "join-url" },
      typeof qrcode === "function" && h("button", { class: "qr-btn", title: "Show bigger", "aria-label": "Show a bigger QR code", onclick: () => showBigQr(url) }, qrSvg(url, 132)),
      h("div", { class: "join-url-text" },
        h("code", null, url),
        h("div", { class: "inline" },
          h("button", { class: "btn", onclick: () => copyText(url) }, icon("copy"), "Copy"),
          typeof qrcode === "function" && h("button", { class: "btn", onclick: () => showBigQr(url) }, "Show QR"))))));
}

// ------------------------------------------------------------------ joining

// This device's characters that aren't in the party yet (blank starter characters left out).
function bringableCharacters() {
  return store.state.characters.filter(c => !party.isLinked(c.id) && !isBlankCharacter(c));
}

// Ways to play in the party: one of this device's characters, a new one, or taking over one of
// the party's (for when you switch devices).
function joinOptions(onDone = () => {}) {
  let name = "";
  const create = async () => {
    if (await joinAs(name)) onDone();
  };
  const mine = bringableCharacters();
  const others = party.others();
  return [
    mine.length > 0 && h("section", { class: "join-card" },
      h("h3", null, "Play one of your characters"),
      h("p", { class: "muted small" }, `Saved on this ${party.app?.android ? "phone" : "device"}. The party gets a live copy: trades and purchases update it here too.`),
      h("div", { class: "group" }, mine.map(c => h("div", { class: "row" },
        h("div", { class: "row-main" }, h("div", { class: "row-title" }, c.name),
          h("div", { class: "row-sub" }, `${entriesLabel(c)} · ${coinSummary(c.coins)}`)),
        h("button", { class: "btn primary", onclick: async () => { if (await party.bring(c.id)) onDone(); } }, icon("users"), "Play"))))),
    h("section", { class: "join-card" },
      h("h3", null, "New " + term("character")),
      h("form", { class: "inline", onsubmit: e => { e.preventDefault(); create(); } },
        h("input", { type: "text", placeholder: "Character name", "aria-label": "Character name", oninput: e => { name = e.target.value; } }),
        h("button", { class: "btn" + (mine.length ? "" : " primary"), type: "submit" }, icon("plus"), "Create"))),
    others.length > 0 && h("section", { class: "join-card" },
      h("h3", null, "Take over a party character"),
      h("p", { class: "muted small" }, "For when you switch devices: it's saved on this device from now on. Characters that are open on another device can't be taken."),
      h("div", { class: "group" }, others.map(c => h("div", { class: "row" },
        onlineDot(c.online),
        h("div", { class: "row-main" }, h("div", { class: "row-title" }, c.name),
          h("div", { class: "row-sub" }, c.online ? "Being played right now" : entriesLabel(c))),
        h("button", { class: "btn", disabled: c.online, onclick: async () => { if (await party.bring(c.id)) onDone(); } }, "Take over"))))),
  ];
}

// Create a character on this device and play it in the party. Returns false (and says why)
// if the name is empty. A blank starter character on a fresh device is replaced.
async function joinAs(name) {
  name = (name || "").trim();
  if (!name) {
    toast("Enter a name for your character");
    return false;
  }
  const c = newCharacter(name);
  commit(s => {
    s.characters = s.characters.filter(x => !isBlankCharacter(x) || party.isLinked(x.id));
    s.characters.push(c);
    s.activeId = c.id;
  });
  return party.active ? party.bring(c.id) : true;
}

// First thing a new player on a fresh device sees: just ask for a name.
function promptForName() {
  let name = "", close;
  const ok = async () => { if (await joinAs(name)) close(); };
  const others = party.others().some(c => !c.online);
  close = openModal("Welcome to the party!", h("form", { class: "form", onsubmit: e => { e.preventDefault(); ok(); } },
    h("p", null, "What's your character's name?"),
    h("label", { class: "field" }, h("span", null, "Character name"),
      h("input", { type: "text", maxlength: 60, autocomplete: "off", placeholder: "e.g. Thistle Underbough",
        oninput: e => { name = e.target.value; } })),
    others && h("p", { class: "muted small" }, "Already have a character in this party? ",
      h("button", { type: "button", class: "link", onclick: () => close() }, "See other options"), ".")),
  { footer: [h("button", { class: "btn primary", onclick: ok }, icon("check"), "Join")] });
  // Phones don't focus automatically from openModal; the name is the only thing to do here.
  setTimeout(() => document.querySelector("#modal-root .overlay:last-child input")?.focus(), 50);
}

// In a party with none of this device's characters playing yet: choose one.
function renderJoin() {
  if (!ui.joinPrompted && !bringableCharacters().length) {
    ui.joinPrompted = true;
    setTimeout(promptForName, 0);
  }
  return h("div", { class: "view-join" },
    h("div", { class: "join-hero" },
      icon("users", "big"),
      h("h2", null, "You've joined a party"),
      h("p", { class: "muted" }, "Choose who you're playing. Your characters stay saved on this device; the party shares a live copy so everyone can trade.")),
    joinOptions(),
    h("section", { class: "join-card" },
      h("h3", null, "I'm the GM"),
      h("p", { class: "muted small" }, "A GM doesn't need a character. Ask the host to make this device a GM: on their Party tab it's listed as ",
        h("b", null, deviceName()), ". This screen moves on by itself once they have."),
      h("button", { class: "btn", onclick: renameDevice }, icon("edit"), "Rename this device")),
    party.isJoinedElsewhere() && h("p", { class: "muted small center" },
      h("button", { class: "link", onclick: confirmLeave }, "Leave this party")));
}

// Characters changed both here and in the party while this device was away.
function undecidedBanner() {
  return [...party.undecided].map(id => {
    const c = store.state.characters.find(x => x.id === id);
    const p = party.owned().find(x => x.id === id);
    if (!c || !p) return null;
    return h("section", { class: "found-banner" },
      icon("users"),
      h("div", null,
        h("b", null, `${c.name} changed in two places`),
        h("p", { class: "muted small" }, `This device has ${entriesLabel(c)} and ${coinSummary(c.coins)}; the party's copy has ${entriesLabel(p)} and ${coinSummary(p.coins)}. Which should the party use?`)),
      h("button", { class: "btn", onclick: () => party.resolve(id, "party") }, "The party's"),
      h("button", { class: "btn primary", onclick: () => party.resolve(id, "device") }, "This device's"));
  });
}

// What the host sees this device as. Reconnects so the host sees the new name.
function renameDevice() {
  let name = deviceName(), close;
  const ok = () => {
    close();
    const v = name.trim().slice(0, 40);
    kv.set("mimic-device-name", v);
    if (party.active) party.connect();
    render();
  };
  close = openModal("This device's name", h("form", { class: "form", onsubmit: e => { e.preventDefault(); ok(); } },
    h("p", { class: "muted small" }, "In a party, the host sees devices by name when choosing who's a GM."),
    h("label", { class: "field" }, h("span", null, "Name"),
      h("input", { type: "text", value: name, maxlength: 40, placeholder: "e.g. Jo's laptop", oninput: e => { name = e.target.value; } }))),
  { footer: [h("button", { class: "btn", onclick: () => close() }, "Cancel"), h("button", { class: "btn primary", onclick: ok }, "Save")] });
}

function confirmLeave() {
  confirmDialog("Leave this party? Your characters stay saved on this device, and the party keeps its copy of them (the host can remove it). You can join again any time.",
    "Leave party", () => party.leave());
}

// ------------------------------------------------------------------ party tab

function describeSide(side) {
  const parts = [
    ...side.items.map(i => (i.qty > 1 ? `${i.qty} × ` : "") + i.name),
    ...coinOrder().filter(k => side.coins[k]).map(k => `${side.coins[k].toLocaleString()} ${k}`),
  ];
  return parts.length ? parts.join(", ") : "nothing";
}

function tradeCard(t) {
  const iGive = t.fromMine ? t.give : t.ask;
  const iGet = t.fromMine ? t.ask : t.give;
  const who = `${t.fromName} → ${t.toName}`;
  const status = {
    accepted: "Completed", declined: "Declined", cancelled: "Cancelled", failed: "Failed",
  }[t.status];
  return h("div", { class: "trade-card " + t.status },
    h("div", { class: "trade-head" }, icon("move"), h("b", null, who), status && h("span", { class: "tag" }, status)),
    h("dl", { class: "trade-sides" },
      h("dt", null, t.fromMine || t.status !== "pending" ? "You give" : "You'd give"), h("dd", null, describeSide(iGive)),
      h("dt", null, t.fromMine || t.status !== "pending" ? "You get" : "You'd get"), h("dd", null, describeSide(iGet))),
    t.note && h("p", { class: "trade-note" }, "“", t.note, "”"),
    t.reason && h("p", { class: "muted small" }, t.reason),
    t.status === "pending" && h("div", { class: "trade-actions" },
      t.toMine ? [
        h("button", { class: "btn", onclick: () => party.act(t.id, "decline") }, "Decline"),
        h("button", { class: "btn primary", onclick: () => party.act(t.id, "accept") }, icon("check"), "Accept"),
      ] : h("button", { class: "btn", onclick: () => party.act(t.id, "cancel") }, "Cancel offer")));
}

function memberCard(c) {
  const open = ui.partyOpen?.has(c.id);
  const toggle = () => {
    ui.partyOpen = ui.partyOpen || new Set();
    open ? ui.partyOpen.delete(c.id) : ui.partyOpen.add(c.id);
    render();
  };
  const where = e => {
    if (!e.parent) return "";
    const p = c.items.find(x => x.uid === e.parent);
    return p ? ` (${entryComp(e) === OUTSIDE ? "on" : "in"} ${entryName(p)})` : "";
  };
  return h("div", { class: "group member" },
    h("div", { class: "row" },
      onlineDot(c.online),
      h("button", { class: "row-main", onclick: toggle, "aria-expanded": String(!!open) },
        h("div", { class: "row-title" }, c.name),
        h("div", { class: "row-sub" }, `${entriesLabel(c)} · ${coinSummary(c.coins)}`)),
      iconBtn("chevron", open ? "Hide inventory" : "Show inventory", toggle, open ? "flip" : ""),
      h("button", { class: "btn primary", disabled: !store.char(), onclick: () => openTradeBuilder(c.id) }, icon("move"), "Trade"),
      // The host can clear out players who have left (only while they're away).
      party.isHost() && !c.online && iconBtn("trash", `Remove ${c.name} from the party`, () => removeMember(c), "danger-hover")),
    open && (c.items.length
      ? h("ul", { class: "member-items" }, byName(c.items.filter(e => !inDeck(c, e))).map(e =>
        h("li", null, itemIcon(e.item, "row-icon small"), e.qty > 1 ? `${e.qty} × ` : "", entryName(e), h("span", { class: "muted" }, where(e)))))
      : h("p", { class: "muted pad" }, "Nothing carried.")));
}

// The campaign the party is playing, and for a GM, loading another of theirs.
function campaignCard() {
  const pc = party.campaign;
  const mine = store.campaigns().filter(c => c.id !== pc?.id);
  const load = async camp => {
    try { await party.loadCampaign(camp); } catch (e) { toast(e.message); }
  };
  const picker = () => {
    let close;
    close = openModal("Load a campaign", [
      h("p", { class: "muted small" }, "Everyone switches to it: players' devices play their characters from it (or bring new ones). "
        + "A campaign the party hasn't played yet starts with its shops and values from your device."),
      h("div", { class: "group" }, mine.map(c => h("button", { class: "row row-main switch", onclick: () => { close(); load(c); } },
        icon("book"), h("div", null, h("div", { class: "row-title" }, c.name),
          h("div", { class: "row-sub" }, [plural(c.shops.length, "shop"), c.notes].filter(Boolean).join(" · ")))))),
    ]);
  };
  return h("section", { class: "found-banner campaign-banner" },
    icon("book"),
    h("div", null,
      h("b", null, pc ? pc.name : "No campaign chosen"),
      h("p", { class: "muted small" }, pc ? "The campaign this party is playing." : party.isGm()
        ? "Load one of your campaigns: the party then keeps a save of its own for it, and players play their characters from it."
        : "The GM hasn't chosen a campaign yet.")),
    party.isGm() && mine.length > 0 && h("button", { class: "btn" + (pc ? "" : " primary"), onclick: picker }, pc ? "Load another" : "Load a campaign"));
}

// The host's devices: who's here, and who's a GM. With no GM chosen, the host is the GM.
function devicesCard() {
  const gms = party.devices.filter(d => d.gm);
  return h("section", { class: "devices-card" },
    h("div", { class: "section-head" }, h("h2", null, "Devices"),
      h("span", { class: "muted small" }, gms.length ? plural(gms.length, "GM") : "You're the GM until you choose one")),
    h("p", { class: "muted small" }, "Make a device a GM to let it run the shops, values and controls and see everyone's details. As host you keep stopping the party, choosing GMs and removing players."),
    h("div", { class: "group" }, party.devices.map(d => h("div", { class: "row" },
      onlineDot(d.online),
      h("div", { class: "row-main static" },
        h("div", { class: "row-title" }, d.name, d.self && h("span", { class: "tag" }, "this device"), d.gm && h("span", { class: "tag on" }, "GM")),
        h("div", { class: "row-sub" }, d.characters.length ? "Plays " + d.characters.join(", ") : "No character")),
      h("button", { class: "btn" + (d.gm ? "" : " primary"), onclick: () => party.setGmRole(d.id, !d.gm) }, d.gm ? "Revoke GM" : "Make GM")))));
}

function renderParty() {
  const incoming = party.incoming();
  const outgoing = party.trades.filter(t => t.status === "pending" && t.fromMine);
  const history = party.trades.filter(t => t.status !== "pending").slice(0, 10);
  const others = party.others();
  return h("div", { class: "view-party" },
    h("section", { class: "party-banner" },
      h("div", { class: "section-head" },
        h("h2", null, "Party"),
        h("span", { class: "status" }, onlineDot(party.connected), party.connected ? "Live" : "Reconnecting…")),
      h("p", { class: "muted small" }, "Others on this network join by opening:"),
      joinAddresses(),
      party.isHosting() && h("div", { class: "inline wrap host-actions" },
        h("span", { class: "muted small" }, "You're hosting this party."),
        h("button", { class: "btn danger", onclick: stopHosting }, "Stop hosting")),
      party.isJoinedElsewhere() && h("div", { class: "inline wrap host-actions" },
        h("span", { class: "muted small" }, `You joined the party at ${hostLabel(party.base)}.`),
        h("button", { class: "btn", onclick: confirmLeave }, "Leave party"))),
    campaignCard(),
    party.isHost() && devicesCard(),
    undecidedBanner(),
    incoming.length > 0 && h("section", null, h("h2", null, "Offers for you"), incoming.map(tradeCard)),
    outgoing.length > 0 && h("section", null, h("h2", null, "Your offers"), outgoing.map(tradeCard)),
    h("section", null,
      h("h2", null, "Party members"),
      others.length ? others.map(memberCard)
        : emptyState("users", "Nobody else has joined yet. Share the address above.")),
    (!party.isGm() || party.linked().length > 0) && h("section", null,
      h("div", { class: "section-head" }, h("h2", null, "Playing in this party"),
        h("button", { class: "btn", onclick: openJoinModal }, icon("plus"), "Bring a character")),
      h("div", { class: "group" }, party.linked().map(c => h("div", { class: "row" + (c.id === store.state.activeId ? " equipped" : "") },
        onlineDot(true),
        h("button", { class: "row-main", onclick: () => { commit(s => { s.activeId = c.id; }); go("inventory"); } },
          h("div", { class: "row-title" }, c.name, c.id === store.state.activeId && h("span", { class: "tag on" }, "active")),
          h("div", { class: "row-sub" }, entriesLabel(c)))))),
      h("p", { class: "muted small" }, `Saved on this ${party.app?.android ? "phone" : "device"} and shared live with the party.`)),
    history.length > 0 && h("section", null, h("h2", null, "Recent trades"), history.map(tradeCard)));
}

// ------------------------------------------------------------------ the GM's view of the players

// Every character in the party, with what a GM wants at a glance: armour class, load, coins,
// attunement and attacks, and their whole inventory (searchable across everyone).
function gmPlayersView() {
  const q = (ui.gmSearch || "").trim().toLowerCase();
  const chars = [...party.chars].sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));

  // Their inventory, shown like any inventory (storageTree in js/app.js): read-only, with the GM's
  // state controls; the search finds items across everyone.
  const playerStorage = c => {
    const st = { char: c, id: "gmp:" + c.id, rootLabel: "On person", search: q,
      open: e => openStoredItem(st, e, statesFor(e).length > 0 && gmStateControls(c, e)),
      extras: e => statesFor(e).length > 0 && iconBtn("wand", `States of ${entryName(e)}`, () => openGmStates(c, e), "gm-states-btn"),
      empty: () => h("p", { class: "muted pad" }, "Carrying nothing.") };
    return st;
  };

  const card = c => {
    const key = "gmp:" + c.id, open = q ? true : ui.collapsed.has(key);
    const toggle = () => { ui.collapsed.has(key) ? ui.collapsed.delete(key) : ui.collapsed.add(key); render(); };
    const sums = panelSummaries(c).map(x => x.result);
    if (q && !c.items.some(e => !inDeck(c, e) && entryMatches(c, e, q))) return null;
    return h("div", { class: "group gm-player-card" },
      h("div", { class: "gm-player-head" },
        onlineDot(c.online),
        h("div", { class: "gm-player-name" }, h("b", null, c.name), c.mine && h("span", { class: "tag" }, "yours")),
        h("button", { class: "btn", onclick: toggle, "aria-expanded": String(open) }, icon(open ? "up" : "down"), open ? "Hide inventory" : `Inventory (${entriesLabel(c)})`)),
      // The system's summary (its gm-player panels: 5e's AC, load, attunement…), and the coins.
      h("div", { class: "gm-stats" },
        sums.flatMap(r => r.stats).map(st => h("div", { class: "gm-stat" + (st.warn ? " warn" : ""), title: st.title },
          h("small", null, st.label), h("b", null, st.value), st.sub && h("span", { class: "small" }, st.sub))),
        h("div", { class: "gm-stat" }, h("small", null, "Coins"), h("b", null, fmtMoney(coinTotalCp(c.coins || {}))))),
      sums.some(r => r.chips.length) && h("div", { class: "gm-attacks" }, sums.flatMap(r => r.chips).map(t => h("span", { class: "chip" }, t))),
      sums.flatMap(r => r.notes).map(n => h("p", { class: "warn-text small pad" }, n)),
      gmLimits(c),
      open && h("div", { class: "gm-inv" }, itemManager({ key: "gmp:" + c.id, prefsKey: "gm-players", parts: { search: false }, storage: () => playerStorage(c) })));
  };
  const cards = chars.map(card).filter(Boolean);
  return h("section", { class: "gm-players" },
    h("div", { class: "section-head" }, h("h2", null, "Players"),
      h("span", { class: "muted small" }, `${plural(chars.filter(c => c.online).length, "player")} online`)),
    h("label", { class: "search" }, icon("search"),
      h("input", { type: "search", placeholder: "Find an item on anyone: rope, potion, map…", value: ui.gmSearch || "",
        oninput: e => { ui.gmSearch = e.target.value; render(); document.querySelector(".gm-players input[type=search]")?.focus(); } })),
    chars.length ? (cards.length ? cards : h("p", { class: "muted pad" }, "Nobody carries anything like that.")) :
      emptyState("users", "Nobody has joined yet. Players join from the address on the Party tab."));
}

// Host: remove a player's character who isn't connected. Offers a backup file first.
function removeMember(c) {
  let close;
  const backup = async () => {
    const char = cleanChar(c);
    download(`${c.name.replace(/\W+/g, "_")}.json`, fileOf("character", { character: char, templates: [],
      images: await bundleImages(allImageRefs([char])) }));
  };
  const remove = async () => {
    close();
    try {
      await party.api("POST", `api/characters/${encodeURIComponent(c.id)}/remove`);
      toast(`${c.name} was removed from the party`);
    } catch (e) {
      toast(e.message);
    }
  };
  close = openModal(`Remove ${c.name}?`, h("div", { class: "form" },
    h("p", null, `${c.name} and everything they carry (${entriesLabel(c)}, ${coinSummary(c.coins)}) will be removed from the party. Any trades waiting on them are cancelled.`),
    h("p", { class: "muted small" }, "Their own device keeps its copy of the character. You can also download a backup here, which can be imported from Settings."),
    h("button", { class: "btn", type: "button", onclick: backup }, icon("download"), "Download a backup")),
  { footer: [
    h("button", { class: "btn", onclick: () => close() }, "Cancel"),
    h("button", { class: "btn danger", onclick: remove }, icon("trash"), "Remove from party"),
  ] });
}

// ------------------------------------------------------------------ hosting (desktop app)

function reloadApp() {
  ui.leaving = true;
  location.reload();
}

async function startHosting(port) {
  try {
    await party.host(true, port);
    party.forgetJoined();
    toast("Party started");
    reloadApp();
  } catch (e) {
    toast(e.message);
  }
}

function stopHosting() {
  const online = party.others().filter(c => c.online).length;
  confirmDialog(online ? `Stop the party? ${online} player${online === 1 ? " is" : "s are"} connected and will be disconnected. Everyone's inventory stays saved for next time.`
    : "Stop hosting the party? Everyone's inventory stays saved for next time.", "Stop hosting", async () => {
    try {
      await party.host(false);
      reloadApp();
    } catch (e) {
      toast(e.message);
    }
  });
}

function hostPartySection() {
  let port = party.app.defaultPort || 8765;
  return h("section", null,
    h("h3", null, "Host a party"),
    h("p", { class: "muted small" }, "Let everyone at the table use the app on their own phone or laptop, with their own inventory, and trade items with each other. Players on the same Wi-Fi join by opening the address shown once the party starts. Nothing to install for them."),
    h("div", { class: "inline wrap" },
      h("label", { class: "field port-field" }, h("span", null, "Port"),
        h("input", { type: "number", min: 1024, max: 65535, value: port, inputmode: "numeric", oninput: e => { port = +e.target.value; } })),
      h("button", { class: "btn primary", onclick: () => startHosting(port) }, icon("users"), "Start hosting")),
    h("p", { class: "muted small" }, party.app.android
      ? "Keep the app running while you host — a notification shows while the party is on. Players need to be on the same Wi-Fi as this phone, or connected to its hotspot."
      : "If Windows asks whether Is This A Mimic? may use the network, allow it on private networks."));
}

// ------------------------------------------------------------------ joining another host (desktop & Android app)

// "192.168.1.27:8765", "192.168.1.27" or a full URL -> "http://192.168.1.27:8765/"
function partyUrl(text) {
  let t = (text || "").trim();
  if (!t) return null;
  if (!/^https?:\/\//i.test(t)) t = "http://" + t;
  try {
    const u = new URL(t);
    if (!u.port && u.protocol === "http:") u.port = "8765";
    return u.origin + "/";
  } catch {
    return null;
  }
}

// The party at this address: { info } (its /api/info), or { problem } saying what's wrong.
async function checkPartyAddress(url) {
  const where = new URL(url).host;
  const info = await fetchInfo(url);
  if (info?.party) return { info };
  return { problem: info
    ? `The app is open at ${where}, but it isn't hosting a party. Ask the host to start one on their Party tab.`
    : `There's no party at ${where}. Check the address on the host's Party tab, including the number after the colon, and that you're on the same Wi-Fi.` };
}

// "http://192.168.1.27:8765/" -> "192.168.1.27:8765"
function hostLabel(url) { return (url || "").replace(/^https?:\/\//, "").replace(/\/$/, ""); }

function joinOtherSection() {
  let addr = readPref("mimic-last-join", "");
  let busy = false;
  const join = async (scanned = null) => {
    if (scanned) addr = hostLabel(scanned);
    const url = scanned || partyUrl(addr);
    if (!url) return toast("Enter the address from the host's Party tab, like 192.168.1.27:8765");
    if (busy) return;
    writePref("mimic-last-join", addr.trim());
    busy = true;
    try {
      const { info, problem } = await checkPartyAddress(url);
      if (problem) return toast(problem);
      // Stay on this page (and this device's saved characters): talk to the host from here.
      await party.join(url, info);
    } catch (e) {
      toast(`Couldn't join: ${e.message}`);
    } finally {
      busy = false;
    }
  };
  return h("section", null,
    h("h3", null, "Join someone else's party"),
    h("p", { class: "muted small" }, "Type the address shown on the host's Party tab (or under the QR code). Your characters stay saved here; you choose which to play."),
    party.unreachable && h("p", { class: "warn-text small" }, `Couldn't reach the party you joined at ${hostLabel(party.unreachable)}. `,
      h("button", { class: "link", onclick: () => { addr = hostLabel(party.unreachable); join(); } }, "Try again"), " · ",
      h("button", { class: "link", onclick: () => party.leave() }, "Forget it")),
    h("form", { class: "inline wrap", onsubmit: e => { e.preventDefault(); join(); } },
      h("input", { type: "text", inputmode: "url", autocomplete: "off", placeholder: "192.168.1.27:8765", value: addr,
        "aria-label": "Party address", style: { maxWidth: "260px" }, oninput: e => { addr = e.target.value; } }),
      h("button", { class: "btn primary", type: "submit" }, icon("users"), "Join"),
      h("button", { class: "btn", type: "button", onclick: () => openQrScanner(url => join(url)) }, icon("qr"), "Scan QR code")));
}

// ------------------------------------------------------------------ scanning a join code

// The QR reader (jsQR) is only loaded when it's needed.
const loadQrReader = () => loadScript("js/vendor/jsQR.js", "jsQR", "the QR reader");

// A party address from a QR code: the host's join code is a plain http address.
function partyUrlFromQr(text) {
  return /^https?:\/\/[^\s]+$/i.test((text || "").trim()) ? partyUrl(text) : null;
}

// Read a QR code from pixels (a camera frame or a picture), scaled down so it stays quick.
function readQr(source, width, height, canvas) {
  const scale = Math.min(1, 800 / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" })?.data || null;
}

// Point the camera at the host's QR code (on their Party tab), or pick a photo / screenshot of it.
// onUrl(url) gets the party address.
async function openQrScanner(onUrl) {
  try {
    await loadQrReader();
  } catch (e) {
    return toast(e.message);
  }
  let stream = null, finished = false, close;
  const canvas = document.createElement("canvas");
  const video = h("video", { class: "qr-video", autoplay: true, muted: true, playsinline: true });
  const status = h("p", { class: "muted small center" }, "Starting the camera…");
  const stop = () => { stream?.getTracks().forEach(t => t.stop()); stream = null; };
  const found = text => {
    const url = partyUrlFromQr(text);
    if (!url) {
      status.textContent = "That QR code isn't a party address. Scan the one on the host's Party tab.";
      return false;
    }
    finished = true;
    stop();
    close();
    onUrl(url);
    return true;
  };
  // Every frame: stop the camera as soon as the dialog is gone (closed any way), else look for a code.
  const tick = () => {
    if (finished) return;
    if (!video.isConnected) return stop();
    if (video.readyState >= 2 && video.videoWidth) {
      const text = readQr(video, video.videoWidth, video.videoHeight, canvas);
      if (text && found(text)) return;
    }
    requestAnimationFrame(tick);
  };
  const picture = h("input", { type: "file", accept: "image/*", hidden: true, onchange: () => {
    const file = picture.files[0];
    picture.value = "";
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      const text = readQr(img, img.naturalWidth, img.naturalHeight, canvas);
      URL.revokeObjectURL(img.src);
      if (!text) status.textContent = "No QR code found in that picture. Try a closer, sharper one.";
      else found(text);
    };
    img.onerror = () => { status.textContent = "Couldn't open that picture."; };
    img.src = URL.createObjectURL(file);
  } });
  close = openModal("Scan the host's QR code", h("div", { class: "qr-scan" },
    h("div", { class: "qr-frame" }, video),
    status,
    h("p", { class: "muted small center" }, "It's on the host's Party tab (and in their Settings)."),
    picture), { footer: [
      h("button", { class: "btn", onclick: () => picture.click() }, icon("image"), "Use a picture"),
      h("button", { class: "btn", onclick: () => { stop(); close(); } }, "Cancel"),
    ] });
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("no camera support");
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    if (!video.isConnected) return stop(); // closed while the camera was starting
    video.srcObject = stream;
    await video.play().catch(() => {});
    status.textContent = "Point the camera at the code.";
    requestAnimationFrame(tick);
  } catch (e) {
    const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
    status.textContent = denied ? "The app isn't allowed to use the camera. Allow it, or use a picture of the code instead."
      : "No camera found. Use a picture of the code instead (a photo or screenshot).";
    video.parentElement.hidden = true;
  }
}

function openJoinModal() {
  let close;
  close = openModal("Bring a character", joinOptions(() => close()), { wide: true });
}

// Settings, in the app's own window: quit the app (and stop its server).
function quitSection() {
  return h("section", null,
    h("h2", null, "App"),
    h("button", { class: "btn", onclick: async () => {
      if (party.isHosting() && party.others().some(c => c.online) &&
          !confirm("Players are connected. Quitting stops the party for everyone. Quit anyway?")) return;
      ui.leaving = true;
      try { await party.quit(); } catch {}
      document.body.replaceChildren(h("div", { class: "empty" }, h("h2", null, "Is This A Mimic? has closed"), h("p", null, "You can close this window.")));
      window.close();
    } }, icon("x"), "Quit"));
}

// ------------------------------------------------------------------ trade builder

// In a party, trading and shopping need the character to be one that's playing in it.
function requireLinked(c = store.char()) {
  if (!party.active || !c || party.isLinked(c.id)) return true;
  toast(`${c.name} is only on this device — bring them into the party first`);
  return false;
}

// Shown on the inventory of a character that's on this device but not playing in the party.
function notInPartyBanner() {
  const c = store.char();
  if (!party.active || !c || party.isLinked(c.id)) return null;
  return h("section", { class: "found-banner" },
    icon("users"),
    h("div", null, h("b", null, `${c.name} isn't in the party`),
      h("p", { class: "muted small" }, "They're saved on this device only. Bring them in to trade and shop with the party.")),
    h("button", { class: "btn primary", onclick: () => party.bring(c.id) }, "Bring into party"));
}

function openTradeBuilder(targetId = null, preselectUid = null) {
  const me = store.char();
  const others = party.others();
  if (!me || !requireLinked(me)) return;
  if (!others.length) return toast("Nobody else is in the party yet");
  let target = others.find(c => c.id === targetId) || others[0];
  const give = new Map(), ask = new Map();
  const giveCoins = {}, askCoins = {};
  let note = "", close;
  if (preselectUid) give.set(preselectUid, 1);

  const giveBox = h("div", { class: "picker" });
  const askBox = h("div", { class: "picker" });
  const askCoinBox = h("div");

  // Items inside a selected container travel with it, so they can't be picked separately.
  const insideSelected = (char, e, map) => {
    let p = e.parent;
    while (p) {
      if (map.has(p)) return true;
      p = char.items.find(x => x.uid === p)?.parent;
    }
    return false;
  };
  // Each side lists its character's items with the inventory management template (itemManager in
  // js/app.js), a pick on each; picked items stay listed whatever the search.
  const picker = (side, getChar, map) => {
    resetList("trade-" + side); // a fresh search for each trade
    let mgr;
    mgr = itemManager({ key: "trade-" + side, prefsKey: "trade", sorts: INVENTORY_SORTS, sort: "name", placeholder: "Search items…",
      storage: () => {
        const char = getChar();
        const st = {
          char, id: "trade:" + char.id, rootLabel: "On person", keep: e => map.has(e.uid),
          open: e => openStoredItem(st, e),
          rowClass: e => map.has(e.uid) ? "picked" : insideSelected(char, e, map) ? "included" : "",
          sub: e => insideSelected(char, e, map) ? "goes with its container" : null,
          extras: e => {
            const included = insideSelected(char, e, map), checked = map.has(e.uid);
            return [
              checked && e.qty > 1 && h("input", { type: "number", class: "trade-n", min: 1, max: e.qty, value: map.get(e.uid), inputmode: "numeric",
                "aria-label": `How many ${entryName(e)}`,
                onchange: ev => map.set(e.uid, Math.max(1, Math.min(e.qty, Math.floor(+ev.target.value || 1)))) }),
              h("label", { class: "check trade-pick" }, h("input", { type: "checkbox", checked: checked || included, disabled: included, "aria-label": `Trade ${entryName(e)}`,
                onchange: ev => { ev.target.checked ? map.set(e.uid, e.qty > 1 ? 1 : e.qty) : map.delete(e.uid); mgr.redraw(); } }))];
          },
          empty: () => h("p", { class: "muted small pad" }, "No items."),
        };
        return st;
      } });
    return mgr;
  };
  const coinInputs = (obj, have) => h("div", { class: "coin-grid small" }, coinOrder().map(k =>
    h("label", { class: "field coin-field " + k },
      h("span", null, k.toUpperCase() + (have ? ` (${(have[k] || 0).toLocaleString()})` : "")),
      h("input", { type: "number", min: 0, max: have?.[k], inputmode: "numeric", value: obj[k] || "",
        oninput: ev => { obj[k] = Math.max(0, Math.floor(+ev.target.value || 0)); } }))));

  const drawAsk = () => {
    for (const k of coinOrder()) delete askCoins[k];
    ask.clear();
    askBox.replaceChildren(picker("ask", () => target, ask));
    askCoinBox.replaceChildren(coinInputs(askCoins, target.coins || {}));
  };
  giveBox.replaceChildren(picker("give", () => me, give));
  drawAsk();

  const side = (map, char) => ({
    items: [...map].filter(([u]) => { const e = char.items.find(x => x.uid === u); return e && !insideSelected(char, e, map); })
      .map(([u, qty]) => ({ uid: u, qty })),
  });
  const send = async () => {
    const offer = {
      from: me.id, to: target.id, note,
      give: { ...side(give, me), coins: { ...giveCoins } },
      ask: { ...side(ask, target), coins: { ...askCoins } },
    };
    if (!offer.give.items.length && !offer.ask.items.length &&
        !coinOrder().some(k => giveCoins[k] || askCoins[k])) return toast("Pick something to trade");
    const short = coinOrder().find(k => (giveCoins[k] || 0) > (me.coins[k] || 0));
    if (short) return toast(`You don't have ${giveCoins[short]} ${short}`);
    try {
      // Make sure the server has our latest inventory before referencing it.
      await party.put(me.id);
      await party.offer(offer);
      close();
      toast(`Offer sent to ${target.name}`);
    } catch (e) {
      toast(e.message);
    }
  };

  const body = h("div", { class: "form" },
    h("label", { class: "field" }, h("span", null, "Trade with"),
      h("select", { onchange: ev => { target = others.find(c => c.id === ev.target.value); drawAsk(); } },
        others.map(c => h("option", { value: c.id, selected: c === target }, c.name + (c.online ? "" : " (offline)"))))),
    h("div", { class: "trade-grid" },
      h("div", { class: "trade-col" }, h("h4", null, `${me.name} gives`), giveBox, h("h4", null, "Coins"), coinInputs(giveCoins, me.coins)),
      h("div", { class: "trade-col" }, h("h4", null, "In return, ask for"), askBox, h("h4", null, "Coins"), askCoinBox)),
    h("label", { class: "field" }, h("span", null, "Note (optional)"),
      h("input", { type: "text", maxlength: 500, placeholder: "e.g. For the rope you lent me", oninput: ev => { note = ev.target.value; } })),
    h("p", { class: "muted small" }, "Nothing moves until they accept. Giving a container also gives what's in it."));
  close = openModal("Offer a trade", body, { wide: true, footer: [
    h("button", { class: "btn", onclick: () => close() }, "Cancel"),
    h("button", { class: "btn primary", onclick: send }, icon("move"), "Send offer"),
  ] });
}

// ------------------------------------------------------------------ the GM's states and limits

// An item's states, for the GM (from the Players list).
function openGmStates(c, e) {
  let close;
  close = openModal(`${entryName(e)} — ${c.name}`, h("div", { class: "form" }, gmStateControls(c, e),
    h("p", { class: "muted small" }, "On or Off holds a state whatever the player does; the player's choice lets them switch it (if it's theirs to switch).")),
    { footer: [h("button", { class: "btn primary", onclick: () => close() }, "Done")] });
}

// A character's limits (5e: attunement slots), which only the GM sets.
function gmLimits(c) {
  const lims = systemStates().filter(limitValueName);
  if (!lims.length) return null;
  return h("div", { class: "gm-limits" }, lims.map(st => {
    const own = charLocal(c.id, limitValueName(st));
    return h("label", { class: "gm-limit" }, h("span", { class: "small muted" }, st.limit.label || `${st.label} limit`),
      h("input", { type: "number", min: 0, max: 99, value: stateLimit(c, st) ?? "", placeholder: String(st.limit.default ?? ""),
        "aria-label": `${st.limit.label || st.label + " limit"} for ${c.name}`, onchange: async ev => {
          const v = ev.target.value === "" ? null : Math.max(0, Math.min(99, Math.round(+ev.target.value)));
          await clockwork.change({ char: c }, `char.limit.${st.key}`, v, "gm").done;
          render();
        } }),
      h("span", { class: "small muted" }, `${stateCount(c, st.key)} ${st.label.toLowerCase()}` + (typeof own === "number" ? "" : " · default")));
  }));
}

// ------------------------------------------------------------------ showing an item
// In a party, an item can be shown to some of the party and the GM (Show… in its menu): it pops up
// for them to look at; nothing moves. The host keeps it until everyone has seen it (server.py:
// prune_shows).

// The entries inside an entry (for showing a container with what's in it).
function entryContents(char, e) {
  const out = [], walk = id => { for (const x of char.items.filter(x => x.parent === id)) { out.push(x); walk(x.uid); } };
  walk(e.uid);
  return out.slice(0, 200);
}
// An entry as it's shown: its item as it is now (identified, named…), without its layers and
// rules (what it could become isn't theirs to see).
function shownEntry(char, e) {
  const { layers, triggers, ...item } = clone(currentItem(e, char));
  return { ...clone(e), item };
}

function openShowItem(entryUid) {
  const char = store.char(), e = char?.items.find(x => x.uid === entryUid);
  if (!e || !party.active) return;
  const others = party.chars.filter(c => c.id !== char.id);
  const toGm = !party.isGm();
  const chosen = new Set(others.filter(c => c.online && !c.mine).map(c => c.id));
  let gm = false, close;
  const send = async () => {
    if (!chosen.size && !gm) return toast("Choose who to show it to");
    close();
    try {
      await party.api("POST", "api/show", { from: party.isLinked(char.id) ? char.id : "", item: shownEntry(char, e),
        contents: entryContents(char, e).map(x => shownEntry(char, x)), to: [...chosen], gm });
      const names = [...others.filter(c => chosen.has(c.id)).map(c => c.name), gm && `the ${term("gm")}`].filter(Boolean);
      toast(`Showing ${entryName(e)} to ${names.join(", ")}`);
    } catch (err) {
      toast(err.status === 404 && /Unknown|endpoint/i.test(err.message) ? "The party's host needs the latest version of the app to show items" : err.message);
    }
  };
  close = openModal(`Show ${entryName(e)}`, h("div", { class: "form" },
    h("p", { class: "muted small" }, "It pops up for them to look at. Nothing changes hands."),
    h("div", { class: "group" },
      others.map(c => h("label", { class: "row check-row" },
        h("input", { type: "checkbox", checked: chosen.has(c.id), onchange: ev => { ev.target.checked ? chosen.add(c.id) : chosen.delete(c.id); } }),
        onlineDot(c.online), h("span", { class: "grow" }, c.name), c.mine && h("span", { class: "tag" }, "yours"))),
      toGm && h("label", { class: "row check-row" },
        h("input", { type: "checkbox", checked: gm, onchange: ev => { gm = ev.target.checked; } }),
        icon("shield"), h("span", { class: "grow" }, `The ${term("gm")}`)))),
  { footer: [h("button", { class: "btn", onclick: () => close() }, "Cancel"), h("button", { class: "btn primary", onclick: send }, icon("eye"), "Show it")] });
}

// Who on this device a show is for: its characters it was shown to, and "gm" (shown to the GM, on
// a GM's device), not yet seen.
const showFor = s => [...s.to.filter(id => party.isLinked(id)), ...(s.gm && party.isGm() ? ["gm"] : [])].filter(w => !s.seen.includes(w));

// Pops up items shown to this device, one at a time (called on every render).
const showsOpen = new Set();
function syncShows() {
  if (!party.active) return;
  const next = (party.shows || []).find(s => showFor(s).length && !showsOpen.has(s.id));
  if (!next || document.querySelector("#modal-root .show-pop")) return;
  showsOpen.add(next.id);
  openShownItem(next);
}

function openShownItem(s) {
  const e = s.item, it = e.item;
  const seen = () => { for (const w of showFor(s)) party.api("POST", `api/show/${s.id}/seen`, { character: w }).catch(() => {}); };
  const close = openModal(`${s.fromName} shows you…`, h("div", { class: "show-pop" },
    h("p", null, h("b", null, entryName(e)), e.qty > 1 && ` ×${e.qty.toLocaleString()}`, e.customName && h("span", { class: "muted small" }, ` (${it.name})`)),
    s.to.length > 1 && h("p", { class: "muted small" }, `Shown to ${s.to.map(id => party.chars.find(c => c.id === id)?.name || "someone").join(", ")}${s.gm ? ` and the ${term("gm")}` : ""}.`),
    e.notes && h("p", { class: "small" }, e.notes),
    itemDetails(it, null, e.srcId),
    s.contents.length > 0 && h("div", { class: "field" }, h("span", null, "Inside"),
      h("ul", { class: "show-contents" }, s.contents.filter(x => x.parent === e.uid).map(x => h("li", null, entryName(x), x.qty > 1 && ` ×${x.qty}`))))),
  { footer: [h("button", { class: "btn primary", onclick: () => { seen(); close(); } }, icon("check"), "Seen")] });
}

// ------------------------------------------------------------------ discarding
// In a party, Remove is Discard: the item goes to the GM (a Discarded hoard on the GM's Treasure
// tab, with a line in its history), by way of the host.

async function discardEntry(entryUid, after) {
  const char = store.char(), e = char?.items.find(x => x.uid === entryUid);
  if (!e) return;
  const name = entryName(e) + (e.qty > 1 ? ` (×${e.qty.toLocaleString()})` : "");
  const inside = holdsItems(char, e) && char.items.some(x => x.parent === e.uid);
  confirmDialog(`Discard ${name}? It goes to the ${term("gm")} (their Treasure tab, Discarded).${inside ? " What's in it stays with you." : ""}`, "Discard", async () => {
    after?.();
    // (all of it, layers and rules too: it's the GM's now)
    const copy = { ...clone(e), parent: null, equipped: false }; delete copy.compartment;
    const kids = char.items.filter(x => x.parent === e.uid).map(x => x.uid); // (they stay with you: removeEntry moves them out)
    commit((s, c) => removeEntry(c, e.uid), `Discarded ${entryName(e)}`);
    try {
      await party.api("POST", "api/discard", { character: char.id, items: [copy] });
    } catch (err) {
      // Not sent: it stays, with what was in it.
      commit((s, c) => { if (c.id !== char.id) return; c.items.push(e); for (const x of c.items) if (kids.includes(x.uid)) x.parent = e.uid; });
      toast(err.status === 404 && /Unknown|endpoint/i.test(err.message) ? "The party's host needs the latest version of the app to discard items: it's back" : `Couldn't discard it: ${err.message}`);
    }
  });
}

// On a GM's device: discarded items go into the Discarded hoard (called on every render).
const discardsTaken = new Set();
function takeDiscards() {
  if (!party.active || !party.isGm()) return;
  for (const d of party.discards || []) {
    if (discardsTaken.has(d.id)) continue;
    discardsTaken.add(d.id);
    commit(s => {
      s.hoards ||= [];
      let hd = s.hoards.find(x => x.discarded);
      if (!hd) { hd = { ...newHoard("Discarded"), discarded: true, notes: "What players discard comes here." }; s.hoards.unshift(hd); }
      for (const e of d.items) {
        const x = { ...clone(e), uid: uid(), parent: null, equipped: false }; delete x.compartment;
        x.history = [...(x.history || []), { at: d.at, text: `Discarded by ${d.name}` }].slice(-20);
        hd.items.push(x);
      }
    }, `${d.name} discarded ${d.items.map(e => entryName(e)).join(", ")} (Treasure: Discarded)`);
    party.api("DELETE", `api/discard/${d.id}`).catch(() => discardsTaken.delete(d.id));
  }
}

