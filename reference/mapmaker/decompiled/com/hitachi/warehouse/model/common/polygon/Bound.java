/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.common.polygon;

import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.common.polygon.Shape;
import common.util.MathUtil;
import java.awt.geom.Rectangle2D;

public class Bound
extends Shape {
    public final Coord tl;
    public final Coord br;
    public final Coord tr;
    public final Coord bl;

    public Bound(Coord tl, Coord br) {
        this.tl = tl;
        this.br = br;
        this.tr = new Coord(br.x, tl.y);
        this.bl = new Coord(tl.x, br.y);
        super.setBounds(this);
    }

    public static Bound boundFromCoords(Coord ... coords) {
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
        if (left != null) {
            return new Bound(new Coord(left, top), new Coord(right, bottom));
        }
        return null;
    }

    public boolean intersects(Bound bound) {
        return this.br.x >= bound.tl.x && this.tl.x < bound.br.x && this.tl.y < bound.br.y && this.br.y >= bound.tl.y;
    }

    @Override
    public boolean intersects(Shape shape) {
        if (Bound.class.isInstance(shape)) {
            return this.intersects((Bound)shape);
        }
        if (this.intersects(shape.bounds())) {
            return shape.intersects(this.bl, this.tl) || shape.intersects(this.tl, this.tr) || shape.intersects(this.tr, this.br) || shape.intersects(this.br, this.bl);
        }
        return false;
    }

    @Override
    public boolean intersects(Coord from, Coord to) {
        return Coord.intersects(from, to, this.bl, this.tl) || Coord.intersects(from, to, this.tl, this.tr) || Coord.intersects(from, to, this.tr, this.br) || Coord.intersects(from, to, this.br, this.bl);
    }

    @Override
    public boolean contains(Coord point) {
        return this.tl.x <= point.x && point.x < this.br.x && this.tl.y <= point.y && point.y < this.br.y;
    }

    @Override
    public java.awt.Shape toAWTShape(MapView mapView) {
        int x = mapView.screenXForWorld(this.tl.x);
        int y = mapView.screenXForWorld(this.tl.y);
        int width = mapView.screenXForWorld(this.br.x) - x;
        int height = mapView.screenXForWorld(this.br.y) - y;
        return new Rectangle2D.Double(x, y, width, height);
    }
}

