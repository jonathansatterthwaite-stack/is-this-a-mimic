// Campaigns and files: Settings → Campaigns (pick, make and edit campaigns) and Settings → Files
// (everything you've made, by kind: campaigns, characters, rule packages, drawings, shops, GM
// controls and pictures, to export, copy, move or delete). The data model is in store.js.

const fmtBytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const sizeOf = v => new Blob([JSON.stringify(v)]).size;
const allCharacters = () => store.campaigns().flatMap(c => c.characters.map(ch => ({ char: ch, campaign: c })));

// ------------------------------------------------------------------ campaigns

// In a party the GM decides the campaign: switching here would take the characters out of it.
function campaignLocked() {
  if (!party.active) return false;
  toast("In a party the campaign is the GM's choice. Leave the party to switch campaigns.");
  return true;
}

function switchCampaign(id) {
  if (id === store.campaign().id || campaignLocked()) return;
  commit(() => { store.data.activeCampaign = id; store.campaign().lastPlayed = Date.now(); });
  resetList("inventory"); // its filters were for the other campaign's items
  toast(`Now playing ${store.campaign().name}`);
}

// Make, or edit, a campaign: its name, notes, rules settings and the rule packages it uses.
function editCampaign(camp = null) {
  const isNew = !camp;
  const draft = isNew ? { name: "", notes: "", system: systemById(store.campaign().system) ? store.campaign().system : defaultSystemId(), packages: [...store.campaign().packages], home: store.campaign().home, settings: { ...store.campaign().settings } }
    : { name: camp.name, notes: camp.notes || "", system: camp.system, packages: [...camp.packages], home: camp.home, settings: { ...camp.settings } };
  let close;
  const pkgBox = h("div", { class: "group pkg-choice" });
  const drawPkgs = () => setChildren(pkgBox, store.packages().length ? store.packages().map(p => {
    const on = draft.packages.includes(p.id);
    return h("div", { class: "row" },
      h("label", { class: "check grow" }, h("input", { type: "checkbox", checked: on, onchange: e => {
        draft.packages = e.target.checked ? [...draft.packages, p.id] : draft.packages.filter(x => x !== p.id);
        if (!draft.packages.includes(draft.home)) draft.home = draft.packages[0] || null;
        drawPkgs();
      } }), h("span", null, h("b", null, p.name), h("span", { class: "muted small" }, ` · ${plural(p.customItems.length, "item")}, ${plural(p.templates.length, "template")}`))),
      on && h("label", { class: "check small", title: "New custom items and templates go into this package" },
        h("input", { type: "radio", name: "home-pkg", checked: draft.home === p.id, onchange: () => { draft.home = p.id; } }), " new items here"));
  }) : h("p", { class: "muted pad" }, "No rule packages yet."));
  drawPkgs();
  // Rules settings: coin weight, and the ones the chosen system uses.
  const rulesBox = h("div", { class: "form grid" });
  const drawRules = () => setChildren(rulesBox,
    usesSetting("encumbrance", systemById(draft.system) || NO_SYSTEM) && h("label", { class: "field" }, h("span", null, "Encumbrance"),
      h("select", { onchange: e => { draft.settings.encumbrance = e.target.value; } },
        [["standard", "Standard (capacity = STR × 15)"], ["variant", "Variant (speed penalties at STR × 5 / × 10)"], ["off", "Off"]]
          .map(([v, l]) => h("option", { value: v, selected: draft.settings.encumbrance === v }, l)))),
    currency(systemById(draft.system) || NO_SYSTEM).perWeight > 0 && h("label", { class: "check field" },
      h("input", { type: "checkbox", checked: draft.settings.coinWeight !== false, onchange: e => { draft.settings.coinWeight = e.target.checked; } }),
      ` Coins have weight (${currency(systemById(draft.system) || NO_SYSTEM).perWeight} coins = 1 ${weightUnit(systemById(draft.system) || NO_SYSTEM)})`));
  drawRules();
  const save = () => {
    const name = draft.name.trim() || (isNew ? "New campaign" : camp.name);
    close();
    commit(() => {
      if (isNew) {
        const c = newCampaign(name, draft.packages, draft.system || null);
        Object.assign(c, { notes: draft.notes, home: draft.home, settings: draft.settings, lastPlayed: Date.now() });
        store.data.campaigns.push(c);
        if (!party.active) store.data.activeCampaign = c.id;
      } else {
        Object.assign(camp, { name, notes: draft.notes, system: draft.system || null, packages: draft.packages, home: draft.home, settings: { ...camp.settings, ...draft.settings } });
      }
      normalizeData(store.data);
    }, isNew ? `Made the campaign ${name}` : `Saved ${name}`, true);
  };
  close = openModal(isNew ? "New campaign" : `Edit ${camp.name}`, h("div", { class: "form" },
    h("label", { class: "field" }, h("span", null, "Name"),
      h("input", { type: "text", value: draft.name, maxlength: 80, placeholder: "e.g. Curse of the Brass Sea", oninput: e => { draft.name = e.target.value; } })),
    h("label", { class: "field" }, h("span", null, "Notes"),
      h("textarea", { rows: 2, value: draft.notes, placeholder: "Where you left off, house rules, who's playing…", oninput: e => { draft.notes = e.target.value; } })),
    h("h4", null, "Rules"),
    h("label", { class: "field" }, h("span", null, "Game system"),
      h("select", { onchange: e => { draft.system = e.target.value || null; drawRules(); } },
        systems().map(x => h("option", { value: x.id, selected: draft.system === x.id }, x.name)),
        // A campaign whose system you don't have (from a file) keeps it until you choose another.
        draft.system && !systemById(draft.system) && h("option", { value: draft.system, selected: true }, `${systemName(draft.system)} (you don't have it)`),
        h("option", { value: "", selected: !draft.system }, NO_SYSTEM.name)),
      h("span", { class: "muted small" }, "Its templates, catalog, money and panels. Add others in Files. "
        + (isNew ? "" : "Items already made keep their details if it changes."))),
    rulesBox,
    h("h4", null, "Rule packages"),
    h("p", { class: "muted small" }, "Custom items and templates come in packages, shared between campaigns. Tick the ones this campaign uses; its catalog shows their items."),
    pkgBox), { wide: true, footer: [
    h("button", { class: "btn", onclick: () => close() }, "Cancel"),
    h("button", { class: "btn primary", onclick: save }, icon("check"), isNew ? "Make campaign" : "Save"),
  ] });
}

