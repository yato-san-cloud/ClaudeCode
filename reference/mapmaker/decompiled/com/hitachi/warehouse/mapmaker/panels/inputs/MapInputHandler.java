/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.panels.inputs;

import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.map.MapProxy;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.AbstractRectangleObject;
import common.ds.DoubleKeyedArray;
import common.gui.MouseClickMotionAdapter;
import java.awt.event.KeyEvent;
import java.awt.event.KeyListener;
import java.awt.event.MouseEvent;

public class MapInputHandler
extends MouseClickMotionAdapter
implements WorldMap.WorldMapChangedListener,
KeyListener {
    protected final MapView mapView;
    private boolean canSelectRegion = false;
    private boolean allowSnap = true;
    MapProxy mapProxy;
    private Double snappedToX = null;
    private Double snappedToY = null;
    private Coord regionStart = null;
    private Coord currentCoord = null;
    private DoubleKeyedArray<Coord> pointHint_xs = new DoubleKeyedArray();
    private DoubleKeyedArray<Coord> pointHint_ys = new DoubleKeyedArray();

    public void setCanSelectRegion(boolean canSelectRegion) {
        this.canSelectRegion = canSelectRegion;
        if (!canSelectRegion) {
            this.regionStart = null;
        }
    }

    public MapInputHandler setAllowSnap(boolean allow) {
        this.allowSnap = allow;
        return this;
    }

    public MapInputHandler(MapProxy mapProxy, MapView mapView, boolean canSelectRegion) {
        this.mapProxy = mapProxy;
        this.mapView = mapView;
        this.canSelectRegion = canSelectRegion;
        mapProxy.addMapChangedListener(this);
        mapView.addMouseListener(this);
        mapView.addMouseMotionListener(this);
        mapView.addKeyListener(this);
    }

    public void kill() {
        this.mapProxy.removeMapChangedListener(this);
        this.mapView.removeMouseListener(this);
        this.mapView.removeMouseMotionListener(this);
        this.mapView.removeKeyListener(this);
    }

    public Coord regionStart() {
        return this.regionStart;
    }

    public Coord currentCoord() {
        return this.currentCoord;
    }

    public boolean isInRegionSelection() {
        return this.regionStart != null;
    }

    public void clearRegionStart() {
        this.regionStart = null;
    }

    public Double snappedToX() {
        return this.snappedToX;
    }

    public Double snappedToY() {
        return this.snappedToY;
    }

    public void pointHover(Coord coord) {
    }

    public void pointClicked(Coord coord, MouseEvent event) {
    }

    public void pointClickedOther(Coord coord, MouseEvent event) {
    }

    public void mouseUp() {
    }

    public void regionSelected(Coord regionFrom, Coord regionTo) {
    }

    @Override
    public void mouseMoved(MouseEvent arg0) {
        this.currentCoord = this.coordForPoint(arg0.getX(), arg0.getY(), this.allowSnap && !arg0.isControlDown());
        this.pointHover(this.currentCoord);
    }

    @Override
    public final void mousePressed(MouseEvent arg0) {
        Coord coord = this.coordForPoint(arg0.getX(), arg0.getY(), this.allowSnap && !arg0.isControlDown());
        switch (arg0.getButton()) {
            case 1: {
                if (this.regionStart != null) {
                    this.regionSelected(this.regionStart, coord);
                    this.regionStart = null;
                } else if (this.canSelectRegion) {
                    this.regionStart = coord;
                }
                this.pointClicked(coord, arg0);
                break;
            }
            default: {
                this.regionStart = null;
                this.pointClickedOther(coord, arg0);
            }
        }
    }

    @Override
    public void mouseReleased(MouseEvent e) {
        this.mouseUp();
    }

    public Coord coordForPoint(int x, int y, boolean doSnap) {
        double origX = this.mapView.worldXForScreen(x);
        double origY = this.mapView.worldYForScreen(y);
        if (doSnap) {
            this.snappedToY = null;
            this.snappedToX = null;
            Double nearestX = this.pointHint_xs.closestKeyForKey(origX);
            Double nearestY = this.pointHint_ys.closestKeyForKey(origY);
            if (nearestX != null && nearestY != null) {
                int nearestScreenX = this.mapView.screenXForWorld(nearestX);
                int nearestScreenY = this.mapView.screenYForWorld(nearestY);
                if (Math.abs(nearestScreenX - x) <= 10) {
                    origX = nearestX;
                    this.snappedToX = origX;
                }
                if (Math.abs(nearestScreenY - y) <= 10) {
                    origY = nearestY;
                    this.snappedToY = origY;
                }
            }
        }
        return new Coord(origX, origY);
    }

    public Double snapX(int x) {
        int nearestScreen;
        double orig = this.mapView.worldXForScreen(x);
        Double nearest = this.pointHint_xs.closestKeyForKey(orig);
        if (nearest != null && Math.abs((nearestScreen = this.mapView.screenXForWorld(nearest)) - x) <= 10) {
            return nearest;
        }
        return null;
    }

    public Double snapY(int y) {
        int nearestScreen;
        double orig = this.mapView.worldYForScreen(y);
        Double nearest = this.pointHint_ys.closestKeyForKey(orig);
        if (nearest != null && Math.abs((nearestScreen = this.mapView.screenYForWorld(nearest)) - y) <= 10) {
            return nearest;
        }
        return null;
    }

    public void setPointHints(DoubleKeyedArray<Coord> xs, DoubleKeyedArray<Coord> ys) {
        this.pointHint_xs = xs;
        this.pointHint_ys = ys;
    }

    public void updatePointHintsFromMap() {
        WorldMap map = this.mapView.map();
        if (map != null) {
            try {
                map.startRead();
                DoubleKeyedArray<Coord> xs = new DoubleKeyedArray<Coord>();
                DoubleKeyedArray<Coord> ys = new DoubleKeyedArray<Coord>();
                xs.add(map.tl().x, map.tl());
                xs.add(map.br().x, map.br());
                ys.add(map.tl().y, map.tl());
                ys.add(map.br().y, map.br());
                for (AbstractObject obj : map.objects()) {
                    if (!AbstractRectangleObject.class.isInstance(obj)) continue;
                    AbstractRectangleObject rectObj = (AbstractRectangleObject)obj;
                    xs.add(rectObj.tl().x, rectObj.tl());
                    xs.add(rectObj.br().x, rectObj.br());
                    ys.add(rectObj.tl().y, rectObj.tl());
                    ys.add(rectObj.br().y, rectObj.br());
                }
                this.setPointHints(xs, ys);
            }
            finally {
                map.endRead();
            }
        }
    }

    @Override
    public void mapChanged(WorldMap map) {
        this.updatePointHintsFromMap();
    }

    @Override
    public void keyTyped(KeyEvent e) {
    }

    @Override
    public void keyPressed(KeyEvent e) {
    }

    @Override
    public void keyReleased(KeyEvent e) {
    }
}

