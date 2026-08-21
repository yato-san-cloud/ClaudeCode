package com.hitachi.warehouse.mapmaker;

import java.awt.Rectangle;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Properties;

/**
 * Tiny persistent settings store for the customized build.
 * Backed by a plain {@code mapmaker.properties} file in the working directory
 * (same place the app already looks for InitialSetting.xml). No external deps.
 */
public final class Prefs {
    private static final File FILE = new File("mapmaker.properties");
    private static final Properties P = new Properties();

    static {
        if (FILE.exists()) {
            try (InputStream in = new FileInputStream(FILE)) {
                P.load(in);
            } catch (IOException e) {
                // ignore — fall back to defaults
            }
        }
    }

    public static synchronized void save() {
        try (OutputStream out = new FileOutputStream(FILE)) {
            P.store(out, "MapMaker custom settings");
        } catch (IOException e) {
            e.printStackTrace();
        }
    }

    public static String get(String k, String d) { return P.getProperty(k, d); }
    public static void put(String k, String v) { P.setProperty(k, v); }

    public static boolean getBool(String k, boolean d) {
        String s = P.getProperty(k);
        return s == null ? d : Boolean.parseBoolean(s);
    }
    public static void putBool(String k, boolean v) { P.setProperty(k, Boolean.toString(v)); }

    public static int getInt(String k, int d) {
        try { return Integer.parseInt(P.getProperty(k)); } catch (Exception e) { return d; }
    }
    public static void putInt(String k, int v) { P.setProperty(k, Integer.toString(v)); }

    public static double getDouble(String k, double d) {
        try { return Double.parseDouble(P.getProperty(k)); } catch (Exception e) { return d; }
    }
    public static void putDouble(String k, double v) { P.setProperty(k, Double.toString(v)); }

    public static Rectangle getRect(String k) {
        String s = P.getProperty(k);
        if (s == null) return null;
        String[] a = s.split(",");
        if (a.length != 4) return null;
        try {
            return new Rectangle(Integer.parseInt(a[0].trim()), Integer.parseInt(a[1].trim()),
                                 Integer.parseInt(a[2].trim()), Integer.parseInt(a[3].trim()));
        } catch (Exception e) {
            return null;
        }
    }
    public static void putRect(String k, Rectangle r) {
        P.setProperty(k, r.x + "," + r.y + "," + r.width + "," + r.height);
    }

    public static void pushRecent(String path) {
        List<String> l = new ArrayList<String>(getRecent());
        l.remove(path);
        l.add(0, path);
        while (l.size() > 8) l.remove(l.size() - 1);
        P.setProperty("recent.files", join(l, "|"));
    }
    public static List<String> getRecent() {
        String s = P.getProperty("recent.files");
        if (s == null || s.isEmpty()) return new ArrayList<String>();
        return new ArrayList<String>(Arrays.asList(s.split("\\|")));
    }

    private static String join(List<String> l, String sep) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < l.size(); i++) {
            if (i > 0) sb.append(sep);
            sb.append(l.get(i));
        }
        return sb.toString();
    }

    private Prefs() {}
}
