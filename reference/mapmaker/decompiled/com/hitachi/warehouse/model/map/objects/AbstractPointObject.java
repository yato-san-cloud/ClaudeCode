/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.map.objects;

import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import java.io.Serializable;

public abstract class AbstractPointObject
extends AbstractObject
implements Serializable {
    private static final long serialVersionUID = -2335217919342012326L;

    public abstract Coord point();

    @Override
    public boolean isInside(Coord coord) {
        return coord.equals(this.point());
    }

    @Override
    public double distTo(Coord coord) {
        return this.point().distTo(coord);
    }

    @Override
    public boolean clipsSegment(Coord from, Coord to) {
        if (this.isInside(from) || this.isInside(to)) {
            return true;
        }
        double bX = from.x;
        double gradX = to.x - bX;
        double bY = from.y;
        double gradY = to.y - bY;
        return (this.point().x - bX) / gradX == (this.point().y - bY) / gradY;
    }
}