function duplicateCampaign(camp) {
  commit(() => {
    const copy = clone(camp);
    copy.id = "cmp" + uid();
    copy.name = camp.name + " (copy)";
    copy.created = Date.now();
    delete copy.party;
    // The copy's characters are separate characters (a party would treat the same ids as one).
    for (const ch of copy.characters) {
      const id = uid();
      if (copy.activeId === ch.id) copy.activeId = id;
      ch.id = id;
    }
    store.data.campaigns.push(copy);
  }, `Copied ${camp.name}`, true);
}

function deleteCampaign(camp) {
  if (store.campaigns().length < 2) return toast("There has to be at least one campaign");
  if (camp.id === store.campaign().id && campaignLocked()) return;
  confirmDialog(`Delete the campaign “${camp.name}” with its ${plural(camp.characters.length, "character")}, shops and GM controls? Rule packages and drawings are kept.`, "Delete", () =>
    commit(() => {
      store.data.campaigns = store.data.campaigns.filter(c => c.id !== camp.id);
      normalizeData(store.data);
    }, `Deleted ${camp.name}`, true));
}

// The drawings some items use, from the library (so an export carries them).
const drawingsUsedBy = items => {
  const ids = new Set(items.map(it => it.iconLib).filter(Boolean));
  return drawingLibrary().filter(d => ids.has(d.id));
};

async function exportCampaign(camp) {
  const packages = store.packages().filter(p => camp.packages.includes(p.id));
  const items = [...camp.characters.flatMap(c => c.items.map(e => e.item)), ...packages.flatMap(p => p.customItems)];
  // An imported system goes with it (the ones that come with the app are in every copy of it).
  const sys = store.data.systems.find(x => x.id === camp.system && !x.bundled);
  download(`${safeName(camp.name)}.campaign.json`, fileOf("campaign", { campaign: camp, packages, system: sys, drawings: drawingsUsedBy(items),
    images: await bundleImages(new Set([...campaignImageRefs([camp]), ...allImageRefs([], packages.flatMap(p => p.customItems))])) }));
}

