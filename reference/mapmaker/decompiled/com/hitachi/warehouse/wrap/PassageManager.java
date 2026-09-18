/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.wrap;

import com.hitachi.warehouse.model.map.Waypoint;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.OneWayPassageObject;
import com.hitachi.warehouse.model.map.objects.ShelfObject;
import com.hitachi.warehouse.model.picking.ShelfArea;
import common.util.HashMapSet;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Set;

public class PassageManager {
    public final WorldMap map;
    private HashMap<Waypoint, OneWayPassageObject> passageForWaypoint = new HashMap();
    private HashMapSet<ShelfArea, OneWayPassageObject> passageForShelf = new HashMapSet();

    public PassageManager(WorldMap map) {
        this.map = map;
        HashMap<Waypoint, ShelfObject> shelfForWaypoint = new HashMap<Waypoint, ShelfObject>();
        for (ShelfObject shelf : map.shelfObjects()) {
            Waypoint[] waypointArray = map.waypointsForRect(shelf);
            int n = waypointArray.length;
            int n2 = 0;
            while (n2 < n) {
                Waypoint waypoint = waypointArray[n2];
                shelfForWaypoint.put(waypoint, shelf);
                ++n2;
            }
        }
        for (OneWayPassageObject passage : map.onewayPassageObjects()) {
            for (Waypoint waypoint : shelfForWaypoint.keySet()) {
                if (!passage.isInside(waypoint.coord())) continue;
                this.passageForWaypoint.put(waypoint, passage);
                this.passageForShelf.put(((ShelfObject)shelfForWaypoint.get(waypoint)).shelf(), passage);
            }
        }
    }

    public boolean isInSamePassage(ShelfArea shelf1, ShelfArea shelf2) {
        Set<OneWayPassageObject> passages1 = this.passageForShelf.get(shelf1);
        Set<OneWayPassageObject> passages2 = this.passageForShelf.get(shelf2);
        for (OneWayPassageObject passage : passages1) {
            if (!passages2.contains(passage)) continue;
            return true;
        }
        return false;
    }

    public OneWayPassageObject passageForWaypoint(Waypoint waypoint) {
        return this.passageForWaypoint.get(waypoint);
    }

    public Set<OneWayPassageObject> passagesForShelf(ShelfArea shelf) {
        return this.passageForShelf.get(shelf);
    }

    public Collection<OneWayPassageObject> passages() {
        HashSet<OneWayPassageObject> passages = new HashSet<OneWayPassageObject>();
        passages.addAll(this.passageForWaypoint.values());
        return passages;
    }
}

