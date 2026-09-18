/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.map;

import com.hitachi.warehouse.model.map.WorldMap;

public interface MapProxy {
    public void addMapChangedListener(WorldMap.WorldMapChangedListener var1);

    public void removeMapChangedListener(WorldMap.WorldMapChangedListener var1);
}

