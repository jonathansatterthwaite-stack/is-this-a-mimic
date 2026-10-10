// Shops: curated item lists with prices and (optionally) limited stock.
//
// Where they live:
// - In a party: on the party host's server. GMs curate; players see open shops in the party
//   snapshot and buy through the server (coins, item and stock change together).
// - Otherwise: in the campaign (store.state.shops), where a GM prepares them; they go to the
//   party when the campaign is loaded into it.

const shopStore = {
  all: [],        // manager's full list from the server
  loaded: false,
  tried: false,     // the Shops tab asked for the list at least once

  // In a party, shops are the host's (and GMs manage them); otherwise they're the campaign's own.
  server() { return party.active; },
  canManage() { return party.active ? party.isGm() : true; },
  base() { return party.active ? party.base : ""; },

  list() {
    if (!this.server()) return store.state.shops || [];
    return this.canManage() ? this.all : party.shops || [];
  },

  find(id) { return this.list().find(s => s.id === id); },

  request(method, url, body) { return apiRequest(this.base() + url, method, body, party.token); },

  // Managers fetch every shop (including closed ones) from the server. Calls
  // made while a fetch is running wait for a fresh one, so callers always see
  // their own changes.
  refresh() {
    if (!this.server() || !this.canManage()) return Promise.resolve();
    if (this.inflight) {
      this.again = true;
      return this.inflight;
    }
    this.inflight = (async () => {
      do {
        this.again = false;
        try {
          this.all = (await this.request("GET", "api/shops")).shops || [];
          this.loaded = true;
        } catch (e) {
          console.warn("Couldn't load shops", e);
        }
      } while (this.again);
    })().finally(() => {
      this.inflight = null;
      if (ui.view === "shops") render();
    });
    return this.inflight;
  },

  async save(shop) {
    if (!this.server()) {
      commit(s => {
        s.shops = s.shops || [];
        if (!shop.id) shop.id = "shop-" + uid();
        const i = s.shops.findIndex(x => x.id === shop.id);
        if (i >= 0) s.shops[i] = shop; else s.shops.push(shop);
      });
      return shop.id;
    }
    let id = shop.id;
    if (!id) {
      id = (await this.request("POST", "api/shops", { shop })).id;
    } else {
      await this.request("PUT", "api/shops/" + id, { shop, baseRev: shop.rev });
    }
    await this.refresh();
    return id;
  },

  async remove(shop) {
    if (!this.server()) {
      commit(s => { s.shops = (s.shops || []).filter(x => x.id !== shop.id); }, `Deleted ${shop.name}`, true);
      return;
    }
    await this.request("DELETE", "api/shops/" + shop.id);
    await this.refresh();
  },
};

// ------------------------------------------------------------------ following values (Clockwork)
// A shop can follow Global values (js/clockwork.js): open while a condition holds (openIf),
// prices times a value (priceValue), an item for sale only while a condition holds (a listing's
// onlyIf). A condition is { name, op, to }; a value that isn't set counts as 0. In a party the
// host checks the same (shop_open, price_factor and cond_holds in server.py; PartyServer.java).

const COND_OPS = [["=", "is"], ["!=", "isn't"], ["<", "is under"], ["<=", "is at most"], [">", "is over"], [">=", "is at least"]];
function condHolds(c) {
  if (!c || !clockworkOn()) return true; // (values switched off: always)
  const v = globalValue(c.name) ?? 0, to = c.to;
  return { "=": v === to, "!=": v !== to, "<": v < to, "<=": v <= to, ">": v > to, ">=": v >= to }[c.op] ?? true;
}
const condWords = c => `${c.name} ${COND_OPS.find(o => o[0] === c.op)?.[1] || c.op} ${c.to}`;
const shopOpen = shop => shop.openIf && clockworkOn() ? condHolds(shop.openIf) : !!shop.open;
// What prices are multiplied by: the shop's price value (1 while it isn't set), from 0 to 100.
function shopPriceFactor(shop) {
  const v = shop.priceValue && clockworkOn() ? globalValue(shop.priceValue) : undefined;
  return typeof v === "number" ? Math.max(0, Math.min(100, v)) : 1;
}

// Price of one lot (a whole bundle, for ammunition) after the shop's markup and price value, in
// copper. (Worked out in the same order as listing_price() in server.py, so it's what's charged.)
function listingPrice(shop, listing) {
  const base = listing.price != null ? listing.price : listing.item.cost || 0;
  return Math.max(0, Math.round(base * (100 + (shop.markup || 0)) * shopPriceFactor(shop) / 100));
}

// A condition, edited in place as obj[key] (cleared when the value name is empty).
function condEditor(obj, key, aria) {
  const c = obj[key] || { name: "", op: ">=", to: 1 };
  const listId = "cond-" + uid();
  const put = () => { if (isValueName(c.name)) obj[key] = { name: c.name, op: c.op, to: c.to }; else delete obj[key]; };
  return h("div", { class: "cond-edit" },
    h("input", { type: "text", list: listId, value: obj[key]?.name || "", placeholder: "Global value", spellcheck: "false", autocomplete: "off",
      "aria-label": `${aria}: value`, class: "cond-name", onchange: e => { c.name = e.target.value.trim(); e.target.classList.toggle("invalid", !!c.name && !isValueName(c.name)); put(); } }),
    h("select", { "aria-label": `${aria}: comparison`, onchange: e => { c.op = e.target.value; put(); } },
      COND_OPS.map(([op, words]) => h("option", { value: op, selected: c.op === op }, words))),
    h("input", { type: "number", step: "any", value: c.to, "aria-label": `${aria}: number`, class: "cond-to",
      onchange: e => { c.to = Number.isFinite(+e.target.value) ? +e.target.value : 0; put(); } }),
    h("datalist", { id: listId }, [...knownValues().values()].filter(v => v.scope === "global").map(v => h("option", { value: v.name }))));
}

