/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.gui.mapframe;

import com.hitachi.warehouse.gui.mapframe.MapView;
import java.awt.Graphics2D;

public abstract class AbstractMapPanel {
    private MapView mapView;

    protected void mapViewSet(MapView mapView) {
    }

    protected void mapViewRemoved(MapView mapView) {
    }

    public boolean dragged(int origX, int origY, int newX, int newY) {
        return true;
    }

    public void dragDone() {
    }

    public final void setMapView(MapView mapView) {
        this.mapView = mapView;
        this.mapViewSet(mapView);
    }

    public final void removedFromMapView(MapView mapView) {
        this.mapViewRemoved(mapView);
    }

    public final MapView mapView() {
        return this.mapView;
    }

    public void repaint() {
        if (this.mapView != null) {
            this.mapView.repaint();
        }
    }

    public abstract void draw(Graphics2D var1);
}