// Which character a campaign is played as: a dropdown inset in its card. For the campaign being
// played it switches character (in a party, among this device's characters there).
function campaignCharacterPick(camp, current) {
  const chars = current && party.active ? party.linked() : camp.characters.filter(c => !isBlankCharacter(c) || c.id === camp.activeId);
  if (!chars.length) return null;
  const sel = h("select", { "aria-label": `${termCap("character")} for ${camp.name}`, disabled: chars.length < 2,
    onchange: ev => commit(() => { camp.activeId = ev.target.value; }, current ? `Now playing ${chars.find(c => c.id === ev.target.value)?.name}` : null) },
    chars.map(c => h("option", { value: c.id, selected: c.id === camp.activeId }, c.name)));
  return h("label", { class: "campaign-pick" }, h("span", { class: "small muted" }, "Playing as"), sel);
}

function campaignsView() {
  const active = store.campaign();
  const card = camp => {
    const current = camp.id === active.id;
    const pkgs = store.packages().filter(p => camp.packages.includes(p.id));
    const players = camp.characters.filter(c => !isBlankCharacter(c));
    const facts = [
      campaignCharacterPick(camp, current),
      h("dl", { class: "campaign-facts" },
        h("dt", null, "Game system"), h("dd", null, systemName(camp.system), camp.system && !systemById(camp.system) && h("span", { class: "warn-text small" }, " (you don't have it: import it in Files)")),
        !current && [h("dt", null, termCap("characters")), h("dd", null, players.length ? players.map(c => c.name).join(", ") : "None yet")],
        h("dt", null, "Rule packages"), h("dd", null, pkgs.length ? pkgs.map(p => p.name).join(", ") : "None"),
        (camp.shops.length > 0 || camp.gmControls.length > 0) && [h("dt", null, "GM"), h("dd", null,
          [camp.shops.length && plural(camp.shops.length, "shop"), camp.gmControls.length && plural(camp.gmControls.length, "panel")].filter(Boolean).join(", "))],
        camp.lastPlayed && [h("dt", null, "Last played"), h("dd", null, new Date(camp.lastPlayed).toLocaleDateString())]),
      h("div", { class: "inline wrap campaign-actions" },
        !party.active && !current && h("button", { class: "btn primary", onclick: () => switchCampaign(camp.id) }, "Play this campaign"),
        party.isGm() && camp.id !== party.campaign?.id && h("button", { class: "btn primary", onclick: async () => {
          try { await party.loadCampaign(camp); } catch (e) { toast(e.message); }
        } }, icon("users"), "Load into the party"),
        h("button", { class: "btn", onclick: () => editCampaign(camp) }, icon("edit"), "Edit"),
        h("button", { class: "btn", onclick: () => duplicateCampaign(camp) }, icon("copy"), "Copy"),
        h("button", { class: "btn", onclick: () => exportCampaign(camp) }, icon("download"), "Export"),
        store.campaigns().length > 1 && iconBtn("trash", `Delete ${camp.name}`, () => deleteCampaign(camp), "danger-hover"))];
    return h("div", { class: "campaign-card" + (current ? " current open" : "") },
      h("div", { class: "campaign-head" },
        h("h3", null, camp.name), current && h("span", { class: "tag on" }, party.active ? "in this party" : "playing")),
      camp.notes && h("p", { class: "muted small campaign-notes" }, camp.notes),
      // The one being played opens up: its characters and rules beside its facts (stacked when narrow).
      current ? h("div", { class: "campaign-open" }, h("div", { class: "campaign-block" }, facts), campaignCharactersBlock(), campaignRulesBlock()) : facts);
  };
  return h("div", { class: "view-campaigns" },
    h("div", { class: "section-head" }, h("h2", null, "Campaigns"),
      h("button", { class: "btn primary", onclick: () => editCampaign(null) }, icon("plus"), "New campaign")),
    h("p", { class: "muted small" }, party.active
      ? "In a party, the campaign is the one the GM has loaded. Your other campaigns wait here until you leave."
      : `Each campaign has its own ${term("characters")}, shops and ${term("gm")} controls. Rule packages and drawings are shared: each campaign picks the packages it uses.`),
    cardGrid([active, ...store.campaigns().filter(c => c !== active)].map(card), { cls: "campaign-grid", min: 300 }));
}