function stockLabel(listing) {
  if (listing.stock == null) return null;
  return listing.stock === 0 ? "Sold out" : `${listing.stock} left`;
}

// What a shop pays for `qty` of an inventory entry, in copper. Most specific
// rule wins: this item's own rule, then its type's %, then the shop's default %.
// (Same as sell_offer() in server.py and sellOffer() in PartyServer.java.)
function sellOffer(shop, entry, qty) {
  if (!shop.buys) return 0;
  const item = entry.item ? currentItem(entry) : {}; // as it is now (identified, cursed…)
  const bundle = Math.max(1, item.bundle || 1);
  const rule = (shop.sellItems || []).find(r => r.srcId === entry.srcId);
  if (rule && rule.mode === "fixed") return Math.floor(rule.value * qty / bundle);
  const rates = shop.typeRates || {};
  const pct = rule ? rule.value : item.type in rates ? rates[item.type] : shop.sellRate ?? 50;
  return Math.floor((Math.trunc(item.cost || 0) * qty * pct) / (bundle * 100));
}

function buysLabel(shop) {
  return shop.buys ? `Buys items · ${shop.sellRate ?? 50}% of list price` : null;
}

function markupLabel(shop) {
  const m = shop.markup || 0, f = shopPriceFactor(shop);
  return [m > 0 ? `Prices +${m}%` : m < 0 ? `Prices ${m}% (discount)` : null, f !== 1 ? `Prices × ${f}` : null].filter(Boolean).join(" · ") || null;
}

function shopIcon(shop, cls) {
  const el = iconSvg(shop.icon && ICON_BY_ID.has(shop.icon) ? shop.icon : "coins", "shop-icon " + (cls || ""));
  el.style.color = "var(--accent)";
  return el;
}

// ------------------------------------------------------------------ buying

async function buyFromShop(shop, listing, lots) {
  const char = store.char();
  if (!char) return toast("Pick a character first");
  const total = listingPrice(shop, listing) * lots;
  const bundle = listing.item.bundle || 1;
  const label = `${lots > 1 ? lots + " × " : ""}${listing.item.name}`;
  try {
    if (party.active) {
      if (!requireLinked(char)) return false;
      // The host checks stock and coins and moves everything at once.
      await party.put(char.id);
      await shopStore.request("POST", `api/shops/${shop.id}/buy`, { character: char.id, lid: listing.lid, qty: lots });
      toast(`Bought ${label} for ${fmtCost(total)}`);
      shopStore.refresh();
      return true;
    }
    if (!condHolds(listing.onlyIf)) return toast(`${listing.item.name} isn't for sale right now`), false;
    const purse = payCoins(char.coins, total, shopMargin(shop));
    if (!purse) return toast(`${char.name} can't afford ${fmtCost(total)}`), false;
    if (shopStore.server()) {
      // Buying for a solo character on the host: reserve the stock first (the host adds the money to the till).
      await shopStore.request("POST", `api/shops/${shop.id}/take`, { lid: listing.lid, qty: lots });
      shopStore.refresh();
    } else {
      commit(s => {
        const sh = s.shops.find(x => x.id === shop.id);
        const li = sh.items.find(x => x.lid === listing.lid);
        if (li.stock != null) li.stock -= lots;
        if (sh.funds != null) sh.funds += total;
      });
    }
    commit((s, c) => {
      c.coins = purse;
      addToInventory(c, { ...clone(listing.item), id: listing.srcId || "shop-" + listing.lid }, lots * bundle);
    }, `Bought ${label} for ${fmtCost(total)}`, !shopStore.server()); // Undo can't restore stock held by the host
    return true;
  } catch (e) {
    toast(e.message);
    if (shopStore.canManage()) shopStore.refresh();
    return false;
  }
}

function openBuy(shop, listing) {
  const char = store.char();
  const unit = listingPrice(shop, listing);
  const max = listing.stock == null ? 99 : listing.stock;
  let lots = 1, close, qtyIn;
  const totalEl = h("p", { class: "big-num" });
  const after = h("p", { class: "muted small" });
  const buyBtn = h("button", { class: "btn primary" }, icon("cart"), "Buy");
  const draw = () => {
    const total = unit * lots;
    totalEl.textContent = total ? fmtCost(total) : "Free";
    const purse = char && payCoins(char.coins, total, shopMargin(shop));
    after.textContent = !char ? "" : purse ? `${char.name} has ${fmtMoney(coinTotalCp(char.coins))}; afterwards ${fmtMoney(coinTotalCp(purse))}`
      : `${char.name} only has ${fmtMoney(coinTotalCp(char.coins))}`;
    buyBtn.disabled = !purse;
  };
  buyBtn.onclick = async () => {
    buyBtn.disabled = true;
    if (await buyFromShop(shop, listing, lots)) close();
    else draw();
  };
  const bundle = listing.item.bundle || 1;
  draw();
  close = openModal(`Buy ${listing.item.name}`, [
    h("div", { class: "form" },
      h("div", { class: "buy-head" }, itemIcon(listing.item, "big-icon"),
        h("div", null, h("b", null, listing.item.name), h("div", { class: "muted small" }, itemSummary(listing.item)),
          h("div", { class: "small" }, fmtCost(unit), bundle > 1 ? ` per ${bundle}` : " each", stockLabel(listing) ? ` · ${stockLabel(listing)}` : ""))),
      h("label", { class: "field" }, h("span", null, bundle > 1 ? `How many bundles of ${bundle}` : "How many"),
        h("div", { class: "qty buy-qty" },
          iconBtn("minus", "Fewer", () => { lots = Math.max(1, lots - 1); qtyIn.value = lots; draw(); }),
          (qtyIn = h("input", { type: "number", min: 1, max, value: 1, inputmode: "numeric",
            oninput: e => { lots = Math.max(1, Math.min(max, Math.floor(+e.target.value || 1))); draw(); } })),
          iconBtn("plus", "More", () => { lots = Math.min(max, lots + 1); qtyIn.value = lots; draw(); }))),
      h("div", null, h("span", { class: "muted" }, "Total"), totalEl, after)),
    itemDetails(listing.item),
  ], { footer: [h("button", { class: "btn", onclick: () => close() }, "Cancel"), buyBtn] });
}

