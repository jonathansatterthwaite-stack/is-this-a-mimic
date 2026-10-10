package com.packrat.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import java.util.List;

/**
 * Keeps the app alive while a party is hosted, so the phone keeps serving the
 * other players when the screen is off or the app is in the background.
 */
public class HostService extends Service {
    static final String ACTION_STOP = "com.packrat.app.STOP_HOSTING";
    static final String CHANNEL = "hosting";
    static final int NOTIFICATION_ID = 1;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    static void start(Context context, int port) {
        Intent i = new Intent(context, HostService.class).putExtra("port", port);
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i);
        else context.startService(i);
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, HostService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            PartyServer s = Mimic.existing();
            if (s != null) s.stopLan(); // the activity's listener stops this service
            stopSelf();
            return START_NOT_STICKY;
        }
        int port = intent != null ? intent.getIntExtra("port", PartyServer.DEFAULT_LAN_PORT) : PartyServer.DEFAULT_LAN_PORT;
        Notification n = buildNotification(port);
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
        acquireLocks();
        return START_NOT_STICKY;
    }

    private Notification buildNotification(int port) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            if (nm.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, getString(R.string.channel_hosting), NotificationManager.IMPORTANCE_LOW);
                ch.setDescription(getString(R.string.channel_hosting_desc));
                nm.createNotificationChannel(ch);
            }
            b = new Notification.Builder(this, CHANNEL);
        } else {
            b = new Notification.Builder(this);
        }
        List<String> addrs = PartyServer.lanAddresses();
        String where = addrs.isEmpty() ? getString(R.string.hosting_no_address)
                : getString(R.string.hosting_join_at, "http://" + addrs.get(0) + ":" + port);
        int immutable = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), immutable);
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, HostService.class).setAction(ACTION_STOP), immutable);
        return b.setSmallIcon(R.drawable.ic_stat_packrat)
                .setContentTitle(getString(R.string.hosting_title))
                .setContentText(where)
                .setContentIntent(open)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(null, getString(R.string.stop_hosting), stop).build())
                .build();
    }

    private void acquireLocks() {
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Mimic:hosting");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
        }
        if (wifiLock == null) {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
            if (wm != null) {
                @SuppressWarnings("deprecation")
                int mode = WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                wifiLock = wm.createWifiLock(mode, "Mimic:hosting");
                wifiLock.setReferenceCounted(false);
                wifiLock.acquire();
            }
        }
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
