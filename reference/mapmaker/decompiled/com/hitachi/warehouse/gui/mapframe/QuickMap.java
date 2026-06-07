/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.gui.mapframe;

import com.hitachi.warehouse.gui.mapframe.AbstractMapPanel;
import com.hitachi.warehouse.gui.mapframe.MapFrame;
import com.hitachi.warehouse.gui.mapframe.panels.WorldMapPanel;
import com.hitachi.warehouse.model.map.WorldMap;
import javax.swing.SwingUtilities;

public abstract class QuickMap
extends AbstractMapPanel {
    public final WorldMap map;
    private MapFrame mapFrame;

    public QuickMap(WorldMap _map) {
        this.map = _map;
        SwingUtilities.invokeLater(new Runnable(){

            @Override
            public void run() {
                QuickMap.this.mapFrame = new MapFrame(QuickMap.this.map);
                ((QuickMap)QuickMap.this).mapFrame.mapView.openChildView(new WorldMapPanel().setShowOriginPosition(true).setShowBackgroundImage(false).setShowNetworks(false).setShowBeacons(false).setShowShelfWaypoints(false));
                ((QuickMap)QuickMap.this).mapFrame.mapView.openChildView(QuickMap.this);
            }
        });
    }
}