// ------------------------------------------------------------------ views

function renderShops() {
  if (ui.shopDraft) return renderShopEditor();
  if (shopStore.server() && shopStore.canManage() && !shopStore.loaded && !shopStore.tried) {
    shopStore.tried = true; // once: a failing server mustn't cause a render/refresh loop
    shopStore.refresh();
  }
  const shop = ui.shopId && shopStore.find(ui.shopId);
  if (shop) return renderShop(shop);
  ui.shopId = null;
  const list = shopStore.list();
  const manage = shopStore.canManage();
  if (shopStore.server() && manage && !shopStore.loaded) {
    return h("div", { class: "view-shops" }, h("h2", null, "Shops"), h("p", { class: "muted pad" }, "Loading shops…"));
  }
  return h("div", { class: "view-shops" },
    h("div", { class: "section-head" }, h("h2", null, "Shops"),
      manage && editing() && h("button", { class: "btn primary", onclick: () => editShop(null) }, icon("plus"), "New shop")),
    manage && party.active && h("p", { class: "muted small" }, "Players in the party see the shops you mark as open."),
    list.length ? cardGrid(list.map(s => h("button", { class: "shop-card" + (!shopOpen(s) && manage ? " closed" : ""), onclick: () => { ui.shopId = s.id; render(); window.scrollTo(0, 0); } },
      shopIcon(s),
      h("div", { class: "shop-card-text" },
        h("b", null, s.name),
        s.keeper && h("span", { class: "muted small" }, s.keeper),
        h("span", { class: "muted small" }, `${s.items.length} item${s.items.length === 1 ? "" : "s"}`, markupLabel(s) ? ` · ${markupLabel(s)}` : "")),
      manage && h("span", { class: "tag " + (shopOpen(s) ? "on" : ""), title: s.openIf ? `Open while ${condWords(s.openIf)}` : "" }, shopOpen(s) ? "open" : "closed"))), { cls: "shop-grid", min: 380 })
      : emptyState("cart", manage ? "No shops yet. Create one and stock it with items from the catalog." : party.active ? "No shops are open right now." : "No shops yet.",
        manage && editing() && h("button", { class: "btn primary", onclick: () => editShop(null) }, icon("plus"), "Create a shop")));
}

function renderShop(shop) {
  const manage = shopStore.canManage();
  const char = store.char();
  const closed = !shopOpen(shop) && (party.active || shopStore.server());
  const back = () => { ui.shopId = null; render(); };
  return h("div", { class: "view-shop" },
    h("button", { class: "link back-link", onclick: back }, "← All shops"),
    h("section", { class: "shop-banner" },
      shopIcon(shop, "big-icon"),
      h("div", { class: "grow" },
        h("h2", null, shop.name),
        shop.keeper && h("p", { class: "muted" }, shop.keeper),
        shop.description && h("p", { class: "shop-desc" }, shop.description),
        h("div", { class: "inline wrap small" },
          markupLabel(shop) && h("span", { class: "tag" }, markupLabel(shop)),
          buysLabel(shop) && h("span", { class: "tag" }, buysLabel(shop)),
          fundsLabel(shop, manage) && h("span", { class: "tag" }, fundsLabel(shop, manage)),
          manage && h("span", { class: "tag " + (shopOpen(shop) ? "on" : "") }, shopOpen(shop) ? "open" : "closed"),
          manage && shop.openIf && h("span", { class: "tag" }, `Open while ${condWords(shop.openIf)}`))),
      manage && h("div", { class: "shop-actions" },
        editing() && h("button", { class: "btn", onclick: () => editShop(shop) }, icon("edit"), "Edit"),
        !(shop.openIf && clockworkOn()) && h("button", { class: "btn", onclick: () => toggleShopOpen(shop) }, shop.open ? "Close shop" : "Open shop"))),
    char && h("div", { class: "purse" }, icon("coins"), h("span", null, h("b", null, char.name), " has ",
      h("b", null, fmtMoney(coinTotalCp(char.coins))))),
    closed && h("p", { class: "warn-text" }, "This shop is closed."),
    shop.buys && char && !closed && h("button", { class: "btn sell-btn", onclick: () => openSellToShop(shop) }, icon("coins"), `Sell items to ${shop.name}`),
    manage && stockroomPanel(shop),
    shop.items.length ? h("div", { class: "group" }, shop.items.map(li => {
      const out = li.stock === 0, away = !condHolds(li.onlyIf); // away: not for sale while its condition doesn't hold
      const price = listingPrice(shop, li);
      return h("div", { class: "row shop-row" + (out || away ? " sold-out" : "") },
        itemIcon(li.item, "row-icon"),
        h("button", { class: "row-main", onclick: () => openBuy(shop, li) },
          h("div", { class: "row-title" }, li.item.name, stockLabel(li) && h("span", { class: "tag" + (out ? "" : " on") }, stockLabel(li)),
            li.onlyIf && manage && h("span", { class: "tag" + (away ? "" : " on"), title: away ? "Players don't see it now" : "" },
              `${away ? "Hidden: for sale only" : "For sale"} while ${condWords(li.onlyIf)}`)),
          h("div", { class: "row-sub" }, itemSummary(li.item))),
        h("div", { class: "shop-price" }, price ? fmtCost(price) : "Free",
          (li.item.bundle || 1) > 1 && h("small", { class: "muted" }, ` / ${li.item.bundle}`)),
        h("button", { class: "btn primary", disabled: out || away || closed || !char, onclick: () => openBuy(shop, li) }, out ? "Sold out" : away ? "Not now" : "Buy"));
    })) : h("p", { class: "muted pad" }, manage ? "Nothing in stock. Edit the shop to add items." : "Nothing for sale."));
}

