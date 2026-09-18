/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.common;

public class NumericCheck {
    public boolean isNumericDouble(String string) {
        try {
            double d = Double.valueOf(string);
        }
        catch (Exception e) {
            return false;
        }
        int len = string.length();
        String right = string.substring(len - 1, len);
        return !right.toUpperCase().equals("D") && !right.toUpperCase().equals("F") && !right.toUpperCase().equals("E");
    }
}

