/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.bms.model;

import com.hitachi.warehouse.bms.model.CellPosition;
import java.io.Serializable;

public class State
implements Serializable {
    private static final long serialVersionUID = 8505699851066851985L;
    public final CellPosition pos;
    public final double rot;

    public State(CellPosition pos, double rot) {
        this.pos = pos;
        this.rot = rot;
    }

    public int hashCode() {
        return this.pos.hashCode() + (int)(this.rot * 360.0);
    }

    public boolean equals(Object _obj) {
        State other = (State)_obj;
        return this.pos.equals(other.pos) && this.rot == other.rot;
    }

    public String toString() {
        return this.pos + " " + this.rot;
    }
}