async function toggleShopOpen(shop) {
  try {
    await shopStore.save({ ...clone(shop), open: !shop.open });
    toast(shop.open ? `${shop.name} is closed` : `${shop.name} is open`);
  } catch (e) {
    toast(e.message);
  }
}

// ------------------------------------------------------------------ editor (host)

function editShop(shop) {
  ui.shopDraft = shop ? clone(shop) : { name: "", keeper: "", description: "", open: true, markup: 0, items: [] };
  const d = ui.shopDraft;
  d.buys = !!d.buys;
  d.sellRate = d.sellRate ?? 50;
  d.typeRates = d.typeRates || {};
  d.sellItems = d.sellItems || [];
  d.funds = d.funds ?? null;
  d.changeMargin = d.changeMargin ?? 10;
  d.backroom = d.backroom || [];
  // What the server had when editing began, to merge changes made meanwhile.
  d._orig = { funds: d.funds, lids: d.items.map(li => li.lid) };
  render();
  window.scrollTo(0, 0);
}

function renderShopEditor() {
  const d = ui.shopDraft;
  const isNew = !d.id;
  const cancel = () => { ui.shopDraft = null; render(); };
  const save = async () => {
    if (!d.name.trim()) return toast("Give the shop a name");
    try {
      const { _orig, ...clean } = d;
      clean.items = clean.items.map(({ _cond, ...li }) => li); // editing state only
      if (clean.openIf && !isValueName(clean.openIf.name)) { delete clean.openIf; } // chosen, but no value named yet
      const id = await shopStore.save({ ...clean, name: d.name.trim() });
      ui.shopDraft = null;
      ui.shopId = id;
      toast(isNew ? `${d.name} is ready` : "Shop saved");
      render();
    } catch (e) {
      if (e.status === 409 && e.data?.shop) {
        // A sale (or the stockroom) changed the shop while it was being edited: keep the
        // edits, take the new stock, money and any items put on the shelf meanwhile.
        const fresh = e.data.shop;
        d.rev = fresh.rev;
        for (const li of d.items) {
          const now = fresh.items.find(x => x.lid === li.lid);
          if (now) li.stock = now.stock;
        }
        for (const li of fresh.items) {
          if (!d._orig.lids.includes(li.lid) && !d.items.some(x => x.lid === li.lid)) d.items.push(li);
        }
        if (d.funds === d._orig.funds) d.funds = fresh.funds ?? null;
        d.backroom = fresh.backroom || [];
        d._orig = { funds: fresh.funds ?? null, lids: fresh.items.map(li => li.lid) };
        toast("The shop changed meanwhile (a sale or the stockroom) — updated, press Save again");
        render();
      } else {
        toast(e.message);
      }
    }
  };
  const priceGp = li => li.price == null ? "" : +(li.price / showCoin().value).toFixed(2);
  const items = h("div", { class: "group shop-edit-items" }, d.items.length ? d.items.map((li, i) => h("div", { class: "row shop-edit-row" },
    itemIcon(li.item, "row-icon"),
    h("div", { class: "row-main static" }, h("div", { class: "row-title" }, li.item.name),
      h("div", { class: "row-sub" }, "List price ", li.item.cost ? fmtCost(li.item.cost) : "free", (li.item.bundle || 1) > 1 ? ` per ${li.item.bundle}` : "")),
    h("label", { class: "field mini" }, h("span", null, `Price (${showCoin().key})`),
      h("input", { type: "number", min: 0, step: "any", inputmode: "decimal", placeholder: "list", value: priceGp(li),
        oninput: e => { li.price = e.target.value === "" ? null : Math.max(0, Math.round(+e.target.value * showCoin().value)); } })),
    h("label", { class: "field mini" }, h("span", null, "Stock"),
      h("input", { type: "number", min: 0, inputmode: "numeric", placeholder: "∞", value: li.stock ?? "",
        oninput: e => { li.stock = e.target.value === "" ? null : Math.max(0, Math.floor(+e.target.value)); } })),
    clockworkOn() && iconBtn("eye", li.onlyIf ? `For sale while ${condWords(li.onlyIf)}: change` : "Only for sale while a value says so…", () => { li._cond = !li._cond; render(); },
      "shop-cond-btn" + (li.onlyIf ? " on" : "")),
    iconBtn("trash", "Remove from shop", () => { d.items.splice(i, 1); render(); }, "danger-hover"),
    clockworkOn() && (li._cond || li.onlyIf) && h("div", { class: "shop-cond" }, h("span", { class: "small muted" }, "For sale only while"), condEditor(li, "onlyIf", `${li.item.name}: for sale while`),
      li.onlyIf && h("button", { type: "button", class: "btn", onclick: () => { delete li.onlyIf; li._cond = false; render(); } }, "Always for sale"))))
    : h("p", { class: "muted pad" }, "No items yet."));
  return h("div", { class: "view-shop-edit" },
    h("div", { class: "section-head" }, h("h2", null, isNew ? "New shop" : `Edit ${d.name}`)),
    h("div", { class: "form grid" },
      h("label", { class: "field" }, h("span", null, "Shop name *"),
        h("input", { type: "text", value: d.name, maxlength: 80, placeholder: "e.g. The Rusty Flagon Outfitters", oninput: e => { d.name = e.target.value; } })),
      h("label", { class: "field" }, h("span", null, "Shopkeeper"),
        h("input", { type: "text", value: d.keeper || "", maxlength: 80, placeholder: "e.g. Grenda Ironfoot, dwarf", oninput: e => { d.keeper = e.target.value; } })),
      h("label", { class: "field full" }, h("span", null, "Description"),
        h("textarea", { rows: 2, maxlength: 2000, value: d.description || "", placeholder: "What the place looks like, what they're known for…", oninput: e => { d.description = e.target.value; } })),
      h("label", { class: "field" }, h("span", null, "Price adjustment (%)"),
        h("input", { type: "number", min: -90, max: 500, value: d.markup || 0, inputmode: "numeric", oninput: e => { d.markup = Math.max(-90, Math.min(500, Math.round(+e.target.value || 0))); } })),
      h("div", { class: "field" }, h("span", null, "Sign"),
        h("div", { class: "inline" }, shopIcon(d, "sign-icon"),
          h("button", { type: "button", class: "btn", onclick: () => openIconPicker(d.icon, id => { if (id) d.icon = id; else delete d.icon; render(); }, { type: "treasure", name: "" }) }, "Choose icon"))),
      h("div", { class: "field full" }, h("span", null, "Open"),
        h("div", { class: "inline wrap" },
          h("select", { "aria-label": "When it's open", onchange: e => { if (e.target.value === "value") d.openIf = d.openIf || { name: "", op: ">=", to: 1 }; else { delete d.openIf; d.open = e.target.value === "open"; } render(); } },
            h("option", { value: "open", selected: !d.openIf && !!d.open }, "Open: players can see it and buy"),
            h("option", { value: "closed", selected: !d.openIf && !d.open }, "Closed"),
            clockworkOn() && h("option", { value: "value", selected: !!d.openIf }, "Open while a Global value says so")),
          d.openIf && clockworkOn() && condEditor(d, "openIf", "Open while"))),
      clockworkOn() && h("div", { class: "field full" }, h("span", null, "Prices follow a Global value (optional)"),
        h("div", { class: "inline wrap" },
          h("input", { type: "text", list: "shop-price-values", value: d.priceValue || "", placeholder: "e.g. prices", spellcheck: "false", autocomplete: "off",
            "aria-label": "Price value", onchange: e => { const v = e.target.value.trim(); if (isValueName(v)) d.priceValue = v; else delete d.priceValue; e.target.classList.toggle("invalid", !!v && !isValueName(v)); } }),
          h("span", { class: "muted small" }, "Every price is multiplied by it (1 while it isn't set): 1.5 is half as much again, 0.5 half price."),
          h("datalist", { id: "shop-price-values" }, [...knownValues().values()].filter(v => v.scope === "global").map(v => h("option", { value: v.name })))))),
    h("div", { class: "section-head shop-items-head" }, h("h3", null, `Items (${d.items.length})`),
      h("button", { class: "btn", onclick: () => openStockPicker({
        title: "Add items to the shop",
        has: id => d.items.some(li => li.srcId === id),
        add: (id, snapshot) => d.items.push({ lid: "l" + uid(), srcId: id, item: snapshot, price: null, stock: null }),
      }) }, icon("plus"), "Add items")),
    h("p", { class: "muted small" }, "Leave Price empty to use the item's list price. The price adjustment % applies to every price in the shop. Leave Stock empty for unlimited."),
    items,
    moneySettings(d),
    sellSettings(d),
    h("div", { class: "inline wrap editor-foot" },
      !isNew && h("button", { class: "btn danger", onclick: () => confirmDialog(`Delete ${d.name}?`, "Delete", async () => {
        try { await shopStore.remove(d); ui.shopDraft = null; ui.shopId = null; render(); toast(`Deleted ${d.name}`); } catch (e) { toast(e.message); }
      }) }, icon("trash"), "Delete shop"),
      h("span", { class: "grow" }),
      h("button", { class: "btn", onclick: cancel }, "Cancel"),
      h("button", { class: "btn primary", onclick: save }, icon("check"), "Save shop")));
}

