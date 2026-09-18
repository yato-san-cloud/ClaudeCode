/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.common;

import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.common.polygon.Bound;
import common.util.MathUtil;

public class Polygon {
    public final Coord[] coords;
    public final Bound bound;

    public Polygon(Coord ... coords) {
        this.coords = coords;
        Double left = null;
        Double right = null;
        Double top = null;
        Double bottom = null;
        Coord[] coordArray = coords;
        int n = coords.length;
        int n2 = 0;
        while (n2 < n) {
            Coord coord = coordArray[n2];
            left = MathUtil.min_ignoreNull(left, coord.x);
            right = MathUtil.max_ignoreNull(right, coord.x);
            top = MathUtil.min_ignoreNull(top, coord.y);
            bottom = MathUtil.max_ignoreNull(bottom, coord.y);
            ++n2;
        }
        this.bound = new Bound(new Coord(left, top), new Coord(right, bottom));
    }

    public boolean clips(Coord from, Coord to) {
        Coord prev = this.coords[this.coords.length - 1];
        Coord[] coordArray = this.coords;
        int n = this.coords.length;
        int n2 = 0;
        while (n2 < n) {
            Coord coord = coordArray[n2];
            if (Coord.intersects(from, to, prev, coord)) {
                return true;
            }
            prev = coord;
            ++n2;
        }
        return false;
    }

    public boolean clips(Polygon other) {
        Coord myPrev = this.coords[this.coords.length - 1];
        int i = 0;
        while (i < this.coords.length) {
            Coord myCurrent = this.coords[i];
            Coord otherPrev = other.coords[other.coords.length - 1];
            int j = 0;
            while (j < other.coords.length) {
                Coord otherCurrent = other.coords[j];
                if (Coord.intersects(myPrev, myCurrent, otherPrev, otherCurrent)) {
                    return true;
                }
                otherPrev = otherCurrent;
                ++j;
            }
            myPrev = myCurrent;
            ++i;
        }
        return false;
    }

    public double distFrom(Coord point) {
        Coord prev = this.coords[this.coords.length - 1];
        double distMin = Double.MAX_VALUE;
        Coord[] coordArray = this.coords;
        int n = this.coords.length;
        int n2 = 0;
        while (n2 < n) {
            Coord coord = coordArray[n2];
            distMin = Math.min(distMin, Coord.actualDistBetween(prev, coord, point));
            prev = coord;
            ++n2;
        }
        return distMin;
    }

    public static interface Shapeful {
        public Polygon polygon();
    }
}

