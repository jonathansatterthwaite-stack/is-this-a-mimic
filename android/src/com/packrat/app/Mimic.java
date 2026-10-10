package com.packrat.app;

import android.content.Context;

import java.io.File;
import java.io.IOException;

/** One PartyServer per app process, shared by the activity and the hosting service. */
public final class Mimic {
    private static PartyServer server;

    private Mimic() {}

    public static synchronized PartyServer server(Context context) throws IOException {
        if (server == null) {
            Context app = context.getApplicationContext();
            // Pack Rat's data (this app replaces it) goes: the fresh version starts empty.
            deleteTree(new File(app.getFilesDir(), "party-data"));
            deleteTree(new File(app.getFilesDir(), "my-data"));
            File home = new File(app.getFilesDir(), "mimic");
            home.mkdirs();
            PartyServer s = new PartyServer(app.getAssets(), new File(home, "party-data"));
            s.startApp();
            server = s;
        }
        return server;
    }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }

    /** The server if it's already running (e.g. from the service's Stop button). */
    public static synchronized PartyServer existing() {
        return server;
    }
}
