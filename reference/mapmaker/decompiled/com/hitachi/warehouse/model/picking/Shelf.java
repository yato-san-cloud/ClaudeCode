/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.picking;

import com.hitachi.warehouse.model.picking.ShelfArea;
import java.io.Serializable;

public class Shelf
implements Serializable {
    private static final long serialVersionUID = 5066022855236408075L;
    public final ShelfArea shelfArea;
    public final String shelfNo;
    public final String level;

    public Shelf(ShelfArea shelfArea, String shelfNo, String shelfLevel) {
        this.shelfArea = shelfArea;
        this.shelfNo = shelfNo;
        this.level = shelfLevel;
    }

    public boolean equals(Object _other) {
        Shelf other = (Shelf)_other;
        return this.shelfArea.equals(other.shelfArea) && this.shelfNo.equals(other.shelfNo) && this.level.equals(other.level);
    }

    public String toString() {
        return this.shelfArea + "[" + this.shelfNo + "," + this.level + "]";
    }

    public int hashCode() {
        return this.shelfArea.hashCode() + this.shelfNo.hashCode() + this.level.hashCode();
    }
}