// A quick switcher (the campaign line in the header, or the character menu).
function openCampaignSwitcher() {
  if (campaignLocked()) return;
  let close;
  close = openModal("Campaign", h("div", { class: "group" },
    store.campaigns().map(c => h("button", { class: "row row-main switch" + (c.id === store.campaign().id ? " equipped" : ""),
      onclick: () => { close(); switchCampaign(c.id); } },
      icon("book"), h("div", null, h("div", { class: "row-title" }, c.name),
        h("div", { class: "row-sub" }, plural(c.characters.filter(x => !isBlankCharacter(x)).length, "character"))))),
    h("button", { class: "btn wide", onclick: () => { close(); ui.settingsTab = "campaigns"; go("settings"); } }, icon("sliders"), "Manage campaigns")));
}

// ------------------------------------------------------------------ rule packages

function editPackage(pkg = null) {
  let name = pkg ? pkg.name : "", notes = pkg?.notes || "", close;
  const save = () => {
    close();
    commit(() => {
      if (pkg) Object.assign(pkg, { name: name.trim() || pkg.name, notes });
      else {
        const p = newPackage(name.trim() || "New rule package");
        p.notes = notes;
        store.data.packages.push(p);
        store.campaign().packages.push(p.id); // this campaign uses it straight away
      }
    }, pkg ? "Saved the package" : "Made a rule package", true);
  };
  close = openModal(pkg ? `Edit ${pkg.name}` : "New rule package", h("div", { class: "form" },
    h("label", { class: "field" }, h("span", null, "Name"), h("input", { type: "text", value: name, maxlength: 80, placeholder: "e.g. Brass Sea homebrew, Firearms", oninput: e => { name = e.target.value; } })),
    h("label", { class: "field" }, h("span", null, "Notes"), h("textarea", { rows: 2, value: notes, oninput: e => { notes = e.target.value; } }))),
  { footer: [h("button", { class: "btn", onclick: () => close() }, "Cancel"), h("button", { class: "btn primary", onclick: save }, icon("check"), "Save")] });
}

function duplicatePackage(pkg) {
  commit(() => {
    const copy = clone(pkg);
    copy.id = "pkg" + uid();
    copy.name = pkg.name + " (copy)";
    // New ids for its items and templates, so both packages can be used at once.
    const tplIds = {};
    for (const t of copy.templates) { tplIds[t.id] = "tpl-" + uid(); t.id = tplIds[t.id]; }
    for (const t of copy.templates) if (tplIds[t.from]) t.from = tplIds[t.from];
    for (const i of copy.customItems) { i.id = "custom-" + uid(); if (tplIds[i.template]) i.template = tplIds[i.template]; }
    store.data.packages.push(copy);
  }, `Copied ${pkg.name}`, true);
}

function deletePackage(pkg) {
  const users = store.campaigns().filter(c => c.packages.includes(pkg.id));
  confirmDialog(`Delete the rule package “${pkg.name}” (${plural(pkg.customItems.length, "item")}, ${plural(pkg.templates.length, "template")})?`
    + (users.length ? ` ${users.map(c => c.name).join(", ")} ${users.length === 1 ? "uses" : "use"} it.` : "") + " Copies already in inventories are kept.", "Delete", () =>
    commit(() => {
      store.data.packages = store.data.packages.filter(p => p.id !== pkg.id);
      normalizeData(store.data);
    }, `Deleted ${pkg.name}`, true));
}

async function exportPackage(pkg) {
  download(`${safeName(pkg.name)}.package.json`, fileOf("package", { package: pkg, drawings: drawingsUsedBy(pkg.customItems),
    images: await bundleImages(allImageRefs([], pkg.customItems)) }));
}

// ------------------------------------------------------------------ the Files view

function deleteSystem(sys) {
  const users = store.campaigns().filter(c => c.system === sys.id);
  if (users.length) return toast(`${users.map(c => c.name).join(", ")} ${users.length === 1 ? "plays" : "play"} ${sys.name}: choose another system for ${users.length === 1 ? "it" : "them"} first`);
  confirmDialog(isBundled(sys) ? `Remove ${sys.name}? It comes with the app, so you can add it again from Files.` : `Remove the game system “${sys.name}”?`, "Remove", () =>
    commit(() => { store.data.systems = store.data.systems.filter(x => x.id !== sys.id); }, `Removed ${sys.name}`, true));
}

