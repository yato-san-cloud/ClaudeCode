/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.picking;

import java.io.Serializable;

public class FreeShelfArea
implements Serializable {
    private static final long serialVersionUID = -5806980039248048961L;
    public static final FreeShelfArea pickingStartEndShelf = new FreeShelfArea("START");
    public final String name;

    public FreeShelfArea(String name) {
        this.name = name;
    }

    public boolean equals(Object _other) {
        FreeShelfArea other = (FreeShelfArea)_other;
        return this.name.equals(other.name);
    }

    public String toString() {
        return this.name;
    }

    public int hashCode() {
        return this.name.hashCode();
    }
}

