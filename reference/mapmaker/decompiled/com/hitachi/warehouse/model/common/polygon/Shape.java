/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.common.polygon;

import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.common.polygon.Bound;

public abstract class Shape {
    private Bound bounds;

    public Bound bounds() {
        return this.bounds;
    }

    protected void setBounds(Bound bounds) {
        this.bounds = bounds;
    }

    public abstract boolean intersects(Shape var1);

    public abstract boolean intersects(Coord var1, Coord var2);

    public abstract boolean contains(Coord var1);

    public abstract java.awt.Shape toAWTShape(MapView var1);
}

