/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.common;

import com.hitachi.warehouse.model.common.Coord;

public class Segment {
    public final Coord from;
    public final Coord to;
    public final double magnitude;

    public Segment(Coord from, Coord to) {
        this.from = from;
        this.to = to;
        this.magnitude = from.distTo(to);
    }

    public double mapping(Coord point) {
        Segment vector2Point = new Segment(this.from, point);
        return this.dotProduct(vector2Point) / this.magnitude;
    }

    public double dotProduct(Segment other) {
        return (this.to.x - this.from.x) * (other.to.x - other.from.x) + (this.to.y - this.from.y) * (other.to.y - other.from.y);
    }

    public boolean intersects(Segment other) {
        Coord from1 = this.from;
        Coord to1 = this.to;
        Coord from2 = other.from;
        Coord to2 = other.to;
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

    public Coord intersection(Segment other) {
        return this.intersection(other, true);
    }

    public Coord intersection(Segment other, boolean withinSegment) {
        double px = this.from.x;
        double py = this.from.y;
        double rx = this.to.x - px;
        double ry = this.to.y - py;
        double qx = other.from.x;
        double qy = other.from.y;
        double sx = other.to.x - qx;
        double sy = other.to.y - qy;
        double det = -rx * sy + sx * ry;
        double s = (-sy * (qx - px) + sx * (qy - py)) / det;
        double t2 = (-ry * (qx - px) + rx * (qy - py)) / det;
        if (!withinSegment || s >= 0.0 && s <= 1.0 && t2 >= 0.0 && t2 <= 1.0) {
            return new Coord(px + rx * s, py + ry * s);
        }
        return null;
    }

    public Coord mappedPoint(Coord point) {
        return this.mappedPoint(point, false);
    }

    public Coord mappedPoint(Coord point, boolean inside) {
        double mapping = this.mapping(point);
        double p = mapping / this.magnitude;
        if (inside) {
            if (p < 0.0) {
                return this.from;
            }
            if (p >= 1.0) {
                return this.to;
            }
        }
        return this.pointAtProp(p);
    }

    public Coord pointAtProp(double p) {
        return new Coord(this.from.x + p * (this.to.x - this.from.x), this.from.y + p * (this.to.y - this.from.y));
    }

    public double actualDist(Coord point) {
        double mapping = this.mapping(point);
        double p = mapping / this.magnitude;
        Coord mapped = new Coord(this.from.x + p * (this.to.x - this.from.x), this.from.y + p * (this.to.y - this.from.y));
        if (p < 0.0) {
            return point.distTo(this.from);
        }
        if (p <= 1.0) {
            return point.distTo(mapped);
        }
        return point.distTo(this.to);
    }
}

