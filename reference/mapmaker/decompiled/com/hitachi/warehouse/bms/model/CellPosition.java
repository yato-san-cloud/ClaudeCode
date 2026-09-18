/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.bms.model;

import com.hitachi.warehouse.model.common.Coord;
import java.io.Serializable;

public class CellPosition
implements Serializable {
    private static final long serialVersionUID = -816629437266256987L;
    public final Coord tl;
    public final Coord br;
    public final Coord center;
    public final int x;
    public final int y;

    public CellPosition(Coord tl, Coord br, int x, int y) {
        this.tl = tl;
        this.br = br;
        this.x = x;
        this.y = y;
        this.center = new Coord((tl.x + br.x) / 2.0, (tl.y + br.y) / 2.0);
    }

    public int hashCode() {
        return this.x * 1000 + this.y;
    }

    public boolean equals(Object _obj) {
        CellPosition pos = (CellPosition)_obj;
        return this.x == pos.x && this.y == pos.y;
    }

    public String toString() {
        return String.valueOf(this.x) + "," + this.y;
    }
}