// Catalog picker (SRD and custom items), as the catalog shows them (the inventory management
// template, itemManager in js/app.js): opts.has(id) marks ones already added, opts.add(id,
// snapshot) adds one. Shops, hoards and treasure tables add items with it.
function openStockPicker(opts) {
  resetList("stock"); // a fresh search each time (its sort order is remembered)
  let close, mgr;
  const add = item => {
    const { id, ...snapshot } = clone(item);
    if (!stacks(snapshot, id)) snapshot.noStack = true; // the party server stacks what's bought by this
    opts.add(id, snapshot);
    mgr.redraw();
  };
  mgr = itemManager({ key: "stock", flat: true, sorts: CATALOG_SORTS, sort: "catalog", limit: 150, customChip: true,
    placeholder: "Search the catalog…",
    storage: () => {
      const st = catalogStorage(store.catalog(), { id: "stock",
        open: item => openStoredItem(st, st.char.items.find(e => e.uid === item.id)),
        extras: e => opts.has(e.srcId) ? h("span", { class: "tag on" }, "added") : iconBtn("plus", `Add ${e.item.name}`, () => add(e.item), "add") });
      return st;
    } });
  close = openModal(opts.title, mgr, { wide: true, footer: [h("button", { class: "btn primary", onclick: () => { close(); render(); } }, icon("check"), "Done")] });
}

// ------------------------------------------------------------------ selling to shops

