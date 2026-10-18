// Party mode: players on the same network share a party hosted by the Windows or Android app
// (or server.py) and can trade with each other.
//
// Characters always live on the device (store.state.characters). Joining a party means choosing
// which of them to play: that character is then *linked* — the host holds a live copy that the
// other players see and trade with, and every change on either side reaches the other. Leaving
// (or losing the connection) leaves the host's copy in the party; the device keeps its own.
//
// Where the party server is:
// - The page is served by it (the host's own window, or a browser that opened the host's
//   address): same origin, party.base = "".
// - The Windows or Android app joined someone else's party: it stays on its own page (and its
//   own saved data) and talks to the host at party.base across the network.
//
// Local edits still go through store.update(); after each save, linked characters are diffed
// against what the server last confirmed and changes are pushed. The server streams snapshots
// back (Server-Sent Events) after any change, e.g. when a trade moves items between characters.

const OLD_TOKEN_KEY = "mimic-player";       // before parties had ids: one token per browser
const JOINED_KEY = "mimic-joined-party";     // the party an app joined (its address)

// Fields the server adds to characters; not part of the character itself.
const SERVER_FIELDS = ["rev", "mine", "online", "owner"];

function cleanChar(c) {
  const out = { ...c };
  for (const k of SERVER_FIELDS) delete out[k];
  return clone(out);
}

const charJson = c => JSON.stringify(cleanChar(c));

// Short fingerprint of a character, to tell later whether it changed (FNV-1a).
function charHash(json) {
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) h = Math.imul(h ^ json.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36) + "." + json.length.toString(36);
}

