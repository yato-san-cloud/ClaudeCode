/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker;

public class MapMakerUtils {
    public static <E extends Enum<E>> E fromOrdinal(Class<E> enumClass, int ordinal) {
        Enum[] enumArray = (Enum[])enumClass.getEnumConstants();
        return (E)enumArray[ordinal];
    }
}