// Editor section: default %, % per item type, and rules for specific items.
function sellSettings(d) {
  const pctInput = (value, placeholder, onInput) => h("input", { type: "number", min: 0, max: 1000, inputmode: "numeric",
    value: value ?? "", placeholder, oninput: e => onInput(e.target.value === "" ? null : Math.max(0, Math.min(1000, Math.round(+e.target.value)))) });
  const body = h("div", { class: "sell-settings", hidden: !d.buys },
    h("div", { class: "form grid" },
      h("label", { class: "field" }, h("span", null, "Default offer (% of list price)"),
        pctInput(d.sellRate, "50", v => { d.sellRate = v ?? 50; })),
      h("p", { class: "muted small" }, "What the shop pays when nothing more specific is set below. 0% means it won't buy.")),
    h("h4", null, "By item type"),
    h("p", { class: "muted small" }, "Leave empty to use the default. 0 = won't buy that kind of item."),
    // By template, in the tree's order (one gathering others is a heading over them); each keeps its own rate.
    // Packs aren't listed: they unpack into their contents, so players never sell one.
    h("div", { class: "type-rates" }, treeTemplates({ ghosts: false }).filter(t => !templateFeatureDefaults(t).pack).map(t => t.abstract
      ? h("div", { class: "type-rate-head" }, colorDot(templateColor(t), templatePlural(t)), templatePlural(t))
      : h("label", { class: "type-rate" + (templateDepth(t) ? " sub" : "") },
        templateBadge(t), h("span", null, templatePlural(t)),
        pctInput(d.typeRates[t.id], String(d.sellRate ?? 50), v => { if (v == null) delete d.typeRates[t.id]; else d.typeRates[t.id] = v; }),
        h("span", { class: "muted small" }, "%")))),
    h("div", { class: "section-head shop-items-head" }, h("h4", null, `Specific items (${d.sellItems.length})`),
      h("button", { class: "btn", type: "button", onclick: () => openStockPicker({
        title: "Items with their own offer",
        has: id => d.sellItems.some(r => r.srcId === id),
        add: (id, snap) => d.sellItems.push({ srcId: id, name: snap.name, icon: snap.icon, type: snap.type, mode: "percent", value: d.sellRate ?? 50 }),
      }) }, icon("plus"), "Add items")),
    h("p", { class: "muted small" }, "Override the offer for particular items: a % of list price, or a fixed price (per bundle for ammunition)."),
    h("div", { class: "group" }, d.sellItems.length ? d.sellItems.map((r, i) => {
      const valueIn = h("input", { type: "number", min: 0, step: "any", inputmode: "decimal",
        value: r.mode === "fixed" ? +(r.value / showCoin().value).toFixed(2) : r.value,
        oninput: e => { r.value = r.mode === "fixed" ? Math.max(0, Math.round(+e.target.value * showCoin().value)) : Math.max(0, Math.min(1000, Math.round(+e.target.value))); } });
      return h("div", { class: "row shop-edit-row" },
        itemIcon({ type: r.type || "gear", name: r.name, icon: r.icon }, "row-icon"),
        h("div", { class: "row-main static" }, h("div", { class: "row-title" }, r.name)),
        h("label", { class: "field mini" }, h("span", null, "Offer"),
          h("select", { onchange: e => {
            r.mode = e.target.value;
            r.value = r.mode === "fixed" ? showCoin().value : d.sellRate ?? 50;
            render();
          } }, h("option", { value: "percent", selected: r.mode !== "fixed" }, "% of list"), h("option", { value: "fixed", selected: r.mode === "fixed" }, `Fixed (${showCoin().key})`))),
        h("label", { class: "field mini" }, h("span", null, r.mode === "fixed" ? showCoin().key : "%"), valueIn),
        iconBtn("trash", "Remove", () => { d.sellItems.splice(i, 1); render(); }, "danger-hover"));
    }) : h("p", { class: "muted pad" }, "None yet.")));
  return h("section", { class: "sell-section" },
    h("h3", null, "Buying from players"),
    h("label", { class: "check field" }, h("input", { type: "checkbox", checked: d.buys, onchange: e => { d.buys = e.target.checked; body.hidden = !d.buys; } }),
      " This shop buys items from players"),
    body);
}

// Player: pick items from the active character's inventory to sell.
function openSellToShop(shop) {
  let close;
  const list = h("div", { class: "group sell-list" });
  const draw = () => {
    const char = store.char();
    // Cards in a deck are sold with it, like a container's contents.
    const entries = char ? byName(char.items.filter(e => !inDeck(char, e))) : [];
    setChildren(list, entries.map(e => {
      const hasContents = char.items.some(x => x.parent === e.uid && !x.item.card);
      const unit = sellOffer(shop, e, e.item.bundle > 1 ? Math.min(e.qty, e.item.bundle) : 1);
      const perLabel = e.item.bundle > 1 ? ` per ${Math.min(e.qty, e.item.bundle)}` : " each";
      const why = hasContents ? "Empty it first" : !sellOffer(shop, e, e.qty) ? "Won't buy"
        : !shopCanPay(shop, unit) ? `${shop.name} can't afford it` : null;
      return h("div", { class: "row" + (why ? " sold-out" : "") },
        itemIcon(e.item, "row-icon"),
        h("div", { class: "row-main static" },
          h("div", { class: "row-title" }, entryName(e), e.qty > 1 && h("span", { class: "tag" }, "×" + e.qty.toLocaleString()), e.equipped && h("span", { class: "tag on" }, "equipped")),
          h("div", { class: "row-sub" }, why || `Offer: ${fmtCost(unit)}${perLabel}`)),
        h("button", { class: "btn", disabled: !!why, onclick: () => sellDialog(shop, e, draw) }, "Sell"));
    }), !entries.length && h("p", { class: "muted pad" }, "Nothing to sell."));
  };
  draw();
  close = openModal(`Sell to ${shop.name}`, [
    h("p", { class: "muted small" }, buysLabel(shop), (shop.sellItems || []).length || Object.keys(shop.typeRates || {}).length ? " (some items and types differ)" : ""),
    list,
  ], { wide: true, footer: [h("button", { class: "btn", onclick: () => close() }, "Done")] });
}

