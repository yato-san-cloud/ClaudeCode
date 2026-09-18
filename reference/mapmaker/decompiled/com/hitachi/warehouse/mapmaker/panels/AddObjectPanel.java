/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.panels;

import com.hitachi.warehouse.gui.mapframe.AbstractMapPanel;
import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.mapmaker.MapMaker;
import com.hitachi.warehouse.mapmaker.OperationMode;
import com.hitachi.warehouse.mapmaker.panels.inputs.MapInputHandler;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.ConstrainedAreaObject;
import com.hitachi.warehouse.model.map.objects.FreeShelfObject;
import com.hitachi.warehouse.model.map.objects.StairsObject;
import com.hitachi.warehouse.model.map.objects.StationObject;
import com.hitachi.warehouse.model.map.objects.WallObject;
import com.hitachi.warehouse.model.picking.FreeShelfArea;
import common.gui.Draw;
import java.awt.Color;
import java.awt.Graphics2D;
import java.util.HashSet;
import javax.swing.JOptionPane;

public class AddObjectPanel
extends AbstractMapPanel {
    private MapMaker maker;
    private InputHandler inputHandler;

    public AddObjectPanel(MapMaker maker) {
        this.maker = maker;
    }

    @Override
    protected void mapViewSet(MapView mapView) {
        this.inputHandler = new InputHandler(mapView, this);
        this.maker.addMapChangedListener(this.inputHandler);
        this.inputHandler.updatePointHintsFromMap();
    }

    @Override
    protected void mapViewRemoved(MapView mapView) {
        this.inputHandler.kill();
    }

    @Override
    public void draw(Graphics2D g) {
        int fromY;
        int fromX;
        Coord origClickedCoord = this.inputHandler.regionStart();
        Coord currentCoord = this.inputHandler.currentCoord();
        if (origClickedCoord != null && currentCoord != null) {
            fromX = this.mapView().screenXForWorld(Math.min(origClickedCoord.x, currentCoord.x));
            fromY = this.mapView().screenYForWorld(Math.min(origClickedCoord.y, currentCoord.y));
            int toX = this.mapView().screenXForWorld(Math.max(origClickedCoord.x, currentCoord.x));
            int toY = this.mapView().screenYForWorld(Math.max(origClickedCoord.y, currentCoord.y));
            g.setColor(Color.RED);
            g.drawRect(fromX, fromY, toX - fromX, toY - fromY);
        }
        if (currentCoord != null) {
            fromX = this.mapView().screenXForWorld(currentCoord.x);
            fromY = this.mapView().screenYForWorld(currentCoord.y);
            g.setColor(Color.RED);
            Draw.drawCross(g, fromX, fromY, 5);
        }
        Double snappedToX = this.inputHandler.snappedToX();
        Double snappedToY = this.inputHandler.snappedToY();
        g.setColor(Color.GREEN);
        if (snappedToX != null) {
            int screenX = this.mapView().screenXForWorld(snappedToX);
            g.drawLine(screenX, 0, screenX, this.mapView().getHeight());
        }
        if (snappedToY != null) {
            int screenY = this.mapView().screenYForWorld(snappedToY);
            g.drawLine(0, screenY, this.mapView().getWidth(), screenY);
        }
    }

    private void addShelfObject(Coord tl, Coord br) {
        WorldMap map = super.mapView().map();
        if (map != null) {
            HashSet<String> shelfNamesAlreadyCreated = new HashSet<String>();
            for (FreeShelfObject shelf : map.freeShelfObjects()) {
                shelfNamesAlreadyCreated.add(shelf.shelf().name);
            }
            String foundName = "";
            for (String cand : map.shelfNameManager().names()) {
                if (shelfNamesAlreadyCreated.contains(cand)) continue;
                foundName = cand;
                break;
            }
            FreeShelfObject defaultObject = new FreeShelfObject();
            defaultObject.setShelf(new FreeShelfArea(foundName));
            defaultObject.setBounds(tl, br);
            try {
                map.startWrite();
                map.add(defaultObject);
            }
            finally {
                map.endWrite();
            }
            this.maker.showInfoForObject(defaultObject, null);
        }
    }

    private void addWallObject(Coord tl, Coord br) {
        WorldMap map = super.mapView().map();
        if (map != null) {
            WallObject wallObject = new WallObject();
            wallObject.setBounds(tl, br);
            try {
                map.startWrite();
                map.add(wallObject);
            }
            finally {
                map.endWrite();
            }
            this.maker.showInfoForObject(wallObject, null);
        }
    }

    private void addConstrainedArea(Coord tl, Coord br) {
        WorldMap map = super.mapView().map();
        if (map != null) {
            ConstrainedAreaObject areaObject = new ConstrainedAreaObject();
            areaObject.setBounds(tl, br);
            try {
                map.startWrite();
                map.add(areaObject);
            }
            finally {
                map.endWrite();
            }
            this.maker.showInfoForObject(areaObject, null);
        }
    }

    private void addStationObject(Coord tl, Coord br) {
        WorldMap map = super.mapView().map();
        if (map != null) {
            StationObject stationObject = new StationObject();
            stationObject.setBounds(tl, br);
            try {
                map.startWrite();
                map.add(stationObject);
            }
            finally {
                map.endWrite();
            }
            this.maker.showInfoForObject(stationObject, null);
        }
    }

    private void addStairsObject(Coord tl, Coord br) {
        WorldMap map = super.mapView().map();
        if (map != null) {
            StairsObject stairsObject = new StairsObject();
            stairsObject.setBounds(tl, br);
            try {
                map.startWrite();
                map.add(stairsObject);
            }
            finally {
                map.endWrite();
            }
            this.maker.showInfoForObject(stairsObject, null);
        }
    }

    public static class InputHandler
    extends MapInputHandler {
        AddObjectPanel parentView;

        public InputHandler(MapView mapView, AddObjectPanel parentView) {
            super(parentView.maker, mapView, true);
            this.parentView = parentView;
        }

        @Override
        public void pointHover(Coord coord) {
            this.mapView.repaint();
        }

        @Override
        public void regionSelected(Coord regionFrom, Coord regionTo) {
            double x = Math.abs(regionFrom.x - regionTo.x) < ((AddObjectPanel)this.parentView).maker.ObjectMinWidthSize ? regionFrom.x + ((AddObjectPanel)this.parentView).maker.ObjectMinWidthSize : regionTo.x;
            double y = Math.abs(regionFrom.y - regionTo.y) < ((AddObjectPanel)this.parentView).maker.ObjectMinHeightSize ? regionFrom.y + ((AddObjectPanel)this.parentView).maker.ObjectMinHeightSize : regionTo.y;
            regionTo = new Coord(x, y);
            double left = Math.min(regionFrom.x, regionTo.x);
            double right = Math.max(regionFrom.x, regionTo.x);
            double top = Math.min(regionFrom.y, regionTo.y);
            double bottom = Math.max(regionFrom.y, regionTo.y);
            Coord tl = new Coord(left, top);
            Coord br = new Coord(right, bottom);
            boolean OverlapObject = false;
            for (AbstractObject obj : this.parentView.maker.map().objects()) {
                if ((this.parentView.maker.mode() == OperationMode.kAddShelf || this.parentView.maker.mode() == OperationMode.kAddConstrainedArea || this.parentView.maker.mode() == OperationMode.kAddStation || this.parentView.maker.mode() == OperationMode.kAddStairs) && (FreeShelfObject.class.isInstance(obj) || WallObject.class.isInstance(obj) || ConstrainedAreaObject.class.isInstance(obj) || StationObject.class.isInstance(obj) || StairsObject.class.isInstance(obj)) && tl.x < obj.boundBR().x && tl.y < obj.boundBR().y && br.x > obj.boundTL().x && br.y > obj.boundTL().y) {
                    OverlapObject = true;
                }
                if (this.parentView.maker.mode() != OperationMode.kAddWall || !FreeShelfObject.class.isInstance(obj) && !ConstrainedAreaObject.class.isInstance(obj) && !StationObject.class.isInstance(obj) && !StairsObject.class.isInstance(obj) || !(tl.x < obj.boundBR().x) || !(tl.y < obj.boundBR().y) || !(br.x > obj.boundTL().x) || !(br.y > obj.boundTL().y)) continue;
                OverlapObject = true;
            }
            if (OverlapObject) {
                JOptionPane.showMessageDialog(((AddObjectPanel)this.parentView).maker.mapFrame, "オブジェクトが重なっています。", "エラー", 0);
                return;
            }
            if (this.parentView.maker.mode() == OperationMode.kAddShelf) {
                this.parentView.addShelfObject(regionFrom, regionTo);
            } else if (this.parentView.maker.mode() == OperationMode.kAddWall) {
                this.parentView.addWallObject(regionFrom, regionTo);
            } else if (this.parentView.maker.mode() == OperationMode.kAddStation) {
                this.parentView.addStationObject(regionFrom, regionTo);
            } else if (this.parentView.maker.mode() == OperationMode.kAddConstrainedArea) {
                this.parentView.addConstrainedArea(regionFrom, regionTo);
            } else if (this.parentView.maker.mode() == OperationMode.kAddStairs) {
                this.parentView.addStairsObject(regionFrom, regionTo);
            }
            this.mapView.repaint();
        }
    }
}

