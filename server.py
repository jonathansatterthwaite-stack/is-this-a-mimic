#!/usr/bin/env python3
"""Is This A Mimic(s)? party server.

Serves the app on your local network and keeps every player's character on
this computer so players can trade with each other.

    python server.py [port]        (default port 8765)

Players on the same Wi-Fi/LAN open the address printed at startup. Only the
standard library is used, so there is nothing to install.

The desktop app (desktop.py / ITAMSapp.exe) imports this module instead: it
serves the app privately on 127.0.0.1 and only opens the network-facing
server while the player chooses to host a party.
"""
import base64
import copy
import hashlib
import json
import math
import os
import random
import re
import socket
import string
import sys
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# App files live next to this script, or in PyInstaller's unpack dir inside the exe.
ROOT = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "party-data")
DATA_FILE = os.path.join(DATA_DIR, "party.json")
DEFAULT_LAN_PORT = 8765
# Only the app itself is served; party-data (which holds player tokens) and tools are not.
STATIC_PREFIXES = ("/index.html", "/manifest.webmanifest", "/sw.js", "/css/", "/js/", "/icons/")
NON_STACKING = {"weapon", "armor", "container", "magic", "pack"}
# The game system's money, as the GM's device sends it with the campaign (see clean_currency):
# coins [key, value] largest first, worth `value` of the smallest; change: what shops pay out and
# give change in. Until a campaign says (one without a game system): D&D 5e's.
DEFAULT_CURRENCY = {"coins": [["pp", 1000], ["gp", 100], ["ep", 50], ["sp", 10], ["cp", 1]], "change": ["gp", "sp", "cp"]}
MAX_BODY = 8 * 1024 * 1024
MAX_VALUES = 200  # Global and Local values kept in one place (the party's, a character's, an item's)
MAX_IMAGE_BYTES = 5 * 1024 * 1024
IMAGE_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}
KEEP_RESOLVED_TRADES = 50

cond = threading.Condition()  # guards everything below
state = {"characters": {}, "trades": []}
version = 0                   # bumped on every change; event streams wait on it
online = {}                   # player token -> number of open event streams
leaving = set()               # tokens whose player chose Leave party: their streams close now

# Desktop mode (see desktop.py)
DESKTOP = False
app_server = None             # the app window's private server on 127.0.0.1
lan_server = None             # the server other players join; None when not hosting
lan_port = None
presence = {"count": 0, "seen": False, "changed": time.time()}  # open app windows


def configure(data_dir, desktop, local_dir=None):
    global DATA_DIR, DATA_FILE, DESKTOP, LOCAL_DIR
    DATA_DIR = data_dir
    DATA_FILE = os.path.join(data_dir, "party.json")
    DESKTOP = desktop
    LOCAL_DIR = local_dir
    load()
    load_local()


# ------------------------------------------------------------------ this PC's own data (desktop app)
#
# Everything the app would otherwise keep in browser storage (characters,
# custom items, settings, party identity) plus document images, stored in
# files so every window or browser tab of the app on this PC shares them.

LOCAL_DIR = None
local = {"rev": 0, "data": {}}  # key -> string value, like localStorage


def local_file():
    return os.path.join(LOCAL_DIR, "app-data.json")


def load_local():
    if LOCAL_DIR and os.path.exists(local_file()):
        with open(local_file(), encoding="utf8") as f:
            local["data"] = json.load(f).get("data", {})


def save_local():
    os.makedirs(LOCAL_DIR, exist_ok=True)
    tmp = local_file() + ".tmp"
    with open(tmp, "w", encoding="utf8") as f:
        json.dump({"data": local["data"]}, f, ensure_ascii=False)
    os.replace(tmp, local_file())


GM_NAME = re.compile(r"^gm_[A-Za-z0-9_]{1,40}$")  # a GM value's name, as drawn icons' formulas use it


def party_enabled():
    return not DESKTOP or lan_server is not None


# ------------------------------------------------------------------ persistence

# Each campaign the GM loads has its own party save (party-data/campaigns/<id>.json); the file
# active-campaign says which is current. party.json is the party until the GM loads one.
CAMPAIGN_ID = re.compile(r"^[A-Za-z0-9_-]{1,60}$")
HOST_LEVEL = ("partyId", "gms", "devices")  # the host's, whatever the campaign


def campaign_file(cid):
    return os.path.join(DATA_DIR, "campaigns", f"{cid}.json")


def pointer_file():
    return os.path.join(DATA_DIR, "active-campaign")


def load():
    global state, DATA_FILE
    DATA_FILE = os.path.join(DATA_DIR, "party.json")
    try:
        with open(pointer_file(), encoding="utf8") as f:
            cid = f.read().strip()
        if CAMPAIGN_ID.match(cid) and os.path.exists(campaign_file(cid)):
            DATA_FILE = campaign_file(cid)
    except OSError:
        pass
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, encoding="utf8") as f:
            state = json.load(f)
        state.setdefault("characters", {})
        state.setdefault("trades", [])
    state.setdefault("shops", [])
    if not state.get("partyId"):
        # Lets devices recognise this party even if the host's address changes.
        state["partyId"] = new_id("p")
        save()


def save():
    os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf8") as f:
        json.dump(state, f, ensure_ascii=False)
    os.replace(tmp, DATA_FILE)


def now_ms():
    """The host's clock, which every device's moving values follow (snapshots carry it)."""
    return int(time.time() * 1000)


def is_num(v, limit=1e9):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and abs(v) <= limit


def clean_value(name, v):
    """A value as kept: a number, or a moving one {value, rate, until?} (a change over time: rate a
    second, stopping at until), stamped with the host's time (since, in ms). Moving values are worked
    out from the time on every device, so only starting and stopping one is sent. None: not a value.
    The GM's state overrides (gm_state_…) are numbers only. A number may be as big as a time in ms
    (a drawing's "mark the time" keeps now)."""
    if is_num(v, 1e13):
        return v
    if not isinstance(v, dict) or name.startswith("gm_state_") or not is_num(v.get("value")) or not is_num(v.get("rate"), 1e6):
        return None
    out = {"value": v["value"], "rate": v["rate"], "since": now_ms()}
    if v.get("until") is not None:
        if not is_num(v["until"]):
            return None
        out["until"] = v["until"]
    return out


def value_now(v, now=None):
    """A kept value as it is now (a moving one worked out from the time), else None."""
    if isinstance(v, dict):
        x = v["value"] + v["rate"] * max(0, ((now or now_ms()) - v["since"]) / 1000)
        u = v.get("until")
        if u is not None:
            x = min(x, u) if v["rate"] > 0 else max(x, u)
        return x
    return v if is_num(v) else None


def clean_gm_values(raw):
    """GM values sent by a GM's campaign: {party: {name: n}, characters: {id: {…}}, items: {"id/uid": {…}}}."""
    def bucket(b):
        if not isinstance(b, dict):
            return {}
        kept = {k: clean_value(k, v) for k, v in b.items() if isinstance(k, str) and GM_NAME.match(k)}
        return {k: v for k, v in kept.items() if v is not None}
    raw = raw if isinstance(raw, dict) else {}
    out = {"party": bucket(raw.get("party"))}
    for group in ("characters", "items"):
        g = raw.get(group) if isinstance(raw.get(group), dict) else {}
        out[group] = {str(t)[:200]: bucket(b) for t, b in list(g.items())[:2000] if bucket(b)}
    return out


def clean_own_states(raw):
    """A campaign's own item states (js/app.js: editOwnState): known fields only, within limits."""
    out = []
    for st in (raw if isinstance(raw, list) else [])[:30]:
        if not isinstance(st, dict) or not isinstance(st.get("key"), str) or not isinstance(st.get("label"), str):
            continue
        x = {"key": st["key"][:40], "label": st["label"][:30], "who": "gm" if st.get("who") == "gm" else "player"}
        if isinstance(st.get("requires"), str) and st["requires"]:
            x["requires"] = st["requires"][:40]
        lim = st.get("limit")
        if isinstance(lim, dict) and isinstance(lim.get("default"), int) and not isinstance(lim.get("default"), bool) and 0 < lim["default"] < 1000:
            x["limit"] = {"default": lim["default"], "mode": "warn"}
        out.append(x)
    return out


RULES_MAX = 200
RULES_MAX_BYTES = 200_000


def clean_rules(raw):
    """The campaign's rule book (js/triggers.js): kept as the GM's device sent it, within limits.
    Every device checks each rule itself before it runs (cleanTriggers), so the host only keeps
    the list sane: objects, at most RULES_MAX, at most RULES_MAX_BYTES in all."""
    out, size = [], 0
    for r in (raw if isinstance(raw, list) else [])[:RULES_MAX]:
        if not isinstance(r, dict):
            continue
        size += len(json.dumps(r))
        if size > RULES_MAX_BYTES:
            break
        out.append(r)
    return out


def clean_system_ref(raw):
    """The game system a campaign plays, as the GM's device names it ({id, name}), or None."""
    if not isinstance(raw, dict) or not raw.get("id"):
        return None
    return {"id": str(raw["id"])[:80], "name": str(raw.get("name") or raw["id"])[:80]}


def switch_campaign(cid, name, shops, gm_values, system=None, money=None, states=None):
    """Call with `cond` held. Saves the current campaign's party and makes `cid` current: its own
    save if it has one, else a fresh party with the GM's shops and GM values. The first campaign
    loaded keeps what the party has so far (players who joined before it)."""
    global state, DATA_FILE
    current = state.get("campaign") or {}
    host_level = {k: state[k] for k in HOST_LEVEL if k in state}
    if current.get("id") == cid:
        state["campaign"] = {"id": cid, "name": name, "system": system, "currency": money, "states": states}
        save()
        return
    save()
    target = campaign_file(cid)
    if os.path.exists(target):
        with open(target, encoding="utf8") as f:
            new = json.load(f)
    elif not current and (state["characters"] or state.get("shops") or state.get("gm")):
        # The party so far: it keeps what it has, and gains the GM's shops (ones it hasn't got) and
        # GM values (where it has none of its own).
        new = state
        have = {sh.get("id") for sh in new.setdefault("shops", [])}
        new["shops"] += [sh for sh in shops if sh["id"] not in have]
        old_gm = new.get("gm") or {}
        new["gm"] = {"party": {**gm_values.get("party", {}), **(old_gm.get("party") or {})}}
        for group in ("characters", "items"):
            merged = {t: dict(b) for t, b in gm_values.get(group, {}).items()}
            for t, b in (old_gm.get(group) or {}).items():
                merged[t] = {**merged.get(t, {}), **b}
            new["gm"][group] = merged
    else:
        new = {"characters": {}, "trades": [], "shops": shops, "gm": gm_values}
    new.update(host_level)
    new["campaign"] = {"id": cid, "name": name, "system": system, "currency": money, "states": states}
    for k, v in (("characters", {}), ("trades", []), ("shops", []), ("gm", {})):
        new.setdefault(k, v)
    state = new
    DATA_FILE = target
    save()
    with open(pointer_file(), "w", encoding="utf8") as f:
        f.write(cid)


def changed(persist=True):
    """Call with `cond` held after mutating state."""
    global version
    version += 1
    if persist:
        save()
    cond.notify_all()


def new_id(prefix=""):
    rnd = "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
    return prefix + format(int(time.time() * 1000), "x") + rnd


# ------------------------------------------------------------------ views

def public_char(c, token):
    out = {k: v for k, v in c.items() if k != "owner"}
    out["mine"] = c["owner"] == token
    out["online"] = online.get(c["owner"], 0) > 0
    return out


# ------------------------------------------------------------------ roles
# The host (the device running the party) can stop it, choose GMs and remove players. GMs run the
# game: shops, GM values, the players' details. Until the host makes some device a GM, the host is.
# Devices are known by their player token; other devices only ever see a hash of it.

def role_of(token, host):
    gms = state.get("gms") or []
    if token and token in gms:
        return "gm"
    return "gm" if host and not gms else "player"


def world_runner():
    """Which GM device runs the campaign's world rules (js/triggers.js): one, so a rule doesn't run
    once per GM. The first GM connected, else the first GM."""
    gms = state.get("gms") or []
    return next((t for t in gms if online.get(t, 0) > 0), gms[0] if gms else None)


def device_id(token):
    return hashlib.sha256(("mimic-device:" + token).encode()).hexdigest()[:16]