function moveCharacter(char, from) {
  if (party.isLinked(char.id)) return toast(`${char.name} is playing in the party: leave it first, or move another character`);
  let close;
  close = openModal(`Move ${char.name}`, h("div", { class: "group" }, store.campaigns().filter(c => c !== from).map(c =>
    h("button", { class: "row row-main switch", onclick: () => {
      close();
      commit(() => {
        from.characters = from.characters.filter(x => x.id !== char.id);
        normalizeData(store.data); // a campaign left with none gets a blank one
        c.characters = c.characters.filter(x => !isBlankCharacter(x));
        c.characters.push(char);
        normalizeData(store.data);
      }, `Moved ${char.name} to ${c.name}`, true);
    } }, icon("book"), h("div", null, h("div", { class: "row-title" }, c.name))))));
}

function duplicateCharacter(char, camp) {
  commit(() => { camp.characters.push({ ...clone(char), id: uid(), name: char.name + " (copy)" }); }, `Copied ${char.name}`, true);
}

function deleteCharacter(char, camp) {
  confirmDialog(party.isLinked(char.id) ? `Delete ${char.name} from this device? They also leave the party, and their inventory is deleted from the host.`
    : `Delete ${char.name} and their whole inventory?`, "Delete", () => commit(() => {
    camp.characters = camp.characters.filter(x => x.id !== char.id);
    normalizeData(store.data);
  }, `Deleted ${char.name}`, true));
}

async function exportCharacter(c) {
  download(`${safeName(c.name)}.json`, fileOf("character", { character: c,
    templates: store.allTemplates().filter(t => c.items.some(e => e.item.template === t.id)),
    images: await bundleImages(allImageRefs([c])) }));
}

// One kind of file: a heading with a count, then a row per file.
function filesSection(title, rows, extra = null, note = null, count = rows.length) {
  const key = "files:" + title, closed = ui.collapsed.has(key);
  const toggle = () => { closed ? ui.collapsed.delete(key) : ui.collapsed.add(key); render(); };
  return h("section", { class: "group files-section" },
    h("div", { class: "group-head" },
      h("button", { class: "collapse" + (closed ? " closed" : ""), "aria-expanded": String(!closed), onclick: toggle }, icon("chevron"), h("h3", null, title)),
      count != null && h("span", { class: "muted small" }, String(count)), extra),
    !closed && [note && h("p", { class: "muted small pad" }, note),
      rows.length ? rows : h("p", { class: "muted pad" }, "None.")]);
}

function fileRow(iconEl, title, sub, size, actions) {
  return h("div", { class: "row file-row" }, iconEl,
    h("div", { class: "row-main static" }, h("div", { class: "row-title" }, title), sub && h("div", { class: "row-sub" }, sub)),
    size != null && h("span", { class: "muted small file-size" }, fmtBytes(size)),
    h("div", { class: "file-actions" }, actions));
}

const fileBtn = (ic, label, fn, cls = "") => iconBtn(ic, label, fn, cls);

