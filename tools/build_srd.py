"""Build js/srd-data.js from the dnd5e.wikidot.com equipment pages.

Usage:  python tools/build_srd.py [--refresh] [--srd-only OUT]

Pages are cached in tools/.cache so re-runs don't hit the site. Pass
--refresh to download them again.

--srd-only writes a copy with only System Reference Document 5.1 content
(CC BY 4.0) to OUT, for the public release: no trinket tables, gemstones,
setting-specific games or tool activities, and no text beyond the SRD's.
"""
import html
import json
import os
import re
import sys
import urllib.request
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "tools", ".cache")
OUT = os.path.join(ROOT, "js", "srd-data.js")
BASE = "https://dnd5e.wikidot.com/"
PAGES = ["adventuring-gear", "armor", "weapons", "tools", "poisons", "trinkets", "currency"]


def fetch(page, refresh=False):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, page + ".html")
    if refresh or not os.path.exists(path):
        req = urllib.request.Request(BASE + page, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req) as r, open(path, "wb") as f:
            f.write(r.read())
    with open(path, encoding="utf8") as f:
        return f.read()


class TableParser(HTMLParser):
    """Collects every table as {heading, tab, rows}; each cell keeps the text
    before and after a '* <em>tooltip</em>' so descriptions can be split out."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables, self.row, self.cell = [], None, None
        self.depth, self.heading, self.cur_h = 0, "", None
        self.tabs, self.in_tab_label, self.tab_label = [], False, ""
        self.tab_index, self.in_nav = -1, False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "div" and (a.get("id") or "").startswith("wiki-tab-0-"):
            self.tab_index = int(a["id"].rsplit("-", 1)[1])
        if tag == "table":
            tab = self.tabs[self.tab_index] if 0 <= self.tab_index < len(self.tabs) else None
            self.tables.append({"heading": self.heading, "tab": tab, "rows": []})
            self.depth += 1
        elif tag == "tr" and self.depth:
            self.row = []
        elif tag in ("td", "th") and self.row is not None:
            self.cell = ""
        elif tag in ("h1", "h2", "h3", "h4", "h5"):
            self.cur_h = ""
        elif tag == "br" and self.cell is not None:
            self.cell += "\n"
        elif tag == "ul" and a.get("class") == "yui-nav":
            self.in_nav = True
        elif tag == "a" and self.in_nav:
            self.in_tab_label, self.tab_label = True, ""

    def handle_endtag(self, tag):
        if tag == "table":
            self.depth -= 1
        elif tag == "tr" and self.row is not None:
            self.tables[-1]["rows"].append(self.row)
            self.row = None
        elif tag in ("td", "th") and self.cell is not None:
            self.row.append(self.cell.strip())
            self.cell = None
        elif tag in ("h1", "h2", "h3", "h4", "h5") and self.cur_h is not None:
            self.heading = " ".join(self.cur_h.split())
            self.cur_h = None
        elif tag == "ul":
            self.in_nav = False
        elif tag == "a" and self.in_tab_label:
            self.tabs.append(" ".join(self.tab_label.split()))
            self.in_tab_label = False

    def handle_data(self, d):
        if self.cell is not None:
            self.cell += d
        if self.cur_h is not None:
            self.cur_h += d
        if self.in_tab_label:
            self.tab_label += d


def tables(page):
    p = TableParser()
    p.feed(fetch(page, "--refresh" in sys.argv))
    return p.tables


def squash(s):
    return " ".join(s.split())


def split_desc(cell):
    """'Name\\n* desc\\n* more' -> ('Name', 'desc\\n\\nmore')."""
    parts = [squash(p) for p in cell.split("*")]
    name = parts[0]
    desc = "\n\n".join(p for p in parts[1:] if p)
    return name, desc


DENOM = {"cp": 1, "sp": 10, "ep": 50, "gp": 100, "pp": 1000}


def cost_cp(s):
    m = re.search(r"([\d,]+)\s*(cp|sp|ep|gp|pp)", s or "")
    if not m:
        return 0
    return int(m.group(1).replace(",", "")) * DENOM[m.group(2)]


def weight_lb(s):
    s = (s or "").replace("½", ".5").replace("¼", ".25")
    m = re.search(r"(\d+)\s*/\s*(\d+)", s)
    if m:
        return int(m.group(1)) / int(m.group(2))
    m = re.search(r"\d*\.?\d+", s)
    return float(m.group(0)) if m else 0


def liquid_pints(capacity):
    """'4 pints liquid' -> 4, '3 gallons liquid, ...' -> 24, '4 ounces liquid' -> 0.25."""
    m = re.search(r"([\d.]+)\s*(gallon|pint|ounce)s?\s+liquid", capacity or "")
    if not m:
        return 0
    return float(m.group(1)) * {"gallon": 8, "pint": 1, "ounce": 1 / 16}[m.group(2)]


def slug(*parts):
    return re.sub(r"[^a-z0-9]+", "-", "-".join(parts).lower()).strip("-")


items = []


def add(item):
    item.setdefault("source", "PHB")
    item.setdefault("weight", 0)
    item.setdefault("cost", 0)
    items.append(item)


# ---------------------------------------------------------------- weapons
PROPERTY_GLOSSARY = {}
weapon_notes = {}
for m in re.finditer(r"<li><strong><em>([^<]+?)\.</em></strong>(.*?)</li>", fetch("weapons"), re.S):
    weapon_notes[m.group(1).strip().lower()] = squash(html.unescape(re.sub(r"<[^>]+>", "", m.group(2))))

for t in tables("weapons"):
    h = t["heading"]
    if h == "Weapon Properties":
        for name, desc in t["rows"][1:]:
            PROPERTY_GLOSSARY[name] = squash(desc)
        continue
    if h == "Ammunition":
        for name, cost, weight in t["rows"][1:]:
            m = re.match(r"(.+?)\s*\((\d+)\)", name)
            add({"id": slug("ammo", m.group(1)), "type": "ammunition", "name": m.group(1),
                 "bundle": int(m.group(2)), "cost": cost_cp(cost), "weight": weight_lb(weight)})
        continue
    # Only the core weapon tables; the pages' campaign-setting extras (Forgotten Realms,
    # Dragonlance, Eberron) are left out.
    if "Weapons" not in h:
        continue
    category, kind = None, None
    for row in t["rows"]:
        if len(row) == 1:
            m = re.match(r"(Simple|Martial) (Melee|Ranged)", row[0])
            category, kind = m.group(1), m.group(2)
            continue
        if row[0] == "Name":
            continue
        name, desc = split_desc(row[0])
        cost, dmg, weight, props = (squash(c) for c in row[1:5])
        m = re.match(r"^(\d+(?:d\d+)?)\s+([a-zA-Z]+)$", dmg)
        damage, dtype = (m.group(1), m.group(2).lower()) if m else ("" if dmg in ("—", "-") else dmg, "")
        props = [] if props in ("—", "-", "") else [p.strip() for p in re.split(r",\s*(?![^()]*\))", props)]
        props = [p[0].upper() + p[1:] for p in props]
        note = weapon_notes.get(name.lower())
        add({"id": slug("weapon", name), "type": "weapon", "name": name, "category": category,
             "kind": kind, "damage": damage, "damageType": dtype, "properties": props,
             "cost": cost_cp(cost), "weight": weight_lb(weight),
             "description": "\n\n".join(x for x in (desc, note) if x),
             "source": "PHB"})

# ---------------------------------------------------------------- armor
for t in tables("armor"):
    cat = t["heading"].replace(" Armor", "")
    if cat not in ("Light", "Medium", "Heavy", "Shield"):
        continue
    for name, ac, strength, stealth, weight, cost in t["rows"][1:]:
        dex = "none"
        if "Dex" in ac:
            dex = "max2" if "max 2" in ac else "full"
        m = re.search(r"\d+", ac)
        s = re.search(r"\d+", strength)
        add({"id": slug("armor", name), "type": "armor", "name": name, "category": cat,
             "ac": int(m.group(0)), "dex": dex if cat != "Shield" else "none",
             "strength": int(s.group(0)) if s else 0,
             "stealthDisadvantage": stealth.lower().startswith("disadv"),
             "cost": cost_cp(cost), "weight": weight_lb(weight)})

# ---------------------------------------------------------------- adventuring gear
PACKS = {
    "Burglar's Pack": [("Backpack", 1), ("Ball Bearings (bag of 1,000)", 1), ("String (10 ft)", 1), ("Bell", 1),
                       ("Candle", 5), ("Crowbar", 1), ("Hammer", 1), ("Piton", 10), ("Lantern - Hooded", 1),
                       ("Oil (flask)", 2), ("Rations (1 day)", 5), ("Tinderbox", 1), ("Waterskin", 1),
                       ("Rope, Hemp (50 ft)", 1)],
    "Diplomat's Pack": [("Chest", 1), ("Case, Map/Scroll", 2), ("Fine Clothes", 1), ("Ink (1 oz)", 1),
                        ("Ink Pen", 1), ("Lamp", 1), ("Oil (flask)", 2), ("Paper (1 sheet)", 5),
                        ("Perfume (vial)", 1), ("Sealing Wax", 1), ("Soap", 1)],
    "Dungeoneer's Pack": [("Backpack", 1), ("Crowbar", 1), ("Hammer", 1), ("Piton", 10), ("Torch", 10),
                          ("Tinderbox", 1), ("Rations (1 day)", 10), ("Waterskin", 1), ("Rope, Hemp (50 ft)", 1)],
    "Entertainer's Pack": [("Backpack", 1), ("Bedroll", 1), ("Costume", 2), ("Candle", 5),
                           ("Rations (1 day)", 5), ("Waterskin", 1), ("Disguise kit", 1)],
    "Explorer's Pack": [("Backpack", 1), ("Bedroll", 1), ("Mess Kit", 1), ("Tinderbox", 1), ("Torch", 10),
                        ("Rations (1 day)", 10), ("Waterskin", 1), ("Rope, Hemp (50 ft)", 1)],
    "Priest's Pack": [("Backpack", 1), ("Blanket", 1), ("Candle", 10), ("Tinderbox", 1), ("Alms Box", 1),
                      ("Incense (block)", 2), ("Censer", 1), ("Vestments", 1), ("Rations (1 day)", 2),
                      ("Waterskin", 1)],
    "Scholar's Pack": [("Backpack", 1), ("Book", 1), ("Ink (1 oz)", 1), ("Ink Pen", 1),
                       ("Parchment (1 sheet)", 10), ("Little Bag of Sand", 1), ("Small Knife", 1)],
}
# What cases and quivers hold: rules (any of them), counted (holdLimit of holdUnit; parchment
# counts as 2 sheets). See containerRules in js/store.js.
HOLDS = {
    "scrolls": {"holdLimit": 10, "holdUnit": "sheet", "allows": [
        {"label": "Parchment", "name": "parchment", "size": 2},
        {"label": "Paper, maps & scrolls", "name": "paper map chart scroll letter deed sheet"},
        {"template": "document", "category": ["Letter", "Note", "Scroll", "Map"]},
        {"template": "consumable", "category": ["Scroll"]}]},
    "arrows": {"holdLimit": 20, "holdUnit": "arrow", "allows": [{"label": "Arrows", "feature": "ammunition", "name": "arrow"}]},
    "bolts": {"holdLimit": 20, "holdUnit": "bolt", "allows": [{"label": "Crossbow bolts", "feature": "ammunition", "name": "bolt"}]},
}
# Pack contents that have no row of their own on the gear page.
PACK_EXTRAS = ["String (10 ft)", "Soap", "Alms Box", "Incense (block)", "Censer", "Vestments",
               "Little Bag of Sand", "Small Knife"]

# ("Common Items" is "Standard": "Common" read as a rarity.)
GEAR_CATS = {"Common Items": "Standard", "Usable Items": "Usable", "Clothes": "Clothes",
             "Arcane Focus": "Arcane Focus", "Druidic Focus": "Druidic Focus",
             "Holy Symbols": "Holy Symbol"}  # the Dragonlance table (setting-specific) is left out

for t in tables("adventuring-gear"):
    h = t["heading"]
    if h == "Equipment Packs":
        for name, cost, contents in t["rows"][1:]:
            add({"id": slug("pack", name), "type": "pack", "name": name, "cost": cost_cp(cost),
                 "description": squash(contents), "contents": [{"name": n, "qty": q} for n, q in PACKS[name]]})
    elif h == "Containers":
        for name, cost, capacity, weight in t["rows"][1:]:
            name, desc = split_desc(name)
            m = re.search(r"(\d+)\s*pounds", capacity)
            item = {"id": slug("container", name), "type": "container", "name": name, "cost": cost_cp(cost),
                    "weight": weight_lb(weight), "capacity": squash(capacity),
                    "capacityLb": int(m.group(1)) if m else 0, "description": desc}
            if "strap items" in desc:  # the Backpack: "You can also strap items ... to the outside"
                item["compartments"] = [{"id": "out", "name": "Strapped outside", "capacity": "separate", "contentsView": "list"}]
            liquid = liquid_pints(capacity)
            if liquid:
                item["liquidPints"] = liquid
            # Cases and quivers take only certain things, counted (a container's allows rules).
            for pattern, kind in ((r"Map/Scroll", "scrolls"), (r"Crossbow Bolt", "bolts"), (r"Quiver", "arrows")):
                if re.search(pattern, name):
                    item.update(HOLDS[kind])
            add(item)
    elif h in GEAR_CATS:
        for name, cost, weight in t["rows"][1:]:
            if name.startswith("Rope"):
                _, desc = split_desc(name.split("\n-")[0])
                for label, c, w in (("Rope, Hemp (50 ft)", "1 gp", "10"), ("Rope, Silk (50 ft)", "10 gp", "5")):
                    add({"id": slug("gear", label), "type": "gear", "category": "Standard", "name": label,
                         "cost": cost_cp(c), "weight": float(w), "description": desc})
                continue
            name, desc = split_desc(name)
            name = name.rstrip("*").strip()
            add({"id": slug("gear", name), "type": "gear", "category": GEAR_CATS[h], "name": name,
                 "cost": cost_cp(cost), "weight": weight_lb(weight), "description": desc,
                 "source": "PHB"})

for name in PACK_EXTRAS:
    add({"id": slug("gear", name), "type": "gear", "category": "Standard", "name": name,
         "description": "Included in an equipment pack; not sold separately in the PHB."})

# ---------------------------------------------------------------- tools
tool_tables = tables("tools")
activities = {}
for t in tool_tables[1:]:
    activities[t["heading"].lower()] = [{"activity": a, "dc": squash(d)} for a, d in t["rows"][1:]]
TOOL_CATS = {"Artisan's tools": "Artisan's Tools", "Gaming set": "Gaming Set",
             "Musical instrument": "Musical Instrument", "Miscellaneous": "Other"}
cat = None
for row in tool_tables[0]["rows"][1:]:
    name, cost, weight = (squash(c) for c in row)
    if not cost and not weight:
        cat = TOOL_CATS[name]
        continue
    acts = activities.get(name.lower()) or activities.get(name.lower().replace("tools", "supplies"))
    if not acts and cat == "Gaming Set":
        acts = activities.get("gaming kit")
    if not acts and cat == "Musical Instrument":
        acts = activities.get("musical instruments")
    add({"id": slug("tool", name), "type": "tool", "category": cat, "name": name, "cost": cost_cp(cost),
         "weight": weight_lb(weight), "activities": acts or []})

# ---------------------------------------------------------------- poisons
POISON_TYPES = {
    "Contact": "Contact poison can be smeared on an object and remains potent until it is touched or washed off. A creature that touches contact poison with exposed skin suffers its effects.",
    "Ingested": "A creature must swallow an entire dose of ingested poison to suffer its effects. The dose can be delivered in food or a liquid.",
    "Inhaled": "These poisons are powders or gases that take effect when inhaled. Blowing the powder or releasing the gas subjects creatures in a 5-foot cube to its effect.",
    "Injury": "Injury poison can be applied to weapons, ammunition, trap components, and other objects that deal piercing or slashing damage and remains potent until delivered through a wound or washed off.",
}
for name, ptype, cost in tables("poisons")[0]["rows"][1:]:
    add({"id": slug("poison", name), "type": "poison", "name": name[0].upper() + name[1:],
         "poisonType": ptype, "cost": cost_cp(cost), "description": POISON_TYPES.get(ptype, ""),
         "source": "DMG"})

# ---------------------------------------------------------------- treasure (currency page)
# Coins themselves live in the purse; the page's trade goods and gemstones become items.
LIVESTOCK = {"chicken", "goat", "sheep", "pig", "cow", "ox"}
for t in tables("currency"):
    if t["heading"] == "Trade Goods":
        for cost, goods in t["rows"][1:]:
            unit = None
            # "1 lb. of cinnamon or pepper, or one sheep" -> cinnamon (1 lb), pepper (1 lb), sheep
            for part in re.split(r",?\s+or\s+", squash(goods)):
                m = re.match(r"(1 lb\.|1 sq\. yd\.) of (.+)", part)
                if m:
                    unit, what = m.group(1), m.group(2)
                elif part.startswith("one "):
                    unit, what = None, part[4:]
                else:
                    what = part  # shares the previous unit: "cinnamon or pepper"
                name = what[0].upper() + what[1:]
                if unit:
                    name += " (1 lb)" if unit == "1 lb." else " (1 sq yd)"
                livestock = what in LIVESTOCK
                add({"id": slug("trade", name), "type": "treasure", "category": "Trade Good", "name": name,
                     "cost": cost_cp(cost), "weight": 1 if unit == "1 lb." else 0,
                     "description": "Livestock, traded by the head." if livestock else
                     "A trade good. Merchants commonly exchange goods like this without using currency."})
    elif t["heading"] == "Gemstones":
        value = t["rows"][0][0]  # "10 gp Gemstones"
        for name, desc in t["rows"][1:]:
            name = squash(name).replace("Yellow-sapphire", "Yellow sapphire").replace("Tigers eye", "Tiger eye")
            add({"id": slug("gem", name), "type": "treasure", "category": "Gem", "name": name,
                 "cost": cost_cp(value), "description": f"{squash(desc)}.\n\nA {value.split(' Gem')[0]} gemstone.",
                 "source": "DMG"})

# ---------------------------------------------------------------- trinkets
TRINKET_SOURCES = {"Player's Handbook": "PHB", "Elemental Evil": "EE", "Curse of Strahd": "CoS",
                   "Mordenkainen's Tome of Foes": "MToF", "Eberron: Rising from the Last War": "ERLW",
                   "Lost Laboratory of Kwalish": "LLoK", "Acquisitions Incorporated": "AI",
                   "Icewind Dale: Rime of the Frostmaiden": "IDRotF",
                   "Van Richten's Guide to Ravenloft": "VRGR", "The Wild Beyond The Witchlight": "WBtW"}
trinket_tables = []
for t in tables("trinkets"):
    book = (t["tab"] or "Player's Handbook").replace("Ebberon", "Eberron")
    # Only the Player's Handbook table: the others are tied to particular settings and adventures.
    if book != "Player's Handbook":
        continue
    title = book
    if t["heading"].startswith("Trinkets from"):
        title = t["heading"]
    elif "Elven" in t["rows"][0][1]:
        title = "Elven Trinkets"
    elif "Feywild" in t["rows"][0][1]:
        title = "Feywild Trinkets"
    table_id = slug("trinkets", title)
    die = t["rows"][0][0]
    entries = []
    for roll, text in t["rows"][1:]:
        text = squash(text)
        iid = slug("trinket", TRINKET_SOURCES.get(book, book), title, roll)
        entries.append({"roll": roll, "id": iid})
        add({"id": iid, "type": "trinket", "name": text, "roll": roll, "table": title,
             "source": TRINKET_SOURCES.get(book, book)})
    trinket_tables.append({"id": table_id, "name": title, "book": book, "die": die, "entries": entries})

# ---------------------------------------------------------------- reclassify
# The gear page lists some things that are really consumables or poisons. The ids stay the
# same (js/store.js RECLASSIFIED updates copies already in inventories to match).
RECLASSIFY = {
    "gear-acid-vial": {"type": "consumable", "category": "Alchemical"},
    "gear-alchemist-s-fire-flask": {"type": "consumable", "category": "Alchemical"},
    "gear-antitoxin-vial": {"type": "consumable", "category": "Potion"},
    "gear-holy-water-flask": {"type": "consumable", "category": "Other"},
    "gear-oil-flask": {"type": "consumable", "category": "Other"},
    "gear-potion-of-healing-common": {"type": "consumable", "category": "Potion", "rarity": "Common"},
    "gear-rations-1-day": {"type": "consumable", "category": "Food"},
    "gear-poison-basic-vial": {"type": "poison", "category": None, "poisonType": "Injury"},
}
by_id = {i["id"]: i for i in items}
for iid, change in RECLASSIFY.items():
    assert iid in by_id, iid
    by_id[iid].update(change)

# ---------------------------------------------------------------- decks
# A playing card set holds its cards as separate items (see "decks" in js/store.js).
RANKS = ["Ace", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Jack", "Queen", "King"]
SUITS = ["Spades", "Hearts", "Diamonds", "Clubs"]
by_id["tool-playing-card-set"]["deckCards"] = [f"{r} of {s}" for s in SUITS for r in RANKS] + ["Red Joker", "Black Joker"]

# ---------------------------------------------------------------- SRD-only copy
SRD_ONLY = "--srd-only" in sys.argv
if SRD_ONLY:
    OUT = os.path.abspath(sys.argv[sys.argv.index("--srd-only") + 1])
    NOT_SRD = {"tool-dragonchess-set", "tool-three-dragon-ante-set"}  # Forgotten Realms games; the SRD has dice and cards
    items = [i for i in items if i["type"] != "trinket" and i["id"] not in NOT_SRD
             and not (i["type"] == "treasure" and i.get("category") == "Gem")]  # gem tables are the DMG's
    for i in items:
        i.pop("activities", None)  # tool activities are from Xanathar's Guide
        if i["type"] in ("container", "treasure"):
            i.pop("description", None)
        i["source"] = "SRD 5.1"
    trinket_tables = []

# ---------------------------------------------------------------- write
ids = [i["id"] for i in items]
dupes = {i for i in ids if ids.count(i) > 1}
assert not dupes, dupes
names = {i["name"] for i in items}
for p in PACKS.values():
    for n, _ in p:
        assert n in names, n
for i in items:
    for k in [k for k, v in i.items() if v in ("", [], None) and k != "properties"]:
        del i[k]

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf8") as f:
    f.write("// Generated by tools/build_srd.py from dnd5e.wikidot.com - do not edit by hand.\n")
    if SRD_ONLY:
        f.write("// Includes material from the System Reference Document 5.1 by Wizards of the Coast LLC,\n"
                "// available at https://dnd.wizards.com/resources/systems-reference-document, licensed under\n"
                "// CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/legalcode).\n")
    f.write("// Costs are in copper pieces, weights in pounds.\n")
    f.write("const SRD_ITEMS = " + json.dumps(items, ensure_ascii=False, separators=(",", ":")) + ";\n")
    f.write("const TRINKET_TABLES = " + json.dumps(trinket_tables, ensure_ascii=False, separators=(",", ":")) + ";\n")
    f.write("const WEAPON_PROPERTIES = " + json.dumps(PROPERTY_GLOSSARY, ensure_ascii=False, indent=0) + ";\n")

from collections import Counter
print(len(items), "items", dict(Counter(i["type"] for i in items)))
print(len(trinket_tables), "trinket tables:", [t["name"] for t in trinket_tables])