async function fetchInfo(base, timeout = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(base + "api/info", { cache: "no-store", signal: ctrl.signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// A JSON request to an app server (this page's own or the party host's), as this player.
// A failure throws the server's message, with its status and reply.
async function apiRequest(url, method, body, token) {
  const res = await fetch(url, {
    method, cache: "no-store",
    headers: { "Content-Type": "application/json", ...(token ? { "X-Player": token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Set (or, with value null, clear) one GM value in a set of them: { party, characters, items }.
// The same shape is kept by the party host and, for preparing, in a campaign. Returns the set.
function putGmValue(g, scope, target, name, value) {
  let bucket;
  if (scope === "party") bucket = g.party = g.party || {};
  else {
    const group = scope === "character" ? "characters" : "items";
    g[group] = g[group] || {};
    bucket = g[group][target] = g[group][target] || {};
  }
  if (value == null) delete bucket[name]; else bucket[name] = value;
  return g;
}

// What this device is called in a party (the host sees devices by name when choosing GMs).
function deviceName() {
  const saved = (kv.get("mimic-device-name") || "").trim();
  if (saved) return saved;
  const ua = navigator.userAgent;
  return party.app?.android ? "Android phone" : party.app?.desktop ? "Windows PC"
    : /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android phone" : "Browser";
}

const party = {
  app: null,          // this page's own server (/api/info), if it has one
  info: null,         // the party server's /api/info
  base: "",           // party server address; "" = this page's own server
  active: false,
  connected: false,
  unreachable: null,  // an app's joined party that couldn't be reached at startup
  token: null,
  chars: [],          // every character in the party, from the latest snapshot
  trades: [],         // trades involving my characters
  shops: [],
  gm: {},             // Global and Local values (js/clockwork.js)
  synced: new Map(),  // id -> { rev, json }: last version the server confirmed (= linked characters)
  records: {},        // id -> { rev, h }: the same, remembered on this device between visits
  undecided: new Set(), // changed both here and in the party while away: waiting for the player
  timers: new Map(),
  inflight: new Set(),
  uploaded: new Set(),

  url(path) { return this.base + path; },

  // This page's own server, and which party (if any) to be in.
  async detect() {
    if (location.protocol.startsWith("http")) this.app = await fetchInfo("", 4000);
    // In the Windows and Android apps, saved data lives in a file shared by every window.
    if (this.app?.localStore && !FRESH_TEST) { // (a fresh-start test keeps to itself)
      try {
        await kv.connect();
      } catch (e) {
        console.warn("Using this browser's storage instead of the app's", e);
      }
    }
    // The desktop app quits when its last window closes; this stream tells it we're open
    // (and tells us when another window on the PC changed the shared data).
    if (this.isApp()) {
      const presence = new EventSource("api/presence");
      presence.addEventListener("local", e => {
        if (JSON.parse(e.data).by !== kv.client && !FRESH_TEST) reloadSharedData();
      });
    }
    if (this.app?.party && !FRESH_TEST) return this.start("", this.app); // (a test doesn't join this PC's party)
    const joined = this.isApp() && kv.get(JOINED_KEY);
    if (joined) {
      const info = await fetchInfo(joined);
      if (info?.party) return this.start(joined, info);
      this.unreachable = joined;
    }
    return false;
  },

  async start(base, info) {
    this.base = base;
    this.info = info;
    const id = info.partyId || "default";
    const tokenKey = "mimic-player-" + id;
    this.token = kv.get(tokenKey) || (base === "" ? kv.get(OLD_TOKEN_KEY) : null) || uid() + uid();
    kv.set(tokenKey, this.token);
    try { this.records = JSON.parse(kv.get("mimic-party-sync-" + id) || "{}"); } catch { this.records = {}; }
    const snap = await this.api("GET", "api/state");
    this.chars = snap.characters;
    this.trades = snap.trades;
    this.takeRoles(snap);
    this.active = true;
    return true;
  },

  // After the device's characters are loaded: link the ones that are mine in this party.
  link() {
    for (const p of this.owned()) this.reconcile(p);
    this.settle();
  },

  api(method, url, body) { return apiRequest(this.url(url), method, body, this.token); },

  // ------------------------------------------------------------ which characters are linked

  isLinked(id) { return this.synced.has(id) || this.undecided.has(id); },
  linked() { return store.state.characters.filter(c => this.isLinked(c.id)); },

  markSynced(id, rev, json) {
    this.synced.set(id, { rev, json });
    this.records[id] = { rev, h: charHash(json) };
    this.saveRecords();
  },

  unlink(id) {
    this.synced.delete(id);
    this.undecided.delete(id);
    clearTimeout(this.timers.get(id));
    delete this.records[id];
    this.saveRecords();
  },

  saveRecords() {
    clearTimeout(this.recordTimer);
    this.recordTimer = setTimeout(() => kv.set("mimic-party-sync-" + (this.info?.partyId || "default"), JSON.stringify(this.records)), 200);
  },

  // A character of mine in the party: bring the device's copy and the party's in line.
  // Whichever changed since they were last in step wins; if both did, the player decides.
  reconcile(p) {
    const local = store.state.characters;
    const i = local.findIndex(c => c.id === p.id);
    const pJson = charJson(p);
    const rec = this.records[p.id];
    if (i < 0) { // created or taken over on another device: now saved here too
      // Linked from this device before, so it was deleted here while away: the party still had
      // it, so it's back rather than lost. Deleting it while connected removes it from the party.
      if (rec) toast(`${p.name} was deleted on this device while you were away, but the party still had it, so it's back. Delete it again while connected to remove it from the party too.`);
      local.push(cleanChar(p));
      this.markSynced(p.id, p.rev, pJson);
      return;
    }
    const devJson = charJson(local[i]);
    if (devJson === pJson) return this.markSynced(p.id, p.rev, pJson);
    const devChanged = !rec || charHash(devJson) !== rec.h;
    const partyChanged = !rec || p.rev !== rec.rev;
    if (devChanged && partyChanged) {
      this.undecided.add(p.id);
      return;
    }
    if (partyChanged) local[i] = cleanChar(p); // changed in the party (a trade?) while away
    // Device newer: the next sync pushes it (it differs from what the party has).
    this.synced.set(p.id, { rev: p.rev, json: pJson });
    if (partyChanged) this.markSynced(p.id, p.rev, pJson);
  },

  // Resolve a character changed in both places: keep this device's version or the party's.
  resolve(id, keep) {
    const p = this.owned().find(c => c.id === id);
    const i = store.state.characters.findIndex(c => c.id === id);
    this.undecided.delete(id);
    if (!p || i < 0) return render();
    const pJson = charJson(p);
    if (keep === "party") {
      store.state.characters[i] = cleanChar(p);
      this.markSynced(id, p.rev, pJson);
    } else {
      this.synced.set(id, { rev: p.rev, json: pJson }); // differs -> pushed by the next sync
    }
    store.save();
    render();
  },

  // Make the active character one that's in the party, if the current one isn't.
  settle() {
    if (!this.isLinked(store.state.activeId)) {
      const first = this.linked()[0];
      if (first) store.state.activeId = first.id;
    }
    store.save();
  },

  // Play one of this device's characters in the party (or take over one of the party's).
  async bring(id) {
    const existing = this.chars.find(p => p.id === id);
    try {
      if (existing && !existing.mine) {
        if (existing.online) throw new Error(`${existing.name} is being played on another device right now.`);
        await this.api("POST", `api/characters/${encodeURIComponent(id)}/claim`);
        const snap = await this.api("GET", "api/state");
        this.chars = snap.characters;
        const mine = this.owned().find(p => p.id === id);
        if (mine) this.reconcile(mine);
      } else if (existing) {
        this.reconcile(existing);
      } else {
        const c = store.state.characters.find(x => x.id === id);
        if (!c) return;
        await this.create(c);
        id = c.id; // the server may have given it a new id
      }
      store.state.activeId = id;
      store.save();
      render();
      return true;
    } catch (e) {
      toast(e.message);
      return false;
    }
  },

  // ------------------------------------------------------------ roles, and values
  // Global and Local values (js/clockwork.js) are kept by the host in `gm`, as GM values were.

  isGm() { return this.active && this.role === "gm"; },
  // The device running the party: it can stop it, choose GMs and remove players.
  isHost() { return this.active && !!this.isHostDevice; },

  takeRoles(snap) {
    this.shops = snap.shops || [];
    this.treasure = snap.treasure || []; // treasure being shown (js/treasure.js)
    this.shares = snap.shares || []; // shared screens: with this device's characters, or by them (js/shared.js)
    this.discards = snap.discards || []; // discarded items waiting for a GM's device
    this.gm = snap.gm || {};
    // The host's clock, which moving values follow (js/clockwork.js): how far ahead of ours it is.
    if (typeof snap.time === "number") this.clockOffset = snap.time - Date.now();
    this.role = snap.role || "player";
    this.isHostDevice = !!snap.isHost;
    // The GM device that runs the campaign's world rules (one, however many GMs: js/triggers.js).
    this.runsWorld = !!snap.runsWorld;
    this.devices = snap.devices || [];
    this.campaign = snap.campaign || null;
  },

  // Host: make a device a GM, or not.
  async setGmRole(deviceId, gm) {
    try { await this.api("POST", "api/gm-role", { device: deviceId, gm }); } catch (e) { toast(e.message); }
  },

  // ------------------------------------------------------------ campaigns
  // The GM loads one of their campaigns into the party; every device then plays that campaign:
  // it switches to its own campaign of the same id (making one if it has none), with the characters
  // it has there.

  async loadCampaign(camp) {
    await this.api("POST", "api/campaign", { id: camp.id, name: camp.name, shops: camp.shops, gmValues: valuesFromNow(camp.gmValues),
      system: camp.system ? { id: camp.system, name: systemName(camp.system) } : null,
      // The servers work out shop payments in its money, and sale prices with its states' layers.
      currency: currencyRules(sysOf(camp)),
      states: [...systemStates(sysOf(camp)), ...(camp === store.campaign() ? [] : campaignStates(camp))].map(st => st.key),
      // The campaign's own states, for players' devices to use (see takeSystem).
      ownStates: campaignStates(camp),
      // Values only a GM sets (states' limits); players set their other Locals (js/clockwork.js).
      gmOnly: systemStates(sysOf(camp)).map(limitValueName).filter(Boolean).map(valueKey),
      // Rules, values and controls (js/clockwork.js): off for everyone when the GM says so.
      clockwork: camp.clockwork !== false,
      // The campaign's rule book (js/triggers.js): every device runs its own share of it.
      rules: Array.isArray(camp.rules) ? camp.rules : [] });
  },

  // The game system the GM's campaign plays.
  takeSystem(camp, pc) {
    if (!pc) return false;
    let changed = false;
    // Its own states (a player's device follows the GM's; the GM's device has them already).
    if (Array.isArray(pc.ownStates) && !this.isGm() && JSON.stringify(camp.states || []) !== JSON.stringify(pc.ownStates)) {
      camp.states = clone(pc.ownStates);
      changed = true;
    }
    if (!("system" in pc)) return changed;
    const id = pc.system?.id || null;
    if (camp.system === id && camp.systemName === pc.system?.name) return changed;
    camp.system = id;
    camp.systemName = pc.system?.name; // to name it if this device hasn't got it
    return true;
  },

  // Called once the device's data is loaded and after each snapshot. Returns true if it switched.
  followCampaign() {
    const pc = this.campaign;
    if (!this.active || !pc) return false;
    if (pc.id === store.campaign().id) {
      // Same campaign: the GM may have changed its game system.
      if (this.takeSystem(store.campaign(), pc)) store.save();
      return false;
    }
    // Let go of the characters linked in the campaign we're leaving: they stay in the party's save
    // of it (and on this device), just not playing now. (Without this, saving would remove them.)
    for (const t of this.timers.values()) clearTimeout(t);
    this.synced = new Map();
    this.undecided = new Set();
    let camp = store.campaigns().find(c => c.id === pc.id);
    if (!camp) {
      camp = newCampaign(pc.name, [...store.campaign().packages]);
      camp.id = pc.id;
      store.data.campaigns.push(camp);
    } else if (camp.name !== pc.name) camp.name = pc.name;
    this.takeSystem(camp, pc);
    normalizeData(store.data);
    store.data.activeCampaign = camp.id;
    camp.lastPlayed = Date.now();
    this.link();
    toast(`Now playing ${pc.name}`);
    return true;
  },

  // scope: "party" | "character" | "item"; target: "" | charId | "charId/entryUid"; value null clears it.
  async setGm(scope, target, name, value) {
    // Here at once, so what reads it next (a rule adding to it again, a redraw) sees it; the
    // host's snapshot follows. Put back if the host says no.
    const g = this.gm || {}, bucket = scope === "party" ? g.party : g[scope === "character" ? "characters" : "items"]?.[target];
    const had = bucket && name in bucket ? bucket[name] : null;
    this.gm = putGmValue(g, scope, target, name, value);
    try {
      await this.api("POST", "api/gm", { scope, target, name, value });
    } catch (err) {
      this.gm = putGmValue(this.gm || {}, scope, target, name, had);
      throw err;
    }
  },

  // ------------------------------------------------------------ document images

  async uploadImage(id, data) {
    if (this.uploaded.has(id)) return;
    await this.api("POST", "api/images", { id, data });
    this.uploaded.add(id);
  },

  // Make sure the host has every image this character's documents use,
  // so other players (e.g. after a trade) can see them.
  async ensureImages(c) {
    for (const id of allImageRefs([c])) {
      if (this.uploaded.has(id)) continue;
      const data = await imageStore.get(id);
      if (data) await this.uploadImage(id, data); // missing locally = came from the host already
    }
  },

  owned() { return this.chars.filter(c => c.mine); },
  others() { return this.chars.filter(c => !c.mine); },
  joinUrls() {
    const port = this.info?.port || location.port;
    const urls = (this.info?.addresses || []).map(a => `http://${a}:${port}`);
    return urls.length ? urls : [this.base ? this.base.replace(/\/$/, "") : location.origin];
  },

  connect() {
    this.events?.close();
    const es = this.events = new EventSource(this.url("api/events?player=" + encodeURIComponent(this.token)
      + "&device=" + encodeURIComponent(deviceName())));
    es.addEventListener("state", e => {
      this.connected = true;
      this.applySnapshot(JSON.parse(e.data));
    });
    es.onerror = () => {
      // EventSource reconnects on its own; just show we're offline meanwhile.
      if (this.connected) { this.connected = false; render(); }
    };
  },

  // ------------------------------------------------------------ joining and leaving (apps)

  // The Windows or Android app joins a party at another address, staying on its own page.
  async join(base, info, { quiet = false } = {}) {
    kv.set(JOINED_KEY, base);
    this.unreachable = null;
    clearInterval(this.retryTimer);
    await this.start(base, info);
    if (!this.followCampaign()) this.link();
    this.connect();
    if (quiet) toast(`Reconnected to the party at ${base.replace(/^https?:\/\/|\/$/g, "")}`);
    else ui.view = "party";
    render();
  },

  // The joined party's host wasn't reachable when the app opened: keep checking quietly.
  retryJoin() {
    clearInterval(this.retryTimer);
    this.retryTimer = setInterval(async () => {
      const base = this.unreachable;
      if (!base || this.active) return clearInterval(this.retryTimer);
      const info = await fetchInfo(base, 4000);
      if (info?.party && this.unreachable === base) this.join(base, info, { quiet: true }).catch(() => {});
    }, 20000);
  },

  // Starting to host: forget a party this app had joined elsewhere.
  forgetJoined() {
    kv.remove(JOINED_KEY);
    this.unreachable = null;
    clearInterval(this.retryTimer);
  },

  // Stop playing in a joined party. Its copies of our characters stay in the party (the host
  // can remove them); this device keeps its own.
  leave() {
    // Tell the host now (it would otherwise notice the closed connection within ~30 s).
    if (this.active) this.api("POST", "api/leave").catch(() => {});
    this.events?.close();
    this.events = null;
    kv.remove(JOINED_KEY);
    clearInterval(this.retryTimer);
    for (const t of this.timers.values()) clearTimeout(t);
    Object.assign(this, { active: false, connected: false, base: "", info: null, token: null, chars: [], trades: [], tradesKnown: false, shares: [], shops: [], gm: {}, role: "player", isHostDevice: false, runsWorld: false, devices: [], campaign: null, unreachable: null });
    this.synced = new Map();
    this.undecided = new Set();
    this.uploaded = new Set();
    this.setStatus(true);
    if (ui.view === "party") ui.view = "inventory";
    render();
  },

  // ------------------------------------------------------------ server -> local

  applySnapshot(snap) {
    const before = this.trades;
    this.chars = snap.characters;
    this.trades = snap.trades;
    this.takeRoles(snap);
    const local = store.state.characters;
    let conflict = false, replaced = false;

    if (this.followCampaign()) { cancelUndo(); render(); return; }
    for (const c of this.owned()) {
      const s = this.synced.get(c.id);
      if (!s) {
        if (this.undecided.has(c.id)) continue;
        this.reconcile(c); // new to this device: taken over here, or just linked
        replaced = true;
        continue;
      }
      const i = local.findIndex(x => x.id === c.id);
      if (i < 0) continue; // deleted here; the DELETE is on its way
      if (c.rev <= s.rev) continue;
      // Our own save echoed back before its response arrived: nothing to do.
      if (charJson(local[i]) === charJson(c)) { this.markSynced(c.id, c.rev, charJson(c)); continue; }
      // A save is in flight; if it's now stale it gets a 409 and adopts the server copy.
      if (this.inflight.has(c.id)) continue;
      if (charJson(local[i]) !== s.json) conflict = true; // unsaved local edit loses
      local[i] = cleanChar(c);
      clearTimeout(this.timers.get(c.id));
      replaced = true;
      this.markSynced(c.id, c.rev, charJson(c));
    }

    // Linked characters that are no longer mine here (taken over elsewhere, or removed by the
    // host). This device keeps its copy; it's just not in the party any more.
    for (const id of [...this.synced.keys(), ...this.undecided]) {
      if (this.owned().some(c => c.id === id)) continue;
      const name = local.find(x => x.id === id)?.name || "A character";
      toast(snap.characters.some(c => c.id === id)
        ? `${name} is now being played on another device (your copy stays on this device)`
        : `${name} was removed from the party by the host (it's still saved on this device)`);
      this.unlink(id);
    }
    if (replaced) cancelUndo();
    if (replaced || !this.isLinked(store.state.activeId)) this.settle();

    if (typeof shopStore !== "undefined" && shopStore.canManage()) shopStore.refresh(); // live stock for the host
    if (conflict) toast("Your inventory changed on the server (a trade?) — showing the latest version");
    // A trade just made or walked away from (js/party-ui.js): what changed hands, or who walked away.
    if (this.tradesKnown) for (const t of this.trades) {
      if (before.some(b => b.id === t.id) || !(t.fromMine || t.toMine)) continue;
      if (t.status === "accepted") {
        const got = describeSide(t.fromMine ? t.ask : t.give), gave = describeSide(t.fromMine ? t.give : t.ask);
        toast(`Traded with ${t.fromMine ? t.toName : t.fromName}: you got ${got}; you gave ${gave}`);
      } else if (t.status === "cancelled") toast(`The trade with ${t.fromMine ? t.toName : t.fromName} is off${t.reason ? `: ${t.reason}` : ""}`);
    }
    this.tradesKnown = true;
    render();
  },

  // ------------------------------------------------------------ local -> server

  // Called after every local save with all of this device's characters: linked ones that
  // changed are pushed; a linked one deleted here leaves the party.
  sync(chars) {
    if (!this.active) return;
    for (const c of chars) {
      const s = this.synced.get(c.id);
      if (s && charJson(c) !== s.json) this.schedulePut(c.id);
    }
    for (const id of [...this.synced.keys()]) {
      if (!chars.some(c => c.id === id)) this.remove(id);
    }
  },

  async create(c) {
    if (this.inflight.has(c.id)) return;
    this.inflight.add(c.id);
    const id = c.id;
    try {
      const json = charJson(c);
      await this.ensureImages(c);
      const res = await this.api("POST", "api/characters", { character: cleanChar(c) });
      if (res.id !== c.id) { // id collision: the server picked a new one
        if (store.state.activeId === c.id) store.state.activeId = res.id;
        c.id = res.id;
      }
      this.markSynced(res.id, res.rev, JSON.stringify({ ...JSON.parse(json), id: res.id }));
      this.setStatus(true);
      toast(`${c.name} is in the party`);
    } catch (e) {
      this.setStatus(false, `Couldn't add ${c.name} to the party: ${e.message}`);
      throw e;
    } finally {
      this.inflight.delete(id);
    }
    this.sync(store.state.characters); // flush edits made while creating
  },

  // Shows a warning in the header while changes aren't reaching the host.
  setStatus(ok, message = "") {
    const el = document.getElementById("sync-status");
    if (!el) return;
    el.hidden = ok;
    el.textContent = ok ? "" : "⚠ Not saved";
    el.title = message;
    if (!ok && message && message !== this.lastStatus) toast(message);
    this.lastStatus = ok ? "" : message;
  },

  schedulePut(id, delay = 300) {
    clearTimeout(this.timers.get(id));
    this.timers.set(id, setTimeout(() => this.put(id), delay));
  },

  async put(id) {
    if (this.inflight.has(id)) return this.schedulePut(id);
    const c = store.state.characters.find(x => x.id === id);
    const s = this.synced.get(id);
    if (!c || !s || !this.active) return;
    const json = charJson(c);
    if (json === s.json) return;
    this.inflight.add(id);
    try {
      await this.ensureImages(c);
      const res = await this.api("PUT", "api/characters/" + encodeURIComponent(id), { baseRev: s.rev, character: cleanChar(c) });
      this.markSynced(id, res.rev, json);
      this.setStatus(true);
    } catch (e) {
      if (e.status === 409 && e.data.character) {
        this.adopt(e.data.character);
        toast("Your inventory changed on the server (a trade?) — showing the latest version");
      } else if (e.status === 403 || e.status === 404) {
        this.unlink(id);
        toast(e.status === 404 ? `${c.name} was removed from the party by the host (it's still saved on this device)`
          : `${c.name} is being played on another device (your copy stays on this device)`);
        this.settle();
        render();
      } else {
        this.setStatus(false, "Can't reach the party host — your changes will be saved when it's back");
        this.schedulePut(id, 3000); // server unreachable; retry
      }
    } finally {
      this.inflight.delete(id);
    }
  },

  adopt(c) {
    const local = store.state.characters;
    const i = local.findIndex(x => x.id === c.id);
    if (i >= 0) local[i] = cleanChar(c); else local.push(cleanChar(c));
    this.markSynced(c.id, c.rev, charJson(c));
    cancelUndo();
    store.save();
    render();
  },

  async remove(id) {
    this.unlink(id);
    try { await this.api("DELETE", "api/characters/" + encodeURIComponent(id)); } catch {}
  },

  // The app's own window (Windows or Android), as opposed to a browser that opened an address.
  isApp() { return !!(this.app?.desktop && this.app.isHost); },
  // ...hosting the party it's in.
  isHosting() { return this.isApp() && this.active && this.base === ""; },
  // In a party at another address (the apps only).
  isJoinedElsewhere() { return this.active && this.base !== ""; },

  async host(enable, port) {
    const res = await fetch("api/host", {
      method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enable, port }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
  },

  async quit() {
    await fetch("api/quit", { method: "POST", cache: "no-store" });
  },

};
