/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.panels;

import com.hitachi.warehouse.gui.mapframe.AbstractMapPanel;
import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.mapmaker.MapMaker;
import com.hitachi.warehouse.mapmaker.common.NumericCheck;
import com.hitachi.warehouse.mapmaker.panels.inputs.MapInputHandler;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.map.WorldMap;
import common.gui.Draw;
import common.gui.InputDialog;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Font;
import java.awt.Graphics2D;
import java.awt.Point;
import java.awt.event.MouseEvent;

public class DistanceSetPanel
extends AbstractMapPanel {
    static MapMaker maker;
    InputHandler inputHandler;

    public DistanceSetPanel(MapMaker maker) {
        DistanceSetPanel.maker = maker;
    }

    @Override
    protected void mapViewSet(MapView mapView) {
        this.inputHandler = new InputHandler(this, mapView);
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
            Coord to = this.inputHandler.currentCoord();
            if (from != null && to != null) {
                g.setFont(new Font(g.getFont().getName(), 0, 12));
                g.setStroke(new BasicStroke(5.0f));
                double distLine = 0.0;
                g.setColor(Color.GREEN);
                Point mousePoint = this.mapView().screenPointForWorld(to);
                Draw.drawLine(g, this.mapView().screenPointForWorld(from), mousePoint);
                distLine = from.distTo(to) / 1000.0;
            }
        }
    }

    public static void distanceSet(Coord regionFrom, Coord regionTo) {
        Coord br;
        Coord tl;
        NumericCheck NC = new NumericCheck();
        double originalDistance = regionFrom.distTo(regionTo);
        String strDistance = InputDialog.showDialog(null, "２点間の距離（mm）を入力してください。", "２点間の距離（mm）を入力してください。", String.valueOf(originalDistance));
        if (!NC.isNumericDouble(strDistance)) {
            return;
        }
        double distance = Double.parseDouble(strDistance);
        if (distance <= 0.0) {
            return;
        }
        double ratio = (distance - originalDistance) / originalDistance;
        if (maker.map().bgImg() != null) {
            tl = maker.map().bgImg().boundTL();
            br = maker.map().bgImg().boundBR();
        } else {
            tl = maker.map().tl();
            br = maker.map().br();
        }
        Coord newtl = new Coord(tl.x, tl.y);
        double x = br.x + (br.x - tl.x) * ratio;
        double y = br.y + (br.y - tl.y) * ratio;
        Coord newbr = new Coord(x, y);
        if (maker.map().bgImg() != null) {
            try {
                maker.map().startWrite();
                maker.map().bgImg().setBounds(newtl, newbr);
            }
            finally {
                maker.map().endWrite();
            }
        }
        maker.setBounds(newtl, newbr);
        DistanceSetPanel.maker.mapFrame.repaint();
    }

    public static class InputHandler
    extends MapInputHandler {
        public InputHandler(DistanceSetPanel parent, MapView mapView) {
            super(maker, mapView, true);
        }

        @Override
        public void pointHover(Coord coord) {
            this.mapView.repaint();
        }

        @Override
        public void pointClicked(Coord currentCoord, MouseEvent e) {
            this.mapView.repaint();
        }

        @Override
        public void regionSelected(Coord regionFrom, Coord regionTo) {
            DistanceSetPanel.distanceSet(regionFrom, regionTo);
        }
    }
}

