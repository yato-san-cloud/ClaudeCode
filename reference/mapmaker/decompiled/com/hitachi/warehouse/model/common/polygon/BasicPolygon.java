/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.common.polygon;

import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.common.polygon.Bound;
import com.hitachi.warehouse.model.common.polygon.Shape;
import java.awt.Point;
import java.awt.geom.GeneralPath;

public class BasicPolygon
extends Shape {
    public final Coord[] coords;

    public BasicPolygon(Coord ... coords) {
        this.coords = coords;
        super.setBounds(Bound.boundFromCoords(coords));
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

    @Override
    public boolean intersects(Shape other) {
        if (BasicPolygon.class.isInstance(other)) {
            return this.intersects((BasicPolygon)other);
        }
        return other.intersects(this);
    }

    public boolean intersects(BasicPolygon other) {
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

    @Override
    public boolean intersects(Coord from, Coord to) {
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

    @Override
    public boolean contains(Coord point) {
        Coord prev = this.coords[this.coords.length - 1];
        Coord[] coordArray = this.coords;
        int n = this.coords.length;
        int n2 = 0;
        while (n2 < n) {
            Coord coord = coordArray[n2];
            double cross = (coord.x - prev.x) * (point.y - prev.y) - (coord.y - prev.y) * (point.x - prev.x);
            if (cross < 0.0) {
                return false;
            }
            prev = coord;
            ++n2;
        }
        return true;
    }

    @Override
    public java.awt.Shape toAWTShape(MapView mapView) {
        Point prev = mapView.screenPointForWorld(this.coords[this.coords.length - 1]);
        GeneralPath path = new GeneralPath();
        path.moveTo(prev.x, prev.y);
        Coord[] coordArray = this.coords;
        int n = this.coords.length;
        int n2 = 0;
        while (n2 < n) {
            Coord coord = coordArray[n2];
            Point p = mapView.screenPointForWorld(coord);
            path.lineTo(p.x, p.y);
            ++n2;
        }
        path.closePath();
        return path;
    }
}

