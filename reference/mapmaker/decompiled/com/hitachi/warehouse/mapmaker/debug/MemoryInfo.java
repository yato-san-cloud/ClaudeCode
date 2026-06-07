/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.debug;

import com.hitachi.warehouse.mapmaker.debug.DebugUtils;
import java.text.DecimalFormat;
import java.text.SimpleDateFormat;
import java.util.Date;

public class MemoryInfo {
    private final DecimalFormat _formatMem = new DecimalFormat("#,###KB");
    private final DecimalFormat _formatRatio = new DecimalFormat("##.#");
    private long _free;
    private long _total;
    private long _max;
    private long _used;
    private double _ratio;

    private MemoryInfo() {
    }

    public long getFree() {
        return this._free;
    }

    public long getTotal() {
        return this._total;
    }

    public long getMax() {
        return this._max;
    }

    public long getUsed() {
        return this._used;
    }

    public double getRatio() {
        return this._ratio;
    }

    public String toString() {
        StringBuffer buff = new StringBuffer();
        buff.append("Total   = ").append(this._formatMem.format(this._total)).append("\n").append("Free    = ").append(this._formatMem.format(this._free)).append("\n").append("use     = ").append(this._formatMem.format(this._used)).append(" (").append(this._formatRatio.format(this._ratio)).append("%)").append("\n").append("can use = ").append(this._formatMem.format(this._max)).append("\n");
        return buff.toString();
    }

    public static MemoryInfo getMemoryInfo() {
        MemoryInfo info = new MemoryInfo();
        System.gc();
        info._free = Runtime.getRuntime().freeMemory() / 1024L;
        info._total = Runtime.getRuntime().totalMemory() / 1024L;
        info._max = Runtime.getRuntime().maxMemory() / 1024L;
        info._used = info._total - info._free;
        info._ratio = (double)(info._used * 100L) / (double)info._total;
        return info;
    }

    public static void viewMemoryInfo() {
        if (!DebugUtils.isDebugMode()) {
            return;
        }
        String className = "";
        StackTraceElement[] elements = new Throwable().getStackTrace();
        if (elements.length > 0) {
            className = elements[1].toString();
        }
        Date currentTime = new Date(System.currentTimeMillis());
        SimpleDateFormat formatTime = new SimpleDateFormat("yyyy/MM/dd HH:mm:ss.SSS");
        StringBuffer buff = new StringBuffer().append("[Memory]").append(className).append(" ").append(formatTime.format(currentTime)).append("\n").append(MemoryInfo.getMemoryInfo());
        System.out.println(buff.toString());
    }
}

