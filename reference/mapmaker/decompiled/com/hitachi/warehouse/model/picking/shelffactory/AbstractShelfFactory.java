/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.picking.shelffactory;

import com.hitachi.warehouse.model.picking.Shelf;

public abstract class AbstractShelfFactory {
    public abstract Shelf shelfFromStrs(String var1, String var2, String var3, String var4);
}