def device_list(me):
    """The devices in the party, for the host: names, who's online, what they play, GM or not."""
    chars = state["characters"].values()
    names = state.get("devices") or {}
    gms = state.get("gms") or []
    tokens = list(dict.fromkeys([*names, *(c["owner"] for c in chars), *gms]))
    return [{"id": device_id(t), "name": (names.get(t) or {}).get("name") or "Unnamed device",
             "online": online.get(t, 0) > 0, "characters": [c["name"] for c in chars if c["owner"] == t],
             "gm": t in gms, "self": t == me} for t in tokens if t]


# ------------------------------------------------------------------ treasure
# The GM shows a hoard to some players (the app's js/treasure.js): they pick items, how many of a
# stack, or coins; press Ready; once everyone taking part is ready the uncontested picks are given
# out, and the GM settles what's contested (more picked than there is). What's left goes back to
# the GM's hoard (their device takes it, then deletes the showing).
#   state["treasure"]: [{id, name, hoard, items: [entry], coins: {coin: n}, players: [charId],
#     picks: {key: {charId: qty}}, ready: [charId], status: "picking" | "settling" | "done", given: [...]}]
# A key is "e:<entry uid>" or "c:<coin>". Given items arrive as new (their triggers fire).

def treasure_available(t, key):
    if key.startswith("c:"):
        return int((t.get("coins") or {}).get(key[2:]) or 0)
    e = next((x for x in t["items"] if x["uid"] == key[2:]), None)
    return e["qty"] if e else 0


def treasure_contested(t):
    return [k for k, p in t["picks"].items() if sum(p.values()) > treasure_available(t, k)]


def treasure_depth(t, e):
    d, seen = 0, set()
    while e and e.get("parent") and e["uid"] not in seen:
        seen.add(e["uid"])
        e = next((x for x in t["items"] if x["uid"] == e["parent"]), None)
        d += 1
    return d


def treasure_give(t, alloc):
    """Give out {charId: {key: qty}}: into the characters, out of the showing. A container's
    contents go in it when the same character gets both; a set's pieces go with the set."""
    taken = {}
    for cid, keys in alloc.items():
        c = state["characters"].get(cid)
        if not c:
            continue
        new_uid, got = {}, []
        picked = sorted((e for e in t["items"] if keys.get("e:" + e["uid"])), key=lambda e: treasure_depth(t, e))
        for e in picked:
            q = min(keys["e:" + e["uid"]], e["qty"])
            parent = new_uid.get(e.get("parent"))
            entry = copy.deepcopy(e)
            entry.update(uid=new_id(), qty=q, parent=parent, equipped=False, seen=None)
            if not parent:
                entry.pop("compartment", None)
            add_history(entry, f"From {t['name']} (treasure)")
            new_uid[e["uid"]] = entry["uid"]
            pieces = [x for x in t["items"] if x.get("parent") == e["uid"] and (x.get("item") or {}).get("card")]
            if parent is None and not pieces and not any(x.get("parent") == e["uid"] for x in picked):
                merge_into(c, entry)
            else:
                c["items"].append(entry)
            for p in pieces:
                c["items"].append(dict(copy.deepcopy(p), uid=new_id(), parent=entry["uid"], fromDeck=entry["uid"], seen=None))
            got.append(f"{q} × {e['item'].get('name', 'item')}" if q > 1 else e["item"].get("name", "item"))
            taken[e["uid"]] = taken.get(e["uid"], 0) + q
        coins = dict(c.get("coins") or {})
        for key, q in keys.items():
            if key.startswith("c:") and q > 0:
                k = key[2:]
                coins[k] = int(coins.get(k) or 0) + q
                t["coins"][k] = max(0, int(t["coins"].get(k) or 0) - q)
                got.append(f"{q} {k}")
        c["coins"] = coins
        c["rev"] += 1
        if got:
            t.setdefault("given", []).append({"character": cid, "name": c["name"], "items": got})
    # What's left: fewer of what was taken; a taken container's contents fall out of it.
    gone = set()
    for e in t["items"]:
        if e["uid"] in taken:
            e["qty"] -= taken[e["uid"]]
            if e["qty"] <= 0:
                gone.add(e["uid"])
    gone |= {x["uid"] for x in t["items"] if x.get("parent") in gone and (x.get("item") or {}).get("card")}
    t["items"] = [x for x in t["items"] if x["uid"] not in gone]
    for x in t["items"]:
        if x.get("parent") in gone:
            x["parent"] = None
            x.pop("compartment", None)
    t["coins"] = {k: n for k, n in t["coins"].items() if n > 0}


def treasure_settle(t):
    """Everyone's ready (or the GM says so): give out what isn't contested; the GM settles the rest."""
    contested = set(treasure_contested(t))
    alloc = {}
    for key, p in t["picks"].items():
        if key not in contested:
            for cid, q in p.items():
                if q > 0:
                    alloc.setdefault(cid, {})[key] = q
    treasure_give(t, alloc)
    t["picks"] = {k: p for k, p in t["picks"].items() if k in contested}
    t["status"] = "settling" if t["picks"] else "done"


def clean_treasure_items(raw):
    items = []
    for e in (raw if isinstance(raw, list) else [])[:3000]:
        if not isinstance(e, dict) or not isinstance(e.get("item"), dict) or not e["item"].get("name"):
            continue
        try:
            qty = max(1, int(e.get("qty") or 1))
        except (TypeError, ValueError):
            continue
        items.append(dict(e, uid=str(e.get("uid") or new_id())[:40], qty=qty, parent=(str(e["parent"])[:40] if e.get("parent") else None)))
    uids = {e["uid"] for e in items}
    for e in items:
        if e["parent"] not in uids:
            e["parent"] = None
            e.pop("compartment", None)
    return items


# ------------------------------------------------------------------ sharing and discarding
# Shared screens (docs/gm-puzzles-plan.md): something a device shows to some of the party, and/or
# the GM. It stays until whoever shared it ends it (or leaves the party; a day at most). Kinds:
# "item" (an item shown to look at: nothing moves), "trade" (a live trade window between two
# characters) and "panel" (a GM's panel shown to players, which they use). (Treasure has its own
# calls, treasure_api.)
#   state["shares"]: [{id, kind, by: token, from: charId | "", fromName, to: [charId], gm: bool,
#     seen: [charId | "gm"] (opened at least once), at, + the kind's own:
#     item: item, contents;
#     trade: with (the other character), withName, sides: {charId: {items: [{uid, qty, name, entry,
#       inside}], coins, asks: [{uid, qty, name}] (the other's items asked for), note}}, agreed:
#       [charId], reason (why it last failed);
#     panel: panelId, title, panel (the panel as the GM's device has it), uses: [{id, character,
#       type: "set" | "used", control, name?, value?, signal?, socket? ("put" | "took"), entry?,
#       contents?, at}] (players' uses, waiting for the GM's device that shared it to make them and
#       take them off), sockets: {controlId: {id, name, items: [entry], by: charId | "" (the GM's,
#       there from the start), byName}} (what each socket holds: the host moves items in and out,
#       as a trade does; ended, what players put in goes back to them)}]
# A trade is made (execute, as an offer was) once both have agreed; any change to a side clears
# the agreements. Done or walked away from, it goes into state["trades"] (the history).
# Discarding an item (in a party, Remove is Discard) sends it to the GM: it waits here until a GM's
# device takes it into a hoard (Discarded), then deletes it.
#   state["discards"]: [{id, character, name, items: [entry], at}]
SHARE_TTL_MS = 24 * 60 * 60 * 1000
# (Kept in memory and in the party's save: a player can't fill them up.)
SHARE_MAX_BYTES, SHARES_PER_DEVICE = 300_000, 20
PANEL_MAX_BYTES, PANEL_USES_MAX = 2_000_000, 200
DISCARD_MAX_BYTES, DISCARDS_PER_CHARACTER = 1_000_000, 50


def prune_shares():
    shares = state.get("shares")
    if shares:
        cutoff = now_ms() - SHARE_TTL_MS
        for s in shares:
            if s["at"] <= cutoff:
                return_socket_items(s)  # (what players put in a shown panel's sockets isn't lost with it)
        state["shares"] = [s for s in shares if s["at"] > cutoff]


def return_socket_items(s):
    """A shown panel ends (ended, its GM gone, or too old): what players put in its sockets goes
    back to them."""
    for held in (s.get("sockets") or {}).values():
        c = state["characters"].get(held.get("by") or "")
        if not c:
            continue
        for e in [x for x in held.get("items") or [] if not x.get("parent")]:
            transfer(held, c, e["uid"], e["qty"], f"back from {held.get('name') or 'a panel'}")
        c["rev"] += 1
    s["sockets"] = {}


def snapshot(token, host=False):
    chars = state["characters"]
    mine = {cid for cid, c in chars.items() if c["owner"] == token}
    trades = [dict(t, fromMine=t["from"] in mine, toMine=t["to"] in mine)
              for t in state["trades"] if t["from"] in mine or t["to"] in mine]
    snap = {"characters": [public_char(c, token) for c in chars.values()], "trades": trades,
            "shops": [public_shop(sh) for sh in state.get("shops", []) if shop_open(sh)],
            "gm": state.get("gm") or {}, "role": role_of(token, host), "isHost": host,
            "campaign": state.get("campaign"), "time": now_ms()}
    # Treasure being shown: a GM sees every showing, a player the ones their characters are in.
    gm_view = role_of(token, host) == "gm"
    snap["treasure"] = [t for t in state.get("treasure", []) if gm_view or mine & set(t["players"])]
    # Items shown: to the devices of those they're shown to (the GM's too, when shown to the GM),
    # and to whoever showed them. Discarded items wait for a GM's device to take them.
    prune_shares()
    snap["shares"] = [dict(s, fromMine=s["by"] == token) for s in state.get("shares", [])
                     if mine & set(s["to"]) or (gm_view and s["gm"]) or s["by"] == token]
    if gm_view:
        snap["discards"] = state.get("discards", [])
        # With no GMs chosen the host is the GM; else one GM device runs the world rules.
        snap["runsWorld"] = token == world_runner() if state.get("gms") else bool(host)
    if host:
        snap["devices"] = device_list(token)
    return snap


_own_ips = {"at": 0, "ips": set()}


def own_ips():
    """This computer's addresses (cached briefly): requests from them come from this PC."""
    if time.time() - _own_ips["at"] > 30:
        _own_ips["ips"] = set(lan_addresses()) | {"127.0.0.1", "::1"}
        _own_ips["at"] = time.time()
    return _own_ips["ips"]


def lan_addresses():
    addrs = set()
    try:  # the address the OS would use to reach the internet; UDP connect sends nothing
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        addrs.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            addrs.add(info[4][0])
    except OSError:
        pass
    return sorted(a for a in addrs if not a.startswith("127."))


# ------------------------------------------------------------------ trades

class TradeError(Exception):
    pass


def find_entry(char, uid):
    return next((e for e in char["items"] if e["uid"] == uid), None)


def descendants(char, uid):
    out, frontier = [], [uid]
    while frontier:
        kids = [e for e in char["items"] if e.get("parent") in frontier]
        out += kids
        frontier = [e["uid"] for e in kids]
    return out


def clean_side(char, side):
    """Normalise one side of an offer and attach item names for display."""
    side = side or {}
    items = []
    for it in side.get("items") or []:
        qty = int(it.get("qty") or 0)
        e = find_entry(char, it.get("uid"))
        if qty <= 0 or not e:
            raise TradeError("An item in the offer no longer exists.")
        name = str(e.get("customName") or "").strip() or e["item"]["name"]  # the player's name for it, if any
        items.append({"uid": e["uid"], "qty": qty, "name": name})
    uids = {i["uid"] for i in items}
    for i in items:  # giving a container already gives everything in it
        if any(d["uid"] in uids for d in descendants(char, i["uid"])):
            raise TradeError(f"Don't list items that are inside {i['name']} - they go with it.")
    coins = {k: int((side.get("coins") or {}).get(k) or 0) for k in coin_keys(currency())}
    if any(v < 0 for v in coins.values()):
        raise TradeError("Coin amounts can't be negative.")
    return {"items": items, "coins": {k: v for k, v in coins.items() if v}}


def check_side(char, side):
    for it in side["items"]:
        e = find_entry(char, it["uid"])
        if not e or e["qty"] < it["qty"]:
            raise TradeError(f"{char['name']} no longer has {it['qty']} x {it['name']}.")
    for k, v in side["coins"].items():
        if (char.get("coins") or {}).get(k, 0) < v:
            raise TradeError(f"{char['name']} doesn't have {v} {k}.")


