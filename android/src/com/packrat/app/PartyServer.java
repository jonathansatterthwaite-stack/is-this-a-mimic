package com.packrat.app;

import android.content.res.AssetManager;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Android port of server.py (desktop mode). Serves the app to this device's
 * WebView on 127.0.0.1 and, while hosting, to other players on the local
 * network, with the same JSON API: characters, trades and live updates.
 */
public class PartyServer {

    public interface Listener {
        void onHostingChanged(boolean hosting, int port);
        void onQuit();
    }

    static final int DEFAULT_LAN_PORT = 8765;
    static final int[] APP_PORTS = {47651, 47652, 47653, 47654, 47655};
    static final int MAX_BODY = 8 * 1024 * 1024;
    static final int MAX_VALUES = 200; // Global and Local values kept in one place (the party's, a character's, an item's)
    static final int MAX_IMAGE_BYTES = 5 * 1024 * 1024;
    static final String[][] IMAGE_TYPES = {{"image/png", "png"}, {"image/jpeg", "jpg"}, {"image/webp", "webp"}, {"image/gif", "gif"}};
    static final java.util.regex.Pattern IMAGE_ID = java.util.regex.Pattern.compile("[a-z0-9]{6,40}");
    static final java.util.regex.Pattern DATA_URL = java.util.regex.Pattern.compile("^data:(image/[a-z]+);base64,(.+)$", java.util.regex.Pattern.DOTALL);
    static final int KEEP_RESOLVED_TRADES = 50;
    static final Set<String> NON_STACKING = new HashSet<>(Arrays.asList("weapon", "armor", "container", "magic", "pack"));
    /** A game system's money (as server.py's clean_currency): coins largest first, each worth `values` of
     *  the smallest; `change` (indexes into keys): what shops pay out and give change in. */
    static final class Currency {
        final String[] keys; final long[] values; final int[] change;
        Currency(String[] keys, long[] values, int[] change) { this.keys = keys; this.values = values; this.change = change; }
        int index(String key) { for (int i = 0; i < keys.length; i++) if (keys[i].equals(key)) return i; return -1; }
    }
    /** Until a campaign says (one without a game system): D&D 5e's coins. */
    static final Currency DEFAULT_CURRENCY = new Currency(new String[]{"pp", "gp", "ep", "sp", "cp"}, new long[]{1000, 100, 50, 10, 1}, new int[]{1, 3, 4});

    /** A currency sent by a GM's device ({coins: [[key, value]…], change: [keys]}), checked; null if it isn't one. */
    static Currency cleanCurrency(JSONObject raw) throws JSONException {
        if (raw == null || raw.optJSONArray("coins") == null) return null;
        JSONArray in = raw.getJSONArray("coins");
        List<String> keys = new ArrayList<>();
        List<Long> values = new ArrayList<>();
        for (int i = 0; i < in.length() && i < 12; i++) {
            JSONArray c = in.optJSONArray(i);
            if (c == null || c.length() != 2 || !(c.opt(0) instanceof String) || !(c.opt(1) instanceof Integer || c.opt(1) instanceof Long)) continue;
            String k = c.getString(0);
            long v = c.getLong(1);
            if (!k.matches("^[a-z][a-z0-9]{0,7}$") || v < 1 || v > 1000000000L || keys.contains(k)) continue;
            int at = 0;
            while (at < values.size() && values.get(at) > v) at++; // largest first
            keys.add(at, k);
            values.add(at, v);
        }
        if (!values.contains(1L)) return null;
        JSONArray asked = raw.optJSONArray("change");
        List<Integer> change = new ArrayList<>();
        for (int i = 0; i < keys.size(); i++) {
            boolean want = asked == null;
            for (int j = 0; asked != null && j < asked.length(); j++) if (keys.get(i).equals(asked.optString(j))) want = true;
            if (want) change.add(i);
        }
        if (!change.contains(keys.size() - 1)) change.add(keys.size() - 1);
        long[] vals = new long[values.size()];
        for (int i = 0; i < vals.length; i++) vals[i] = values.get(i);
        int[] ch = new int[change.size()];
        for (int i = 0; i < ch.length; i++) ch[i] = change.get(i);
        return new Currency(keys.toArray(new String[0]), vals, ch);
    }

    /** The money of the campaign being played. */
    Currency currency() {
        try {
            Currency c = campaign == null ? null : cleanCurrency(campaign.optJSONObject("currency"));
            return c == null ? DEFAULT_CURRENCY : c;
        } catch (JSONException e) {
            return DEFAULT_CURRENCY;
        }
    }

    /** The currency as it's kept with the campaign. */
    static JSONObject currencyJson(Currency c) throws JSONException {
        JSONArray coins = new JSONArray(), change = new JSONArray();
        for (int i = 0; i < c.keys.length; i++) coins.put(new JSONArray().put(c.keys[i]).put(c.values[i]));
        for (int i : c.change) change.put(c.keys[i]);
        return new JSONObject().put("coins", coins).put("change", change);
    }
    static final String[] STATIC_PREFIXES = {"/index.html", "/manifest.webmanifest", "/sw.js", "/css/", "/js/", "/icons/"};
    static final String[] NO_TOKEN = {"/api/info", "/api/presence", "/api/host", "/api/quit"};

    private final AssetManager assets;
    private final File dataDir;
    /** The current party save: party.json, or the current campaign's (see switchCampaign). */
    private File dataFile;
    private volatile Listener listener;

    // Everything below is guarded by `lock` (like `cond` in server.py).
    private final Object lock = new Object();
    private JSONObject characters = new JSONObject();
    private JSONArray trades = new JSONArray();
    private JSONArray shops = new JSONArray();
    private JSONArray treasure = new JSONArray(); // treasure being shown to players (see treasureApi)
    private JSONArray shows = new JSONArray(); // items being shown (see showApi)
    private JSONArray discards = new JSONArray(); // discarded items waiting for a GM's device (see discardApi)
    /** GM values (see gm_api in server.py): {party: {name: v}, characters: {id: {…}}, items: {"charId/uid": {…}}}. */
    private JSONObject gm = new JSONObject();
    /** Host-level (kept whatever the campaign): tokens of the devices the host has made GMs, and devices' names. */
    private JSONArray gms = new JSONArray();
    private JSONObject devices = new JSONObject();
    /** The campaign this party save belongs to, {id, name}; null until the GM loads one. */
    private JSONObject campaign = null;
    static final java.util.regex.Pattern CAMPAIGN_ID = java.util.regex.Pattern.compile("[A-Za-z0-9_-]{1,60}");
    static final java.util.regex.Pattern GM_NAME = java.util.regex.Pattern.compile("gm_[A-Za-z0-9_]{1,40}");
    private long version = 0;
    private final Map<String, Integer> online = new HashMap<>();

    private ServerSocket appSocket;
    private volatile ServerSocket lanSocket;
    private int appPort;
    private int lanPort = 0;

    private final SecureRandom random = new SecureRandom();

    public PartyServer(AssetManager assets, File dataDir) {
        this.assets = assets;
        dataDir.mkdirs();
        this.dataDir = dataDir;
        this.dataFile = new File(dataDir, "party.json");
        // This phone's own characters, settings and images, next to party-data (like the
        // Windows app's my-data): kept in a file so they don't depend on the WebView's
        // storage, which is tied to the app's port.
        this.localDir = new File(dataDir.getParentFile(), "my-data");
        load();
        if (partyId.isEmpty()) {
            // Lets devices recognise this party even if the phone's address changes.
            partyId = newId("p");
            save();
        }
        loadLocal();
    }

    private String partyId = "";

    private final File localDir;
    private JSONObject localData = new JSONObject();
    private long localRev = 0;

    private void loadLocal() {
        File f = new File(localDir, "app-data.json");
        if (!f.exists()) return;
        try (InputStream in = new java.io.FileInputStream(f)) {
            JSONObject o = new JSONObject(new String(readAll(in), StandardCharsets.UTF_8));
            localData = o.optJSONObject("data") != null ? o.getJSONObject("data") : new JSONObject();
        } catch (Exception e) {
            f.renameTo(new File(f.getPath() + ".broken-" + System.currentTimeMillis()));
        }
    }

    /** Call with `lock` held. */
    private void saveLocal() {
        try {
            localDir.mkdirs();
            File f = new File(localDir, "app-data.json"), tmp = new File(localDir, "app-data.json.tmp");
            JSONObject o = new JSONObject();
            o.put("data", localData);
            try (OutputStream out = new FileOutputStream(tmp)) { out.write(o.toString().getBytes(StandardCharsets.UTF_8)); }
            if (!tmp.renameTo(f)) {
                // Some filesystems won't rename over an existing file.
                f.delete();
                if (!tmp.renameTo(f)) throw new IOException("rename failed");
            }
        } catch (Exception e) {
            android.util.Log.e("Mimic", "Could not save app data", e);
        }
    }