function filesView() {
  const fileInput = h("input", { type: "file", accept: "application/json,.json", hidden: true,
    onchange: e => { if (e.target.files[0]) importFile(e.target.files[0]); e.target.value = ""; } });
  const total = sizeOf(store.data);
  const camps = store.campaigns();
  const usedPkg = p => camps.filter(c => c.packages.includes(p.id)).map(c => c.name);
  const usedSys = x => camps.filter(c => c.system === x.id).map(c => c.name);

  const picturesBox = h("div", { class: "files-pictures" }, h("p", { class: "muted pad" }, "Looking for pictures…"));
  drawPictures(picturesBox);

  return h("div", { class: "view-files" },
    h("div", { class: "section-head" }, h("h2", null, "Files"),
      h("div", { class: "inline wrap" },
        h("button", { class: "btn", onclick: () => fileInput.click() }, icon("upload"), "Import a file"),
        h("button", { class: "btn", onclick: exportAll }, icon("download"), "Export everything"), fileInput)),
    h("p", { class: "muted small" }, `Everything you've made, saved ${kv.remote && party.app?.localStore ? "on this " + (party.app.android ? "phone" : "PC") : "in this browser"}: ${fmtBytes(total)} of data, plus pictures. `
      + "Import takes any file exported here: a whole backup, a campaign, a character, a rule package or a drawing."),

    // Two columns on a wide page: the campaigns' own things, then what's made and shared.
    pageColumns([
    filesSection("Campaigns", camps.map(c => fileRow(icon("book"), [c.name, c === store.campaign() && h("span", { class: "tag on" }, "current")],
      `${plural(c.characters.length, term("character"), term("characters"))} · ${plural(c.shops.length, "shop")} · ${plural(c.gmControls.length, "GM panel")}`, sizeOf(c), [
        fileBtn("edit", `Edit ${c.name}`, () => editCampaign(c)),
        fileBtn("download", `Export ${c.name}`, () => exportCampaign(c)),
        fileBtn("copy", `Copy ${c.name}`, () => duplicateCampaign(c)),
        camps.length > 1 && fileBtn("trash", `Delete ${c.name}`, () => deleteCampaign(c), "danger-hover"),
      ]))),

    filesSection(termCap("characters"), allCharacters().map(({ char, campaign }) => fileRow(icon("user"), char.name,
      `${campaign.name} · ${entriesLabel(char)} · ${coinSummary(char.coins)}`, sizeOf(char), [
        fileBtn("download", `Export ${char.name}`, () => exportCharacter(char)),
        camps.length > 1 && fileBtn("move", `Move ${char.name} to another campaign`, () => moveCharacter(char, campaign)),
        fileBtn("copy", `Copy ${char.name}`, () => duplicateCharacter(char, campaign)),
        fileBtn("trash", `Delete ${char.name}`, () => deleteCharacter(char, campaign), "danger-hover"),
      ]))),

    filesSection("Shops", camps.flatMap(c => c.shops.map(sh => fileRow(icon("cart"), sh.name, `${c.name} · ${plural(sh.items.length, "item")}`, sizeOf(sh), [
      fileBtn("trash", `Delete ${sh.name}`, () => confirmDialog(`Delete the shop “${sh.name}”?`, "Delete",
        () => commit(() => { c.shops = c.shops.filter(x => x.id !== sh.id); }, `Deleted ${sh.name}`, true)), "danger-hover"),
    ]))), null, party.active ? "The party's shops are kept by its host; these are your campaigns' own." : null),

    filesSection("GM panels", camps.flatMap(c => c.gmControls.map(g => fileRow(icon("grid"), g.name, `${c.name} · ${plural(g.controls.length, "control")}`, sizeOf(g), [
      fileBtn("trash", `Delete ${g.name}`, () => confirmDialog(`Delete the panel “${g.name}”?`, "Delete",
        () => commit(() => { c.gmControls = c.gmControls.filter(x => x.id !== g.id); }, `Deleted ${g.name}`, true)), "danger-hover"),
    ])))),
    ], [

    filesSection("Rule packages", store.packages().map(p => fileRow(icon("package"), p.name,
      `${plural(p.customItems.length, "item")}, ${plural(p.templates.length, "template")} · ${usedPkg(p).length ? "used by " + usedPkg(p).join(", ") : "not used by any campaign"}`, sizeOf(p), [
        fileBtn("edit", `Rename ${p.name}`, () => editPackage(p)),
        fileBtn("download", `Export ${p.name}`, () => exportPackage(p)),
        fileBtn("copy", `Copy ${p.name}`, () => duplicatePackage(p)),
        fileBtn("trash", `Delete ${p.name}`, () => deletePackage(p), "danger-hover"),
      ])), h("button", { class: "btn", onclick: () => editPackage(null) }, icon("plus"), "New"),
      "Custom items and templates. Each campaign chooses the packages it uses (Campaigns → Edit)."),

    filesSection("Game systems", [
      ...systems().map(x => fileRow(icon("book"), x.name,
        `${isBundled(x) ? "Comes with the app · " : ""}${plural((x.templates || []).length, "template")} · ${plural((x.catalog || []).length, "catalog item")} · ${usedSys(x).length ? "played by " + usedSys(x).join(", ") : "no campaign plays it"}`,
        isBundled(x) ? null : sizeOf(x), [
          fileBtn("download", `Export ${x.name}`, () => download(`${safeName(x.name)}.system.json`, systemFile(x))),
          fileBtn("trash", `Remove ${x.name}`, () => deleteSystem(x), "danger-hover"),
        ])),
      // Ones that come with the app and were removed: added back with a tap.
      ...BUNDLED_SYSTEMS.filter(b => !systemById(b.id)).map(b => fileRow(icon("book"), b.name, "Comes with the app · not added", null, [
        h("button", { class: "btn", onclick: () => commit(() => installSystem({ id: b.id }), `Added ${b.name}`, true) }, icon("plus"), "Add"),
      ])),
    ], null, "What a campaign plays: its templates, groups, features, catalog and panels. A campaign can also play none. Others come as files to import (Import a file).", systems().length),

    filesSection("Drawings", drawingLibrary().map(d => fileRow(h("span", { class: "file-thumb" }, drawnIcon(d.svg, "file-svg") || icon("image")), d.name,
      `Used in ${plural(drawingUsers(d.id).length, "place")}${isLiveDrawing(d.doc) ? " · live" : ""}`, sizeOf(d), [
        fileBtn("download", `Export ${d.name}`, () => download(`${safeName(d.name)}.drawing.json`, fileOf("drawing", { drawing: d }))),
        fileBtn("trash", `Delete ${d.name}`, () => confirmDialog(`Delete the drawing “${d.name}”? Items using it keep their icon.`, "Delete",
          () => commit(s => { s.iconLibrary = s.iconLibrary.filter(x => x.id !== d.id); for (const it of drawingUsers(d.id)) delete it.iconLib; }, `Deleted “${d.name}”`, true)), "danger-hover"),
      ])), null, "Icons drawn in the icon editor (SVG). Items → Catalog → Drawings edits them."),

    filesSection("Pictures", [picturesBox], null, "Pictures in documents, item images, set pieces and GM control backgrounds.", null),
    dataCard(),
    ]));
}

