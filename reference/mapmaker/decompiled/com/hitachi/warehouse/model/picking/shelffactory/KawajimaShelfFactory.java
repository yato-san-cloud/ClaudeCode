/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.picking.shelffactory;

import com.hitachi.warehouse.model.picking.Shelf;
import com.hitachi.warehouse.model.picking.ShelfArea;
import com.hitachi.warehouse.model.picking.shelffactory.AbstractShelfFactory;

public class KawajimaShelfFactory
extends AbstractShelfFactory {
    private static KawajimaShelfFactory shared = null;

    public static KawajimaShelfFactory shared() {
        if (shared == null) {
            shared = new KawajimaShelfFactory();
        }
        return shared;
    }

    @Override
    public Shelf shelfFromStrs(String colStr, String rowStr, String shelfNo, String shelfLevel) {
        if (colStr.matches("7.")) {
            if (colStr.matches("77")) {
                rowStr = "SE";
            } else {
                rowStr = shelfNo;
                shelfNo = "1";
            }
        } else if (colStr.matches("EO")) {
            colStr = "70";
            rowStr = shelfNo;
        } else if (colStr.matches("HO")) {
            colStr = "78";
            rowStr = shelfNo;
            shelfNo = "1";
        }
        ShelfArea shelfArea = new ShelfArea(colStr, rowStr);
        return new Shelf(shelfArea, shelfNo, shelfLevel);
    }
}