function sellDialog(shop, entry, redraw) {
  const char = store.char();
  let qty = entry.qty > 1 && !(entry.item.bundle > 1) ? 1 : entry.qty, close;
  const out = h("p", { class: "big-num" });
  const sellBtn = h("button", { class: "btn primary" }, icon("coins"), "Sell");
  const note = h("p", { class: "warn-text small" });
  const draw = () => {
    const paid = sellOffer(shop, entry, qty);
    out.textContent = paid ? fmtCost(paid) : "Nothing";
    note.textContent = paid && !shopCanPay(shop, paid) ? `${shop.name} only has ${fmtMoney(shop.funds)}` : "";
    sellBtn.disabled = !paid || !shopCanPay(shop, paid);
  };
  sellBtn.onclick = async () => {
    sellBtn.disabled = true;
    if (await sellToShop(shop, entry, qty)) { close(); redraw(); } else draw();
  };
  draw();
  close = openModal(`Sell ${entryName(entry)}`, h("div", { class: "form" },
    h("div", { class: "buy-head" }, itemIcon(entry.item, "big-icon"),
      h("div", null, h("b", null, entryName(entry)), h("div", { class: "muted small" }, `${char.name} has ${entry.qty.toLocaleString()}`))),
    entry.qty > 1 && h("label", { class: "field" }, h("span", null, "How many"),
      h("input", { type: "number", min: 1, max: entry.qty, value: qty, inputmode: "numeric",
        oninput: e => { qty = Math.max(1, Math.min(entry.qty, Math.floor(+e.target.value || 1))); draw(); } })),
    h("div", null, h("span", { class: "muted" }, `${shop.name} pays`), out, note),
    entry.equipped && h("p", { class: "muted small" }, "It's currently equipped.")),
  { footer: [h("button", { class: "btn", onclick: () => close() }, "Cancel"), sellBtn] });
}

async function sellToShop(shop, entry, qty) {
  const char = store.char();
  const paid = sellOffer(shop, entry, qty);
  const label = `${qty > 1 ? qty + " × " : ""}${entryName(entry)}`;
  try {
    if (party.active) {
      if (!requireLinked(char)) return false;
      // The host checks the item and the offer and pays out.
      await party.put(char.id);
      const r = await shopStore.request("POST", `api/shops/${shop.id}/sell`, { character: char.id, uid: entry.uid, qty });
      toast(`Sold ${label} for ${fmtCost(r.paid)}`);
      return true;
    }
    if (!paid) return toast(`${shop.name} won't buy that`), false;
    if (!shopCanPay(shop, paid)) return toast(`${shop.name} can't afford that right now`), false;
    if (char.items.some(x => x.parent === entry.uid && !x.item.card)) return toast(`Empty the ${entryName(entry)} first`), false;
    let received = paid;
    if (shopStore.server()) {
      // The host's own solo character: the shop's till and stockroom live on the server.
      received = (await shopStore.request("POST", `api/shops/${shop.id}/receive`, { srcId: entry.srcId, item: currentItem(entry), qty })).paid;
      shopStore.refresh();
    }
    commit((s, c) => {
      const x = c.items.find(x => x.uid === entry.uid);
      x.qty -= qty;
      if (x.qty <= 0) removeEntry(c, x.uid);
      c.coins = receiveCoins(c.coins, received, shopMargin(shop));
      if (!shopStore.server()) {
        const sh = s.shops.find(y => y.id === shop.id);
        addToBackroom(sh, entry, qty);
        if (sh.funds != null) sh.funds -= received;
      }
    }, `Sold ${label} for ${fmtCost(received)}`, !shopStore.server()); // Undo can't reach the host's till
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  }
}

// ------------------------------------------------------------------ money & stockroom

function shopMargin(shop) { return shop.changeMargin ?? 10; }

function shopCanPay(shop, amount) { return shop.funds == null || shop.funds >= amount; }

function fundsLabel(shop, manage) {
  if (shop.funds == null) return manage ? "Unlimited funds" : null;
  return `Funds: ${fmtMoney(shop.funds)}`;
}

// Items bought from players go to the stockroom, stacking identical ones (as add_to_backroom in server.py).
function addToBackroom(shop, entry, qty) {
  shop.backroom = shop.backroom || [];
  const item = clone(entry.item);
  const same = shop.backroom.find(b => (b.srcId || null) === (entry.srcId || null) && JSON.stringify(b.item) === JSON.stringify(item));
  if (same) same.qty += qty;
  else shop.backroom.push({ bid: "b" + uid(), srcId: entry.srcId || null, item, qty });
}

// Editor: the shop's till and how it gives change.
function moneySettings(d) {
  let amount = d.funds == null ? "" : +(d.funds / showCoin().value).toFixed(2);
  return h("section", { class: "sell-section" },
    h("h3", null, "Money"),
    h("label", { class: "check field" }, h("input", { type: "checkbox", checked: d.funds == null, onchange: e => {
      d.funds = e.target.checked ? null : Math.round((+amount || 0) * showCoin().value);
      render();
    } }), " Unlimited funds"),
    h("div", { class: "form grid" },
      d.funds != null && h("label", { class: "field" }, h("span", null, `Funds (${showCoin().key})`),
        h("input", { type: "number", min: 0, step: "any", inputmode: "decimal", value: amount,
          oninput: e => { amount = e.target.value; d.funds = Math.max(0, Math.round((+e.target.value || 0) * showCoin().value)); } })),
      h("label", { class: "field" }, h("span", null, "Small change margin (%)"),
        h("input", { type: "number", min: 0, max: 50, inputmode: "numeric", value: d.changeMargin,
          oninput: e => { d.changeMargin = Math.max(0, Math.min(50, Math.round(+e.target.value || 0))); } }))),
    h("p", { class: "muted small" }, d.funds == null
      ? "Unlimited: the shop can always pay. Turn this off to give it a till that sales fill and purchases from players empty."
      : "Sales to players add to the till; buying from players spends it. The shop won't buy what it can't pay for."),
    h("p", { class: "muted small" }, "The margin is the share of every payout (money for items, and change) given in the next smaller coin, "
      + "like a real shopkeeper. At 10%, a payout comes partly in the next smaller coin. At 0%, it always pays in the largest coins."));
}

