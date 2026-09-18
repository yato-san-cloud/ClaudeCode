/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker;

import com.hitachi.warehouse.mapmaker.WorldMapExtension;
import com.hitachi.warehouse.model.map.objects.StairsObject;
import java.io.Serializable;

public class StairsBetweenDistance
implements Serializable {
    private static final long serialVersionUID = -8468453201122970038L;
    public WorldMapExtension FromFloor;
    public StairsObject FromStairsObject;
    public WorldMapExtension ToFloor;
    public StairsObject ToStairsObject;
    public double Distance;

    StairsBetweenDistance(WorldMapExtension FromFloor, StairsObject FromStairsObject, WorldMapExtension ToFloor, StairsObject ToStairsObject, double Distance) {
        this.FromFloor = FromFloor;
        this.FromStairsObject = FromStairsObject;
        this.ToFloor = ToFloor;
        this.ToStairsObject = ToStairsObject;
        this.Distance = Distance;
    }
}

