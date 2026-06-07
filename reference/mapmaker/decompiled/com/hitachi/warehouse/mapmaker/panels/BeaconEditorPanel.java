/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.panels;

import com.hitachi.warehouse.bms.model.Beacon;
import com.hitachi.warehouse.gui.mapframe.AbstractMapPanel;
import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.mapmaker.MapMaker;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.BeaconObject;
import common.gui.Dragger;
import java.awt.Cursor;
import java.awt.Graphics2D;
import java.awt.Point;

public class BeaconEditorPanel
extends AbstractMapPanel {
    private MapMaker parent;
    Dragger dragger;
    BeaconObject draggingBeacon = null;

    public BeaconEditorPanel(MapMaker parent) {
        this.parent = parent;
    }

    @Override
    protected void mapViewSet(MapView mapView) {
        this.dragger = new Dragger();
        this.dragger.addListener(new Dragger.DraggerListener(){
            int numClicks = 0;
            Coord lastCoord = null;

            @Override
            public void mousedPressed(int origX, int origY) {
                int minDist = Integer.MAX_VALUE;
                BeaconObject nearestBeacon = null;
                for (BeaconObject obj : BeaconEditorPanel.this.mapView().map().beaconObjects()) {
                    Point centerPoint = BeaconEditorPanel.this.mapView().screenPointForWorld(obj.point());
                    int dist = Math.abs(origX - centerPoint.x) + Math.abs(origY - centerPoint.y);
                    if (dist >= minDist) continue;
                    minDist = dist;
                    nearestBeacon = obj;
                }
                if (minDist < 20) {
                    BeaconEditorPanel.this.draggingBeacon = nearestBeacon;
                    this.numClicks = 0;
                    BeaconEditorPanel.this.parent.showInfoForObject(nearestBeacon, null);
                } else {
                    BeaconEditorPanel.this.draggingBeacon = null;
                    ++this.numClicks;
                }
                this.lastCoord = BeaconEditorPanel.this.mapView().coordForScreen(origX, origY);
            }

            @Override
            public void mouseReleased() {
                if (this.numClicks >= 2) {
                    System.out.println("add beacon!");
                    BeaconObject newBeaconObj = new BeaconObject();
                    Beacon newBeacon = new Beacon("ID", "Name");
                    newBeaconObj.setBeacon(newBeacon);
                    newBeacon.setCoord(this.lastCoord);
                    try {
                        BeaconEditorPanel.this.mapView().map().startWrite();
                        BeaconEditorPanel.this.mapView().map().add(newBeaconObj);
                    }
                    finally {
                        BeaconEditorPanel.this.mapView().map().endWrite();
                    }
                    BeaconEditorPanel.this.parent.showInfoForObject(newBeaconObj, null);
                    BeaconEditorPanel.this.draggingBeacon = newBeaconObj;
                    this.numClicks = 0;
                }
            }

            @Override
            public void hover(int origX, int origY) {
                this.numClicks = 0;
                int minDist = Integer.MAX_VALUE;
                for (BeaconObject obj : BeaconEditorPanel.this.mapView().map().beaconObjects()) {
                    Point centerPoint = BeaconEditorPanel.this.mapView().screenPointForWorld(obj.point());
                    int dist = Math.abs(origX - centerPoint.x) + Math.abs(origY - centerPoint.y);
                    if (dist >= minDist) continue;
                    minDist = dist;
                }
                if (minDist < 20) {
                    ((BeaconEditorPanel)BeaconEditorPanel.this).parent.mapFrame.setCursor(new Cursor(1));
                } else {
                    ((BeaconEditorPanel)BeaconEditorPanel.this).parent.mapFrame.setCursor(new Cursor(0));
                }
                this.lastCoord = BeaconEditorPanel.this.mapView().coordForScreen(origX, origY);
            }

            @Override
            public void dragged(int origX, int origY, int newX, int newY) {
                this.numClicks = 0;
                this.lastCoord = BeaconEditorPanel.this.mapView().coordForScreen(newX, newY);
            }
        });
        super.mapView().addMouseListener(this.dragger);
        super.mapView().addMouseMotionListener(this.dragger);
    }

    @Override
    protected void mapViewRemoved(MapView mapView) {
        mapView.removeMouseMotionListener(this.dragger);
        mapView.removeMouseListener(this.dragger);
    }

    @Override
    public boolean dragged(int origX, int origY, int newX, int newY) {
        if (this.draggingBeacon != null) {
            if (this.draggingBeacon.getEditLock()) {
                return false;
            }
            Coord coord = this.mapView().coordForScreen(newX, newY);
            try {
                this.mapView().map().startWrite();
                this.draggingBeacon.beacon().setCoord(coord);
            }
            finally {
                this.mapView().map().endWrite();
            }
            this.mapView().map().dispatchChangedEvent();
            return false;
        }
        return true;
    }

    @Override
    public void draw(Graphics2D g) {
        WorldMap map = super.mapView().map();
        for (BeaconObject obj : map.beaconObjects()) {
            if (obj == this.draggingBeacon) {
                obj.highlight(g, this.mapView());
                continue;
            }
            obj.paint(g, this.mapView());
        }
    }
}