// Host: what players have sold to this shop, waiting to go back on the shelves.
function stockroomPanel(shop) {
  const room = shop.backroom || [];
  return h("section", { class: "stockroom" },
    h("div", { class: "section-head" }, h("h3", null, `Stockroom (${room.length})`)),
    h("p", { class: "muted small" }, "Items players sold here. Only you can see this. Put them on the shelf to sell them on, or throw them out."),
    room.length ? h("div", { class: "group" }, room.map(b => {
      const bundle = Math.max(1, b.item.bundle || 1);
      const lots = Math.floor(b.qty / bundle);
      return h("div", { class: "row stock-row" },
        itemIcon(b.item, "row-icon"),
        h("div", { class: "row-main static" },
          h("div", { class: "row-title" }, b.item.name, h("span", { class: "tag" }, "×" + b.qty.toLocaleString())),
          h("div", { class: "row-sub" }, bundle > 1 ? `${lots} bundle${lots === 1 ? "" : "s"} of ${bundle} to shelve` : itemSummary(b.item))),
        h("button", { class: "btn primary", disabled: lots < 1, onclick: () => shelveDialog(shop, b) }, "Put on shelf"),
        iconBtn("trash", "Throw out", () => discardDialog(shop, b), "danger-hover"));
    })) : h("p", { class: "muted pad" }, "Empty."));
}

async function stockroomAction(shop, bid, action, qty, price = null) {
  try {
    if (shopStore.server()) {
      await shopStore.request("POST", `api/shops/${shop.id}/backroom`, { bid, action, qty, price });
      await shopStore.refresh();
    } else {
      commit(s => {
        const sh = s.shops.find(x => x.id === shop.id);
        const b = sh.backroom.find(x => x.bid === bid);
        const bundle = Math.max(1, b.item.bundle || 1);
        if (action === "shelve") {
          const same = sh.items.find(li => (li.srcId || null) === (b.srcId || null) && JSON.stringify(li.item) === JSON.stringify(b.item));
          if (same) { if (same.stock != null) same.stock += qty; }
          else sh.items.push({ lid: "l" + uid(), srcId: b.srcId, item: clone(b.item), price, stock: qty });
          b.qty -= qty * bundle;
        } else {
          b.qty -= qty;
        }
        if (b.qty <= 0) sh.backroom = sh.backroom.filter(x => x.bid !== bid);
      });
    }
    toast(action === "shelve" ? "Put on the shelf" : "Thrown out");
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  }
}

function shelveDialog(shop, b) {
  const bundle = Math.max(1, b.item.bundle || 1);
  const max = Math.floor(b.qty / bundle);
  const same = shop.items.find(li => (li.srcId || null) === (b.srcId || null) && JSON.stringify(li.item) === JSON.stringify(b.item));
  let qty = max, priceGp = "", close;
  const go = async () => {
    const price = priceGp === "" ? null : Math.max(0, Math.round(+priceGp * showCoin().value));
    if (await stockroomAction(shop, b.bid, "shelve", qty, price)) close();
  };
  close = openModal(`Put ${b.item.name} on the shelf`, h("div", { class: "form" },
    h("div", { class: "buy-head" }, itemIcon(b.item, "big-icon"),
      h("div", null, h("b", null, b.item.name), h("div", { class: "muted small" }, `${b.qty.toLocaleString()} in the stockroom`))),
    h("label", { class: "field" }, h("span", null, bundle > 1 ? `How many bundles of ${bundle}` : "How many"),
      h("input", { type: "number", min: 1, max, value: qty, inputmode: "numeric", oninput: e => { qty = Math.max(1, Math.min(max, Math.floor(+e.target.value || 1))); } })),
    same
      ? h("p", { class: "muted small" }, same.stock == null
        ? "It's already on the shelf with unlimited stock, so this just clears it from the stockroom."
        : `Adds to the ${same.stock} already on the shelf, at the same price (${listingPrice(shop, same) ? fmtCost(listingPrice(shop, same)) : "free"}).`)
      : h("label", { class: "field" }, h("span", null, `Price (${showCoin().key}) — empty for the list price`),
        h("input", { type: "number", min: 0, step: "any", inputmode: "decimal", placeholder: +((b.item.cost || 0) / showCoin().value).toFixed(2),
          oninput: e => { priceGp = e.target.value; } }))),
  { footer: [h("button", { class: "btn", onclick: () => close() }, "Cancel"), h("button", { class: "btn primary", onclick: go }, "Put on shelf")] });
}

function discardDialog(shop, b) {
  let qty = b.qty, close;
  const go = async () => { if (await stockroomAction(shop, b.bid, "discard", qty)) close(); };
  close = openModal(`Throw out ${b.item.name}?`, h("div", { class: "form" },
    b.qty > 1 && h("label", { class: "field" }, h("span", null, `How many (of ${b.qty.toLocaleString()})`),
      h("input", { type: "number", min: 1, max: b.qty, value: qty, inputmode: "numeric", oninput: e => { qty = Math.max(1, Math.min(b.qty, Math.floor(+e.target.value || 1))); } })),
    h("p", { class: "muted small" }, "They're removed from the stockroom for good. The shop keeps the money it paid.")),
  { footer: [h("button", { class: "btn", onclick: () => close() }, "Cancel"), h("button", { class: "btn danger", onclick: go }, icon("trash"), "Throw out")] });
}
