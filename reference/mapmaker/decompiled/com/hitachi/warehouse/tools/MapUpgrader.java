/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.tools;

import com.hitachi.warehouse.gui.mapframe.MapFrame;
import com.hitachi.warehouse.gui.mapframe.panels.WorldMapPanel;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.ConstrainedAreaObject;
import com.hitachi.warehouse.model.map.objects.FreeShelfObject;
import com.hitachi.warehouse.model.map.objects.OneWayPassageObject;
import com.hitachi.warehouse.model.map.objects.ShelfObject;
import com.hitachi.warehouse.model.picking.FreeShelfArea;
import java.io.File;
import java.util.ArrayList;

public class MapUpgrader {
    public static WorldMap updateVersion(WorldMap map) {
        while (map.internalVersion() < 3) {
            System.out.println("upgrading from [" + map.internalVersion() + "]");
            if (map.internalVersion() == 0) {
                ArrayList<OneWayPassageObject> purge = new ArrayList<OneWayPassageObject>();
                for (OneWayPassageObject passage : map.onewayPassageObjects()) {
                    purge.add(passage);
                    ConstrainedAreaObject constrainedArea = new ConstrainedAreaObject();
                    constrainedArea.setBounds(passage.tl(), passage.br());
                    map.add(constrainedArea);
                }
                for (OneWayPassageObject passage : purge) {
                    map.remove(passage);
                }
                map.updateInternalVersion(1);
            } else if (map.internalVersion() == 1) {
                ArrayList<ShelfObject> shelves = new ArrayList<ShelfObject>();
                for (ShelfObject shelf : map.shelfObjects()) {
                    FreeShelfObject newShelf = new FreeShelfObject();
                    newShelf.setBounds(shelf.tl(), shelf.br());
                    newShelf.setShelf(new FreeShelfArea(shelf.shelf().toString()));
                    newShelf.setShelfColor(shelf.shelfColor());
                    map.add(newShelf);
                    shelves.add(shelf);
                }
                for (ShelfObject shelf : shelves) {
                    map.remove(shelf);
                }
                map.updateInternalVersion(2);
            } else if (map.internalVersion() == 2) {
                for (AbstractObject obj : map.obstacleObjects()) {
                    obj.setEditLock(false);
                }
                map.updateInternalVersion(3);
            } else {
                System.err.println("unknown version: " + map.internalVersion());
                return map;
            }
            System.out.println(" -> " + map.internalVersion());
        }
        return map;
    }

    public static void main(String[] args) {
        WorldMap map = WorldMap.loadFrom(new File("/Users/ken/map.rmp"));
        map = MapUpgrader.updateVersion(map);
        int currentVersion = map.internalVersion();
        System.out.println(map.internalVersion());
        MapFrame viewer = new MapFrame(map);
        viewer.mapView.openChildView(new WorldMapPanel().setShowNetworks(false));
    }
}