// Pictures: every one saved on this device, which are used, and clearing the unused ones.
async function drawPictures(box) {
  const used = new Set([...campaignImageRefs(store.campaigns()), ...allImageRefs([], store.allCustomItems())]);
  const list = await imageStore.list();
  const unused = list.filter(p => !used.has(p.id));
  const bytes = list.reduce((n, p) => n + p.bytes, 0);
  setChildren(box,
    h("p", { class: "muted small pad" }, `${plural(list.length, "picture")}, ${fmtBytes(bytes)}` + (unused.length ? ` · ${unused.length} not used by anything` : "")),
    unused.length > 0 && h("div", { class: "pad" }, h("button", { class: "btn", onclick: () => confirmDialog(
      `Delete ${plural(unused.length, "picture")} that nothing uses (${fmtBytes(unused.reduce((n, p) => n + p.bytes, 0))})? This can't be undone.`, "Delete", async () => {
        for (const p of unused) await imageStore.remove(p.id);
        toast(`Cleared ${plural(unused.length, "unused picture")}`);
        drawPictures(box);
      }) }, icon("trash"), "Clear unused pictures")),
    h("div", { class: "picture-grid" }, list.map(p => h("figure", { class: "picture-tile" + (used.has(p.id) ? "" : " unused"), title: used.has(p.id) ? "In use" : "Not used by anything" },
      storedImage(p.id, "picture-thumb"), h("figcaption", { class: "muted small" }, fmtBytes(p.bytes), !used.has(p.id) && " · unused")))));
}

// ------------------------------------------------------------------ the Settings tab: This device · Campaigns · Files

const SETTINGS_TABS = [["settings", "This device"], ["campaigns", "Campaigns"], ["files", "Files"]];

function renderSettingsTabs() {
  const tab = SETTINGS_TABS.some(([k]) => k === ui.settingsTab) ? ui.settingsTab : "settings";
  return h("div", { class: "view-settings-tabs" },
    subTabs("Settings", SETTINGS_TABS, tab, k => { ui.settingsTab = k; render(); }),
    tab === "campaigns" ? campaignsView() : tab === "files" ? filesView() : renderSettings());
}
