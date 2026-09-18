/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.panels;

import com.hitachi.warehouse.gui.mapframe.AbstractMapPanel;
import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.mapmaker.MapMaker;
import com.hitachi.warehouse.mapmaker.networkgenerator.RectGrid;
import com.hitachi.warehouse.mapmaker.panels.inputs.MapInputHandler;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.AbstractRectangleObject;
import common.gui.Draw;
import java.awt.Color;
import java.awt.Font;
import java.awt.Graphics2D;
import java.awt.Point;
import java.awt.event.MouseEvent;

public class DebugPanel
extends AbstractMapPanel {
    MapMaker maker;
    RectGrid<AbstractRectangleObject> grid;
    InputHandler inputHandler;

    public DebugPanel(MapMaker maker) {
        this.maker = maker;
    }

    @Override
    protected void mapViewSet(MapView mapView) {
        this.inputHandler = new InputHandler(this, mapView);
        this.grid = new RectGrid<AbstractRectangleObject>(mapView.map().tl(), mapView.map().br(), 5000.0, AbstractRectangleObject.class);
        for (AbstractObject obj : mapView.map().objects()) {
            AbstractRectangleObject rect;
            if (!AbstractRectangleObject.class.isInstance(obj) || !(rect = (AbstractRectangleObject)obj).isObstructing()) continue;
            this.grid.add(rect);
        }
        this.grid.commit();
    }

    @Override
    protected void mapViewRemoved(MapView mapView) {
        this.inputHandler.kill();
    }

    @Override
    public void draw(Graphics2D g) {
        WorldMap map = this.mapView().map();
        if (map != null) {
            Coord from = this.inputHandler.regionStart();
            Coord coord = this.inputHandler.currentCoord();
            if (from != null && coord != null) {
                g.setColor(Color.RED);
                Draw.drawLine(g, super.mapView().screenPointForWorld(from), super.mapView().screenPointForWorld(coord));
                for (AbstractRectangleObject obj : this.grid.getClipping(from, coord)) {
                    obj.highlight(g, this.mapView());
                }
            }
            g.setFont(new Font("Arial", 1, 14));
            if (coord != null) {
                g.setColor(Color.RED);
                Point p = super.mapView().screenPointForWorld(coord);
                Draw.drawString(g, String.format("%.02f, %.02f", coord.x, coord.y), p.x, p.y);
            }
        }
    }

    public static class InputHandler
    extends MapInputHandler {
        public InputHandler(DebugPanel parent, MapView mapView) {
            super(parent.maker, mapView, true);
        }

        @Override
        public void pointHover(Coord coord) {
            this.mapView.repaint();
        }

        @Override
        public void pointClicked(Coord currentCoord, MouseEvent e) {
            this.mapView.repaint();
        }
    }
}

