/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.wrap;

import com.hitachi.warehouse.gui.mapframe.MapFrame;
import com.hitachi.warehouse.gui.mapframe.panels.WorldMapPanel;
import com.hitachi.warehouse.model.map.Waypoint;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.OneWayPassageObject;
import com.hitachi.warehouse.model.map.objects.ShelfObject;
import com.hitachi.warehouse.model.picking.ShelfArea;
import common.util.HashMapSet;
import java.io.File;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Set;

public class AisleManager {
    public final WorldMap map;
    private HashMap<ShelfArea, Aisle> aisleForShelfArea;
    private HashSet<Aisle> aisles = new HashSet();

    public AisleManager(WorldMap map) {
        this.map = map;
        HashMap<Waypoint, ShelfObject> shelfForWaypoint = new HashMap<Waypoint, ShelfObject>();
        HashMap<ShelfArea, Aisle> aisleForShelfArea = new HashMap<ShelfArea, Aisle>();
        HashMap<String, Aisle> aisleForCol = new HashMap<String, Aisle>();
        for (ShelfObject shelf : map.shelfObjects()) {
            Waypoint[] waypointArray = map.waypointsForRect(shelf);
            int n = waypointArray.length;
            int n2 = 0;
            while (n2 < n) {
                Waypoint waypoint = waypointArray[n2];
                shelfForWaypoint.put(waypoint, shelf);
                ++n2;
            }
            Aisle aisle = (Aisle)aisleForCol.get(shelf.shelf().colStr());
            if (aisle == null) {
                aisle = new Aisle();
                aisleForCol.put(shelf.shelf().colStr(), aisle);
            }
            aisle.shelves.add(shelf.shelf());
            aisleForShelfArea.put(shelf.shelf(), aisle);
        }
        HashMapSet<OneWayPassageObject, ShelfArea> shelvesForPassages = new HashMapSet<OneWayPassageObject, ShelfArea>();
        for (OneWayPassageObject passage : map.onewayPassageObjects()) {
            for (Waypoint waypoint : shelfForWaypoint.keySet()) {
                if (!passage.isInside(waypoint.coord())) continue;
                shelvesForPassages.put(passage, ((ShelfObject)shelfForWaypoint.get(waypoint)).shelf());
            }
        }
        for (OneWayPassageObject passage : shelvesForPassages.keySet()) {
            Aisle baseAisle = new Aisle();
            for (ShelfArea shelf : shelvesForPassages.get(passage)) {
                if (shelf.colStr().equals("70")) continue;
                Aisle aisle = (Aisle)aisleForShelfArea.get(shelf);
                baseAisle.shelves.addAll(aisle.shelves);
                aisleForShelfArea.put(shelf, baseAisle);
            }
            for (ShelfArea shelf : baseAisle.shelves) {
                aisleForShelfArea.put(shelf, baseAisle);
            }
        }
        this.aisleForShelfArea = aisleForShelfArea;
        this.aisles.addAll(aisleForShelfArea.values());
    }

    public boolean isInSameAisle(ShelfArea shelf1, ShelfArea shelf2) {
        return this.aisleForShelfArea.get(shelf1) == this.aisleForShelfArea.get(shelf2);
    }

    public Aisle aisleFor(ShelfArea shelf) {
        return this.aisleForShelfArea.get(shelf);
    }

    public Set<Aisle> aisles() {
        return this.aisles;
    }

    public static void main(String[] args) {
        WorldMap map = WorldMap.loadFrom(new File("../WarehouseAnalysis/data/kawajima_data/map.rmp"));
        AisleManager aisles = new AisleManager(map);
        new MapFrame((WorldMap)map).mapView.openChildView(new WorldMapPanel(false, true, false).setShowBeacons(false).setShowNetworks(false).setShowShelfWaypoints(false));
    }

    public static class Aisle {
        private HashSet<ShelfArea> shelves = new HashSet();

        public Set<ShelfArea> shelves() {
            return this.shelves;
        }

        public String toString() {
            return this.shelves.toString();
        }
    }
}

