/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.picking.shelffactory;

import com.hitachi.warehouse.model.picking.Shelf;
import com.hitachi.warehouse.model.picking.ShelfArea;
import com.hitachi.warehouse.model.picking.shelffactory.AbstractShelfFactory;

public class KinkiShelfFactory
extends AbstractShelfFactory {
    private static KinkiShelfFactory shared = null;

    public static KinkiShelfFactory shared() {
        if (shared == null) {
            shared = new KinkiShelfFactory();
        }
        return shared;
    }

    @Override
    public Shelf shelfFromStrs(String colStr, String rowStr, String shelfNo, String shelfLevel) {
        ShelfArea shelfArea = new ShelfArea(colStr, rowStr);
        return new Shelf(shelfArea, shelfNo, shelfLevel);
    }
}