# ------------------------------------------------------------------ shops

def clean_currency(raw):
    """A currency sent by a GM's device, checked; None if it isn't one (one coin must be worth 1)."""
    if not isinstance(raw, dict) or not isinstance(raw.get("coins"), list):
        return None
    coins = []
    for c in raw["coins"][:12]:
        if (isinstance(c, list) and len(c) == 2 and isinstance(c[0], str) and re.match(r"^[a-z][a-z0-9]{0,7}$", c[0])
                and isinstance(c[1], int) and not isinstance(c[1], bool) and 1 <= c[1] <= 10 ** 9 and c[0] not in (k for k, _ in coins)):
            coins.append([c[0], c[1]])
    coins.sort(key=lambda c: -c[1])
    if not any(v == 1 for _, v in coins):
        return None
    keys = [k for k, _ in coins]
    asked = raw.get("change") if isinstance(raw.get("change"), list) else keys
    change = [k for k in keys if k in asked]
    if keys[-1] not in change:
        change.append(keys[-1])
    return {"coins": coins, "change": change}


def currency():
    """The money of the campaign being played."""
    return (state.get("campaign") or {}).get("currency") or DEFAULT_CURRENCY


def coin_keys(cur):
    return [k for k, _ in cur["coins"]]


def coins_for(amount, allowed, values):
    """Greedy split of an amount into the allowed coins."""
    out = {}
    for k in allowed:
        out[k], amount = divmod(amount, values[k])
    return out


def payout(amount, margin=0, top=None, cur=None):
    """Coins a shop hands over (same as payout() in store.js). Mostly the largest change coins (up
    to `top`), but `margin` % of it in the next smaller coin, the way a shopkeeper gives some small
    change."""
    cur = cur or currency()
    values, change = dict(cur["coins"]), cur["change"]
    allowed = change[change.index(top or change[0]):]
    small = amount * margin // 100
    main = coins_for(amount - small, allowed, values)
    largest = next((k for k in allowed if main.get(k)), allowed[-1])
    smaller = change[change.index(largest) + 1:] or [largest]
    extra = coins_for(small, smaller, values)
    return {k: main.get(k, 0) + extra.get(k, 0) for k in change}


def pay_coins(coins, cost, margin=0, cur=None):
    """Same as payCoins() in store.js: spend big coins first without overpaying,
    then break the smallest coin that covers the rest. None if unaffordable.
    Change comes as payout(margin) in coins smaller than the one broken."""
    cur = cur or currency()
    keys, values = coin_keys(cur), dict(cur["coins"])
    c = {k: int((coins or {}).get(k) or 0) for k in keys}
    if sum(c[k] * values[k] for k in keys) < cost:
        return None
    remaining = cost
    for d in keys:
        n = min(c[d], remaining // values[d])
        c[d] -= n
        remaining -= n * values[d]
    if remaining > 0:
        d = next(k for k in reversed(keys) if c[k] > 0 and values[k] > remaining)
        c[d] -= 1
        top = next(k for k in cur["change"] if values[k] < values[d])
        for k, n in payout(values[d] - remaining, margin, top, cur).items():
            c[k] += n
    return c


# Shops can follow Global values (Clockwork, see js/clockwork.js and shops.js): open while a
# condition holds (openIf), prices times a value (priceValue), an item for sale only while a
# condition holds (a listing's onlyIf). A condition is {name, op, to}; an unset value counts as 0.
COND_OPS = ("=", "!=", "<", "<=", ">", ">=")
VALUE_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,39}$")


def clean_cond(raw):
    """A condition on a Global value, checked, or None."""
    if not isinstance(raw, dict) or not isinstance(raw.get("name"), str) or not VALUE_NAME.match(raw["name"]) \
            or raw.get("op") not in COND_OPS:
        return None
    to = raw.get("to")
    if isinstance(to, bool) or not isinstance(to, (int, float)) or not math.isfinite(to):
        return None
    return {"name": raw["name"], "op": raw["op"], "to": to}


def global_value(name, default=0):
    """A Global value (kept as the GM value gm_<name>), else default."""
    v = value_now(((state.get("gm") or {}).get("party") or {}).get("gm_" + name))
    return default if v is None else v


def clockwork_on():
    """The campaign's rules, values and controls (the GM can switch them off): shops follow values only while on."""
    return (state.get("campaign") or {}).get("clockwork") is not False


def cond_holds(c):
    if not c or not clockwork_on():
        return True
    v, to = global_value(c["name"]), c["to"]
    return {"=": v == to, "!=": v != to, "<": v < to, "<=": v <= to, ">": v > to, ">=": v >= to}[c["op"]]


def shop_open(shop):
    """Open by its condition if it has one, else as the GM set it."""
    return cond_holds(shop["openIf"]) if shop.get("openIf") and clockwork_on() else bool(shop.get("open"))


def price_factor(shop):
    """What the shop's prices are multiplied by: its price value (1 while unset), from 0 to 100."""
    name = shop.get("priceValue")
    v = global_value(name, None) if name and clockwork_on() else None
    return 1 if v is None else max(0, min(100, v))


def listing_price(shop, listing):
    """Price of one lot (a bundle, for ammunition) after the shop's markup and price value, in copper."""
    base = listing["price"] if listing.get("price") is not None else int(listing["item"].get("cost") or 0)
    # Worked out in the same order as listingPrice() in the app, and halves rounded up like its
    # Math.round(), so the price shown is the price charged.
    return max(0, math.floor(base * (100 + int(shop.get("markup") or 0)) * price_factor(shop) / 100 + 0.5))


def clean_shop(raw):
    if not isinstance(raw, dict):
        raise ApiError(400, "Invalid shop")
    try:
        items = []
        for li in (raw.get("items") or [])[:500]:
            it = li.get("item") if isinstance(li, dict) else None
            if not isinstance(it, dict) or not it.get("name") or not it.get("type"):
                continue
            price, stock = li.get("price"), li.get("stock")
            listing = {
                "lid": str(li.get("lid") or new_id("l"))[:40], "srcId": (str(li.get("srcId") or "")[:80] or None),
                "item": it, "price": None if price in (None, "") else max(0, int(price)),
                "stock": None if stock in (None, "") else max(0, int(stock)),
            }
            if clean_cond(li.get("onlyIf")):
                listing["onlyIf"] = clean_cond(li.get("onlyIf"))
            items.append(listing)
        type_rates = {}
        for k, v in list((raw.get("typeRates") or {}).items())[:40]:
            if v not in (None, ""):
                type_rates[str(k)[:20]] = max(0, min(1000, int(v)))
        sell_items = []
        for r in (raw.get("sellItems") or [])[:300]:
            if not isinstance(r, dict) or not r.get("srcId"):
                continue
            mode = "fixed" if r.get("mode") == "fixed" else "percent"
            sell_items.append({"srcId": str(r["srcId"])[:80], "name": str(r.get("name") or "")[:120],
                               "icon": (str(r.get("icon") or "")[:40] or None), "type": str(r.get("type") or "")[:20],
                               "mode": mode, "value": max(0, min(100000000 if mode == "fixed" else 1000, int(r.get("value") or 0)))})
        return {
            "name": str(raw.get("name") or "Shop")[:80], "keeper": str(raw.get("keeper") or "")[:80],
            "description": str(raw.get("description") or "")[:2000], "icon": (str(raw.get("icon") or "")[:40] or None),
            "open": bool(raw.get("open")), "markup": max(-90, min(500, int(raw.get("markup") or 0))), "items": items,
            # Following Global values (see shop_open, price_factor)
            "openIf": clean_cond(raw.get("openIf")),
            "priceValue": raw["priceValue"] if isinstance(raw.get("priceValue"), str) and VALUE_NAME.match(raw["priceValue"]) else None,
            # Buying from players
            "buys": bool(raw.get("buys")), "sellRate": max(0, min(1000, int(raw.get("sellRate") if raw.get("sellRate") not in (None, "") else 50))),
            "typeRates": type_rates, "sellItems": sell_items,
            # Money: one universal pot in copper; None = unlimited. Margin = % of payouts in smaller coins.
            "funds": None if raw.get("funds") in (None, "") else max(0, int(raw.get("funds"))),
            "changeMargin": max(0, min(50, int(raw.get("changeMargin") if raw.get("changeMargin") not in (None, "") else 10))),
        }
    except (TypeError, ValueError, AttributeError):
        raise ApiError(400, "Invalid shop")


LAYER_META = {"locks", "features"}


