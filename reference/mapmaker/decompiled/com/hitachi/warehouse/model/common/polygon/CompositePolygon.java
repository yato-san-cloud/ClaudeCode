/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.common.polygon;

import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.common.polygon.Shape;
import common.ds.FastIteratingList;
import java.awt.geom.Area;

public class CompositePolygon
extends Shape {
    private FastIteratingList<Shape> shapes = new FastIteratingList();

    public void add(Shape child) {
        this.shapes.add(child);
    }

    @Override
    public boolean intersects(Shape other) {
        for (Shape shape : this.shapes) {
            if (!shape.intersects(other)) continue;
            return true;
        }
        return false;
    }

    @Override
    public boolean intersects(Coord from, Coord to) {
        for (Shape shape : this.shapes) {
            if (!shape.intersects(from, to)) continue;
            return true;
        }
        return false;
    }

    @Override
    public boolean contains(Coord point) {
        for (Shape shape : this.shapes) {
            if (!shape.contains(point)) continue;
            return true;
        }
        return false;
    }

    @Override
    public java.awt.Shape toAWTShape(MapView mapView) {
        Area area = new Area();
        for (Shape shape : this.shapes) {
            area.add(new Area(shape.toAWTShape(mapView)));
        }
        return area;
    }
}

