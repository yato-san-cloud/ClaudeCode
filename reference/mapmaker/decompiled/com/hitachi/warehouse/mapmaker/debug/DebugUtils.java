/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.debug;

public class DebugUtils {
    public static boolean isDebugMode() {
        String prop = System.getProperty("DEBUG");
        if (prop == null) {
            return false;
        }
        return prop.toUpperCase().equals("TRUE");
    }
}