    /** GET /api/local -> {rev, data}; PUT {set: {key: value or null}}; /api/local/images/... */
    private JSONObject localApi(Request req, List<String> parts, OutputStream out) throws ApiError, IOException, JSONException {
        if (!req.fromApp) throw new ApiError(403, "Only the app on this phone can do that");
        if (parts.size() >= 2 && parts.get(1).equals("images")) return images(req, parts.subList(1, parts.size()), out, new File(localDir, "images"), true);
        if (parts.size() != 1) throw new ApiError(404, "Unknown endpoint");
        synchronized (lock) {
            if (req.method.equals("GET")) {
                JSONObject r = new JSONObject();
                r.put("rev", localRev);
                r.put("data", localData);
                return r;
            }
            if (req.method.equals("PUT")) {
                JSONObject set = req.json().optJSONObject("set");
                if (set == null) throw new ApiError(400, "Bad data");
                Iterator<String> it = set.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    Object v = set.get(k);
                    if (v == JSONObject.NULL) localData.remove(k);
                    else if (v instanceof String) localData.put(k, v);
                    else throw new ApiError(400, "Bad data");
                }
                localRev++;
                saveLocal();
                JSONObject r = new JSONObject();
                r.put("rev", localRev);
                return r;
            }
        }
        throw new ApiError(405, "Method not allowed");
    }

    public void setListener(Listener l) { listener = l; }

    // ------------------------------------------------------------------ listeners

    /** Start the private listener the app's own WebView uses. */
    public synchronized void startApp() throws IOException {
        if (appSocket != null) return;
        IOException last = null;
        for (int port : APP_PORTS) {
            try {
                ServerSocket s = new ServerSocket();
                s.setReuseAddress(true);
                s.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port));
                appSocket = s;
                appPort = port;
                acceptLoop(s, true);
                return;
            } catch (IOException e) {
                last = e;
            }
        }
        throw last;
    }

    public String appUrl() { return "http://127.0.0.1:" + appPort + "/"; }

    public boolean isHosting() { return lanSocket != null; }

    public int lanPort() { return lanPort; }

    public void startLan(int port) throws IOException {
        synchronized (lock) {
            if (lanSocket != null) return;
        }
        ServerSocket s = new ServerSocket();
        s.setReuseAddress(true);
        s.bind(new InetSocketAddress(port)); // all interfaces: Wi-Fi, hotspot...
        synchronized (lock) {
            lanSocket = s;
            lanPort = port;
            changed(false);
        }
        acceptLoop(s, false);
        Listener l = listener;
        if (l != null) l.onHostingChanged(true, port);
    }

    public void stopLan() {
        ServerSocket s;
        synchronized (lock) {
            s = lanSocket;
            lanSocket = null;
            changed(false); // wakes event streams so they notice and close
        }
        if (s != null) {
            try { s.close(); } catch (IOException ignored) {}
            Listener l = listener;
            if (l != null) l.onHostingChanged(false, lanPort);
        }
    }

    private boolean partyEnabled() { return lanSocket != null; }

    private void acceptLoop(final ServerSocket server, final boolean fromApp) {
        Thread t = new Thread(() -> {
            while (!server.isClosed()) {
                try {
                    final Socket client = server.accept();
                    Thread h = new Thread(() -> handle(client, fromApp), "mimic-conn");
                    h.setDaemon(true);
                    h.start();
                } catch (IOException e) {
                    if (server.isClosed()) return;
                }
            }
        }, fromApp ? "mimic-app" : "mimic-lan");
        t.setDaemon(true);
        t.start();
    }

    // ------------------------------------------------------------------ persistence

    private File campaignFile(String cid) { return new File(new File(dataDir, "campaigns"), cid + ".json"); }

    private File pointerFile() { return new File(dataDir, "active-campaign"); }

    private void load() {
        dataFile = new File(dataDir, "party.json");
        if (pointerFile().exists()) {
            try (InputStream in = new java.io.FileInputStream(pointerFile())) {
                String cid = new String(readAll(in), StandardCharsets.UTF_8).trim();
                if (CAMPAIGN_ID.matcher(cid).matches() && campaignFile(cid).exists()) dataFile = campaignFile(cid);
            } catch (IOException ignored) {}
        }
        if (!dataFile.exists()) return;
        try (InputStream in = new java.io.FileInputStream(dataFile)) {
            readState(new JSONObject(new String(readAll(in), StandardCharsets.UTF_8)), true);
        } catch (Exception e) {
            // Corrupt file: keep a copy and start fresh rather than refusing to run.
            dataFile.renameTo(new File(dataFile.getPath() + ".broken-" + System.currentTimeMillis()));
        }
    }

    /** Take a party save's contents; hostLevel: also its party id, GMs and device names. */
    private void readState(JSONObject data, boolean hostLevel) {
        characters = data.optJSONObject("characters") != null ? data.optJSONObject("characters") : new JSONObject();
        trades = data.optJSONArray("trades") != null ? data.optJSONArray("trades") : new JSONArray();
        shops = data.optJSONArray("shops") != null ? data.optJSONArray("shops") : new JSONArray();
        treasure = data.optJSONArray("treasure") != null ? data.optJSONArray("treasure") : new JSONArray();
        shows = data.optJSONArray("shows") != null ? data.optJSONArray("shows") : new JSONArray();
        discards = data.optJSONArray("discards") != null ? data.optJSONArray("discards") : new JSONArray();
        gm = data.optJSONObject("gm") != null ? data.optJSONObject("gm") : new JSONObject();
        campaign = data.optJSONObject("campaign");
        if (hostLevel) {
            partyId = data.optString("partyId", "");
            gms = data.optJSONArray("gms") != null ? data.optJSONArray("gms") : new JSONArray();
            devices = data.optJSONObject("devices") != null ? data.optJSONObject("devices") : new JSONObject();
        }
    }

    private void save() {
        try {
            JSONObject data = new JSONObject();
            data.put("characters", characters);
            data.put("trades", trades);
            data.put("shops", shops);
            data.put("treasure", treasure);
            data.put("shows", shows);
            data.put("discards", discards);
            data.put("gm", gm);
            data.put("partyId", partyId);
            data.put("gms", gms);
            data.put("devices", devices);
            if (campaign != null) data.put("campaign", campaign);
            dataFile.getParentFile().mkdirs();
            File tmp = new File(dataFile.getPath() + ".tmp");
            try (OutputStream out = new FileOutputStream(tmp)) {
                out.write(data.toString().getBytes(StandardCharsets.UTF_8));
            }
            if (!tmp.renameTo(dataFile)) throw new IOException("rename failed");
        } catch (Exception e) {
            android.util.Log.e("Mimic", "Could not save party", e);
        }
    }

    /** Call with `lock` held after mutating state. */
    private void changed(boolean persist) {
        version++;
        if (persist) save();
        lock.notifyAll();
    }

    private String newId(String prefix) {
        String chars = "abcdefghijklmnopqrstuvwxyz0123456789";
        StringBuilder sb = new StringBuilder(prefix).append(Long.toHexString(System.currentTimeMillis()));
        for (int i = 0; i < 8; i++) sb.append(chars.charAt(random.nextInt(chars.length())));
        return sb.toString();
    }

    // ------------------------------------------------------------------ roles (see role_of in server.py)

    private boolean isGmToken(String token) {
        for (int i = 0; i < gms.length(); i++) if (gms.optString(i).equals(token)) return true;
        return false;
    }

    /** "gm" for a device the host made a GM, and for the host while it hasn't made any; else "player". */
    private String roleOf(String token, boolean host) {
        if (!token.isEmpty() && isGmToken(token)) return "gm";
        return host && gms.length() == 0 ? "gm" : "player";
    }

    private boolean isGm(Request req, String token) { return roleOf(token, req.fromHostDevice()).equals("gm"); }

    /** Which GM device runs the campaign's world rules: the first GM connected, else the first GM (as server.py's world_runner). */
    private String worldRunner() {
        for (int i = 0; i < gms.length(); i++) { Integer n = online.get(gms.optString(i)); if (n != null && n > 0) return gms.optString(i); }
        return gms.length() > 0 ? gms.optString(0) : null;
    }

    static String deviceId(String token) {
        try {
            byte[] d = java.security.MessageDigest.getInstance("SHA-256").digest(("mimic-device:" + token).getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 8; i++) sb.append(String.format("%02x", d[i]));
            return sb.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Every device token the party knows: named devices, characters' owners and GMs. */
    private List<String> knownTokens() throws JSONException {
        java.util.LinkedHashSet<String> tokens = new java.util.LinkedHashSet<>();
        Iterator<String> it = devices.keys();
        while (it.hasNext()) tokens.add(it.next());
        it = characters.keys();
        while (it.hasNext()) tokens.add(characters.getJSONObject(it.next()).optString("owner"));
        for (int i = 0; i < gms.length(); i++) tokens.add(gms.optString(i));
        tokens.remove("");
        return new ArrayList<>(tokens);
    }

    /** The devices in the party, for the host: names, who's online, what they play, GM or not. Never tokens. */
    private JSONArray deviceList(String me) throws JSONException {
        JSONArray out = new JSONArray();
        for (String t : knownTokens()) {
            JSONObject d = new JSONObject();
            JSONObject named = devices.optJSONObject(t);
            String name = named == null ? "" : named.optString("name");
            d.put("id", deviceId(t));
            d.put("name", name.isEmpty() ? "Unnamed device" : name);
            Integer n = online.get(t);
            d.put("online", n != null && n > 0);
            JSONArray playing = new JSONArray();
            Iterator<String> it = characters.keys();
            while (it.hasNext()) {
                JSONObject c = characters.getJSONObject(it.next());
                if (c.optString("owner").equals(t)) playing.put(c.optString("name"));
            }
            d.put("characters", playing);
            d.put("gm", isGmToken(t));
            d.put("self", t.equals(me));
            out.put(d);
        }
        return out;
    }

    // ------------------------------------------------------------------ views

    private JSONObject publicChar(JSONObject c, String token) throws JSONException {
        JSONObject out = new JSONObject(c.toString());
        String owner = c.optString("owner");
        out.remove("owner");
        out.put("mine", owner.equals(token));
        Integer n = online.get(owner);
        out.put("online", n != null && n > 0);
        return out;
    }

    private JSONObject snapshot(String token, boolean host) throws JSONException {
        Set<String> mine = new HashSet<>();
        JSONArray chars = new JSONArray();
        Iterator<String> it = characters.keys();
        while (it.hasNext()) {
            String id = it.next();
            JSONObject c = characters.getJSONObject(id);
            if (c.optString("owner").equals(token)) mine.add(id);
            chars.put(publicChar(c, token));
        }
        JSONArray ts = new JSONArray();
        for (int i = 0; i < trades.length(); i++) {
            JSONObject t = trades.getJSONObject(i);
            boolean fromMine = mine.contains(t.optString("from")), toMine = mine.contains(t.optString("to"));
            if (!fromMine && !toMine) continue;
            JSONObject copy = new JSONObject(t.toString());
            copy.put("fromMine", fromMine);
            copy.put("toMine", toMine);
            ts.put(copy);
        }
        JSONObject snap = new JSONObject();
        snap.put("characters", chars);
        snap.put("trades", ts);
        JSONArray openShops = new JSONArray();
        for (int i = 0; i < shops.length(); i++) if (shopOpen(shops.getJSONObject(i))) openShops.put(publicShop(shops.getJSONObject(i)));
        snap.put("shops", openShops);
        snap.put("gm", new JSONObject(gm.toString()));
        snap.put("role", roleOf(token, host));
        // Treasure being shown: a GM sees every showing, a player the ones their characters are in.
        boolean gmView = roleOf(token, host).equals("gm");
        JSONArray shown = new JSONArray();
        for (int i = 0; i < treasure.length(); i++) {
            JSONObject t = treasure.getJSONObject(i);
            JSONArray ps = t.getJSONArray("players");
            boolean in = gmView;
            for (int j = 0; !in && j < ps.length(); j++) in = mine.contains(ps.optString(j));
            if (in) shown.put(t);
        }
        snap.put("treasure", shown);
        // Items shown: to the devices of those they're shown to (a GM's, when shown to the GM), and
        // to whoever showed them. Discarded items wait for a GM's device to take them.
        pruneShows();
        JSONArray myShows = new JSONArray();
        for (int i = 0; i < shows.length(); i++) {
            JSONObject s = shows.getJSONObject(i);
            JSONArray to = s.getJSONArray("to");
            boolean in = (gmView && s.optBoolean("gm")) || s.optString("by").equals(token);
            for (int j = 0; !in && j < to.length(); j++) in = mine.contains(to.optString(j));
            if (!in) continue;
            JSONObject copy = new JSONObject(s.toString());
            copy.put("fromMine", s.optString("by").equals(token));
            myShows.put(copy);
        }
        snap.put("shows", myShows);
        if (gmView) {
            snap.put("discards", new JSONArray(discards.toString()));
            // With no GMs chosen the host is the GM; else one GM device runs the world rules.
            snap.put("runsWorld", gms.length() > 0 ? token.equals(worldRunner()) : host);
        }
        snap.put("isHost", host);
        snap.put("campaign", campaign == null ? JSONObject.NULL : new JSONObject(campaign.toString()));
        snap.put("time", System.currentTimeMillis()); // the clock moving values follow
        if (host) snap.put("devices", deviceList(token));
        return snap;
    }

    static List<String> lanAddresses() {
        List<String> out = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && a.isSiteLocalAddress()) out.add(a.getHostAddress());
                }
            }
        } catch (Exception ignored) {}
        Collections.sort(out);
        return out;
    }

    // ------------------------------------------------------------------ trades

    static class TradeError extends Exception {
        private static final long serialVersionUID = 1L;
        TradeError(String m) { super(m); }
    }

    static class ApiError extends Exception {
        private static final long serialVersionUID = 1L;
        final int status;
        final JSONObject extra;
        ApiError(int status, String message) { this(status, message, null); }
        ApiError(int status, String message, JSONObject extra) {
            super(message);
            this.status = status;
            this.extra = extra;
        }
    }

    private static JSONObject findEntry(JSONObject ch, String uid) throws JSONException {
        JSONArray items = ch.getJSONArray("items");
        for (int i = 0; i < items.length(); i++) {
            JSONObject e = items.getJSONObject(i);
            if (e.optString("uid").equals(uid)) return e;
        }
        return null;
    }

    private static List<JSONObject> descendants(JSONObject ch, String uid) throws JSONException {
        List<JSONObject> out = new ArrayList<>();
        Set<String> frontier = new HashSet<>(Collections.singleton(uid));
        JSONArray items = ch.getJSONArray("items");
        while (!frontier.isEmpty()) {
            Set<String> next = new HashSet<>();
            for (int i = 0; i < items.length(); i++) {
                JSONObject e = items.getJSONObject(i);
                if (!e.isNull("parent") && frontier.contains(e.optString("parent"))) {
                    out.add(e);
                    next.add(e.optString("uid"));
                }
            }
            frontier = next;
        }
        return out;
    }

    private static int intOf(Object v) {
        if (v instanceof Number) return ((Number) v).intValue();
        try { return (int) Double.parseDouble(String.valueOf(v)); } catch (Exception e) { return 0; }
    }

    private JSONObject cleanSide(JSONObject ch, JSONObject side) throws JSONException, TradeError {
        if (side == null) side = new JSONObject();
        JSONArray items = new JSONArray();
        Set<String> uids = new HashSet<>();
        JSONArray in = side.optJSONArray("items");
        if (in != null) {
            for (int i = 0; i < in.length(); i++) {
                JSONObject it = in.getJSONObject(i);
                int qty = intOf(it.opt("qty"));
                JSONObject e = findEntry(ch, it.optString("uid"));
                if (qty <= 0 || e == null) throw new TradeError("An item in the offer no longer exists.");
                JSONObject clean = new JSONObject();
                clean.put("uid", e.getString("uid"));
                clean.put("qty", qty);
                String custom = e.isNull("customName") ? "" : e.optString("customName").trim(); // the player's name for it, if any
                clean.put("name", custom.isEmpty() ? e.getJSONObject("item").optString("name") : custom);
                items.put(clean);
                uids.add(e.getString("uid"));
            }
        }
        for (int i = 0; i < items.length(); i++) { // giving a container already gives everything in it
            JSONObject it = items.getJSONObject(i);
            for (JSONObject d : descendants(ch, it.getString("uid"))) {
                if (uids.contains(d.optString("uid"))) {
                    throw new TradeError("Don't list items that are inside " + it.getString("name") + " - they go with it.");
                }
            }
        }
        JSONObject coins = new JSONObject();
        JSONObject inCoins = side.optJSONObject("coins");
        for (String k : currency().keys) {
            int v = inCoins == null ? 0 : intOf(inCoins.opt(k));
            if (v < 0) throw new TradeError("Coin amounts can't be negative.");
            if (v > 0) coins.put(k, v);
        }
        JSONObject out = new JSONObject();
        out.put("items", items);
        out.put("coins", coins);
        return out;
    }

    private static void checkSide(JSONObject ch, JSONObject side) throws JSONException, TradeError {
        JSONArray items = side.getJSONArray("items");
        for (int i = 0; i < items.length(); i++) {
            JSONObject it = items.getJSONObject(i);
            JSONObject e = findEntry(ch, it.getString("uid"));
            if (e == null || e.optInt("qty") < it.getInt("qty")) {
                throw new TradeError(ch.optString("name") + " no longer has " + it.getInt("qty") + " x " + it.optString("name") + ".");
            }
        }
        JSONObject coins = side.getJSONObject("coins");
        JSONObject have = ch.optJSONObject("coins");
        Iterator<String> ks = coins.keys();
        while (ks.hasNext()) {
            String k = ks.next();
            if ((have == null ? 0 : have.optInt(k)) < coins.getInt(k)) {
                throw new TradeError(ch.optString("name") + " doesn't have " + coins.getInt(k) + " " + k + ".");
            }
        }
    }

    /** Structural equality for JSON values (key order and int/double differences don't matter). */
    static boolean jsonEquals(Object a, Object b) throws JSONException {
        if (a == null || a == JSONObject.NULL) return b == null || b == JSONObject.NULL;
        if (a instanceof JSONObject) {
            if (!(b instanceof JSONObject)) return false;
            JSONObject x = (JSONObject) a, y = (JSONObject) b;
            if (x.length() != y.length()) return false;
            Iterator<String> it = x.keys();
            while (it.hasNext()) {
                String k = it.next();
                if (!y.has(k) || !jsonEquals(x.get(k), y.get(k))) return false;
            }
            return true;
        }
        if (a instanceof JSONArray) {
            if (!(b instanceof JSONArray)) return false;
            JSONArray x = (JSONArray) a, y = (JSONArray) b;
            if (x.length() != y.length()) return false;
            for (int i = 0; i < x.length(); i++) if (!jsonEquals(x.get(i), y.get(i))) return false;
            return true;
        }
        if (a instanceof Number && b instanceof Number) return ((Number) a).doubleValue() == ((Number) b).doubleValue();
        return a.equals(b);
    }

    // ------------------------------------------------------------------ shops (same rules as server.py)

    /** payout() in server.py/store.js: mostly the largest change coins up to `top`, but `margin` % in the next smaller coin. */
    static long[] payout(Currency cur, long amount, int margin, int top) {
        long[] out = new long[cur.keys.length];
        int[] change = cur.change;
        int start = 0;
        while (change[start] != top) start++;
        long small = amount * margin / 100;
        long main = amount - small;
        int largest = change[change.length - 1];
        boolean found = false;
        for (int j = start; j < change.length; j++) {
            int i = change[j];
            out[i] = main / cur.values[i];
            main -= out[i] * cur.values[i];
            if (out[i] > 0 && !found) { largest = i; found = true; }
        }
        int from = 0;
        while (change[from] != largest) from++;
        from = Math.min(from + 1, change.length - 1); // the next smaller coin (the smallest stays itself)
        for (int j = from; j < change.length; j++) {
            int i = change[j];
            long n = small / cur.values[i];
            out[i] += n;
            small -= n * cur.values[i];
        }
        return out;
    }

    static long[] payout(long amount, int margin, int top) { return payout(DEFAULT_CURRENCY, amount, margin, top); }

    /** payCoins() from store.js: big coins first without overpaying, then break one coin; change comes as payout(margin). */
    static JSONObject payCoins(Currency cur, JSONObject coins, long cost, int margin) throws JSONException {
        int n = cur.keys.length;
        long[] c = new long[n];
        long total = 0;
        for (int i = 0; i < n; i++) {
            c[i] = coins == null ? 0 : coins.optLong(cur.keys[i]);
            total += c[i] * cur.values[i];
        }
        if (total < cost) return null;
        long remaining = cost;
        for (int i = 0; i < n; i++) {
            long k = Math.min(c[i], remaining / cur.values[i]);
            c[i] -= k;
            remaining -= k * cur.values[i];
        }
        if (remaining > 0) {
            int d = -1;
            for (int i = n - 1; i >= 0; i--) if (c[i] > 0 && cur.values[i] > remaining) { d = i; break; }
            c[d] -= 1;
            int top = cur.change[cur.change.length - 1];
            for (int i : cur.change) if (cur.values[i] < cur.values[d]) { top = i; break; }
            long[] change = payout(cur, cur.values[d] - remaining, margin, top);
            for (int i = 0; i < n; i++) c[i] += change[i];
        }
        JSONObject out = new JSONObject();
        for (int i = 0; i < n; i++) out.put(cur.keys[i], c[i]);
        return out;
    }

    static JSONObject payCoins(JSONObject coins, int cost, int margin) throws JSONException { return payCoins(DEFAULT_CURRENCY, coins, cost, margin); }

    // Shops can follow Global values (see shop_open etc. in server.py): open while a condition holds
    // (openIf), prices times a value (priceValue), an item for sale only while a condition holds (a
    // listing's onlyIf). A condition is {name, op, to}; an unset value counts as 0.
    static final java.util.regex.Pattern VALUE_NAME = java.util.regex.Pattern.compile("[A-Za-z][A-Za-z0-9_]{0,39}");
    static final List<String> COND_OPS = java.util.Arrays.asList("=", "!=", "<", "<=", ">", ">=");

    /** A condition on a Global value, checked, or null. */
    static JSONObject cleanCond(JSONObject raw) throws JSONException {
        if (raw == null || !(raw.opt("name") instanceof String) || !VALUE_NAME.matcher(raw.getString("name")).matches()) return null;
        if (!COND_OPS.contains(raw.optString("op"))) return null;
        Object to = raw.opt("to");
        if (!(to instanceof Number) || Double.isNaN(((Number) to).doubleValue()) || Double.isInfinite(((Number) to).doubleValue())) return null;
        JSONObject c = new JSONObject();
        c.put("name", raw.getString("name"));
        c.put("op", raw.getString("op"));
        c.put("to", to);
        return c;
    }

    /** A Global value (kept as the GM value gm_<name>), else dflt. */
    private Double globalValue(String name, Double dflt) {
        JSONObject p = gm.optJSONObject("party");
        Double v = valueNow(p == null ? null : p.opt("gm_" + name));
        return v != null ? v : dflt; // (boxed: dflt may be null)
    }

    /** The campaign's rules, values and controls (see clockwork_on in server.py). */
    private boolean clockworkOn() { return campaign == null || campaign.optBoolean("clockwork", true); }

    private boolean condHolds(JSONObject c) {
        if (c == null || !clockworkOn()) return true;
        double v = globalValue(c.optString("name"), 0.0), to = c.optDouble("to");
        switch (c.optString("op")) {
            case "=": return v == to;
            case "!=": return v != to;
            case "<": return v < to;
            case "<=": return v <= to;
            case ">": return v > to;
            default: return v >= to;
        }
    }

    /** Open by its condition if it has one, else as the GM set it. */
    private boolean shopOpen(JSONObject shop) {
        JSONObject c = shop.optJSONObject("openIf");
        return c != null && clockworkOn() ? condHolds(c) : shop.optBoolean("open");
    }

    /** What the shop's prices are multiplied by: its price value (1 while unset), from 0 to 100. */
    private double priceFactor(JSONObject shop) {
        String name = shop.isNull("priceValue") ? "" : shop.optString("priceValue");
        Double v = name.isEmpty() || !clockworkOn() ? null : globalValue(name, null);
        return v == null ? 1 : Math.max(0, Math.min(100, v));
    }

    private int listingPrice(JSONObject shop, JSONObject listing) { return listingPrice(shop, listing, priceFactor(shop)); }

    static int listingPrice(JSONObject shop, JSONObject listing, double factor) {
        double base = listing.isNull("price") ? listing.optJSONObject("item").optDouble("cost", 0) : listing.optDouble("price", 0);
        if (Double.isNaN(base)) base = 0;
        // In the same order as listingPrice() in the app and server.py, so the price shown is the price charged.
        return (int) Math.max(0, Math.round(base * (100 + shop.optInt("markup")) * factor / 100.0));
    }

    private JSONObject cleanShop(JSONObject raw) throws ApiError {
        if (raw == null) throw new ApiError(400, "Invalid shop");
        // Reject non-numbers rather than quietly treating them as 0 (matches server.py).
        if (raw.has("markup") && !raw.isNull("markup") && Double.isNaN(raw.optDouble("markup"))) throw new ApiError(400, "Invalid shop");
        try {
            JSONArray items = new JSONArray();
            JSONArray in = raw.optJSONArray("items");
            for (int i = 0; in != null && i < in.length() && i < 500; i++) {
                JSONObject li = in.optJSONObject(i);
                JSONObject it = li == null ? null : li.optJSONObject("item");
                if (it == null || it.optString("name").isEmpty() || it.optString("type").isEmpty()) continue;
                JSONObject out = new JSONObject();
                String lid = li.optString("lid");
                out.put("lid", lid.isEmpty() ? newId("l") : lid.substring(0, Math.min(40, lid.length())));
                String src = li.isNull("srcId") ? "" : li.optString("srcId");
                out.put("srcId", src.isEmpty() ? JSONObject.NULL : src);
                out.put("item", it);
                out.put("price", li.isNull("price") || "".equals(li.opt("price")) ? JSONObject.NULL : Math.max(0, li.getInt("price")));
                out.put("stock", li.isNull("stock") || "".equals(li.opt("stock")) ? JSONObject.NULL : Math.max(0, li.getInt("stock")));
                JSONObject onlyIf = cleanCond(li.optJSONObject("onlyIf"));
                if (onlyIf != null) out.put("onlyIf", onlyIf);
                items.put(out);
            }
            JSONObject shop = new JSONObject();
            shop.put("name", cut(raw.optString("name", "Shop"), 80));
            shop.put("keeper", cut(raw.optString("keeper"), 80));
            shop.put("description", cut(raw.optString("description"), 2000));
            String icon = raw.isNull("icon") ? "" : raw.optString("icon");
            shop.put("icon", icon.isEmpty() ? JSONObject.NULL : cut(icon, 40));
            shop.put("open", raw.optBoolean("open"));
            shop.put("markup", Math.max(-90, Math.min(500, raw.optInt("markup"))));
            shop.put("items", items);
            // Following Global values (see shopOpen, priceFactor)
            JSONObject openIf = cleanCond(raw.optJSONObject("openIf"));
            shop.put("openIf", openIf == null ? JSONObject.NULL : openIf);
            String pv = raw.isNull("priceValue") ? "" : raw.optString("priceValue");
            shop.put("priceValue", VALUE_NAME.matcher(pv).matches() ? pv : JSONObject.NULL);
            // Buying from players
            shop.put("buys", raw.optBoolean("buys"));
            shop.put("sellRate", raw.isNull("sellRate") || "".equals(raw.opt("sellRate")) ? 50 : Math.max(0, Math.min(1000, raw.getInt("sellRate"))));
            JSONObject rates = new JSONObject();
            JSONObject inRates = raw.optJSONObject("typeRates");
            if (inRates != null) {
                Iterator<String> it = inRates.keys();
                for (int n = 0; it.hasNext() && n < 40; n++) {
                    String k = it.next();
                    if (inRates.isNull(k) || "".equals(inRates.opt(k))) continue;
                    rates.put(cut(k, 20), Math.max(0, Math.min(1000, inRates.getInt(k))));
                }
            }
            shop.put("typeRates", rates);
            JSONArray rules = new JSONArray();
            JSONArray inRules = raw.optJSONArray("sellItems");
            for (int i = 0; inRules != null && i < inRules.length() && i < 300; i++) {
                JSONObject r = inRules.optJSONObject(i);
                if (r == null || r.optString("srcId").isEmpty()) continue;
                boolean fixed = "fixed".equals(r.optString("mode"));
                JSONObject out = new JSONObject();
                out.put("srcId", cut(r.getString("srcId"), 80));
                out.put("name", cut(r.optString("name"), 120));
                String ic = r.isNull("icon") ? "" : r.optString("icon");
                out.put("icon", ic.isEmpty() ? JSONObject.NULL : cut(ic, 40));
                out.put("type", cut(r.optString("type"), 20));
                out.put("mode", fixed ? "fixed" : "percent");
                out.put("value", Math.max(0, Math.min(fixed ? 100000000 : 1000, r.optInt("value"))));
                rules.put(out);
            }
            shop.put("sellItems", rules);
            // Money: one universal pot in copper; null = unlimited. Margin = % of payouts in smaller coins.
            if (raw.has("funds") && !raw.isNull("funds") && !"".equals(raw.opt("funds")) && Double.isNaN(raw.optDouble("funds"))) {
                throw new ApiError(400, "Invalid shop");
            }
            shop.put("funds", raw.isNull("funds") || "".equals(raw.opt("funds")) ? JSONObject.NULL : Math.max(0, raw.getLong("funds")));
            shop.put("changeMargin", raw.isNull("changeMargin") || "".equals(raw.opt("changeMargin")) ? 10 : Math.max(0, Math.min(50, raw.getInt("changeMargin"))));
            return shop;
        } catch (JSONException e) {
            throw new ApiError(400, "Invalid shop");
        }
    }

    private static String cut(String s, int n) { return s.length() > n ? s.substring(0, n) : s; }

    /** current_item() in server.py: an inventory item as it is now, with the layers of the states that are
     *  on (the entry's own, or the GM's override gm_state_<key>), in the system's order. */
    JSONObject currentItem(JSONObject entry, String charId) throws JSONException {
        JSONObject item = entry.optJSONObject("item");
        JSONObject layers = item == null ? null : item.optJSONObject("layers");
        if (layers == null || layers.length() == 0) return item;
        JSONObject own = new JSONObject();
        JSONObject o = entry.optJSONObject("states");
        if (o != null) {
            Iterator<String> it = o.keys();
            while (it.hasNext()) { String k = it.next(); own.put(k, o.optBoolean(k)); }
        }
        JSONObject items = gm.optJSONObject("items");
        JSONObject over = charId == null || items == null ? null : items.optJSONObject(charId + "/" + entry.optString("uid"));
        List<String> order = new ArrayList<>();
        JSONArray st = campaign == null ? null : campaign.optJSONArray("states");
        if (st != null) for (int i = 0; i < st.length(); i++) order.add(st.optString(i));
        else { Iterator<String> it = layers.keys(); while (it.hasNext()) order.add(it.next()); }
        JSONObject out = new JSONObject(item.toString());
        for (String k : order) {
            Object v = over == null ? null : over.opt("gm_state_" + k);
            boolean on = v instanceof Number ? ((Number) v).doubleValue() != 0 : own.optBoolean(k);
            JSONObject layer = layers.optJSONObject(k);
            if (!on || layer == null) continue;
            Iterator<String> it = layer.keys();
            while (it.hasNext()) {
                String f = it.next();
                Object x = layer.opt(f);
                if (f.equals("locks") || f.equals("features") || x == null || x == JSONObject.NULL || "".equals(x)) continue;
                out.put(f, x);
            }
        }
        return out;
    }

    /** sell_offer() in server.py: this item's rule, then its type's %, then the shop's default % (as it is now). */
    long sellOffer(JSONObject shop, JSONObject entry, int qty, String charId) throws JSONException {
        if (!shop.optBoolean("buys")) return 0;
        JSONObject item = currentItem(entry, charId);
        if (item == null) return 0;
        long bundle = Math.max(1, item.optInt("bundle", 1));
        JSONObject rule = null;
        JSONArray rules = shop.optJSONArray("sellItems");
        for (int i = 0; rules != null && i < rules.length(); i++) {
            if (rules.getJSONObject(i).optString("srcId").equals(entry.optString("srcId"))) { rule = rules.getJSONObject(i); break; }
        }
        if (rule != null && "fixed".equals(rule.optString("mode"))) return rule.optLong("value") * qty / bundle;
        long pct;
        if (rule != null) pct = rule.optLong("value");
        else {
            JSONObject rates = shop.optJSONObject("typeRates");
            String type = item.optString("type");
            pct = rates != null && rates.has(type) ? rates.optLong(type) : shop.optLong("sellRate", 50);
        }
        return (long) item.optDouble("cost", 0) * qty * pct / (bundle * 100);
    }

    /** receiveCoins() in store.js: add an amount in change coins (see payout). */
    static JSONObject receiveCoins(Currency cur, JSONObject coins, long amount, int margin) throws JSONException {
        JSONObject c = new JSONObject();
        long[] add = payout(cur, amount, margin, cur.change[0]);
        for (int i = 0; i < cur.keys.length; i++) c.put(cur.keys[i], (coins == null ? 0 : coins.optLong(cur.keys[i])) + add[i]);
        return c;
    }

    static JSONObject receiveCoins(JSONObject coins, long amount, int margin) throws JSONException { return receiveCoins(DEFAULT_CURRENCY, coins, amount, margin); }

    /** A shop as players see it: the stockroom is the host's business, and items only for sale
     *  while a value says so are left out while it doesn't. */
    private JSONObject publicShop(JSONObject shop) throws JSONException {
        JSONObject out = new JSONObject(shop.toString());
        out.remove("backroom");
        JSONArray items = new JSONArray(), all = out.optJSONArray("items");
        for (int i = 0; all != null && i < all.length(); i++) if (condHolds(all.getJSONObject(i).optJSONObject("onlyIf"))) items.put(all.get(i));
        out.put("items", items);
        return out;
    }

    /** Items bought from players go to the stockroom, stacking identical ones. */
    private void addToBackroom(JSONObject shop, JSONObject entry, int qty) throws JSONException {
        JSONObject item = new JSONObject(entry.getJSONObject("item").toString());
        if (shop.optJSONArray("backroom") == null) shop.put("backroom", new JSONArray());
        JSONArray room = shop.getJSONArray("backroom");
        String src = entry.isNull("srcId") ? "" : entry.optString("srcId");
        for (int i = 0; i < room.length(); i++) {
            JSONObject b = room.getJSONObject(i);
            String bs = b.isNull("srcId") ? "" : b.optString("srcId");
            if (bs.equals(src) && jsonEquals(b.getJSONObject("item"), item)) {
                b.put("qty", b.optInt("qty") + qty);
                return;
            }
        }
        JSONObject b = new JSONObject();
        b.put("bid", newId("b"));
        b.put("srcId", src.isEmpty() ? JSONObject.NULL : src);
        b.put("item", item);
        b.put("qty", qty);
        room.put(b);
    }

    private JSONObject shopEntry(JSONObject listing, int lots) throws JSONException {
        JSONObject item = new JSONObject(listing.getJSONObject("item").toString());
        JSONObject e = new JSONObject();
        e.put("uid", newId(""));
        e.put("srcId", listing.opt("srcId"));
        e.put("item", item);
        e.put("qty", Math.max(1, item.optInt("bundle", 1)) * lots);
        e.put("equipped", false);
        e.put("parent", JSONObject.NULL);
        e.put("notes", "");
        if (item.optInt("maxCharges") > 0) e.put("charges", item.optInt("maxCharges"));
        return e;
    }

    /** GM values: see gm_api() in server.py. POST /api/gm {scope, target, name, value|null}, GMs only. */
    private JSONObject gmApi(Request req, List<String> parts, String token) throws ApiError, JSONException {
        if (!req.method.equals("POST") || !parts.isEmpty()) throw new ApiError(404, "Unknown endpoint");
        JSONObject body = req.json();
        String scope = body.optString("scope"), target = body.isNull("target") ? "" : body.optString("target", ""), name = body.optString("name");
        boolean scopeOk = scope.equals("party") || scope.equals("character") || scope.equals("item");
        if (!scopeOk || !name.matches("gm_[A-Za-z0-9_]{1,40}") || target.length() > 200 || (!scope.equals("party") && target.isEmpty())) {
            throw new ApiError(400, "Not a GM value");
        }
        // A player sets the Locals of their own characters and their items, but not the GM's state
        // overrides or the values the campaign keeps for the GM (gmOnly: states' limits).
        if (!isGm(req, token)) {
            if (scope.equals("party")) throw new ApiError(403, "Only a GM can set Global values");
            synchronized (lock) {
                // Their own character, or an item of it (one just added may not have arrived yet, so
                // its id is checked for shape; how many items keep values is limited below).
                int slash = target.indexOf('/');
                String cid = slash < 0 ? target : target.substring(0, slash), uid = slash < 0 ? "" : target.substring(slash + 1);
                JSONObject c = characters.optJSONObject(cid);
                if (scope.equals("character") != uid.isEmpty() || (!uid.isEmpty() && !uid.matches("[A-Za-z0-9_-]{1,64}"))) throw new ApiError(400, "Not one of your characters' items");
                JSONArray gmOnly = campaign == null ? null : campaign.optJSONArray("gmOnly");
                boolean kept = false;
                for (int i = 0; gmOnly != null && i < gmOnly.length(); i++) if (name.equals(gmOnly.optString(i))) kept = true;
                if (c == null || !c.optString("owner").equals(token) || name.startsWith("gm_state_") || kept) {
                    throw new ApiError(403, "Only a GM can set that");
                }
            }
        }
        Object raw = body.opt("value");
        boolean clear = raw == null || raw == JSONObject.NULL;
        Object value = clear ? null : cleanValue(name, raw); // a number, or a moving value
        if (!clear && value == null) throw new ApiError(400, "GM values are numbers");
        synchronized (lock) {
            JSONObject group = null, bucket;
            if (scope.equals("party")) {
                bucket = gm.optJSONObject("party");
                if (bucket == null) { bucket = new JSONObject(); gm.put("party", bucket); }
            } else {
                String key = scope.equals("character") ? "characters" : "items";
                group = gm.optJSONObject(key);
                if (group == null) { group = new JSONObject(); gm.put(key, group); }
                if (scope.equals("item") && !group.has(target) && !clear) {
                    String prefix = target.substring(0, target.indexOf('/') + 1);
                    int n = 0;
                    for (Iterator<String> it = group.keys(); it.hasNext(); ) if (it.next().startsWith(prefix)) n++;
                    if (n >= MAX_VALUES) throw new ApiError(400, "Too many items with values");
                }
                bucket = group.optJSONObject(target);
                if (bucket == null) { bucket = new JSONObject(); group.put(target, bucket); }
            }
            if (clear) bucket.remove(name);
            else if (!bucket.has(name) && bucket.length() >= MAX_VALUES) throw new ApiError(400, "Too many values there");
            else bucket.put(name, value);
            if (group != null && bucket.length() == 0) group.remove(target);
            changed(true);
        }
        JSONObject r = new JSONObject();
        r.put("ok", true);
        return r;
    }

    /** See shops_api() in server.py for the endpoints. */
    private JSONObject shopsApi(Request req, List<String> parts, String token) throws ApiError, JSONException {
        boolean host = isGm(req, token); // "host" below: whoever runs the shops (a GM)
        JSONObject body = (req.method.equals("POST") || req.method.equals("PUT")) ? req.json() : new JSONObject();
        synchronized (lock) {
            if (req.method.equals("GET") && parts.isEmpty()) {
                JSONArray list = new JSONArray();
                for (int i = 0; i < shops.length(); i++) {
                    if (host) list.put(shops.get(i));
                    else if (shopOpen(shops.getJSONObject(i))) list.put(publicShop(shops.getJSONObject(i)));
                }
                JSONObject r = new JSONObject();
                r.put("shops", list);
                return r;
            }
            if (req.method.equals("POST") && parts.isEmpty()) {
                if (!host) throw new ApiError(403, "Only the host can set up shops");
                JSONObject shop = cleanShop(body.optJSONObject("shop"));
                shop.put("id", newId("s"));
                shop.put("rev", 1);
                shop.put("backroom", new JSONArray());
                shops.put(shop);
                changed(true);
                JSONObject r = new JSONObject();
                r.put("id", shop.getString("id"));
                r.put("rev", 1);
                return r;
            }
            int index = -1;
            for (int i = 0; i < shops.length() && !parts.isEmpty(); i++) if (shops.getJSONObject(i).optString("id").equals(parts.get(0))) index = i;
            if (index < 0) throw new ApiError(404, "No such shop");
            JSONObject shop = shops.getJSONObject(index);
            String action = parts.size() > 1 ? parts.get(1) : null;
            if (req.method.equals("PUT") && action == null) {
                if (!host) throw new ApiError(403, "Only the host can set up shops");
                if (!body.has("baseRev") || body.optLong("baseRev", -1) != shop.optLong("rev")) {
                    JSONObject extra = new JSONObject();
                    extra.put("shop", shop);
                    throw new ApiError(409, "The shop changed (someone may have bought something)", extra);
                }
                JSONObject next = cleanShop(body.optJSONObject("shop"));
                next.put("id", shop.getString("id"));
                next.put("rev", shop.optLong("rev") + 1);
                // The stockroom only changes through sales and the backroom actions.
                next.put("backroom", shop.optJSONArray("backroom") != null ? shop.getJSONArray("backroom") : new JSONArray());
                shops.put(index, next);
                changed(true);
                JSONObject r = new JSONObject();
                r.put("rev", next.getLong("rev"));
                return r;
            }
            if (req.method.equals("DELETE") && action == null) {
                if (!host) throw new ApiError(403, "Only the host can set up shops");
                shops.remove(index);
                changed(true);
                JSONObject r = new JSONObject();
                r.put("ok", true);
                return r;
            }
            if (req.method.equals("POST") && "sell".equals(action)) {
                if (!partyEnabled()) throw new ApiError(404, "No party is being hosted");
                if (!shopOpen(shop)) throw new ApiError(409, shop.optString("name") + " is closed");
                if (!shop.optBoolean("buys")) throw new ApiError(409, shop.optString("name") + " doesn't buy items");
                JSONObject c = characters.optJSONObject(body.optString("character"));
                if (c == null || !c.optString("owner").equals(token)) throw new ApiError(403, "You can only sell your own character's items");
                JSONObject entry = findEntry(c, body.optString("uid"));
                int qty = body.optInt("qty", 1);
                if (entry == null || qty < 1 || qty > entry.optInt("qty")) throw new ApiError(409, c.optString("name") + " doesn't have that many");
                JSONArray inv = c.getJSONArray("items");
                for (int i = 0; i < inv.length(); i++) {
                    JSONObject e = inv.getJSONObject(i);
                    // A deck sells with the cards still in it; anything else has to be emptied first.
                    if (!e.isNull("parent") && e.optString("parent").equals(entry.optString("uid")) && !e.getJSONObject("item").optBoolean("card")) {
                        throw new ApiError(409, "Empty the " + entry.getJSONObject("item").optString("name", "container") + " before selling it");
                    }
                }
                long paid = sellOffer(shop, entry, qty, c.optString("id", null));
                if (paid <= 0) throw new ApiError(409, shop.optString("name") + " won't buy " + entry.getJSONObject("item").optString("name", "that"));
                boolean limitedFunds = !shop.isNull("funds") && shop.has("funds");
                if (limitedFunds && shop.optLong("funds") < paid) throw new ApiError(409, shop.optString("name") + " can't afford that right now");
                addToBackroom(shop, entry, qty);
                if (limitedFunds) shop.put("funds", shop.optLong("funds") - paid);
                shop.put("rev", shop.optLong("rev") + 1);
                entry.put("qty", entry.optInt("qty") - qty);
                if (entry.optInt("qty") <= 0) {
                    JSONArray keep = new JSONArray();
                    for (int i = 0; i < inv.length(); i++) {
                        JSONObject x = inv.getJSONObject(i);
                        if (x != entry && !x.optString("parent").equals(entry.optString("uid"))) keep.put(x);
                    }
                    c.put("items", keep);
                }
                c.put("coins", receiveCoins(currency(), c.optJSONObject("coins"), paid, shop.optInt("changeMargin", 10)));
                c.put("rev", c.optLong("rev") + 1);
                changed(true);
                JSONObject r = new JSONObject();
                r.put("ok", true);
                r.put("paid", paid);
                return r;
            }
            if (req.method.equals("POST") && ("buy".equals(action) || "take".equals(action))) {
                JSONObject listing = null;
                JSONArray items = shop.getJSONArray("items");
                for (int i = 0; i < items.length(); i++) if (items.getJSONObject(i).optString("lid").equals(body.optString("lid"))) listing = items.getJSONObject(i);
                int lots = body.optInt("qty", 1);
                if (listing == null || lots < 1 || lots > 999) throw new ApiError(400, "That item isn't sold here");
                if (!condHolds(listing.optJSONObject("onlyIf"))) throw new ApiError(409, listing.getJSONObject("item").optString("name") + " isn't for sale right now");
                boolean limited = !listing.isNull("stock");
                if (limited && listing.getInt("stock") < lots) {
                    throw new ApiError(409, listing.getInt("stock") == 0 ? "Sold out" : "Only " + listing.getInt("stock") + " left");
                }
                if ("take".equals(action)) {
                    if (!host) throw new ApiError(403, "Only the host can do that");
                } else {
                    if (!partyEnabled()) throw new ApiError(404, "No party is being hosted");
                    if (!shopOpen(shop)) throw new ApiError(409, shop.optString("name") + " is closed");
                    JSONObject c = characters.optJSONObject(body.optString("character"));
                    if (c == null || !c.optString("owner").equals(token)) throw new ApiError(403, "You can only buy for your own character");
                    int total = listingPrice(shop, listing) * lots;
                    JSONObject purse = payCoins(currency(), c.optJSONObject("coins"), total, shop.optInt("changeMargin", 10));
                    if (purse == null) throw new ApiError(409, c.optString("name") + " can't afford that");
                    c.put("coins", purse);
                    mergeInto(c, shopEntry(listing, lots));
                    c.put("rev", c.optLong("rev") + 1);
                }
                if (limited) listing.put("stock", listing.getInt("stock") - lots);
                if (shop.has("funds") && !shop.isNull("funds")) shop.put("funds", shop.optLong("funds") + (long) listingPrice(shop, listing) * lots);
                shop.put("rev", shop.optLong("rev") + 1);
                changed(true);
                JSONObject r = new JSONObject();
                r.put("ok", true);
                r.put("shopRev", shop.getLong("rev"));
                return r;
            }
            if (req.method.equals("POST") && "receive".equals(action)) {
                // Host selling their own solo character's item: the shop pays and stocks it here.
                if (!host) throw new ApiError(403, "Only the host can do that");
                JSONObject item = body.optJSONObject("item");
                int qty = body.optInt("qty", 0);
                if (item == null || item.optString("name").isEmpty() || item.optString("type").isEmpty() || qty < 1 || qty > 100000) {
                    throw new ApiError(400, "Invalid item");
                }
                JSONObject entry = new JSONObject();
                String src = body.isNull("srcId") ? "" : cut(body.optString("srcId"), 80);
                entry.put("srcId", src.isEmpty() ? JSONObject.NULL : src);
                entry.put("item", item);
                long paid = sellOffer(shop, entry, qty, null);
                if (paid <= 0) throw new ApiError(409, shop.optString("name") + " won't buy " + item.optString("name"));
                boolean limitedFunds = shop.has("funds") && !shop.isNull("funds");
                if (limitedFunds && shop.optLong("funds") < paid) throw new ApiError(409, shop.optString("name") + " can't afford that right now");
                addToBackroom(shop, entry, qty);
                if (limitedFunds) shop.put("funds", shop.optLong("funds") - paid);
                shop.put("rev", shop.optLong("rev") + 1);
                changed(true);
                JSONObject r = new JSONObject();
                r.put("ok", true);
                r.put("paid", paid);
                return r;
            }
            if (req.method.equals("POST") && "backroom".equals(action)) {
                // Host: put stockroom items on the shelves, or throw them out.
                if (!host) throw new ApiError(403, "Only the host can do that");
                JSONArray room = shop.optJSONArray("backroom");
                int bi = -1;
                for (int i = 0; room != null && i < room.length(); i++) if (room.getJSONObject(i).optString("bid").equals(body.optString("bid"))) bi = i;
                if (bi < 0) throw new ApiError(404, "That item isn't in the stockroom");
                JSONObject b = room.getJSONObject(bi);
                int bundle = Math.max(1, b.getJSONObject("item").optInt("bundle", 1));
                int qty = body.optInt("qty", 0);
                String act = body.optString("action");
                if ("shelve".equals(act)) {
                    if (qty < 1 || (long) qty * bundle > b.optInt("qty")) throw new ApiError(409, "Not that many in the stockroom");
                    JSONObject same = null;
                    JSONArray items = shop.getJSONArray("items");
                    String src = b.isNull("srcId") ? "" : b.optString("srcId");
                    for (int i = 0; i < items.length(); i++) {
                        JSONObject li = items.getJSONObject(i);
                        String ls = li.isNull("srcId") ? "" : li.optString("srcId");
                        if (ls.equals(src) && jsonEquals(li.getJSONObject("item"), b.getJSONObject("item"))) same = li;
                    }
                    if (same != null) {
                        if (!same.isNull("stock")) same.put("stock", same.getInt("stock") + qty);
                    } else {
                        JSONObject li = new JSONObject();
                        li.put("lid", newId("l"));
                        li.put("srcId", src.isEmpty() ? JSONObject.NULL : src);
                        li.put("item", new JSONObject(b.getJSONObject("item").toString()));
                        li.put("price", body.isNull("price") || "".equals(body.opt("price")) ? JSONObject.NULL : Math.max(0, body.optInt("price")));
                        li.put("stock", qty);
                        items.put(li);
                    }
                    b.put("qty", b.optInt("qty") - qty * bundle);
                } else if ("discard".equals(act)) {
                    if (qty < 1 || qty > b.optInt("qty")) throw new ApiError(409, "Not that many in the stockroom");
                    b.put("qty", b.optInt("qty") - qty);
                } else {
                    throw new ApiError(400, "Unknown stockroom action");
                }
                if (b.optInt("qty") <= 0) room.remove(bi);
                shop.put("rev", shop.optLong("rev") + 1);
                changed(true);
                JSONObject r = new JSONObject();
                r.put("ok", true);
                r.put("shopRev", shop.getLong("rev"));
                return r;
            }
        }
        throw new ApiError(404, "Unknown endpoint");
    }

    // ------------------------------------------------------------ treasure (see treasure_api in server.py)
    // The GM shows a hoard to some players; they pick, press Ready; then the uncontested picks are
    // given out and the GM settles the contested ones. A pick's key is "e:<uid>" or "c:<coin>".

    private static int treasureAvailable(JSONObject t, String key) throws JSONException {
        if (key.startsWith("c:")) return t.getJSONObject("coins").optInt(key.substring(2));
        JSONObject e = treasureEntry(t, key.substring(2));
        return e == null ? 0 : e.optInt("qty");
    }

    private static JSONObject treasureEntry(JSONObject t, String uid) throws JSONException {
        JSONArray items = t.getJSONArray("items");
        for (int i = 0; i < items.length(); i++) if (items.getJSONObject(i).optString("uid").equals(uid)) return items.getJSONObject(i);
        return null;
    }

    private static List<String> treasureContested(JSONObject t) throws JSONException {
        List<String> out = new ArrayList<>();
        JSONObject picks = t.getJSONObject("picks");
        for (Iterator<String> it = picks.keys(); it.hasNext(); ) {
            String k = it.next();
            JSONObject p = picks.getJSONObject(k);
            int sum = 0;
            for (Iterator<String> c = p.keys(); c.hasNext(); ) sum += p.optInt(c.next());
            if (sum > treasureAvailable(t, k)) out.add(k);
        }
        return out;
    }

    private static int treasureDepth(JSONObject t, JSONObject e) throws JSONException {
        int d = 0;
        Set<String> seen = new HashSet<>();
        while (e != null && !e.isNull("parent") && !e.optString("parent").isEmpty() && seen.add(e.optString("uid"))) {
            e = treasureEntry(t, e.optString("parent"));
            d++;
        }
        return d;
    }

    private static boolean isPiece(JSONObject x) {
        JSONObject it = x.optJSONObject("item");
        return it != null && it.optBoolean("card");
    }
    private static String parentOf(JSONObject x) { return x.isNull("parent") ? "" : x.optString("parent"); }

    /** Give out {charId: {key: qty}}: into the characters, out of the showing (see treasure_give). */
    private void treasureGive(JSONObject t, Map<String, Map<String, Integer>> alloc) throws JSONException {
        Map<String, Integer> taken = new HashMap<>();
        JSONArray items = t.getJSONArray("items");
        JSONObject coinsLeft = t.getJSONObject("coins");
        for (Map.Entry<String, Map<String, Integer>> a : alloc.entrySet()) {
            JSONObject c = characters.optJSONObject(a.getKey());
            if (c == null) continue;
            Map<String, Integer> keys = a.getValue();
            Map<String, String> newUid = new HashMap<>();
            List<String> got = new ArrayList<>();
            List<JSONObject> picked = new ArrayList<>();
            for (int i = 0; i < items.length(); i++) if (keys.containsKey("e:" + items.getJSONObject(i).optString("uid"))) picked.add(items.getJSONObject(i));
            final JSONObject tt = t;
            picked.sort((x, y) -> { try { return treasureDepth(tt, x) - treasureDepth(tt, y); } catch (JSONException ex) { return 0; } });
            Set<String> pickedUids = new HashSet<>();
            for (JSONObject e : picked) pickedUids.add(e.optString("uid"));
            for (JSONObject e : picked) {
                String uid = e.optString("uid");
                int q = Math.min(keys.get("e:" + uid), e.optInt("qty"));
                String parent = newUid.get(parentOf(e));
                JSONObject entry = new JSONObject(e.toString());
                entry.put("uid", newId(""));
                entry.put("qty", q);
                entry.put("parent", parent == null ? JSONObject.NULL : parent);
                if (parent == null) entry.remove("compartment");
                entry.put("equipped", false);
                entry.put("seen", JSONObject.NULL);
                addHistory(entry, "From " + t.optString("name") + " (treasure)");
                newUid.put(uid, entry.getString("uid"));
                List<JSONObject> pieces = new ArrayList<>();
                boolean kids = false;
                for (int i = 0; i < items.length(); i++) {
                    JSONObject x = items.getJSONObject(i);
                    if (!parentOf(x).equals(uid)) continue;
                    if (isPiece(x)) pieces.add(x);
                    if (pickedUids.contains(x.optString("uid"))) kids = true;
                }
                if (parent == null && pieces.isEmpty() && !kids) mergeInto(c, entry);
                else c.getJSONArray("items").put(entry);
                for (JSONObject p : pieces) {
                    JSONObject piece = new JSONObject(p.toString());
                    piece.put("uid", newId(""));
                    piece.put("parent", entry.getString("uid"));
                    piece.put("fromDeck", entry.getString("uid"));
                    piece.put("seen", JSONObject.NULL);
                    c.getJSONArray("items").put(piece);
                }
                String name = e.getJSONObject("item").optString("name", "item");
                got.add(q > 1 ? q + " × " + name : name);
                taken.put(uid, taken.getOrDefault(uid, 0) + q);
            }
            JSONObject coins = c.optJSONObject("coins") != null ? new JSONObject(c.getJSONObject("coins").toString()) : new JSONObject();
            for (Map.Entry<String, Integer> k : keys.entrySet()) {
                if (!k.getKey().startsWith("c:") || k.getValue() <= 0) continue;
                String coin = k.getKey().substring(2);
                coins.put(coin, coins.optInt(coin) + k.getValue());
                coinsLeft.put(coin, Math.max(0, coinsLeft.optInt(coin) - k.getValue()));
                got.add(k.getValue() + " " + coin);
            }
            c.put("coins", coins);
            c.put("rev", c.optLong("rev") + 1);
            if (!got.isEmpty()) {
                JSONObject g = new JSONObject();
                g.put("character", a.getKey());
                g.put("name", c.optString("name"));
                g.put("items", new JSONArray(got));
                t.getJSONArray("given").put(g);
            }
        }
        // What's left: fewer of what was taken; a taken container's contents fall out of it.
        Set<String> gone = new HashSet<>();
        for (int i = 0; i < items.length(); i++) {
            JSONObject e = items.getJSONObject(i);
            Integer q = taken.get(e.optString("uid"));
            if (q == null) continue;
            e.put("qty", e.optInt("qty") - q);
            if (e.optInt("qty") <= 0) gone.add(e.optString("uid"));
        }
        Set<String> pieces = new HashSet<>();
        for (int i = 0; i < items.length(); i++) if (gone.contains(parentOf(items.getJSONObject(i))) && isPiece(items.getJSONObject(i))) pieces.add(items.getJSONObject(i).optString("uid"));
        gone.addAll(pieces);
        JSONArray left = new JSONArray();
        for (int i = 0; i < items.length(); i++) {
            JSONObject x = items.getJSONObject(i);
            if (gone.contains(x.optString("uid"))) continue;
            if (gone.contains(parentOf(x))) { x.put("parent", JSONObject.NULL); x.remove("compartment"); }
            left.put(x);
        }
        t.put("items", left);
        JSONObject coins = new JSONObject();
        for (Iterator<String> it = coinsLeft.keys(); it.hasNext(); ) { String k = it.next(); if (coinsLeft.optInt(k) > 0) coins.put(k, coinsLeft.optInt(k)); }
        t.put("coins", coins);
    }

    /** Everyone's ready (or the GM says so): give out what isn't contested; the GM settles the rest. */
    private void treasureSettle(JSONObject t) throws JSONException {
        List<String> contested = treasureContested(t);
        Map<String, Map<String, Integer>> alloc = new HashMap<>();
        JSONObject picks = t.getJSONObject("picks"), still = new JSONObject();
        for (Iterator<String> it = picks.keys(); it.hasNext(); ) {
            String key = it.next();
            JSONObject p = picks.getJSONObject(key);
            if (contested.contains(key)) { still.put(key, p); continue; }
            for (Iterator<String> c = p.keys(); c.hasNext(); ) {
                String cid = c.next();
                if (p.optInt(cid) > 0) alloc.computeIfAbsent(cid, x -> new HashMap<>()).put(key, p.optInt(cid));
            }
        }
        treasureGive(t, alloc);
        t.put("picks", still);
        t.put("status", still.length() > 0 ? "settling" : "done");
    }

    private JSONArray cleanTreasureItems(JSONArray raw) throws JSONException {
        JSONArray items = new JSONArray();
        Set<String> uids = new HashSet<>();
        for (int i = 0; raw != null && i < raw.length() && i < 3000; i++) {
            JSONObject e = raw.optJSONObject(i);
            JSONObject it = e == null ? null : e.optJSONObject("item");
            if (it == null || it.optString("name").isEmpty()) continue;
            JSONObject x = new JSONObject(e.toString());
            String uid = e.optString("uid");
            x.put("uid", uid.isEmpty() ? newId("") : cut(uid, 40));
            x.put("qty", Math.max(1, e.optInt("qty", 1)));
            x.put("parent", parentOf(e).isEmpty() ? JSONObject.NULL : cut(parentOf(e), 40));
            uids.add(x.getString("uid"));
            items.put(x);
        }
        for (int i = 0; i < items.length(); i++) {
            JSONObject x = items.getJSONObject(i);
            if (!x.isNull("parent") && !uids.contains(x.getString("parent"))) { x.put("parent", JSONObject.NULL); x.remove("compartment"); }
        }
        return items;
    }

    // ------------------------------------------------------------ showing and discarding (see show_api in server.py)

    /** A line in an item's history (where it came from): its last 20 kept. */
    private static void addHistory(JSONObject e, String text) throws JSONException {
        JSONArray past = e.optJSONArray("history"), out = new JSONArray();
        int from = past == null ? 0 : Math.max(0, past.length() - 19);
        for (int i = from; past != null && i < past.length(); i++) if (past.optJSONObject(i) != null) out.put(past.getJSONObject(i));
        JSONObject line = new JSONObject();
        line.put("at", System.currentTimeMillis());
        line.put("text", cut(text, 160));
        out.put(line);
        e.put("history", out);
    }

    private static final long SHOW_TTL_MS = 2L * 60 * 60 * 1000;
    // (Kept in memory and in the party's save: a player can't fill them up.)
    private static final int SHOW_MAX_BYTES = 300_000, SHOWS_PER_DEVICE = 20, DISCARD_MAX_BYTES = 1_000_000, DISCARDS_PER_CHARACTER = 50;

    /** Shows go once everyone they're shown to has seen them, or after two hours. */
    private void pruneShows() throws JSONException {
        long cutoff = System.currentTimeMillis() - SHOW_TTL_MS;
        JSONArray keep = new JSONArray();
        for (int i = 0; i < shows.length(); i++) {
            JSONObject s = shows.getJSONObject(i);
            if (s.optLong("at") > cutoff && !seenByAll(s)) keep.put(s);
        }
        shows = keep;
    }

    private static boolean seenByAll(JSONObject s) throws JSONException {
        Set<String> seen = new HashSet<>();
        JSONArray sn = s.getJSONArray("seen"), to = s.getJSONArray("to");
        for (int i = 0; i < sn.length(); i++) seen.add(sn.optString(i));
        for (int i = 0; i < to.length(); i++) if (!seen.contains(to.optString(i))) return false;
        return !s.optBoolean("gm") || seen.contains("gm");
    }

    private JSONObject showApi(Request req, List<String> parts, String token) throws ApiError, JSONException {
        boolean isGm = isGm(req, token);
        JSONObject body = req.method.equals("POST") ? req.json() : new JSONObject();
        synchronized (lock) {
            JSONObject r = new JSONObject();
            if (req.method.equals("POST") && parts.isEmpty()) {
                if (!partyEnabled()) throw new ApiError(404, "No party is being hosted");
                String from = body.optString("from", "");
                JSONObject c = from.isEmpty() ? null : characters.optJSONObject(from);
                if (!from.isEmpty() && (c == null || !c.optString("owner").equals(token))) throw new ApiError(403, "You can only show your own characters' things");
                if (from.isEmpty() && !isGm) throw new ApiError(403, "Show it from one of your characters");
                JSONArray one = new JSONArray();
                if (body.optJSONObject("item") != null) one.put(body.getJSONObject("item"));
                JSONArray items = cleanTreasureItems(one);
                if (items.length() == 0) throw new ApiError(400, "Nothing to show");
                JSONArray to = new JSONArray(), in = body.optJSONArray("to");
                for (int i = 0; in != null && i < in.length() && to.length() < 30; i++) {
                    String id = in.optString(i);
                    if (characters.has(id) && !id.equals(from)) to.put(id);
                }
                boolean toGm = body.optBoolean("gm");
                if (to.length() == 0 && !toGm) throw new ApiError(400, "Choose who to show it to");
                int mine = 0;
                for (int i = 0; i < shows.length(); i++) if (shows.getJSONObject(i).optString("by").equals(token)) mine++;
                if (shows.length() >= 200 || mine >= SHOWS_PER_DEVICE) throw new ApiError(429, "Too much is being shown: try again once it's been seen");
                JSONArray contents = cleanTreasureItems(body.optJSONArray("contents")), kept = new JSONArray();
                for (int i = 0; i < contents.length() && i < 200; i++) kept.put(contents.get(i));
                JSONObject s = new JSONObject();
                s.put("id", newId("s"));
                s.put("by", token);
                s.put("from", from);
                s.put("fromName", c != null ? c.optString("name") : "The GM");
                s.put("item", items.get(0));
                s.put("contents", kept);
                s.put("to", to);
                s.put("gm", toGm);
                s.put("seen", new JSONArray());
                s.put("at", System.currentTimeMillis());
                if (s.toString().length() > SHOW_MAX_BYTES) throw new ApiError(413, "That's too big to show");
                shows.put(s);
                changed(true);
                r.put("id", s.getString("id"));
                return r;
            }
            JSONObject s = null;
            int at = -1;
            for (int i = 0; !parts.isEmpty() && i < shows.length(); i++) if (shows.getJSONObject(i).optString("id").equals(parts.get(0))) { s = shows.getJSONObject(i); at = i; }
            if (s == null) throw new ApiError(404, "That isn't being shown any more");
            String action = parts.size() > 1 ? parts.get(1) : null;
            if (req.method.equals("DELETE") && action == null) {
                if (!s.optString("by").equals(token) && !isGm) throw new ApiError(403, "Only whoever showed it can take it back");
                shows.remove(at);
                changed(true);
                r.put("ok", true);
                return r;
            }
            if (req.method.equals("POST") && "seen".equals(action)) {
                String who = body.optString("character", "");
                if (who.equals("gm")) {
                    if (!(isGm && s.optBoolean("gm"))) throw new ApiError(403, "That wasn't shown to you");
                } else {
                    JSONObject c = characters.optJSONObject(who);
                    boolean to = false;
                    JSONArray ts = s.getJSONArray("to");
                    for (int i = 0; i < ts.length(); i++) to |= ts.optString(i).equals(who);
                    if (c == null || !c.optString("owner").equals(token) || !to) throw new ApiError(403, "That wasn't shown to you");
                }
                JSONArray seen = s.getJSONArray("seen");
                boolean already = false;
                for (int i = 0; i < seen.length(); i++) already |= seen.optString(i).equals(who);
                if (!already) seen.put(who);
                pruneShows();
                changed(true);
                r.put("ok", true);
                return r;
            }
            throw new ApiError(404, "Unknown endpoint");
        }
    }

    private JSONObject discardApi(Request req, List<String> parts, String token) throws ApiError, JSONException {
        synchronized (lock) {
            JSONObject r = new JSONObject();
            if (req.method.equals("POST") && parts.isEmpty()) {
                JSONObject body = req.json();
                String cid = body.optString("character", "");
                JSONObject c = characters.optJSONObject(cid);
                if (c == null || !c.optString("owner").equals(token)) throw new ApiError(403, "You can only discard your own characters' things");
                JSONArray items = cleanTreasureItems(body.optJSONArray("items")), kept = new JSONArray();
                for (int i = 0; i < items.length() && i < 500; i++) kept.put(items.get(i));
                if (kept.length() == 0) throw new ApiError(400, "Nothing to discard");
                int theirs = 0;
                for (int i = 0; i < discards.length(); i++) if (discards.getJSONObject(i).optString("character").equals(cid)) theirs++;
                if (discards.length() >= 500 || theirs >= DISCARDS_PER_CHARACTER) throw new ApiError(429, "The GM has a lot waiting: try again once they've taken it");
                JSONObject d = new JSONObject();
                d.put("id", newId("d"));
                d.put("character", cid);
                d.put("name", c.optString("name"));
                d.put("items", kept);
                d.put("at", System.currentTimeMillis());
                if (d.toString().length() > DISCARD_MAX_BYTES) throw new ApiError(413, "That's too big to discard in one go");
                discards.put(d);
                changed(true);
                r.put("id", d.getString("id"));
                return r;
            }
            if (req.method.equals("DELETE") && parts.size() == 1) {
                if (!isGm(req, token)) throw new ApiError(403, "Only a GM can do that");
                JSONArray keep = new JSONArray();
                for (int i = 0; i < discards.length(); i++) if (!discards.getJSONObject(i).optString("id").equals(parts.get(0))) keep.put(discards.get(i));
                discards = keep;
                changed(true);
                r.put("ok", true);
                return r;
            }
            throw new ApiError(404, "Unknown endpoint");
        }
    }

    private JSONObject treasureApi(Request req, List<String> parts, String token) throws ApiError, JSONException {
        boolean isGm = isGm(req, token);
        JSONObject body = req.method.equals("POST") ? req.json() : new JSONObject();
        synchronized (lock) {
            JSONObject r = new JSONObject();
            if (req.method.equals("POST") && parts.isEmpty()) {
                if (!isGm) throw new ApiError(403, "Only a GM can show treasure");
                if (!partyEnabled()) throw new ApiError(404, "No party is being hosted");
                JSONArray players = new JSONArray(), in = body.optJSONArray("players");
                for (int i = 0; in != null && i < in.length() && players.length() < 30; i++) if (characters.has(in.optString(i))) players.put(in.optString(i));
                if (players.length() == 0) throw new ApiError(400, "Choose who to show it to");
                JSONObject coins = new JSONObject(), inCoins = body.optJSONObject("coins");
                for (Iterator<String> it = inCoins == null ? java.util.Collections.<String>emptyIterator() : inCoins.keys(); it.hasNext(); ) {
                    String k = it.next();
                    Object n = inCoins.opt(k);
                    if (n instanceof Integer || n instanceof Long) { long v = ((Number) n).longValue(); if (v > 0) coins.put(cut(k, 10), Math.min(v, 1000000000L)); }
                }
                JSONObject t = new JSONObject();
                t.put("id", newId("t"));
                t.put("name", cut(body.optString("name", "Treasure"), 80));
                t.put("hoard", cut(body.optString("hoard"), 40));
                t.put("items", cleanTreasureItems(body.optJSONArray("items")));
                t.put("coins", coins);
                t.put("players", players);
                t.put("picks", new JSONObject());
                t.put("ready", new JSONArray());
                t.put("status", "picking");
                t.put("given", new JSONArray());
                treasure.put(t);
                changed(true);
                r.put("id", t.getString("id"));
                return r;
            }
            JSONObject t = null;
            int at = -1;
            for (int i = 0; !parts.isEmpty() && i < treasure.length(); i++) if (treasure.getJSONObject(i).optString("id").equals(parts.get(0))) { t = treasure.getJSONObject(i); at = i; }
            if (t == null) throw new ApiError(404, "That treasure isn't being shown");
            String action = parts.size() > 1 ? parts.get(1) : null;
            if (req.method.equals("DELETE") && action == null) {
                if (!isGm) throw new ApiError(403, "Only a GM can do that");
                treasure.remove(at);
                changed(true);
                r.put("ok", true);
                return r;
            }
            if (!req.method.equals("POST")) throw new ApiError(404, "Unknown endpoint");
            if ("pick".equals(action) || "ready".equals(action)) {
                String cid = body.optString("character");
                JSONObject c = characters.optJSONObject(cid);
                if (c == null || !c.optString("owner").equals(token)) throw new ApiError(403, "You can only pick for your own character");
                if (!jsonHas(t.getJSONArray("players"), cid)) throw new ApiError(403, c.optString("name") + " isn't sharing this treasure");
                if (!t.optString("status").equals("picking")) throw new ApiError(409, "The picking is over");
                JSONArray ready = t.getJSONArray("ready");
                if ("pick".equals(action)) {
                    String key = body.optString("key");
                    int qty = body.optInt("qty", -1);
                    int avail = (key.startsWith("e:") || key.startsWith("c:")) ? treasureAvailable(t, key) : 0;
                    if (avail == 0 || qty < 0 || qty > avail) throw new ApiError(400, "There isn't that much");
                    JSONObject picks = t.getJSONObject("picks");
                    JSONObject p = picks.optJSONObject(key);
                    if (p == null) { p = new JSONObject(); picks.put(key, p); }
                    if (qty > 0) p.put(cid, qty);
                    else { p.remove(cid); if (p.length() == 0) picks.remove(key); }
                    jsonRemove(ready, cid); // changed their mind: not ready any more
                } else {
                    if (body.optBoolean("ready")) { if (!jsonHas(ready, cid)) ready.put(cid); }
                    else jsonRemove(ready, cid);
                    boolean all = true;
                    JSONArray players = t.getJSONArray("players");
                    for (int i = 0; i < players.length(); i++) if (!jsonHas(ready, players.getString(i))) all = false;
                    if (all) treasureSettle(t);
                }
                changed(true);
                r.put("ok", true);
                r.put("status", t.getString("status"));
                return r;
            }
            if (!isGm) throw new ApiError(403, "Only a GM can do that");
            if ("settle".equals(action)) {
                String key = body.optString("key");
                JSONObject give = body.optJSONObject("give");
                if (!t.getJSONObject("picks").has(key) || !t.optString("status").equals("settling") || give == null) throw new ApiError(400, "That isn't waiting to be settled");
                Map<String, Map<String, Integer>> alloc = new HashMap<>();
                int sum = 0;
                for (Iterator<String> it = give.keys(); it.hasNext(); ) {
                    String cid = it.next();
                    Object q = give.opt(cid);
                    if (!jsonHas(t.getJSONArray("players"), cid) || !(q instanceof Integer || q instanceof Long) || ((Number) q).intValue() <= 0) continue;
                    Map<String, Integer> m = new HashMap<>();
                    m.put(key, ((Number) q).intValue());
                    alloc.put(cid, m);
                    sum += ((Number) q).intValue();
                }
                if (sum > treasureAvailable(t, key)) throw new ApiError(400, "There isn't that much");
                treasureGive(t, alloc);
                t.getJSONObject("picks").remove(key);
                if (t.getJSONObject("picks").length() == 0) t.put("status", "done");
                changed(true);
                r.put("ok", true);
                r.put("status", t.getString("status"));
                return r;
            }
            if ("end".equals(action)) {
                if (body.optBoolean("settle")) { if (t.optString("status").equals("picking")) treasureSettle(t); }
                else { t.put("picks", new JSONObject()); t.put("status", "done"); }
                changed(true);
                r.put("ok", true);
                r.put("status", t.getString("status"));
                return r;
            }
            throw new ApiError(404, "Unknown endpoint");
        }
    }

    private static boolean jsonHas(JSONArray a, String v) {
        for (int i = 0; i < a.length(); i++) if (v.equals(a.optString(i))) return true;
        return false;
    }
    private static void jsonRemove(JSONArray a, String v) {
        for (int i = a.length() - 1; i >= 0; i--) if (v.equals(a.optString(i))) a.remove(i);
    }

    private static void mergeInto(JSONObject dst, JSONObject entry) throws JSONException {
        JSONObject item = entry.getJSONObject("item");
        JSONArray items = dst.getJSONArray("items");
        JSONObject features = item.optJSONObject("features");
        boolean separate = features != null && (features.optBoolean("holds") || features.optBoolean("pack"));
        // Decks keep their own cards; anything made a container or pack stays separate too. The app
        // marks what doesn't stack (noStack).
        if (!NON_STACKING.contains(item.optString("type")) && !item.optBoolean("noStack") && item.optJSONArray("deckCards") == null && !separate) {
            for (int i = 0; i < items.length(); i++) {
                JSONObject x = items.getJSONObject(i);
                if (x.isNull("parent") && x.optString("srcId").equals(entry.optString("srcId"))
                        && jsonEquals(x.getJSONObject("item"), item) && x.optString("customName").equals(entry.optString("customName"))) {
                    x.put("qty", x.optInt("qty") + entry.optInt("qty"));
                    return;
                }
            }
        }
        items.put(entry);
    }

    private static void makeLoose(JSONObject e) throws JSONException {
        e.put("parent", JSONObject.NULL);
        e.remove("compartment");
        e.put("equipped", false);
        e.put("states", new JSONObject()); // the game system's states (attuned…) are off
        e.put("seen", JSONObject.NULL); // new to its receiver: its "acquired" triggers fire there
    }

    // An item's Local values (js/clockwork.js) go with it to its new owner: an abacus keeps its
    // count. Moved with the whole item (and what's in it); copied for part of a stack (partUid).
    private void carryValues(JSONObject src, JSONObject dst, Collection<String> uids, String partUid) throws JSONException {
        JSONObject items = gm.optJSONObject("items");
        if (items == null) return;
        for (String uid : uids) {
            String key = src.optString("id") + "/" + uid;
            JSONObject v = items.optJSONObject(key);
            if (v == null) continue;
            if (partUid != null) items.put(dst.optString("id") + "/" + partUid, new JSONObject(v.toString()));
            else {
                items.remove(key);
                items.put(dst.optString("id") + "/" + uid, v);
            }
        }
    }

    private void transfer(JSONObject src, JSONObject dst, String uid, int qty) throws JSONException {
        JSONObject e = findEntry(src, uid);
        if (qty >= e.optInt("qty")) {
            List<JSONObject> kids = descendants(src, uid);
            Set<String> moving = new HashSet<>(Collections.singleton(uid));
            for (JSONObject k : kids) moving.add(k.optString("uid"));
            JSONArray keep = new JSONArray();
            JSONArray items = src.getJSONArray("items");
            for (int i = 0; i < items.length(); i++) {
                JSONObject x = items.getJSONObject(i);
                if (!moving.contains(x.optString("uid"))) keep.put(x);
            }
            src.put("items", keep);
            carryValues(src, dst, moving, null);
            makeLoose(e);
            addHistory(e, "From " + src.optString("name", "someone") + ", in a trade");
            for (JSONObject k : kids) {
                k.put("equipped", false);
                k.put("states", new JSONObject());
                k.put("seen", JSONObject.NULL);
            }
            if (kids.isEmpty()) mergeInto(dst, e);
            else dst.getJSONArray("items").put(e);
            for (JSONObject k : kids) dst.getJSONArray("items").put(k);
        } else {
            e.put("qty", e.optInt("qty") - qty);
            JSONObject part = new JSONObject(e.toString());
            makeLoose(part);
            addHistory(part, "From " + src.optString("name", "someone") + ", in a trade");
            part.put("uid", newId(""));
            part.put("qty", qty);
            carryValues(src, dst, Collections.singletonList(uid), part.optString("uid"));
            mergeInto(dst, part);
        }
    }

    private static void moveCoins(JSONObject src, JSONObject dst, JSONObject coins) throws JSONException {
        if (src.optJSONObject("coins") == null) src.put("coins", new JSONObject());
        if (dst.optJSONObject("coins") == null) dst.put("coins", new JSONObject());
        Iterator<String> ks = coins.keys();
        while (ks.hasNext()) {
            String k = ks.next();
            int v = coins.getInt(k);
            src.getJSONObject("coins").put(k, src.getJSONObject("coins").optInt(k) - v);
            dst.getJSONObject("coins").put(k, dst.getJSONObject("coins").optInt(k) + v);
        }
    }

    private void execute(JSONObject trade) throws JSONException, TradeError {
        JSONObject a = characters.optJSONObject(trade.getString("from"));
        JSONObject b = characters.optJSONObject(trade.getString("to"));
        if (a == null || b == null) throw new TradeError("One of the characters has left the party.");
        JSONObject give = trade.getJSONObject("give"), ask = trade.getJSONObject("ask");
        checkSide(a, give);
        checkSide(b, ask);
        JSONArray gi = give.getJSONArray("items"), ai = ask.getJSONArray("items");
        for (int i = 0; i < gi.length(); i++) transfer(a, b, gi.getJSONObject(i).getString("uid"), gi.getJSONObject(i).getInt("qty"));
        for (int i = 0; i < ai.length(); i++) transfer(b, a, ai.getJSONObject(i).getString("uid"), ai.getJSONObject(i).getInt("qty"));
        moveCoins(a, b, give.getJSONObject("coins"));
        moveCoins(b, a, ask.getJSONObject("coins"));
        a.put("rev", a.optLong("rev") + 1);
        b.put("rev", b.optLong("rev") + 1);
    }

    private void resolve(JSONObject trade, String status, String reason) throws JSONException {
        trade.put("status", status);
        trade.put("resolved", System.currentTimeMillis() / 1000.0);
        if (reason != null) trade.put("reason", reason);
        JSONArray pending = new JSONArray();
        List<JSONObject> done = new ArrayList<>();
        for (int i = 0; i < trades.length(); i++) {
            JSONObject t = trades.getJSONObject(i);
            if ("pending".equals(t.optString("status"))) pending.put(t); else done.add(t);
        }
        for (int i = Math.max(0, done.size() - KEEP_RESOLVED_TRADES); i < done.size(); i++) pending.put(done.get(i));
        trades = pending;
    }

    // ------------------------------------------------------------------ HTTP

    static class Request {
        String method, path, query = "";
        Map<String, String> headers = new HashMap<>();
        byte[] body = new byte[0];
        boolean fromApp;
        InetAddress remote;

        /** From this device (the host curates shops): the app's own listener, loopback (IPv4 or IPv6) or its own address. */
        boolean fromHostDevice() {
            return fromApp || (ownPage() && remote != null && (remote.isLoopbackAddress() || lanAddresses().contains(remote.getHostAddress())));
        }

        /** Not sent by some other web page (see own_page in server.py): the host's rights go by where
         *  a request comes from, so a website open on this phone could otherwise use them. */
        boolean ownPage() {
            String site = headers.get("sec-fetch-site");
            if (site != null && !site.equals("same-origin") && !site.equals("none")) return false;
            String origin = headers.get("origin");
            return origin == null || origin.equals("http://" + headers.getOrDefault("host", ""));
        }

        String token() {
            String t = headers.get("x-player");
            if (t != null && !t.isEmpty()) return t;
            for (String kv : query.split("&")) {
                if (kv.startsWith("player=")) {
                    try { return URLDecoder.decode(kv.substring(7), "UTF-8"); } catch (Exception ignored) {}
                }
            }
            return "";
        }

        JSONObject json() throws ApiError {
            try {
                String s = new String(body, StandardCharsets.UTF_8).trim();
                return s.isEmpty() ? new JSONObject() : new JSONObject(s);
            } catch (JSONException e) {
                throw new ApiError(400, "Invalid JSON");
            }
        }
    }

    private void handle(Socket socket, boolean fromApp) {
        try (Socket s = socket) {
            s.setSoTimeout(60000);
            InputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = new BufferedOutputStream(s.getOutputStream());
            String line = readLine(in);
            if (line == null || line.isEmpty()) return;
            String[] parts = line.split(" ");
            if (parts.length < 2) return;
            Request req = new Request();
            req.fromApp = fromApp; // (checked against other web pages once the headers are in: ownPage)
            req.remote = s.getInetAddress();
            req.method = parts[0].toUpperCase();
            String target = parts[1];
            int q = target.indexOf('?');
            req.path = q >= 0 ? target.substring(0, q) : target;
            if (q >= 0) req.query = target.substring(q + 1);
            String h;
            while ((h = readLine(in)) != null && !h.isEmpty()) {
                int c = h.indexOf(':');
                if (c > 0) req.headers.put(h.substring(0, c).trim().toLowerCase(), h.substring(c + 1).trim());
            }
            req.fromApp = fromApp && req.ownPage();
            int len = 0;
            try { len = Integer.parseInt(req.headers.getOrDefault("content-length", "0")); } catch (NumberFormatException ignored) {}
            if (len > MAX_BODY) {
                reply(out, 413, error("Request too large", null));
                return;
            }
            if (len > 0) {
                req.body = new byte[len];
                int read = 0;
                while (read < len) {
                    int n = in.read(req.body, read, len - read);
                    if (n < 0) break;
                    read += n;
                }
            }
            CORS.set(corsHeaders(req));
            if (req.path.startsWith("/api/") && req.method.equals("OPTIONS")) preflight(req, out);
            else if (req.path.startsWith("/api/")) api(req, out);
            else if (req.method.equals("GET") || req.method.equals("HEAD")) serveStatic(req, out);
            else send(out, 405, "text/plain", "Method not allowed".getBytes(StandardCharsets.UTF_8), null);
            out.flush();
        } catch (IOException ignored) {
            // client went away (phone asleep, page closed...)
        }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int b;
        while ((b = in.read()) != -1) {
            if (b == '\n') break;
            if (b != '\r') buf.write(b);
            if (buf.size() > 16384) throw new IOException("header too long");
        }
        if (b == -1 && buf.size() == 0) return null;
        return new String(buf.toByteArray(), StandardCharsets.ISO_8859_1);
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[16384];
        int n;
        while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
        return buf.toByteArray();
    }

    private static String reason(int status) {
        switch (status) {
            case 200: return "OK";
            case 400: return "Bad Request";
            case 401: return "Unauthorized";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 409: return "Conflict";
            case 413: return "Payload Too Large";
            default: return "Error";
        }
    }

    // ------------------------------------------------------------------ cross-origin (the apps join from their own page)

    /** CORS headers for the request this connection's thread is answering (see corsHeaders). */
    private static final ThreadLocal<Map<String, String>> CORS = new ThreadLocal<>();
    private static final String[] APP_ONLY = {"/api/local", "/api/presence", "/api/host", "/api/quit"};

    /** The party API answers pages from this device or the home network, never public websites;
     *  the app's private endpoints (its saved data, hosting, quitting) never do. */
    static Map<String, String> corsHeaders(Request req) {
        Map<String, String> h = new HashMap<>();
        if (req.path.equals("/api/info")) { h.put("Access-Control-Allow-Origin", "*"); return h; }
        if (!req.path.startsWith("/api/")) return h;
        for (String p : APP_ONLY) if (req.path.startsWith(p)) return h;
        String origin = req.headers.getOrDefault("origin", "");
        boolean local = origin.equals("null"); // a page opened from a file
        if (!local && !origin.isEmpty()) {
            try {
                String host = java.net.URI.create(origin).getHost();
                if (host != null) {
                    host = host.replace("[", "").replace("]", "");
                    local = host.equals("localhost") || host.equals("::1") || host.endsWith(".local")
                            || host.matches("(127|10)\\..*|192\\.168\\..*|172\\.(1[6-9]|2\\d|3[01])\\..*");
                }
            } catch (IllegalArgumentException ignored) {}
        }
        if (local) { h.put("Access-Control-Allow-Origin", origin); h.put("Vary", "Origin"); }
        return h;
    }

    /** CORS preflight for the party API. */
    private static void preflight(Request req, OutputStream out) throws IOException {
        Map<String, String> h = new HashMap<>();
        if (CORS.get() != null && CORS.get().containsKey("Access-Control-Allow-Origin")) {
            h.put("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
            h.put("Access-Control-Allow-Headers", "Content-Type, X-Player");
            h.put("Access-Control-Max-Age", "600");
            if (req.headers.containsKey("access-control-request-private-network")) h.put("Access-Control-Allow-Private-Network", "true");
        }
        send(out, 204, "text/plain", new byte[0], h);
    }

    private static String corsLines() {
        StringBuilder sb = new StringBuilder();
        if (CORS.get() != null) for (Map.Entry<String, String> e : CORS.get().entrySet()) sb.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
        return sb.toString();
    }

    private static void send(OutputStream out, int status, String type, byte[] body, Map<String, String> extra) throws IOException {
        StringBuilder sb = new StringBuilder();
        sb.append("HTTP/1.0 ").append(status).append(' ').append(reason(status)).append("\r\n");
        sb.append("Content-Type: ").append(type).append("\r\n");
        sb.append("Content-Length: ").append(body.length).append("\r\n");
        sb.append("Cache-Control: no-cache\r\n");
        sb.append("Connection: close\r\n");
        Map<String, String> all = new HashMap<>();
        if (CORS.get() != null) all.putAll(CORS.get());
        if (extra != null) all.putAll(extra);
        for (Map.Entry<String, String> e : all.entrySet()) sb.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
        sb.append("\r\n");
        out.write(sb.toString().getBytes(StandardCharsets.ISO_8859_1));
        out.write(body);
    }

    private static void reply(OutputStream out, int status, JSONObject data) throws IOException {
        send(out, status, "application/json; charset=utf-8", data.toString().getBytes(StandardCharsets.UTF_8), null);
    }

    private static JSONObject error(String message, JSONObject extra) {
        JSONObject o = new JSONObject();
        try {
            if (extra != null) {
                Iterator<String> it = extra.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    o.put(k, extra.get(k));
                }
            }
            o.put("error", message);
        } catch (JSONException ignored) {}
        return o;
    }

    private void serveStatic(Request req, OutputStream out) throws IOException {
        String path = req.path.equals("/") ? "/index.html" : req.path;
        boolean allowed = false;
        for (String p : STATIC_PREFIXES) if (path.startsWith(p)) allowed = true;
        if (!allowed || path.contains("..")) {
            send(out, 404, "text/plain", "Not found".getBytes(StandardCharsets.UTF_8), null);
            return;
        }
        byte[] body;
        try (InputStream in = assets.open("www" + URLDecoder.decode(path, "UTF-8"))) {
            body = readAll(in);
        } catch (IOException e) {
            send(out, 404, "text/plain", "Not found".getBytes(StandardCharsets.UTF_8), null);
            return;
        }
        if (req.method.equals("HEAD")) {
            send(out, 200, contentType(path), new byte[0], null);
            return;
        }
        send(out, 200, contentType(path), body, null);
    }

    private static String contentType(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html; charset=utf-8";
        if (p.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (p.endsWith(".css")) return "text/css; charset=utf-8";
        if (p.endsWith(".json")) return "application/json; charset=utf-8";
        if (p.endsWith(".webmanifest")) return "application/manifest+json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".txt")) return "text/plain; charset=utf-8";
        return "application/octet-stream";
    }

    // ------------------------------------------------------------------ API

    private void api(Request req, OutputStream out) throws IOException {
        try {
            String token = req.token();
            // Document images load via <img>, which can't send the player header.
            boolean openImage = req.method.equals("GET") && req.path.startsWith("/api/images/");
            boolean shopPath = req.path.startsWith("/api/shops");
            boolean localPath = req.path.startsWith("/api/local"); // the phone's own data: app only, no player token
            if (token.isEmpty() && !openImage && !shopPath && !localPath && !Arrays.asList(NO_TOKEN).contains(req.path)) throw new ApiError(401, "Missing player token");
            List<String> parts = new ArrayList<>();
            for (String p : req.path.substring("/api/".length()).split("/")) if (!p.isEmpty()) parts.add(p);
            JSONObject result = route(req, parts, token, out);
            if (result != null) reply(out, 200, result);
        } catch (ApiError e) {
            reply(out, e.status, error(e.getMessage(), e.extra));
        } catch (TradeError e) {
            reply(out, 409, error(e.getMessage(), null));
        } catch (JSONException e) {
            reply(out, 400, error("Bad data: " + e.getMessage(), null));
        }
    }

    private JSONObject route(Request req, List<String> parts, String token, OutputStream out)
            throws ApiError, TradeError, JSONException, IOException {
        String m = req.method;
        String p0 = parts.isEmpty() ? "" : parts.get(0);

        if (m.equals("GET") && parts.equals(Collections.singletonList("info"))) {
            JSONObject info = new JSONObject();
            info.put("party", partyEnabled());
            info.put("desktop", true); // same role as the Windows app: this device can host
            info.put("android", true);
            info.put("isHost", req.fromApp);
            info.put("localStore", req.fromApp);
            info.put("hosting", partyEnabled());
            info.put("addresses", new JSONArray(lanAddresses()));
            info.put("port", lanPort > 0 ? lanPort : JSONObject.NULL);
            info.put("defaultPort", lanPort > 0 ? lanPort : DEFAULT_LAN_PORT);
            info.put("canManageShops", req.fromHostDevice());
            info.put("partyId", partyId);
            return info; // readable from any page (see corsHeaders): apps check an address before joining
        }
        if (p0.equals("shops")) return shopsApi(req, parts.subList(1, parts.size()), token);
        if (p0.equals("gm")) return gmApi(req, parts.subList(1, parts.size()), token);
        if (p0.equals("treasure")) return treasureApi(req, parts.subList(1, parts.size()), token);
        if (p0.equals("show")) return showApi(req, parts.subList(1, parts.size()), token);
        if (p0.equals("discard")) return discardApi(req, parts.subList(1, parts.size()), token);
        if (p0.equals("presence") || p0.equals("host") || p0.equals("quit")) {
            if (!req.fromApp) throw new ApiError(403, "Only the app on the hosting device can do that");
            if (m.equals("GET") && p0.equals("presence")) {
                presenceStream(out);
                return null;
            }
            if (m.equals("POST") && p0.equals("host")) {
                JSONObject body = req.json();
                if (body.optBoolean("enable")) {
                    int port = body.optInt("port", DEFAULT_LAN_PORT);
                    if (port < 1024 || port > 65535) throw new ApiError(400, "Pick a port between 1024 and 65535");
                    try {
                        startLan(port);
                    } catch (IOException e) {
                        throw new ApiError(409, "Port " + port + " is already in use - try another one");
                    }
                } else {
                    stopLan();
                }
                JSONObject r = new JSONObject();
                r.put("hosting", partyEnabled());
                return r;
            }
            if (m.equals("POST") && p0.equals("quit")) {
                stopLan();
                Listener l = listener;
                if (l != null) l.onQuit();
                JSONObject r = new JSONObject();
                r.put("ok", true);
                return r;
            }
        }
        // The phone's own data works whether or not a party is running.
        if (p0.equals("local")) return localApi(req, parts, out);
        if (!partyEnabled()) throw new ApiError(404, "No party is being hosted");
        if (p0.equals("images")) return images(req, parts, out, new File(dataDir, "images"), false);

        if (m.equals("POST") && p0.equals("gm-role") && parts.size() == 1) return gmRoleApi(req);
        if (m.equals("POST") && p0.equals("campaign") && parts.size() == 1) return campaignApi(req, token);

        if (m.equals("GET") && p0.equals("events") && parts.size() == 1) {
            eventStream(req, token, out);
            return null;
        }
        if (m.equals("POST") && p0.equals("leave") && parts.size() == 1) {
            // Leave party: close this player's live connection now, so they show as away at once.
            synchronized (lock) {
                Integer n = online.get(token);
                if (n != null && n > 0) {
                    leaving.add(token);
                    lock.notifyAll();
                }
            }
            JSONObject r = new JSONObject();
            r.put("ok", true);
            return r;
        }
        if (m.equals("GET") && p0.equals("state") && parts.size() == 1) {
            synchronized (lock) { return snapshot(token, req.fromHostDevice()); }
        }

        if (p0.equals("characters")) {
            JSONObject body = (m.equals("POST") || m.equals("PUT")) ? req.json() : new JSONObject();
            synchronized (lock) {
                if (m.equals("POST") && parts.size() == 1) {
                    JSONObject c = body.optJSONObject("character");
                    if (c == null || c.optJSONArray("items") == null || c.optString("name").isEmpty()) throw new ApiError(400, "Invalid character");
                    String cid = c.optString("id");
                    if (cid.isEmpty() || characters.has(cid)) cid = newId("c");
                    c.put("id", cid);
                    c.put("owner", token);
                    c.put("rev", 1);
                    characters.put(cid, c);
                    changed(true);
                    JSONObject r = new JSONObject();
                    r.put("id", cid);
                    r.put("rev", 1);
                    return r;
                }
                JSONObject c = parts.size() > 1 ? characters.optJSONObject(parts.get(1)) : null;
                if (c == null) throw new ApiError(404, "No such character");
                if (m.equals("POST") && parts.size() == 3 && parts.get(2).equals("claim")) {
                    String owner = c.optString("owner");
                    Integer n = online.get(owner);
                    if (!owner.equals(token) && n != null && n > 0) {
                        throw new ApiError(409, c.optString("name") + " is being played on another device right now.");
                    }
                    c.put("owner", token);
                    c.put("rev", c.optLong("rev") + 1);
                    changed(true);
                    JSONObject r = new JSONObject();
                    r.put("rev", c.getLong("rev"));
                    return r;
                }
                if (m.equals("POST") && parts.size() == 3 && parts.get(2).equals("remove")) {
                    // The host clears out a player who has left: only while they're not connected.
                    if (!req.fromHostDevice()) throw new ApiError(403, "Only the host can remove players");
                    Integer n = online.get(c.optString("owner"));
                    if (n != null && n > 0) {
                        throw new ApiError(409, c.optString("name") + " is connected right now. Players can only be removed while they're away.");
                    }
                    String id = c.getString("id");
                    characters.remove(id);
                    for (int i = 0; i < trades.length(); i++) {
                        JSONObject t = trades.getJSONObject(i);
                        if ("pending".equals(t.optString("status")) && (id.equals(t.optString("from")) || id.equals(t.optString("to")))) {
                            resolve(t, "cancelled", c.optString("name") + " was removed from the party.");
                            i = -1; // resolve() rebuilt the list
                        }
                    }
                    changed(true);
                    JSONObject r = new JSONObject();
                    r.put("ok", true);
                    return r;
                }
                if (!c.optString("owner").equals(token)) throw new ApiError(403, "That character belongs to someone else.");
                if (m.equals("PUT") && parts.size() == 2) {
                    if (!body.has("baseRev") || body.optLong("baseRev", -1) != c.optLong("rev")) {
                        JSONObject extra = new JSONObject();
                        extra.put("character", publicChar(c, token));
                        throw new ApiError(409, "Out of date", extra);
                    }
                    JSONObject nc = body.optJSONObject("character");
                    if (nc == null || nc.optJSONArray("items") == null) throw new ApiError(400, "Invalid character");
                    nc.put("id", c.getString("id"));
                    nc.put("owner", token);
                    nc.put("rev", c.optLong("rev") + 1);
                    characters.put(c.getString("id"), nc);
                    changed(true);
                    JSONObject r = new JSONObject();
                    r.put("rev", nc.getLong("rev"));
                    return r;
                }
                if (m.equals("DELETE") && parts.size() == 2) {
                    String id = c.getString("id");
                    characters.remove(id);
                    for (int i = 0; i < trades.length(); i++) {
                        JSONObject t = trades.getJSONObject(i);
                        if ("pending".equals(t.optString("status")) && (id.equals(t.optString("from")) || id.equals(t.optString("to")))) {
                            resolve(t, "cancelled", c.optString("name") + " left the party.");
                            i = -1; // resolve() rebuilt the list
                        }
                    }
                    changed(true);
                    JSONObject r = new JSONObject();
                    r.put("ok", true);
                    return r;
                }
            }
        }

        if (p0.equals("trades")) {
            JSONObject body = m.equals("POST") ? req.json() : new JSONObject();
            synchronized (lock) {
                if (m.equals("POST") && parts.size() == 1) {
                    JSONObject a = characters.optJSONObject(body.optString("from"));
                    JSONObject b = characters.optJSONObject(body.optString("to"));
                    if (a == null || !a.optString("owner").equals(token)) throw new ApiError(403, "You can only trade from your own character.");
                    if (b == null || b == a) throw new ApiError(400, "Pick someone else to trade with.");
                    JSONObject give = cleanSide(a, body.optJSONObject("give"));
                    JSONObject ask = cleanSide(b, body.optJSONObject("ask"));
                    if (give.getJSONArray("items").length() == 0 && give.getJSONObject("coins").length() == 0
                            && ask.getJSONArray("items").length() == 0 && ask.getJSONObject("coins").length() == 0) {
                        throw new ApiError(400, "The offer is empty.");
                    }
                    checkSide(a, give);
                    JSONObject trade = new JSONObject();
                    trade.put("id", newId("t"));
                    trade.put("from", a.getString("id"));
                    trade.put("to", b.getString("id"));
                    trade.put("fromName", a.optString("name"));
                    trade.put("toName", b.optString("name"));
                    trade.put("give", give);
                    trade.put("ask", ask);
                    String note = body.optString("note", "");
                    trade.put("note", note.length() > 500 ? note.substring(0, 500) : note);
                    trade.put("status", "pending");
                    trade.put("created", System.currentTimeMillis() / 1000.0);
                    JSONArray next = new JSONArray();
                    next.put(trade);
                    for (int i = 0; i < trades.length(); i++) next.put(trades.get(i));
                    trades = next;
                    changed(true);
                    JSONObject r = new JSONObject();
                    r.put("id", trade.getString("id"));
                    return r;
                }
                JSONObject trade = null;
                if (parts.size() == 3) {
                    for (int i = 0; i < trades.length(); i++) {
                        if (trades.getJSONObject(i).optString("id").equals(parts.get(1))) trade = trades.getJSONObject(i);
                    }
                }
                if (trade == null || !m.equals("POST")) throw new ApiError(404, "No such trade");
                if (!"pending".equals(trade.optString("status"))) throw new ApiError(409, "That trade is already closed.");
                String action = parts.get(2);
                String side = action.equals("cancel") ? "from" : "to";
                JSONObject sideChar = characters.optJSONObject(trade.optString(side));
                String owner = sideChar == null ? null : sideChar.optString("owner");
                if (!token.equals(owner) || !Arrays.asList("accept", "decline", "cancel").contains(action)) {
                    throw new ApiError(403, "Not your trade to " + action);
                }
                if (action.equals("accept")) {
                    try {
                        execute(trade);
                    } catch (TradeError e) {
                        resolve(trade, "failed", e.getMessage());
                        changed(true);
                        throw e;
                    }
                    resolve(trade, "accepted", null);
                } else {
                    resolve(trade, action.equals("decline") ? "declined" : "cancelled", null);
                }
                changed(true);
                JSONObject r = new JSONObject();
                r.put("ok", true);
                return r;
            }
        }
        throw new ApiError(404, "Unknown endpoint");
    }

    // ------------------------------------------------------------------ document images

    /** The data really is the image type it claims (checks the file signature). */
    static boolean imageBytesMatch(byte[] b, String mime) {
        switch (mime) {
            case "image/png": return b.length > 8 && (b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G';
            case "image/jpeg": return b.length > 3 && (b[0] & 0xff) == 0xff && (b[1] & 0xff) == 0xd8 && (b[2] & 0xff) == 0xff;
            case "image/gif": return b.length > 6 && b[0] == 'G' && b[1] == 'I' && b[2] == 'F' && b[3] == '8';
            case "image/webp": return b.length > 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F'
                    && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P';
            default: return false;
        }
    }

    /** Images used in documents: the party's (party-data/images) or this phone's own (my-data/images), as <id>.<ext>. */
    private JSONObject images(Request req, List<String> parts, OutputStream out, File folder, boolean own) throws ApiError, IOException {
        if (req.method.equals("POST") && parts.size() == 1) {
            JSONObject body = req.json();
            String id = body.optString("id"), data = body.optString("data");
            java.util.regex.Matcher m = DATA_URL.matcher(data);
            String ext = null;
            if (m.matches()) for (String[] t : IMAGE_TYPES) if (t[0].equals(m.group(1))) ext = t[1];
            if (!IMAGE_ID.matcher(id).matches() || ext == null) throw new ApiError(400, "Not a supported image");
            byte[] raw;
            try {
                raw = Base64.decode(m.group(2), Base64.DEFAULT);
            } catch (IllegalArgumentException e) {
                throw new ApiError(400, "Not a supported image");
            }
            if (raw.length > MAX_IMAGE_BYTES) throw new ApiError(413, "Image is too large");
            if (!imageBytesMatch(raw, m.group(1))) throw new ApiError(400, "Not a supported image");
            folder.mkdirs();
            synchronized (lock) { // first upload wins; ids are random per image
                boolean exists = false;
                for (String[] t : IMAGE_TYPES) if (new File(folder, id + "." + t[1]).exists()) exists = true;
                if (!exists) {
                    try (OutputStream f = new FileOutputStream(new File(folder, id + "." + ext))) { f.write(raw); }
                }
            }
            JSONObject r = new JSONObject();
            try { r.put("ok", true); } catch (JSONException ignored) {}
            return r;
        }
        if (req.method.equals("GET") && parts.size() == 2 && IMAGE_ID.matcher(parts.get(1)).matches()) {
            for (String[] t : IMAGE_TYPES) {
                File f = new File(folder, parts.get(1) + "." + t[1]);
                if (f.exists()) {
                    byte[] raw;
                    try (InputStream in = new java.io.FileInputStream(f)) { raw = readAll(in); }
                    Map<String, String> extra = new HashMap<>();
                    extra.put("X-Content-Type-Options", "nosniff");
                    send(out, 200, t[0], raw, extra);
                    return null;
                }
            }
            throw new ApiError(404, "No such image");
        }
        // This phone's own pictures can also be listed and deleted (Settings → Files); the party's can't.
        if (own && req.method.equals("GET") && parts.size() == 1) {
            JSONArray list = new JSONArray();
            File[] files = folder.listFiles();
            if (files != null) {
                Arrays.sort(files);
                for (File f : files) {
                    String[] bits = f.getName().split("\\.", 2);
                    if (bits.length == 2 && IMAGE_ID.matcher(bits[0]).matches()) {
                        try { list.put(new JSONObject().put("id", bits[0]).put("bytes", f.length())); } catch (JSONException ignored) {}
                    }
                }
            }
            try { return new JSONObject().put("images", list); } catch (JSONException e) { throw new IOException(e); }
        }
        if (own && req.method.equals("DELETE") && parts.size() == 2 && IMAGE_ID.matcher(parts.get(1)).matches()) {
            synchronized (lock) {
                for (String[] t : IMAGE_TYPES) new File(folder, parts.get(1) + "." + t[1]).delete();
            }
            try { return new JSONObject().put("ok", true); } catch (JSONException e) { throw new IOException(e); }
        }
        throw new ApiError(404, "Unknown endpoint");
    }

    // ------------------------------------------------------------------ GMs and campaigns

    /** POST /api/gm-role {device, gm}: the host makes a device a GM, or not (see gm_role_api in server.py). */
    private JSONObject gmRoleApi(Request req) throws ApiError, JSONException {
        if (!req.fromHostDevice()) throw new ApiError(403, "Only the host can choose GMs");
        JSONObject body = req.json();
        synchronized (lock) {
            String target = null;
            for (String t : knownTokens()) if (deviceId(t).equals(body.optString("device"))) target = t;
            if (target == null) throw new ApiError(404, "No such device");
            boolean make = body.optBoolean("gm");
            if (make && !isGmToken(target)) gms.put(target);
            if (!make) {
                JSONArray kept = new JSONArray();
                for (int i = 0; i < gms.length(); i++) if (!gms.optString(i).equals(target)) kept.put(gms.optString(i));
                gms = kept;
            }
            changed(true);
        }
        return new JSONObject().put("ok", true);
    }

    /** GM values a GM's campaign brings (see clean_gm_values in server.py). */
    private static JSONObject cleanGmValues(JSONObject raw) throws JSONException {
        JSONObject out = new JSONObject();
        out.put("party", cleanGmBucket(raw == null ? null : raw.optJSONObject("party")));
        for (String group : new String[]{"characters", "items"}) {
            JSONObject g = raw == null ? null : raw.optJSONObject(group), kept = new JSONObject();
            if (g != null) {
                Iterator<String> it = g.keys();
                for (int n = 0; it.hasNext() && n < 2000; n++) {
                    String t = it.next();
                    JSONObject b = cleanGmBucket(g.optJSONObject(t));
                    if (b.length() > 0) kept.put(cut(t, 200), b);
                }
            }
            out.put(group, kept);
        }
        return out;
    }

    private static JSONObject cleanGmBucket(JSONObject b) throws JSONException {
        JSONObject out = new JSONObject();
        if (b == null) return out;
        Iterator<String> it = b.keys();
        while (it.hasNext()) {
            String k = it.next();
            Object v = b.opt(k);
            Object kept = GM_NAME.matcher(k).matches() ? cleanValue(k, v) : null;
            if (kept != null) out.put(k, kept);
        }
        return out;
    }

    private static boolean isNum(Object v, double limit) {
        if (!(v instanceof Number) || v instanceof Boolean) return false;
        double d = ((Number) v).doubleValue();
        return !Double.isNaN(d) && !Double.isInfinite(d) && Math.abs(d) <= limit;
    }

    /** A value as kept: a number, or a moving one {value, rate, until?} stamped with this host's time
     *  (since, ms); null when it isn't one. See clean_value in server.py. */
    static Object cleanValue(String name, Object v) throws JSONException {
        if (isNum(v, 1e13)) return v; // (as big as a time in ms: a drawing's "mark the time")
        if (!(v instanceof JSONObject) || name.startsWith("gm_state_")) return null;
        JSONObject m = (JSONObject) v;
        if (!isNum(m.opt("value"), 1e9) || !isNum(m.opt("rate"), 1e6)) return null;
        JSONObject out = new JSONObject().put("value", m.get("value")).put("rate", m.get("rate")).put("since", System.currentTimeMillis());
        if (m.has("until") && !m.isNull("until")) {
            if (!isNum(m.opt("until"), 1e9)) return null;
            out.put("until", m.get("until"));
        }
        return out;
    }

    /** A kept value as it is now (a moving one worked out from the time), else null. */
    static Double valueNow(Object v) {
        if (v instanceof JSONObject) {
            JSONObject m = (JSONObject) v;
            double rate = m.optDouble("rate", 0);
            double x = m.optDouble("value", 0) + rate * Math.max(0, (System.currentTimeMillis() - m.optLong("since")) / 1000.0);
            if (m.has("until") && !m.isNull("until")) x = rate > 0 ? Math.min(x, m.optDouble("until")) : Math.max(x, m.optDouble("until"));
            return x;
        }
        return isNum(v, Double.MAX_VALUE) ? Double.valueOf(((Number) v).doubleValue()) : null;
    }

    /** A's GM values with B's on top (B wins where both have one). */
    private static JSONObject mergeBuckets(JSONObject a, JSONObject b) throws JSONException {
        JSONObject out = new JSONObject();
        for (JSONObject src : new JSONObject[]{a, b}) {
            if (src == null) continue;
            Iterator<String> it = src.keys();
            while (it.hasNext()) { String k = it.next(); out.put(k, src.get(k)); }
        }
        return out;
    }

    /** POST /api/campaign {id, name, shops, gmValues}: a GM loads one of their campaigns (see campaign_api in server.py). */
    /** A campaign's own item states (see clean_own_states in server.py): known fields only, within limits. */
    // The campaign's rule book (js/triggers.js): kept as the GM's device sent it, within limits
    // (every device checks each rule itself before it runs). As server.py's clean_rules.
    private static final int RULES_MAX = 200, RULES_MAX_BYTES = 200_000;
    private static JSONArray cleanRules(JSONArray raw) {
        JSONArray out = new JSONArray();
        int size = 0;
        for (int i = 0; raw != null && i < raw.length() && i < RULES_MAX; i++) {
            JSONObject r = raw.optJSONObject(i);
            if (r == null) continue;
            size += r.toString().length();
            if (size > RULES_MAX_BYTES) break;
            out.put(r);
        }
        return out;
    }

    private static JSONArray cleanOwnStates(JSONArray raw) throws JSONException {
        JSONArray out = new JSONArray();
        for (int i = 0; raw != null && i < raw.length() && out.length() < 30; i++) {
            JSONObject st = raw.optJSONObject(i);
            if (st == null || !(st.opt("key") instanceof String) || !(st.opt("label") instanceof String)) continue;
            JSONObject x = new JSONObject();
            x.put("key", cut(st.getString("key"), 40));
            x.put("label", cut(st.getString("label"), 30));
            x.put("who", "gm".equals(st.optString("who")) ? "gm" : "player");
            if (!st.optString("requires").isEmpty()) x.put("requires", cut(st.optString("requires"), 40));
            JSONObject lim = st.optJSONObject("limit");
            if (lim != null && (lim.opt("default") instanceof Integer) && lim.getInt("default") > 0 && lim.getInt("default") < 1000) {
                JSONObject l = new JSONObject();
                l.put("default", lim.getInt("default"));
                l.put("mode", "warn");
                x.put("limit", l);
            }
            out.put(x);
        }
        return out;
    }

    private JSONObject campaignApi(Request req, String token) throws ApiError, JSONException {
        if (!isGm(req, token)) throw new ApiError(403, "Only a GM can choose the campaign");
        JSONObject body = req.json();
        String cid = body.optString("id"), name = cut(body.optString("name").trim(), 80);
        if (name.isEmpty()) name = "Campaign";
        if (!CAMPAIGN_ID.matcher(cid).matches()) throw new ApiError(400, "Not a campaign");
        JSONArray seedShops = new JSONArray();
        JSONArray raw = body.optJSONArray("shops");
        for (int i = 0; raw != null && i < raw.length() && i < 100; i++) {
            JSONObject r = raw.optJSONObject(i);
            JSONObject shop = cleanShop(r);
            String id = r == null ? "" : r.optString("id");
            shop.put("id", id.isEmpty() ? newId("s") : cut(id, 40));
            shop.put("rev", 1);
            shop.put("backroom", new JSONArray());
            seedShops.put(shop);
        }
        JSONObject seedGm = cleanGmValues(body.optJSONObject("gmValues"));
        // The game system it plays, as the GM's device names it (null: none).
        JSONObject sys = body.optJSONObject("system"), system = null;
        if (sys != null && !sys.optString("id").isEmpty())
            system = new JSONObject().put("id", cut(sys.optString("id"), 80)).put("name", cut(sys.optString("name", sys.optString("id")), 80));
        synchronized (lock) {
            Currency money = cleanCurrency(body.optJSONObject("currency"));
            JSONArray rawStates = body.optJSONArray("states"), states = null;
            if (rawStates != null) {
                states = new JSONArray();
                for (int i = 0; i < rawStates.length() && i < 30; i++) if (rawStates.opt(i) instanceof String) states.put(cut(rawStates.getString(i), 40));
            }
            switchCampaign(cid, name, system, money == null ? null : currencyJson(money), states, seedShops, seedGm);
            // Values only a GM sets (states' limits); players set their other Locals.
            JSONArray rawOnly = body.optJSONArray("gmOnly"), gmOnly = new JSONArray();
            for (int i = 0; rawOnly != null && i < rawOnly.length() && i < 50; i++) {
                Object k = rawOnly.opt(i);
                if (k instanceof String && GM_NAME.matcher((String) k).matches()) gmOnly.put(k);
            }
            campaign.put("gmOnly", gmOnly);
            // Rules, values and controls (Clockwork): off, shops don't follow values.
            campaign.put("clockwork", !(body.opt("clockwork") instanceof Boolean) || body.optBoolean("clockwork", true));
            campaign.put("ownStates", cleanOwnStates(body.optJSONArray("ownStates")));
            campaign.put("rules", cleanRules(body.optJSONArray("rules")));
            changed(false);
        }
        return new JSONObject().put("ok", true);
    }

    /** Call with `lock` held: save this campaign's party and make `cid` current (see switch_campaign in server.py). */
    private void switchCampaign(String cid, String name, JSONObject system, JSONObject money, JSONArray states, JSONArray seedShops, JSONObject seedGm) throws JSONException {
        String current = campaign == null ? "" : campaign.optString("id");
        JSONObject named = new JSONObject().put("id", cid).put("name", name).put("system", system == null ? JSONObject.NULL : system)
            .put("currency", money == null ? JSONObject.NULL : money).put("states", states == null ? JSONObject.NULL : states);
        if (current.equals(cid)) {
            campaign = named;
            save();
            return;
        }
        save();
        File target = campaignFile(cid);
        if (target.exists()) {
            try (InputStream in = new java.io.FileInputStream(target)) {
                readState(new JSONObject(new String(readAll(in), StandardCharsets.UTF_8)), false);
            } catch (IOException e) {
                throw new JSONException("Couldn't read the campaign's party: " + e.getMessage());
            }
        } else if (campaign == null && (characters.length() > 0 || shops.length() > 0 || gm.length() > 0)) {
            // The party so far (players who joined before the GM loaded a campaign) becomes this
            // one's. It keeps what it has, and gains the GM's shops (ones it hasn't got) and GM
            // values (where it has none of its own).
            Set<String> have = new HashSet<>();
            for (int i = 0; i < shops.length(); i++) have.add(shops.getJSONObject(i).optString("id"));
            for (int i = 0; i < seedShops.length(); i++) if (!have.contains(seedShops.getJSONObject(i).optString("id"))) shops.put(seedShops.getJSONObject(i));
            JSONObject merged = new JSONObject();
            merged.put("party", mergeBuckets(seedGm.optJSONObject("party"), gm.optJSONObject("party")));
            for (String group : new String[]{"characters", "items"}) {
                JSONObject seed = seedGm.optJSONObject(group), old = gm.optJSONObject(group), out = new JSONObject();
                for (JSONObject src : new JSONObject[]{seed, old}) {
                    if (src == null) continue;
                    Iterator<String> it = src.keys();
                    while (it.hasNext()) {
                        String t = it.next();
                        out.put(t, mergeBuckets(out.optJSONObject(t), src.optJSONObject(t)));
                    }
                }
                merged.put(group, out);
            }
            gm = merged;
        } else {
            characters = new JSONObject();
            trades = new JSONArray();
            shops = seedShops;
            gm = seedGm;
        }
        campaign = named;
        dataFile = target;
        save();
        try (OutputStream out = new FileOutputStream(pointerFile())) {
            out.write(cid.getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            android.util.Log.e("Mimic", "Could not note the campaign", e);
        }
    }

    // ------------------------------------------------------------------ live updates (Server-Sent Events)

    private static void startStream(OutputStream out) throws IOException {
        String head = "HTTP/1.0 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n" + corsLines() + "\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        out.flush();
    }

    /** Tokens whose player chose Leave party: their live connections close now. */
    private final Set<String> leaving = new HashSet<>();

    private void eventStream(Request req, String token, OutputStream out) throws IOException, JSONException {
        startStream(out);
        boolean host = req.fromHostDevice();
        String name = "";
        for (String kv : req.query.split("&")) {
            if (kv.startsWith("device=")) {
                try { name = cut(URLDecoder.decode(kv.substring(7), "UTF-8").trim(), 40); } catch (Exception ignored) {}
            }
        }
        synchronized (lock) {
            online.put(token, online.getOrDefault(token, 0) + 1);
            JSONObject named = devices.optJSONObject(token);
            if (!name.isEmpty() && (named == null || !name.equals(named.optString("name")))) {
                devices.put(token, new JSONObject().put("name", name));
                changed(true);
            } else {
                changed(false);
            }
        }
        long last = -1;
        try {
            while (true) {
                String data = null;
                synchronized (lock) {
                    if (!partyEnabled() || leaving.contains(token)) break; // the host stopped the party, or this player left it
                    if (version == last) {
                        try { lock.wait(15000); } catch (InterruptedException e) { break; }
                    }
                    if (leaving.contains(token)) break;
                    if (version != last) {
                        last = version;
                        data = snapshot(token, host).toString();
                    }
                }
                String msg = data != null ? "event: state\ndata: " + data + "\n\n" : ": ping\n\n";
                out.write(msg.getBytes(StandardCharsets.UTF_8));
                out.flush();
            }
        } finally {
            synchronized (lock) {
                int n = online.getOrDefault(token, 1) - 1;
                online.put(token, n);
                if (n <= 0) leaving.remove(token);
                changed(false);
            }
        }
    }

    /** Kept open by the app's page (the desktop app uses it to know when to quit; here it's just a heartbeat). */
    private void presenceStream(OutputStream out) throws IOException {
        startStream(out);
        while (true) {
            out.write(": ping\n\n".getBytes(StandardCharsets.UTF_8));
            out.flush();
            try { Thread.sleep(5000); } catch (InterruptedException e) { return; }
        }
    }
}