def current_item(entry, char_id=None):
    """An inventory item as it is now (same as currentItem() in the app): with the layers of the
    states that are on (the entry's own, or the GM's override, gm_state_<key>), in the system's order."""
    item = entry.get("item") or {}
    layers = item.get("layers")
    if not isinstance(layers, dict) or not layers:
        return item
    src = entry.get("states")
    own = {k: bool(v) for k, v in src.items()} if isinstance(src, dict) else {}
    over = (((state.get("gm") or {}).get("items") or {}).get(f"{char_id}/{entry.get('uid')}") or {}) if char_id else {}
    order = (state.get("campaign") or {}).get("states") or list(layers)
    out = dict(item)
    for k in order:
        v = over.get("gm_state_" + str(k))
        on = bool(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else own.get(k, False)
        layer = layers.get(k)
        if on and isinstance(layer, dict):
            out.update({f: x for f, x in layer.items() if f not in LAYER_META and x not in ("", None)})
    return out


def sell_offer(shop, entry, qty, char_id=None):
    """What a shop pays for `qty` of an inventory entry, in the smallest coin (same as sellOffer() in
    shops.js). Most specific rule wins: this item's own rule, then its type's %, then the shop's
    default %. The item as it is now (identified, cursed…)."""
    if not shop.get("buys"):
        return 0
    item = current_item(entry, char_id)
    bundle = max(1, int(item.get("bundle") or 1))
    rule = next((r for r in shop.get("sellItems") or [] if r["srcId"] == entry.get("srcId")), None)
    if rule and rule["mode"] == "fixed":
        return rule["value"] * qty // bundle  # fixed price per item (per bundle for ammunition)
    pct = rule["value"] if rule else (shop.get("typeRates") or {}).get(item.get("type"), shop.get("sellRate", 50))
    return int(item.get("cost") or 0) * qty * pct // (bundle * 100)


def receive_coins(coins, amount, margin=0, cur=None):
    """Same as receiveCoins() in store.js: add an amount in change coins (see payout)."""
    cur = cur or currency()
    c = {k: int((coins or {}).get(k) or 0) for k in coin_keys(cur)}
    for k, n in payout(amount, margin, None, cur).items():
        c[k] += n
    return c


def public_shop(shop):
    """A shop as players see it: the stockroom is the host's business, and items only for sale
    while a value says so are left out while it doesn't."""
    out = {k: v for k, v in shop.items() if k != "backroom"}
    out["items"] = [li for li in shop.get("items") or [] if cond_holds(li.get("onlyIf"))]
    return out


def add_to_backroom(shop, entry, qty):
    """Items bought from players go to the stockroom, stacking identical ones."""
    item = copy.deepcopy(entry.get("item") or {})
    room = shop.setdefault("backroom", [])
    for b in room:
        if b.get("srcId") == entry.get("srcId") and b["item"] == item:
            b["qty"] += qty
            return
    room.append({"bid": new_id("b"), "srcId": entry.get("srcId"), "item": item, "qty": qty})


def shop_entry(listing, lots):
    """A new inventory entry for `lots` purchases of a listing."""
    item = copy.deepcopy(listing["item"])
    entry = {"uid": new_id(), "srcId": listing.get("srcId"), "item": item, "qty": int(item.get("bundle") or 1) * lots,
             "equipped": False, "parent": None, "notes": ""}
    if item.get("maxCharges"):
        entry["charges"] = item["maxCharges"]
    return entry


def merge_into(dst, entry):
    it = entry["item"]
    features = it.get("features") or {}
    # Decks keep their own cards; anything made a container or pack stays separate too. The app
    # marks what doesn't stack (noStack).
    if (it.get("type") not in NON_STACKING and not it.get("noStack") and not it.get("deckCards")
            and not features.get("holds") and not features.get("pack")):
        for x in dst["items"]:
            if (x.get("parent") is None and x.get("srcId") == entry.get("srcId")
                    and x["item"] == it and x.get("customName") == entry.get("customName")):
                x["qty"] += entry["qty"]
                return
    dst["items"].append(entry)


def carry_values(src, dst, uids, part_uid=None):
    """An item's Local values (js/clockwork.js) go with it to its new owner: an abacus keeps its
    count. Moved with the whole item (and what's in it); copied for part of a stack (part_uid)."""
    items = (state.get("gm") or {}).get("items")
    if not items:
        return
    for uid in uids:
        key = f"{src['id']}/{uid}"
        if key not in items:
            continue
        if part_uid:
            items[f"{dst['id']}/{part_uid}"] = copy.deepcopy(items[key])
        else:
            items[f"{dst['id']}/{uid}"] = items.pop(key)


def add_history(e, text):
    """A line in an item's history (where it came from): its last 20 kept."""
    past = [x for x in (e.get("history") or []) if isinstance(x, dict)][-19:]
    e["history"] = past + [{"at": now_ms(), "text": str(text)[:160]}]


def transfer(src, dst, uid, qty, how="in a trade"):
    e = find_entry(src, uid)
    # Traded items arrive loose and unequipped, with the game system's states (attuned…) off.
    loose = {"parent": None, "equipped": False, "states": {}, "seen": None}
    if qty >= e["qty"]:
        kids = descendants(src, uid)
        moving = {uid} | {k["uid"] for k in kids}
        src["items"] = [x for x in src["items"] if x["uid"] not in moving]
        carry_values(src, dst, moving)
        e.update(loose)
        e.pop("compartment", None)
        add_history(e, f"From {src.get('name') or 'someone'}, {how}")
        for k in kids:
            k["equipped"] = False
            k["states"] = {}
            k["seen"] = None
        if kids:
            dst["items"].append(e)
        else:
            merge_into(dst, e)
        dst["items"] += kids
    else:
        e["qty"] -= qty
        part = copy.deepcopy(e)
        part.update(loose, uid=new_id(), qty=qty)
        add_history(part, f"From {src.get('name') or 'someone'}, {how}")
        carry_values(src, dst, [uid], part["uid"])
        merge_into(dst, part)


def move_coins(src, dst, coins):
    src.setdefault("coins", {})
    dst.setdefault("coins", {})
    for k, v in coins.items():
        src["coins"][k] = src["coins"].get(k, 0) - v
        dst["coins"][k] = dst["coins"].get(k, 0) + v


def execute(trade):
    chars = state["characters"]
    a, b = chars.get(trade["from"]), chars.get(trade["to"])
    if not a or not b:
        raise TradeError("One of the characters has left the party.")
    check_side(a, trade["give"])
    check_side(b, trade["ask"])
    for it in trade["give"]["items"]:
        transfer(a, b, it["uid"], it["qty"])
    for it in trade["ask"]["items"]:
        transfer(b, a, it["uid"], it["qty"])
    move_coins(a, b, trade["give"]["coins"])
    move_coins(b, a, trade["ask"]["coins"])
    a["rev"] += 1
    b["rev"] += 1


def trade_history(s, status, reason=None):
    """A live trade (a share) as it goes into the history (state["trades"])."""
    side = lambda cid: s["sides"][cid]
    return {"id": s["id"], "from": s["from"], "to": s["with"], "fromName": s["fromName"], "toName": s["withName"],
            "give": {"items": [{k: i[k] for k in ("uid", "qty", "name")} for i in side(s["from"])["items"]], "coins": side(s["from"])["coins"]},
            "ask": {"items": [{k: i[k] for k in ("uid", "qty", "name")} for i in side(s["with"])["items"]], "coins": side(s["with"])["coins"]},
            "note": " / ".join(n for n in (side(s["from"]).get("note"), side(s["with"]).get("note")) if n),
            "status": status, "created": s["at"] / 1000, "resolved": time.time(), **({"reason": reason} if reason else {})}


def record_trade(t):
    """A finished trade (made, or walked away from) goes into the history, newest first."""
    state["trades"] = [t] + state["trades"][:KEEP_RESOLVED_TRADES - 1]


def end_trades_with(cid, reason):
    """A character leaves (or is removed): their live trades end, for the other side too."""
    for s in [x for x in state.get("shares", []) if x.get("kind") == "trade" and cid in (x["from"], x["with"])]:
        record_trade(trade_history(s, "cancelled", reason))
        state["shares"].remove(s)


# ------------------------------------------------------------------ listeners

class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass  # dropped connections (e.g. a phone going to sleep) aren't worth a traceback


def serve_in_background(srv):
    threading.Thread(target=srv.serve_forever, daemon=True).start()


# ------------------------------------------------------------------ hosting (desktop mode)

def start_lan(port):
    global lan_server, lan_port
    if lan_server:
        return
    srv = QuietServer(("0.0.0.0", port), Handler)  # OSError if the port is taken
    serve_in_background(srv)
    with cond:
        lan_server, lan_port = srv, port
        changed(persist=False)


def stop_lan():
    global lan_server
    with cond:
        srv, lan_server = lan_server, None
        changed(persist=False)  # wakes event streams so they notice and close
    if srv:
        srv.shutdown()
        srv.server_close()


def make_app_server(port):
    global app_server
    srv = QuietServer(("127.0.0.1", port), Handler)
    app_server = srv
    return srv


def image_bytes_match(raw, mime):
    """The data really is the image type it claims (checks the file signature)."""
    return {
        "image/png": raw.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg": raw.startswith(b"\xff\xd8\xff"),
        "image/gif": raw[:6] in (b"GIF87a", b"GIF89a"),
        "image/webp": raw[:4] == b"RIFF" and raw[8:12] == b"WEBP",
    }.get(mime, False)


# ------------------------------------------------------------------ HTTP

class ApiError(Exception):
    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status, self.message, self.extra = status, message, extra


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        pass  # keep the console for the address and party events

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        origin = self.cors_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        super().end_headers()

    # The apps (Windows and Android) join a party from their own page, on another address, so
    # the party API answers pages from this device or the home network (never public websites).
    # The apps' private endpoints (their saved data, hosting, quitting) never do.
    APP_ONLY = ("/api/local", "/api/presence", "/api/host", "/api/quit", "/api/update")

    def cors_origin(self):
        path = urlparse(self.path).path
        if path == "/api/info":
            return "*"
        if not path.startswith("/api/") or path.startswith(self.APP_ONLY):
            return None
        origin = self.headers.get("Origin") or ""
        if origin == "null":  # a page opened from a file
            return origin
        host = urlparse(origin).hostname or ""
        local = host in ("localhost", "::1") or host.endswith(".local") or re.match(
            r"^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)", host)
        return origin if local else None

    def do_OPTIONS(self):
        """CORS preflight for the party API."""
        self.send_response(204)
        if self.cors_origin():
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Player")
            self.send_header("Access-Control-Max-Age", "600")
            if self.headers.get("Access-Control-Request-Private-Network"):
                self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # -------------------------------------------------------------- plumbing
    def token(self):
        return self.headers.get("X-Player") or parse_qs(urlparse(self.path).query).get("player", [""])[0]

    def body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError(400, "Bad Content-Length")
        if length < 0 or length > MAX_BODY:
            raise ApiError(413, "Request too large")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw or b"{}")
        except json.JSONDecodeError:
            raise ApiError(400, "Invalid JSON")

    def reply(self, status, data):
        raw = json.dumps(data, ensure_ascii=False).encode("utf8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def api(self, method):
        path = urlparse(self.path).path
        try:
            token = self.token()
            # Document images load via <img>, which can't send the player header.
            open_paths = ("/api/info", "/api/presence", "/api/host", "/api/quit", "/api/open", "/api/update")
            if not token and path not in open_paths and not path.startswith(("/api/local", "/api/shops")) \
                    and not (method == "GET" and path.startswith("/api/images/")):
                raise ApiError(401, "Missing player token")
            parts = path.strip("/").split("/")[1:]
            result = self.route(method, parts, token)
            if result is not None:
                self.reply(200, result)
        except ApiError as e:
            self.reply(e.status, {"error": e.message, **e.extra})
        except TradeError as e:
            self.reply(409, {"error": str(e)})

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            return self.api("GET")
        if path == "/" or path.startswith(STATIC_PREFIXES):
            return super().do_GET()
        self.send_error(404)

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        self.api("POST")

    def do_PUT(self):
        self.api("PUT")

    def do_DELETE(self):
        self.api("DELETE")

    def own_page(self):
        """Not sent by some other web page. The host's rights (and the app's) go by where a request
        comes from, so a website open in a browser on the host computer could otherwise use them:
        browsers send such requests (they only hide the reply). Browsers say where a request comes
        from: Sec-Fetch-Site, and Origin on anything but a plain GET. The app's own pages are this
        server's origin; other programs send neither."""
        site = self.headers.get("Sec-Fetch-Site")
        if site not in (None, "same-origin", "none"):
            return False
        origin = self.headers.get("Origin")
        return origin is None or origin == "http://" + (self.headers.get("Host") or "")

    def is_host_pc(self):
        """Request from the computer running this server (the host curates shops), from the app's
        own page there (see own_page)."""
        return self.client_address[0] in own_ips() and self.own_page()

    def is_gm(self, token):
        """The GM role (see role_of): runs shops and GM values."""
        return role_of(token, self.is_host_pc()) == "gm"

    def is_app(self):
        """Request from this PC (the app's window, or a browser on it) rather than another player's device."""
        return DESKTOP and self.client_address[0] in own_ips() and self.own_page()

    # -------------------------------------------------------------- routes
    def route(self, method, parts, token):
        chars = state["characters"]
        if method == "GET" and parts == ["info"]:
            return {"party": party_enabled(), "partyId": state.get("partyId"), "desktop": DESKTOP, "isHost": self.is_app(),
                    "localStore": bool(LOCAL_DIR) and self.is_app(),
                    "canManageShops": self.is_host_pc(),
                    "localDir": LOCAL_DIR if self.is_app() else None,
                    "appPort": app_server.server_address[1] if app_server and self.is_app() else None,
                    "hosting": lan_server is not None, "addresses": lan_addresses(),
                    "port": lan_port if DESKTOP else PORT,
                    # The installed Windows app can update itself (see update_app); run from source, it can't.
                    "selfUpdate": DESKTOP and bool(getattr(sys, "frozen", False)) and self.is_app(),
                    "defaultPort": lan_port or DEFAULT_LAN_PORT}
        if parts[:1] == ["shops"]:
            return self.shops_api(method, parts[1:], token)
        if parts == ["gm-role"]:
            return self.gm_role_api(method, token)
        if parts == ["campaign"]:
            return self.campaign_api(method, token)
        if parts[:1] == ["gm"]:
            return self.gm_api(method, parts[1:], token)
        if parts[:1] == ["treasure"]:
            return self.treasure_api(method, parts[1:], token)
        if parts[:1] == ["share"]:
            return self.share_api(method, parts[1:], token)
        if parts[:1] == ["discard"]:
            return self.discard_api(method, parts[1:], token)
        if parts[:1] == ["local"]:
            if not (self.is_app() and LOCAL_DIR):
                raise ApiError(403, "Only the app on this PC can do that")
            return self.local_api(method, parts[1:])
        if parts[:1] in (["presence"], ["host"], ["quit"], ["open"], ["update"]):
            if not self.is_app():
                raise ApiError(403, "Only the desktop app can do that")
            if method == "GET" and parts == ["presence"]:
                return self.presence_stream()
            if method == "POST" and parts == ["host"]:
                body = self.body()
                if body.get("enable"):
                    port = int(body.get("port") or DEFAULT_LAN_PORT)
                    if not 1024 <= port <= 65535:
                        raise ApiError(400, "Pick a port between 1024 and 65535")
                    try:
                        start_lan(port)
                    except OSError:
                        raise ApiError(409, f"Port {port} is already in use - try another one")
                else:
                    stop_lan()
                return {"hosting": lan_server is not None}
            if method == "POST" and parts == ["quit"]:
                threading.Thread(target=shutdown_all, daemon=True).start()
                return {"ok": True}
            if method == "POST" and parts == ["update"]:
                version = update_app()
                threading.Timer(1.0, shutdown_all).start()  # (after the reply): the new one starts as this one stops
                return {"ok": True, "version": version}
            if method == "POST" and parts == ["open"]:
                # A link to the web (the user guide, credits) in the PC's default browser: the app's
                # own window is an Edge app window, which would open it in another one of those.
                url = str(self.body().get("url") or "")
                if not re.match(r"^https?://[^\s\x00-\x1f\"<>]+$", url) or len(url) > 2000:
                    raise ApiError(400, "Not a web address")
                webbrowser.open(url)
                return {"ok": True}
        if not party_enabled():
            raise ApiError(404, "No party is being hosted")
        if parts[:1] == ["images"]:
            return self.images(method, parts, os.path.join(DATA_DIR, "images"))
        if method == "GET" and parts == ["events"]:
            return self.events(token)
        if method == "GET" and parts == ["state"]:
            with cond:
                return snapshot(token, self.is_host_pc())
        if method == "POST" and parts == ["leave"]:
            # Leave party: close this player's live connection now, so they show as away at once.
            with cond:
                if online.get(token, 0) > 0:
                    leaving.add(token)
                    cond.notify_all()
                # What they shared ends with them.
                if any(s["by"] == token for s in state.get("shares", [])):
                    for s in state["shares"]:
                        if s["by"] == token:
                            return_socket_items(s)
                    state["shares"] = [s for s in state["shares"] if s["by"] != token]
                    changed()
            return {"ok": True}

        if parts[:1] == ["characters"]:
            body = self.body() if method in ("POST", "PUT") else {}
            with cond:
                if method == "POST" and len(parts) == 1:
                    c = body.get("character") or {}
                    if not isinstance(c.get("items"), list) or not c.get("name"):
                        raise ApiError(400, "Invalid character")
                    cid = c.get("id")
                    if not cid or cid in chars:
                        cid = new_id("c")
                    c.update(id=cid, owner=token, rev=1)
                    chars[cid] = c
                    changed()
                    print(f"  + {c['name']} joined the party")
                    return {"id": cid, "rev": 1}
                c = chars.get(parts[1]) if len(parts) > 1 else None
                if not c:
                    raise ApiError(404, "No such character")
                if method == "POST" and parts[2:] == ["claim"]:
                    if c["owner"] != token and online.get(c["owner"], 0) > 0:
                        raise ApiError(409, f"{c['name']} is being played on another device right now.")
                    c["owner"] = token
                    c["rev"] += 1
                    changed()
                    print(f"  ~ {c['name']} was taken over by another device")
                    return {"rev": c["rev"]}
                if method == "POST" and parts[2:] == ["remove"]:
                    # The host clears out a player who has left: only while they're not connected.
                    if not self.is_host_pc():
                        raise ApiError(403, "Only the host can remove players")
                    if online.get(c["owner"], 0) > 0:
                        raise ApiError(409, f"{c['name']} is connected right now. Players can only be removed while they're away.")
                    del chars[c["id"]]
                    end_trades_with(c["id"], f"{c['name']} was removed from the party.")
                    changed()
                    print(f"  - {c['name']} was removed from the party by the host")
                    return {"ok": True}
                if c["owner"] != token:
                    raise ApiError(403, "That character belongs to someone else.")
                if method == "PUT" and len(parts) == 2:
                    if body.get("baseRev") != c["rev"]:
                        raise ApiError(409, "Out of date", character=public_char(c, token))
                    new = body.get("character") or {}
                    if not isinstance(new.get("items"), list):
                        raise ApiError(400, "Invalid character")
                    new.update(id=c["id"], owner=token, rev=c["rev"] + 1)
                    chars[c["id"]] = new
                    changed()
                    return {"rev": new["rev"]}
                if method == "DELETE" and len(parts) == 2:
                    del chars[c["id"]]
                    end_trades_with(c["id"], f"{c['name']} left the party.")
                    changed()
                    print(f"  - {c['name']} left the party")
                    return {"ok": True}

        raise ApiError(404, "Unknown endpoint")

    # -------------------------------------------------------------- live updates (Server-Sent Events)
    def events(self, token):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True
        host = self.is_host_pc()
        name = (parse_qs(urlparse(self.path).query).get("device") or [""])[0].strip()[:40]
        with cond:
            online[token] = online.get(token, 0) + 1
            devices = state.setdefault("devices", {})
            if name and (devices.get(token) or {}).get("name") != name:
                devices[token] = {"name": name}
                changed()
            else:
                changed(persist=False)
        last = -1
        try:
            while True:
                with cond:
                    if not party_enabled() or token in leaving:
                        break  # the host stopped the party, or this player left it
                    if version == last:
                        cond.wait(timeout=15)
                    if token in leaving:
                        break
                    data = None
                    if version != last:
                        last = version
                        data = json.dumps(snapshot(token, host), ensure_ascii=False)
                self.wfile.write(f"event: state\ndata: {data}\n\n".encode("utf8") if data else b": ping\n\n")
                self.wfile.flush()
        except OSError:
            pass
        finally:
            with cond:
                online[token] -= 1
                if not online[token]:
                    leaving.discard(token)
                changed(persist=False)


    # -------------------------------------------------------------- document images
    def shops_api(self, method, parts, token):
        """Shops: the host curates them (even when not hosting); party players buy from open ones.

        GET    /api/shops                     host: all shops; others: open ones
        POST   /api/shops {shop}              host: create
        PUT    /api/shops/<id> {shop, baseRev} host: edit (409 if someone bought meanwhile)
        DELETE /api/shops/<id>                host
        POST   /api/shops/<id>/buy {character, lid, qty}  party player: pay and receive
        POST   /api/shops/<id>/take {lid, qty}            host buying for a solo character: reserve stock
        POST   /api/shops/<id>/sell {character, uid, qty} party player: sell an inventory item (goes to the stockroom)
        POST   /api/shops/<id>/backroom {bid, action: shelve|discard, qty, price}  host: manage the stockroom
        POST   /api/shops/<id>/receive {srcId, item, qty}  host selling a solo character's item
        """
        host = self.is_gm(token)  # "host" below: whoever runs the shops (a GM)
        body = self.body() if method in ("POST", "PUT") else {}
        with cond:
            shops = state.setdefault("shops", [])
            if method == "GET" and not parts:
                return {"shops": shops if host else [public_shop(sh) for sh in shops if shop_open(sh)]}
            if method == "POST" and not parts:
                if not host:
                    raise ApiError(403, "Only the host can set up shops")
                shop = clean_shop(body.get("shop"))
                shop.update(id=new_id("s"), rev=1, backroom=[])
                shops.append(shop)
                changed()
                return {"id": shop["id"], "rev": 1}
            shop = next((sh for sh in shops if parts and sh["id"] == parts[0]), None)
            if not shop:
                raise ApiError(404, "No such shop")
            action = parts[1] if len(parts) > 1 else None
            if method == "PUT" and action is None:
                if not host:
                    raise ApiError(403, "Only the host can set up shops")
                if body.get("baseRev") != shop["rev"]:
                    raise ApiError(409, "The shop changed (someone may have bought something)", shop=shop)
                new = clean_shop(body.get("shop"))
                # The stockroom only changes through sales and the backroom actions below.
                new.update(id=shop["id"], rev=shop["rev"] + 1, backroom=shop.get("backroom", []))
                shops[shops.index(shop)] = new
                changed()
                return {"rev": new["rev"]}
            if method == "DELETE" and action is None:
                if not host:
                    raise ApiError(403, "Only the host can set up shops")
                shops.remove(shop)
                changed()
                return {"ok": True}
            if method == "POST" and action == "sell":
                if not party_enabled():
                    raise ApiError(404, "No party is being hosted")
                if not shop_open(shop):
                    raise ApiError(409, f"{shop['name']} is closed")
                if not shop.get("buys"):
                    raise ApiError(409, f"{shop['name']} doesn't buy items")
                c = state["characters"].get(body.get("character"))
                if not c or c["owner"] != token:
                    raise ApiError(403, "You can only sell your own character's items")
                entry = find_entry(c, body.get("uid"))
                try:
                    qty = int(body.get("qty") or 1)
                except (TypeError, ValueError):
                    qty = 0
                if not entry or not 1 <= qty <= entry["qty"]:
                    raise ApiError(409, f"{c['name']} doesn't have that many")
                # A deck sells with the cards still in it; anything else has to be emptied first.
                if any(e.get("parent") == entry["uid"] and not e["item"].get("card") for e in c["items"]):
                    raise ApiError(409, f"Empty the {entry['item'].get('name', 'container')} before selling it")
                paid = sell_offer(shop, entry, qty, c["id"])
                if paid <= 0:
                    raise ApiError(409, f"{shop['name']} won't buy {entry['item'].get('name', 'that')}")
                if shop.get("funds") is not None and shop["funds"] < paid:
                    raise ApiError(409, f"{shop['name']} can't afford that right now")
                entry["qty"] -= qty
                if entry["qty"] <= 0:
                    c["items"] = [e for e in c["items"] if e["uid"] != entry["uid"] and e.get("parent") != entry["uid"]]
                add_to_backroom(shop, entry, qty)
                if shop.get("funds") is not None:
                    shop["funds"] -= paid
                shop["rev"] += 1
                c["coins"] = receive_coins(c.get("coins"), paid, shop.get("changeMargin", 10))
                c["rev"] += 1
                changed()
                print(f"  $ {c['name']} sold {qty} x {entry['item'].get('name')} to {shop['name']}")
                return {"ok": True, "paid": paid}
            if method == "POST" and action in ("buy", "take"):
                if action == "take" and not host:
                    raise ApiError(403, "Only the host can do that")
                listing = next((li for li in shop["items"] if li["lid"] == body.get("lid")), None)
                try:
                    lots = int(body.get("qty") or 1)
                except (TypeError, ValueError):
                    lots = 0
                if not listing or not 1 <= lots <= 999:
                    raise ApiError(400, "That item isn't sold here")
                if not cond_holds(listing.get("onlyIf")):
                    raise ApiError(409, f"{listing['item']['name']} isn't for sale right now")
                if listing.get("stock") is not None and listing["stock"] < lots:
                    raise ApiError(409, "Sold out" if listing["stock"] == 0 else f"Only {listing['stock']} left")
                if action == "take":  # the host's own solo character pays on their side
                    if not host:
                        raise ApiError(403, "Only the host can do that")
                else:
                    if not party_enabled():
                        raise ApiError(404, "No party is being hosted")
                    if not shop_open(shop):
                        raise ApiError(409, f"{shop['name']} is closed")
                    c = state["characters"].get(body.get("character"))
                    if not c or c["owner"] != token:
                        raise ApiError(403, "You can only buy for your own character")
                    total = listing_price(shop, listing) * lots
                    purse = pay_coins(c.get("coins"), total, shop.get("changeMargin", 10))
                    if purse is None:
                        raise ApiError(409, f"{c['name']} can't afford that")
                    c["coins"] = purse
                    merge_into(c, shop_entry(listing, lots))
                    c["rev"] += 1
                    print(f"  $ {c['name']} bought {lots} x {listing['item']['name']} at {shop['name']}")
                if listing.get("stock") is not None:
                    listing["stock"] -= lots
                if shop.get("funds") is not None:
                    shop["funds"] += listing_price(shop, listing) * lots
                shop["rev"] += 1
                changed()
                return {"ok": True, "shopRev": shop["rev"]}
            if method == "POST" and action == "receive":
                # Host selling their own solo character's item: the shop pays and stocks it here;
                # the character's side happens on the host's device. The price is worked out here.
                if not host:
                    raise ApiError(403, "Only the host can do that")
                item = body.get("item")
                try:
                    qty = int(body.get("qty") or 0)
                except (TypeError, ValueError):
                    qty = 0
                if not isinstance(item, dict) or not item.get("name") or not item.get("type") or not 1 <= qty <= 100000:
                    raise ApiError(400, "Invalid item")
                entry = {"srcId": (str(body.get("srcId") or "")[:80] or None), "item": item}
                paid = sell_offer(shop, entry, qty)
                if paid <= 0:
                    raise ApiError(409, f"{shop['name']} won't buy {item['name']}")
                if shop.get("funds") is not None and shop["funds"] < paid:
                    raise ApiError(409, f"{shop['name']} can't afford that right now")
                add_to_backroom(shop, entry, qty)
                if shop.get("funds") is not None:
                    shop["funds"] -= paid
                shop["rev"] += 1
                changed()
                return {"ok": True, "paid": paid}
            if method == "POST" and action == "backroom":
                # Host: put stockroom items on the shelves, or throw them out.
                if not host:
                    raise ApiError(403, "Only the host can do that")
                b = next((x for x in shop.get("backroom", []) if x["bid"] == body.get("bid")), None)
                if not b:
                    raise ApiError(404, "That item isn't in the stockroom")
                bundle = max(1, int(b["item"].get("bundle") or 1))
                try:
                    qty = int(body.get("qty") or 0)
                    price = body.get("price")
                    price = None if price in (None, "") else max(0, int(price))
                except (TypeError, ValueError):
                    raise ApiError(400, "Invalid amount")
                if body.get("action") == "shelve":
                    # qty counts shelf lots (bundles of 20 arrows, say)
                    if qty < 1 or qty * bundle > b["qty"]:
                        raise ApiError(409, "Not that many in the stockroom")
                    same = next((li for li in shop["items"] if li.get("srcId") == b.get("srcId") and li["item"] == b["item"]), None)
                    if same:
                        if same.get("stock") is not None:
                            same["stock"] += qty
                    else:
                        shop["items"].append({"lid": new_id("l"), "srcId": b.get("srcId"), "item": copy.deepcopy(b["item"]),
                                              "price": price, "stock": qty})
                    b["qty"] -= qty * bundle
                elif body.get("action") == "discard":
                    if qty < 1 or qty > b["qty"]:
                        raise ApiError(409, "Not that many in the stockroom")
                    b["qty"] -= qty
                else:
                    raise ApiError(400, "Unknown stockroom action")
                if b["qty"] <= 0:
                    shop["backroom"].remove(b)
                shop["rev"] += 1
                changed()
                return {"ok": True, "shopRev": shop["rev"]}
        raise ApiError(404, "Unknown endpoint")

    def local_api(self, method, parts):
        """GET  /api/local            -> {rev, data}
        PUT  /api/local {set: {key: value or null}, client}  (per-key, last write wins)
        GET/POST /api/local/images... -> this PC's document images"""
        if parts[:1] == ["images"]:
            return self.images(method, parts, os.path.join(LOCAL_DIR, "images"), own=True)
        if method == "GET" and not parts:
            with cond:
                return {"rev": local["rev"], "data": local["data"]}
        if method == "PUT" and not parts:
            body = self.body()
            changes = body.get("set") or {}
            if not isinstance(changes, dict) or not all(isinstance(v, (str, type(None))) for v in changes.values()):
                raise ApiError(400, "Bad data")
            with cond:
                for k, v in changes.items():
                    if v is None:
                        local["data"].pop(str(k), None)
                    else:
                        local["data"][str(k)] = v
                local["rev"] += 1
                local["by"] = str(body.get("client") or "")
                save_local()
                cond.notify_all()  # other windows on this PC reload
                return {"rev": local["rev"]}
        raise ApiError(404, "Unknown endpoint")

    def campaign_api(self, method, token):
        """POST /api/campaign {id, name, system, currency, states, gmOnly, clockwork, rules, shops, gmValues}: a GM loads one of their campaigns into
        the party (see switch_campaign). Shops and GM values seed a campaign the party hasn't played
        yet; every device plays its game system (system: {id, name}, or null for none)."""
        if method != "POST":
            raise ApiError(404, "Unknown endpoint")
        if not party_enabled():
            raise ApiError(404, "No party is being hosted")
        if not self.is_gm(token):
            raise ApiError(403, "Only a GM can choose the campaign")
        body = self.body()
        cid, name = str(body.get("id") or ""), str(body.get("name") or "").strip()[:80] or "Campaign"
        if not CAMPAIGN_ID.match(cid):
            raise ApiError(400, "Not a campaign")
        shops = []
        for raw in (body.get("shops") or [])[:100]:
            shop = clean_shop(raw)
            shop["id"] = str((raw or {}).get("id") or new_id("s"))[:40]
            shop["rev"] = 1
            shop["backroom"] = []
            shops.append(shop)
        with cond:
            states = [str(k)[:40] for k in (body.get("states") or [])[:30] if isinstance(k, str)] or None
            switch_campaign(cid, name, shops, clean_gm_values(body.get("gmValues")), clean_system_ref(body.get("system")),
                            clean_currency(body.get("currency")), states)
            # Values only a GM sets (states' limits); players set their other Locals.
            state["campaign"]["gmOnly"] = [k for k in (body.get("gmOnly") or [])[:50] if isinstance(k, str) and GM_NAME.match(k)]
            # Rules, values and controls (Clockwork): off, shops don't follow values.
            state["campaign"]["clockwork"] = body.get("clockwork") is not False
            # The campaign's own item states, for players' devices.
            state["campaign"]["ownStates"] = clean_own_states(body.get("ownStates"))
            # The campaign's rule book (Clockwork): every device runs its own share of it.
            state["campaign"]["rules"] = clean_rules(body.get("rules"))
            changed(persist=False)
        print(f"  * The GM loaded the campaign {name}")
        return {"ok": True}

    def gm_role_api(self, method, token):
        """POST /api/gm-role {device, gm}: the host makes a device a GM (gm true) or not. device is the
        id from the host's device list. With no GMs, the host is the GM."""
        if method != "POST":
            raise ApiError(404, "Unknown endpoint")
        if not self.is_host_pc():
            raise ApiError(403, "Only the host can choose GMs")
        body = self.body()
        with cond:
            target = next((t for t in [*(state.get("devices") or {}), *(c["owner"] for c in state["characters"].values()),
                                       *(state.get("gms") or [])] if t and device_id(t) == body.get("device")), None)
            if not target:
                raise ApiError(404, "No such device")
            gms = state.setdefault("gms", [])
            if body.get("gm") and target not in gms:
                gms.append(target)
            elif not body.get("gm") and target in gms:
                gms.remove(target)
            changed()
        return {"ok": True}

    def treasure_api(self, method, parts, token):
        """Showing a hoard to players (see treasure_settle).

        POST   /api/treasure {name, hoard, items, coins, players}  GM: show it
        POST   /api/treasure/<id>/pick {character, key, qty}       a player's pick (qty 0: none)
        POST   /api/treasure/<id>/ready {character, ready}         ready, or not (picks can change)
        POST   /api/treasure/<id>/settle {key, give: {charId: qty}} GM: settle a contested pick
        POST   /api/treasure/<id>/end {settle}                     GM: settle as it stands, or close (nothing moves)
        DELETE /api/treasure/<id>                                  GM: gone (the GM's device has taken back what's left)
        """
        gm = self.is_gm(token)
        body = self.body() if method == "POST" else {}
        with cond:
            shows = state.setdefault("treasure", [])
            if method == "POST" and not parts:
                if not gm:
                    raise ApiError(403, "Only a GM can show treasure")
                if not party_enabled():
                    raise ApiError(404, "No party is being hosted")
                players = [str(p) for p in (body.get("players") or []) if str(p) in state["characters"]][:30]
                if not players:
                    raise ApiError(400, "Choose who to show it to")
                coins = {}
                for k, n in (body.get("coins") or {}).items() if isinstance(body.get("coins"), dict) else []:
                    if isinstance(n, int) and not isinstance(n, bool) and n > 0:
                        coins[str(k)[:10]] = min(n, 10 ** 9)
                t = {"id": new_id("t"), "name": str(body.get("name") or "Treasure")[:80], "hoard": str(body.get("hoard") or "")[:40],
                     "items": clean_treasure_items(body.get("items")), "coins": coins, "players": players,
                     "picks": {}, "ready": [], "status": "picking", "given": []}
                shows.append(t)
                changed()
                return {"id": t["id"]}
            t = next((x for x in shows if parts and x["id"] == parts[0]), None)
            if not t:
                raise ApiError(404, "That treasure isn't being shown")
            action = parts[1] if len(parts) > 1 else None
            if method == "DELETE" and action is None:
                if not gm:
                    raise ApiError(403, "Only a GM can do that")
                shows.remove(t)
                changed()
                return {"ok": True}
            if method != "POST":
                raise ApiError(404, "Unknown endpoint")
            if action in ("pick", "ready"):
                cid = str(body.get("character") or "")
                c = state["characters"].get(cid)
                if not c or c["owner"] != token:
                    raise ApiError(403, "You can only pick for your own character")
                if cid not in t["players"]:
                    raise ApiError(403, f"{c['name']} isn't sharing this treasure")
                if t["status"] != "picking":
                    raise ApiError(409, "The picking is over")
                if action == "pick":
                    key = str(body.get("key") or "")
                    try:
                        qty = int(body.get("qty") or 0)
                    except (TypeError, ValueError):
                        qty = -1
                    if not (key.startswith(("e:", "c:"))) or not 0 <= qty <= treasure_available(t, key) or not treasure_available(t, key):
                        raise ApiError(400, "There isn't that much")
                    p = t["picks"].setdefault(key, {})
                    if qty:
                        p[cid] = qty
                    else:
                        p.pop(cid, None)
                        if not p:
                            del t["picks"][key]
                    if cid in t["ready"]:
                        t["ready"].remove(cid)  # changed their mind: not ready any more
                else:
                    if body.get("ready"):
                        if cid not in t["ready"]:
                            t["ready"].append(cid)
                    elif cid in t["ready"]:
                        t["ready"].remove(cid)
                    if set(t["players"]) <= set(t["ready"]):
                        treasure_settle(t)
                changed()
                return {"ok": True, "status": t["status"]}
            if not gm:
                raise ApiError(403, "Only a GM can do that")
            if action == "settle":
                key, give = str(body.get("key") or ""), body.get("give")
                if key not in t["picks"] or t["status"] != "settling" or not isinstance(give, dict):
                    raise ApiError(400, "That isn't waiting to be settled")
                alloc = {}
                for cid, q in give.items():
                    if cid in t["players"] and isinstance(q, int) and not isinstance(q, bool) and q > 0:
                        alloc[cid] = {key: q}
                if sum(a[key] for a in alloc.values()) > treasure_available(t, key):
                    raise ApiError(400, "There isn't that much")
                treasure_give(t, alloc)
                del t["picks"][key]
                if not t["picks"]:
                    t["status"] = "done"
                changed()
                return {"ok": True, "status": t["status"]}
            if action == "end":
                if body.get("settle"):
                    if t["status"] == "picking":
                        treasure_settle(t)
                else:
                    t["picks"], t["status"] = {}, "done"
                changed()
                return {"ok": True, "status": t["status"]}
            raise ApiError(404, "Unknown endpoint")

    def share_api(self, method, parts, token):
        """Shared screens (see prune_shares).

        POST   /api/share {kind: "item", from, to: [charId], gm, item, contents}
                                                   share it: from one of your characters (or, the GM,
                                                   from "" too)
        POST   /api/share {kind: "trade", from, with} a trade between your character and theirs (one
                                                   open between two characters: that one again)
        POST   /api/share/<id>/side {character, items: [{uid, qty}], coins, asks: [{uid, qty}], note}
                                                   a trade: what your character gives, asks for
        POST   /api/share/<id>/agree {character, agree} a trade: agree (both: it's made) or not
        POST   /api/share {kind: "panel", panelId, title, panel, to: [charId]}  a GM: show a panel
        POST   /api/share/<id>/panel {title, panel}  whoever shared it: the panel as it is now
        POST   /api/share/<id>/use {character, type: "set" | "used", control, name, value, signal}
                                                   a player it's shown to uses a control (queued)
        POST   /api/share/<id>/socket {character, control, uid}   a player puts an item in a socket
        POST   /api/share/<id>/socket {character, control, take: true}  … takes what's in it (the
                                                   GM, with no character: back to whoever put it in)
        DELETE /api/share/<id>/use/<useId>         whoever shared it: made (taken off the queue)
        POST   /api/share/<id>/seen {character}    opened, by one of your characters (or "gm")
        DELETE /api/share/<id>                     whoever shared it (or a GM): end it; a trade:
                                                   either of them walks away
        """
        gm = self.is_gm(token)
        body = self.body() if method == "POST" else {}
        with cond:
            shows = state.setdefault("shares", [])
            if method == "POST" and not parts:
                if not party_enabled():
                    raise ApiError(404, "No party is being hosted")
                kind = body.get("kind", "item")
                if kind == "trade":
                    return self.start_trade(shows, body, token)
                if kind == "panel":
                    if not gm:
                        raise ApiError(403, "Only a GM can show a panel")
                    to = [str(x) for x in (body.get("to") or []) if str(x) in state["characters"]][:30]
                    if not to:
                        raise ApiError(400, "Choose who to show it to")
                    if not isinstance(body.get("panel"), dict):
                        raise ApiError(400, "Nothing to show")
                    if len(shows) >= 200 or sum(1 for x in shows if x["by"] == token) >= SHARES_PER_DEVICE:
                        raise ApiError(429, "You're sharing too much: end something first")
                    s = {"id": new_id("s"), "kind": "panel", "by": token, "from": "", "fromName": "The GM", "to": to, "gm": False, "seen": [],
                         "at": now_ms(), "panelId": str(body.get("panelId") or "")[:80], "title": str(body.get("title") or "Panel")[:80],
                         "panel": body["panel"], "uses": [], "sockets": {}}
                    for ctl in body["panel"].get("controls") or []:
                        held = ctl.get("held") if isinstance(ctl, dict) and ctl.get("type") == "socket" else None
                        items = clean_treasure_items(held) if isinstance(held, list) else []
                        if items:
                            s["sockets"][str(ctl.get("id"))] = {"id": f"socket-{s['id']}-{ctl.get('id')}", "name": str(ctl.get("label") or "the socket")[:60],
                                                               "items": items, "by": "", "byName": "The GM"}
                    if len(json.dumps(s)) > PANEL_MAX_BYTES:
                        raise ApiError(413, "That panel is too big to show")
                    shows.append(s)
                    changed()
                    return {"id": s["id"]}
                if kind != "item":
                    raise ApiError(400, "Not something that can be shared")
                frm = str(body.get("from") or "")
                c = state["characters"].get(frm)
                if frm and (not c or c["owner"] != token):
                    raise ApiError(403, "You can only show your own characters' things")
                if not frm and not gm:
                    raise ApiError(403, "Show it from one of your characters")
                items = clean_treasure_items([body.get("item")])
                if not items:
                    raise ApiError(400, "Nothing to show")
                to = [str(x) for x in (body.get("to") or []) if str(x) in state["characters"] and str(x) != frm][:30]
                to_gm = bool(body.get("gm"))
                if not to and not to_gm:
                    raise ApiError(400, "Choose who to show it to")
                if len(shows) >= 200 or sum(1 for x in shows if x["by"] == token) >= SHARES_PER_DEVICE:
                    raise ApiError(429, "You're sharing too much: end something first")
                s = {"id": new_id("s"), "kind": "item", "by": token, "from": frm, "fromName": c["name"] if c else "The GM",
                     "item": items[0], "contents": clean_treasure_items(body.get("contents"))[:200], "to": to, "gm": to_gm,
                     "seen": [], "at": now_ms()}
                if len(json.dumps(s)) > SHARE_MAX_BYTES:
                    raise ApiError(413, "That's too big to show")
                shows.append(s)
                changed()
                return {"id": s["id"]}
            s = next((x for x in shows if parts and x["id"] == parts[0]), None)
            if not s:
                raise ApiError(404, "That isn't being shared any more")
            action = parts[1] if len(parts) > 1 else None
            if s.get("kind") == "panel" and action in ("panel", "use", "socket"):
                return self.panel_share(s, method, parts, body, token, gm)
            if s.get("kind") == "trade" and (action in ("side", "agree") or method == "DELETE"):
                return self.trade_share(shows, s, method, action, body, token, gm)
            if method == "DELETE" and action is None:
                if s["by"] != token and not gm:
                    raise ApiError(403, "Only whoever shared it can end it")
                if s.get("kind") == "panel":
                    return_socket_items(s)
                shows.remove(s)
                changed()
                return {"ok": True}
            if method == "POST" and action == "seen":
                who = str(body.get("character") or "")
                if who == "gm":
                    if not (gm and s["gm"]):
                        raise ApiError(403, "That wasn't shown to you")
                else:
                    c = state["characters"].get(who)
                    if not c or c["owner"] != token or who not in s["to"]:
                        raise ApiError(403, "That wasn't shown to you")
                if who not in s["seen"]:
                    s["seen"].append(who)
                changed()
                return {"ok": True}
            raise ApiError(404, "Unknown endpoint")

    def panel_share(self, s, method, parts, body, token, gm):
        """A shown panel's calls: the GM's updates, players' uses and their being made (see share_api).
        Call with cond held."""
        action = parts[1]
        if action == "panel" and method == "POST":
            if s["by"] != token:
                raise ApiError(403, "Only whoever showed it can change it")
            if not isinstance(body.get("panel"), dict):
                raise ApiError(400, "Not a panel")
            before = s["panel"]
            s["panel"], s["title"] = body["panel"], str(body.get("title") or s["title"])[:80]
            if len(json.dumps(s)) > PANEL_MAX_BYTES:
                s["panel"] = before
                raise ApiError(413, "That panel is too big to show")
            changed()
            return {"ok": True}
        if action == "use" and method == "POST" and len(parts) == 2:
            cid = str(body.get("character") or "")
            c = state["characters"].get(cid)
            if not c or c["owner"] != token or cid not in s["to"]:
                raise ApiError(403, "That isn't shown to you")
            kind = body.get("type")
            if kind not in ("set", "used"):
                raise ApiError(400, "Not a use")
            use = {"id": new_id("u"), "character": cid, "type": kind, "control": str(body.get("control") or "")[:80], "at": now_ms()}
            if kind == "set":
                if not isinstance(body.get("name"), str) or not isinstance(body.get("value"), (int, float)) or isinstance(body.get("value"), bool):
                    raise ApiError(400, "Not a value")
                use["name"], use["value"] = body["name"][:80], body["value"]
            else:
                if isinstance(body.get("value"), (int, float)) and not isinstance(body.get("value"), bool):
                    use["value"] = body["value"]
                if body.get("signal"):
                    use["signal"] = str(body["signal"])[:80]
            uses = s.setdefault("uses", [])
            uses.append(use)
            del uses[:-PANEL_USES_MAX]
            changed()
            return {"id": use["id"]}
        if action == "socket" and method == "POST":
            return self.socket_call(s, body, token, gm)
        if action == "use" and method == "DELETE" and len(parts) == 3:
            if s["by"] != token:
                raise ApiError(403, "Only whoever showed it makes its uses")
            s["uses"] = [u for u in s.get("uses", []) if u["id"] != parts[2]]
            changed()
            return {"ok": True}
        raise ApiError(404, "Unknown endpoint")

    def socket_call(self, s, body, token, gm):
        """A socket of a shown panel: an item put in (it leaves the character, as in a trade) or
        taken out (into the character); either is a use for the GM's device (its rules). Call with
        cond held."""
        chars = state["characters"]
        ctl_id = str(body.get("control") or "")
        ctl = next((c for c in (s.get("panel") or {}).get("controls") or [] if isinstance(c, dict) and c.get("id") == ctl_id and c.get("type") == "socket"), None)
        if not ctl:
            raise ApiError(404, "No such socket")
        label = str(ctl.get("label") or "the socket")[:60]
        sockets = s.setdefault("sockets", {})
        held = sockets.get(ctl_id)
        cid = str(body.get("character") or "")
        by_gm = False
        if body.get("take"):
            if not held or not held.get("items"):
                raise ApiError(409, "There's nothing in it")
            if gm and not cid:
                cid, by_gm = held.get("by") or "", True
            c = chars.get(cid)
            if not c:
                raise ApiError(400, "Nobody to give it to")
            if not gm and (c["owner"] != token or cid not in s["to"]):
                raise ApiError(403, "That isn't shown to you")
            top = [e for e in held["items"] if not e.get("parent")]
            what = copy.deepcopy(top[0]) if top else None
            inside = [copy.deepcopy(e) for e in held["items"] if e.get("parent")]
            for e in top:
                transfer(held, c, e["uid"], e["qty"], f"taken from {label}")
            c["rev"] += 1
            sockets.pop(ctl_id, None)
            use = {"socket": "took", **({"byGm": True} if by_gm else {})}
        else:
            if held and held.get("items"):
                raise ApiError(409, "Something's in it already")
            c = chars.get(cid)
            if not c or c["owner"] != token or cid not in s["to"]:
                raise ApiError(403, "That isn't shown to you")
            e = find_entry(c, str(body.get("uid") or ""))
            if not e:
                raise ApiError(404, "You don't have that any more")
            holder = {"id": f"socket-{s['id']}-{ctl_id}", "name": label, "items": [], "by": cid, "byName": c["name"]}
            transfer(c, holder, e["uid"], e["qty"], f"put into {label}")
            c["rev"] += 1
            sockets[ctl_id] = holder
            what = copy.deepcopy(next((x for x in holder["items"] if not x.get("parent")), None))
            inside = [copy.deepcopy(x) for x in holder["items"] if x.get("parent")]
            use = {"socket": "put"}
        uses = s.setdefault("uses", [])
        uses.append({"id": new_id("u"), "character": cid, "type": "used", "control": ctl_id, "at": now_ms(), **use, "entry": what, "contents": inside[:200]})
        del uses[:-PANEL_USES_MAX]
        changed()
        return {"ok": True}

    def start_trade(self, shares, body, token):
        """A live trade between one of your characters and another (see share_api). Call with cond held."""
        chars = state["characters"]
        a, b = chars.get(str(body.get("from") or "")), chars.get(str(body.get("with") or ""))
        if not a or a["owner"] != token:
            raise ApiError(403, "You can only trade from your own character.")
        if not b or b is a:
            raise ApiError(400, "Pick someone else to trade with.")
        same = next((x for x in shares if x.get("kind") == "trade" and {x["from"], x["with"]} == {a["id"], b["id"]}), None)
        if same:
            return {"id": same["id"]}
        if len(shares) >= 200 or sum(1 for x in shares if x["by"] == token) >= SHARES_PER_DEVICE:
            raise ApiError(429, "You're sharing too much: end something first")
        empty = lambda: {"items": [], "coins": {}, "asks": [], "note": ""}
        s = {"id": new_id("s"), "kind": "trade", "by": token, "from": a["id"], "fromName": a["name"], "with": b["id"], "withName": b["name"],
             "to": [b["id"]], "gm": False, "seen": [], "at": now_ms(), "sides": {a["id"]: empty(), b["id"]: empty()},
             "agreed": [], "reason": None}
        shares.append(s)
        changed()
        print(f"  ? {a['name']} opened a trade with {b['name']}")
        return {"id": s["id"]}

    def trade_share(self, shares, s, method, action, body, token, gm):
        """A trade's calls: a side, agreeing, walking away (see share_api). Call with cond held."""
        chars = state["characters"]
        a, b = chars.get(s["from"]), chars.get(s["with"])
        cid = str(body.get("character") or "")
        mine = [c for c in (a, b) if c and c["owner"] == token]
        if method == "DELETE":
            if not mine and not gm:
                raise ApiError(403, "Not your trade")
            who = (mine[0]["name"] if mine else "The GM")
            record_trade(trade_history(s, "cancelled", f"{who} walked away"))
            shares.remove(s)
            changed()
            return {"ok": True}
        me = chars.get(cid)
        if not me or me["owner"] != token or cid not in (s["from"], s["with"]):
            raise ApiError(403, "Not your trade")
        other = b if cid == s["from"] else a
        if action == "side":
            side = clean_side(me, {"items": body.get("items"), "coins": body.get("coins")})
            check_side(me, side)
            for it in side["items"]:
                e = find_entry(me, it["uid"])
                it["entry"] = dict(e, item={k: v for k, v in e["item"].items() if k not in ("layers", "triggers")})
                it["inside"] = len(descendants(me, it["uid"]))
            asks = []
            for x in (body.get("asks") or [])[:50]:
                e = other and find_entry(other, str((x or {}).get("uid") or ""))
                if e:
                    asks.append({"uid": e["uid"], "qty": max(1, min(int(e.get("qty") or 1), int((x or {}).get("qty") or 1))),
                                 "name": str(e.get("customName") or "").strip() or e["item"]["name"]})
            s["sides"][cid] = {"items": side["items"], "coins": side["coins"], "asks": asks, "note": str(body.get("note") or "")[:300]}
            if len(json.dumps(s)) > SHARE_MAX_BYTES:
                raise ApiError(413, "That's too much for one trade")
            s["agreed"], s["reason"] = [], None
            changed()
            return {"ok": True}
        if action == "agree":
            if not body.get("agree"):
                s["agreed"] = [x for x in s["agreed"] if x != cid]
                changed()
                return {"ok": True}
            sa, sb = s["sides"][s["from"]], s["sides"][s["with"]]
            if not (sa["items"] or sa["coins"] or sb["items"] or sb["coins"]):
                raise ApiError(400, "Put something in first")
            if cid not in s["agreed"]:
                s["agreed"].append(cid)
            if set(s["agreed"]) >= {s["from"], s["with"]}:
                t = trade_history(s, "accepted")
                try:
                    execute(t)
                except TradeError as e:
                    s["agreed"], s["reason"] = [], str(e)
                    changed()
                    raise
                record_trade(t)
                shares.remove(s)
                print(f"  $ {s['fromName']} and {s['withName']} traded")
                changed()
                return {"ok": True, "done": True}
            changed()
            return {"ok": True}
        raise ApiError(404, "Unknown endpoint")

    def discard_api(self, method, parts, token):
        """Discarded items, for the GM (see prune_shares).

        POST   /api/discard {character, items}   one of your characters discards them (already taken out)
        DELETE /api/discard/<id>                  a GM's device has taken them
        """
        with cond:
            discards = state.setdefault("discards", [])
            if method == "POST" and not parts:
                body = self.body()
                cid = str(body.get("character") or "")
                c = state["characters"].get(cid)
                if not c or c["owner"] != token:
                    raise ApiError(403, "You can only discard your own characters' things")
                items = clean_treasure_items(body.get("items"))[:500]
                if not items:
                    raise ApiError(400, "Nothing to discard")
                if len(discards) >= 500 or sum(1 for x in discards if x["character"] == cid) >= DISCARDS_PER_CHARACTER:
                    raise ApiError(429, "The GM has a lot waiting: try again once they've taken it")
                d = {"id": new_id("d"), "character": cid, "name": c["name"], "items": items, "at": now_ms()}
                if len(json.dumps(d)) > DISCARD_MAX_BYTES:
                    raise ApiError(413, "That's too big to discard in one go")
                discards.append(d)
                changed()
                return {"id": d["id"]}
            if method == "DELETE" and len(parts) == 1:
                if not self.is_gm(token):
                    raise ApiError(403, "Only a GM can do that")
                state["discards"] = [x for x in discards if x["id"] != parts[0]]
                changed()
                return {"ok": True}
            raise ApiError(404, "Unknown endpoint")

    def gm_api(self, method, parts, token):
        """Global and Local values (js/clockwork.js): numbers for the whole party (Globals), one
        character or one item (Locals). Items use the most specific value set; every player gets
        them in the state snapshot. Stored as {"party": {gm_name: v}, "characters": {charId: {…}},
        "items": {"charId/entryUid": {…}}}.

        POST /api/gm {scope: party|character|item, target: "" | charId | "charId/uid", name, value}
             value null clears it (the level above then applies); {value, rate, until?} starts it
             moving (see clean_value).
        GMs set any. A player sets the Locals of their own characters and their items, except the
        GM's state overrides (gm_state_…) and the values the campaign keeps for the GM (gmOnly:
        states' limits).
        """
        if method != "POST" or parts:
            raise ApiError(404, "Unknown endpoint")
        body = self.body()
        scope, target, name, value = body.get("scope"), str(body.get("target") or ""), body.get("name"), body.get("value")
        if scope not in ("party", "character", "item") or not isinstance(name, str) \
                or not GM_NAME.match(name) or len(target) > 200 or (scope != "party" and not target):
            raise ApiError(400, "Not a GM value")
        if not self.is_gm(token):
            if scope == "party":
                raise ApiError(403, "Only a GM can set Global values")
            # Their own character, or an item of it (one just added may not have arrived yet, so
            # its id is checked for shape; how many items keep values is limited below).
            cid, _, uid = target.partition("/")
            c = state["characters"].get(cid) or {}
            if (scope == "character") != (not uid) or (uid and not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", uid)):
                raise ApiError(400, "Not one of your characters' items")
            if c.get("owner") != token or name.startswith("gm_state_") or name in ((state.get("campaign") or {}).get("gmOnly") or []):
                raise ApiError(403, "Only a GM can set that")
        if value is not None:
            value = clean_value(name, value)
            if value is None:
                raise ApiError(400, "GM values are numbers")
        with cond:
            gm = state.setdefault("gm", {})
            if scope == "party":
                group, bucket = None, gm.setdefault("party", {})
            else:
                group = gm.setdefault("characters" if scope == "character" else "items", {})
                if scope == "item" and target not in group and value is not None \
                        and sum(1 for t in group if t.startswith(target.split("/")[0] + "/")) >= MAX_VALUES:
                    raise ApiError(400, "Too many items with values")
                bucket = group.setdefault(target, {})
            if value is None:
                bucket.pop(name, None)
            elif name not in bucket and len(bucket) >= MAX_VALUES:
                raise ApiError(400, "Too many values there")
            else:
                bucket[name] = value
            if group is not None and not bucket:
                del group[target]
            changed()
        return {"ok": True}

    def images(self, method, parts, folder, own=False):
        """Document images: the party's (party-data/images) or this PC's own (my-data/images)."""
        if method == "POST" and len(parts) == 1:
            body = self.body()
            image_id, data = str(body.get("id") or ""), str(body.get("data") or "")
            m = re.match(r"^data:(image/[a-z]+);base64,(.+)$", data, re.S)
            if not re.fullmatch(r"[a-z0-9]{6,40}", image_id) or not m or m.group(1) not in IMAGE_TYPES:
                raise ApiError(400, "Not a supported image")
            try:
                raw = base64.b64decode(m.group(2), validate=True)
            except ValueError:
                raise ApiError(400, "Not a supported image")
            if len(raw) > MAX_IMAGE_BYTES:
                raise ApiError(413, "Image is too large")
            if not image_bytes_match(raw, m.group(1)):
                raise ApiError(400, "Not a supported image")
            os.makedirs(folder, exist_ok=True)
            with cond:  # first upload wins; ids are random per image
                if not any(f.startswith(image_id + ".") for f in os.listdir(folder)):
                    with open(os.path.join(folder, f"{image_id}.{IMAGE_TYPES[m.group(1)]}"), "wb") as f:
                        f.write(raw)
            return {"ok": True}
        if method == "GET" and len(parts) == 2 and re.fullmatch(r"[a-z0-9]{6,40}", parts[1]):
            for mime, ext in IMAGE_TYPES.items():
                path = os.path.join(folder, f"{parts[1]}.{ext}")
                if os.path.exists(path):
                    with open(path, "rb") as f:
                        raw = f.read()
                    self.send_response(200)
                    self.send_header("Content-Type", mime)
                    self.send_header("Content-Length", str(len(raw)))
                    self.send_header("X-Content-Type-Options", "nosniff")
                    self.end_headers()
                    self.wfile.write(raw)
                    return None
            raise ApiError(404, "No such image")
        # This PC's own pictures can also be listed and deleted (Settings → Files); the party's can't.
        if own and method == "GET" and len(parts) == 1:
            out = []
            if os.path.isdir(folder):
                for name in sorted(os.listdir(folder)):
                    image_id, _, ext = name.partition(".")
                    if re.fullmatch(r"[a-z0-9]{6,40}", image_id) and ext in IMAGE_TYPES.values():
                        out.append({"id": image_id, "bytes": os.path.getsize(os.path.join(folder, name))})
            return {"images": out}
        if own and method == "DELETE" and len(parts) == 2 and re.fullmatch(r"[a-z0-9]{6,40}", parts[1]):
            with cond:
                for ext in IMAGE_TYPES.values():
                    path = os.path.join(folder, f"{parts[1]}.{ext}")
                    if os.path.exists(path):
                        os.remove(path)
            return {"ok": True}
        raise ApiError(404, "Unknown endpoint")

    def presence_stream(self):
        """Held open by each desktop app window; the app quits when none are left."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        self.close_connection = True
        with cond:
            presence["count"] += 1
            presence["seen"] = True
            presence["changed"] = time.time()
            seen_rev = local["rev"]
        try:
            # Also tells this window when another window on the PC changed the shared data.
            while True:
                with cond:
                    if local["rev"] == seen_rev:
                        cond.wait(timeout=2)
                    msg = b": ping\n\n"
                    if local["rev"] != seen_rev:
                        seen_rev = local["rev"]
                        msg = f"event: local\ndata: {json.dumps({'rev': seen_rev, 'by': local.get('by', '')})}\n\n".encode()
                self.wfile.write(msg)
                self.wfile.flush()
        except OSError:
            pass
        finally:
            with cond:
                presence["count"] -= 1
                presence["changed"] = time.time()


# ------------------------------------------------------------------ updating the Windows app

RELEASES_API = "https://api.github.com/repos/jonathansatterthwaite-stack/is-this-a-mimic/releases/latest"
UPDATE_ASSET = "ITAMSapp.exe"
UPDATE_MAX_BYTES = 200 * 1024 * 1024


def update_app():
    """Replace the running exe with the latest release's, checked against GitHub's SHA-256 of it,
    and start the new one (it waits for this one to stop: see desktop.py). Returns its version."""
    import subprocess
    import urllib.request
    if not getattr(sys, "frozen", False):
        raise ApiError(400, "Only the installed app can update itself: download the new version instead")
    headers = {"User-Agent": "ITAMSapp-updater", "Accept": "application/vnd.github+json"}
    try:
        with urllib.request.urlopen(urllib.request.Request(RELEASES_API, headers=headers), timeout=20) as r:
            release = json.load(r)
    except Exception:
        raise ApiError(502, "Couldn't reach GitHub to find the latest version")
    asset = next((a for a in release.get("assets", []) if a.get("name") == UPDATE_ASSET), None)
    digest = str((asset or {}).get("digest") or "")
    if not asset or not digest.startswith("sha256:"):
        raise ApiError(502, "The latest release has no Windows app to install")
    exe = sys.executable
    new, old = exe + ".new", exe + ".old"
    sha = hashlib.sha256()
    try:
        with urllib.request.urlopen(urllib.request.Request(asset["browser_download_url"], headers={"User-Agent": headers["User-Agent"]}), timeout=60) as r,                 open(new, "wb") as f:
            size = 0
            while chunk := r.read(1 << 16):
                size += len(chunk)
                if size > UPDATE_MAX_BYTES:
                    raise ValueError("too big")
                sha.update(chunk)
                f.write(chunk)
    except Exception:
        _remove(new)
        raise ApiError(502, "The download didn't finish: nothing was changed")
    if sha.hexdigest() != digest.split(":", 1)[1].lower():
        _remove(new)
        raise ApiError(502, "The download didn't match GitHub's checksum: nothing was changed")
    # A running exe can be renamed (not overwritten): this one becomes .old (deleted by the next start).
    _remove(old)
    os.replace(exe, old)
    try:
        os.replace(new, exe)
    except OSError:
        os.replace(old, exe)
        _remove(new)
        raise ApiError(500, "Couldn't put the new version in place: nothing was changed")
    # PYINSTALLER_RESET_ENVIRONMENT: the new exe unpacks itself afresh, not into this one's folder.
    env = {**os.environ, "PYINSTALLER_RESET_ENVIRONMENT": "1"}
    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    subprocess.Popen([exe, "--after-update"], env=env, creationflags=flags, close_fds=True, cwd=os.path.dirname(exe))
    return str(release.get("tag_name") or "")


def _remove(path):
    try:
        os.remove(path)
    except OSError:
        pass


def shutdown_all():
    stop_lan()
    if app_server:
        app_server.shutdown()


PORT = None  # standalone mode's plain-HTTP port


def main():
    global PORT
    PORT = port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    load()
    try:
        server = QuietServer(("0.0.0.0", port), Handler)
    except OSError as e:
        sys.exit(f"Couldn't start on port {port} ({e}). Is it already running? Try: python server.py {port + 1}")
    print("\n  Is This A Mimic(s)? party server is running!\n")
    print(f"  On this computer:   http://localhost:{port}")
    addrs = lan_addresses()
    if addrs:
        print("  Players on your network join at:")
        for a in addrs:
            print(f"      http://{a}:{port}")
    else:
        print("  (Couldn't find a network address - are you connected to Wi-Fi/LAN?)")
    print(f"\n  Party data is saved in {DATA_FILE}")
    print("  Press Ctrl+C to stop.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Server stopped.")


if __name__ == "__main__":
    main()
