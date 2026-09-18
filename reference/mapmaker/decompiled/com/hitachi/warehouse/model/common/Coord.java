/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.common;

import com.hitachi.warehouse.model.common.Segment;
import common.ds.Vector;
import common.util.MathUtil;
import java.io.Serializable;

public class Coord
implements Serializable {
    private static final long serialVersionUID = -2323197057680313436L;
    public final double x;
    public final double y;

    public Coord(double x, double y) {
        this.x = x;
        this.y = y;
    }

    public Segment segmentTo(Coord to) {
        return new Segment(this, to);
    }

    public String toString() {
        return String.valueOf(this.x) + "," + this.y;
    }

    public double distTo(Coord other) {
        return Math.sqrt(MathUtil.square(this.x - other.x) + MathUtil.square(this.y - other.y));
    }

    public double distToFast(Coord other) {
        return MathUtil.sqrtFast(MathUtil.square(this.x - other.x) + MathUtil.square(this.y - other.y));
    }

    public double squaredDistTo(Coord other) {
        return MathUtil.square(this.x - other.x) + MathUtil.square(this.y - other.y);
    }

    public double distManhattan(Coord other) {
        return Math.abs(this.x - other.x) + Math.abs(this.y - other.y);
    }

    public boolean isInside(Coord tl, Coord br) {
        return tl.x <= this.x && tl.y <= this.y && this.x < br.x && this.y < br.y;
    }

    public double heading(Coord nextCoord) {
        double dy = nextCoord.y - this.y;
        double dx = nextCoord.x - this.x;
        double heading = Math.atan2(dy, dx) + 1.5707963267948966;
        if (heading < 0.0) {
            heading += Math.PI * 2;
        }
        return heading;
    }

    public Vector getVector() {
        Vector vec = new Vector(2);
        vec.set(this.x, this.y);
        return vec;
    }

    public Coord moveHeading(double heading, double dist) {
        double sin = Math.sin(heading);
        double cos = MathUtil.cosFast(sin, heading);
        return new Coord(this.x + dist * sin, this.y - dist * cos);
    }

    public static double angleBetween(double heading1, double heading2) {
        double between;
        if (heading1 > heading2) {
            double t2 = heading2;
            heading2 = heading1;
            heading1 = t2;
        }
        if ((between = heading2 - heading1) > Math.PI) {
            return Math.PI * 2 - between;
        }
        return between;
    }

    public static double closestAnglePeriod(double baseAngle, double otherAngle) {
        double diff = otherAngle - baseAngle;
        while (diff > Math.PI) {
            diff = (otherAngle -= Math.PI * 2) - baseAngle;
        }
        while (diff < -Math.PI) {
            diff = (otherAngle += Math.PI * 2) - baseAngle;
        }
        return otherAngle;
    }

    public static Coord mean(Coord fst, Coord snd) {
        return new Coord((fst.x + snd.x) / 2.0, (fst.y + snd.y) / 2.0);
    }

    public static void main(String[] args) {
        double a = 90.0 * MathUtil.DEG2RAD;
        double b = 120.0 * MathUtil.DEG2RAD;
        b = 0.0;
        while (b < Math.PI * 2) {
            System.out.println(String.valueOf(a * MathUtil.RAD2DEG) + " " + b * MathUtil.RAD2DEG + " " + Coord.closestAnglePeriod(a, b) * MathUtil.RAD2DEG + "    " + (Coord.closestAnglePeriod(a, b) - a) * MathUtil.RAD2DEG);
            b += 0.1;
        }
    }

    public Coord clone() {
        return new Coord(this.x, this.y);
    }

    public static double normalizeRange_0_2PI(double theta) {
        while (theta < 0.0) {
            theta += Math.PI * 2;
        }
        while (theta >= Math.PI * 2) {
            theta -= Math.PI * 2;
        }
        return theta;
    }

    public static double normalizeRange_PI_PI(double theta) {
        while (theta < Math.PI) {
            theta += Math.PI * 2;
        }
        while (theta >= Math.PI) {
            theta -= Math.PI * 2;
        }
        return theta;
    }

    public static double mapping(Coord segFrom, Coord segTo, Coord point) {
        return Coord.dotProduct(segFrom, segTo, segFrom, point) / Math.sqrt(Math.pow(segFrom.x - segTo.x, 2.0) + Math.pow(segFrom.y - segTo.y, 2.0));
    }

    public static double dotProduct(Coord segFrom1, Coord segTo1, Coord segFrom2, Coord segTo2) {
        return (segTo1.x - segFrom1.x) * (segTo2.x - segFrom2.x) + (segTo1.y - segFrom1.y) * (segTo2.y - segFrom2.y);
    }

    public static double actualDistBetween(Coord segFrom, Coord segTo, Coord point) {
        double mapping = Coord.mapping(segFrom, segTo, point);
        double p = mapping / Math.sqrt(Math.pow(segFrom.x - segTo.x, 2.0) + Math.pow(segFrom.y - segTo.y, 2.0));
        Coord mapped = new Coord(segFrom.x + p * (segFrom.x - segFrom.x), segFrom.y + p * (segFrom.y - segFrom.y));
        if (p < 0.0) {
            return point.distTo(segFrom);
        }
        if (p <= 1.0) {
            return point.distTo(mapped);
        }
        return point.distTo(segTo);
    }

    public static Coord intersection(Coord from1, Coord to1, Coord from2, Coord to2, boolean withinSegment) {
        double px = from1.x;
        double py = from1.y;
        double rx = to1.x - px;
        double ry = to1.y - py;
        double qx = from2.x;
        double qy = from2.y;
        double sx = to2.x - qx;
        double sy = to2.y - qy;
        double det = -rx * sy + sx * ry;
        double s = (-sy * (qx - px) + sx * (qy - py)) / det;
        double t2 = (-ry * (qx - px) + rx * (qy - py)) / det;
        if (!withinSegment || s >= 0.0 && s <= 1.0 && t2 >= 0.0 && t2 <= 1.0) {
            return new Coord(px + rx * s, py + ry * s);
        }
        return null;
    }

    public static boolean intersects(Coord from1, Coord to1, Coord from2, Coord to2) {
        double px = from1.x;
        double py = from1.y;
        double rx = to1.x - px;
        double ry = to1.y - py;
        double qx = from2.x;
        double qy = from2.y;
        double sx = to2.x - qx;
        double sy = to2.y - qy;
        double det = -rx * sy + sx * ry;
        double s = (-sy * (qx - px) + sx * (qy - py)) / det;
        double t2 = (-ry * (qx - px) + rx * (qy - py)) / det;
        return s >= 0.0 && s <= 1.0 && t2 >= 0.0 && t2 <= 1.0;
    }

    public boolean equals(Object other) {
        Coord _other = (Coord)other;
        return _other.x == this.x && _other.y == this.y;
    }

    public int hashCode() {
        return (int)(this.x * 100000.0) + (int)(this.y * 1000.0);
    }

    public static boolean clips(Coord tl1, Coord br1, Coord tl2, Coord br2) {
        return tl1.x <= br2.x && tl1.y <= br2.y && br1.x >= tl2.x && br1.y >= tl2.y;
    }
}

