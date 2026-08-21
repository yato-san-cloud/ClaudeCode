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
import com.hitachi.warehouse.model.map.Waypoint;
import com.hitachi.warehouse.model.map.WaypointGraph;
import com.hitachi.warehouse.model.map.WorldMap;
import common.gui.Draw;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Font;
import java.awt.Graphics2D;
import java.awt.Point;
import java.awt.Rectangle;
import java.awt.event.MouseEvent;
import java.util.List;

public class RulerPanel
extends AbstractMapPanel {
    MapMaker maker;
    InputHandler inputHandler;

    public RulerPanel(MapMaker maker) {
        this.maker = maker;
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
                Waypoint toWaypoint;
                WaypointGraph graph;
                g.setFont(new Font(g.getFont().getName(), 0, 12));
                g.setStroke(new BasicStroke(5.0f));
                double distLine = 0.0;
                g.setColor(Color.GREEN);
                Point mousePoint = this.mapView().screenPointForWorld(to);
                Draw.drawLine(g, this.mapView().screenPointForWorld(from), mousePoint);
                distLine = from.distTo(to) / 1000.0;
                double distPath = 0.0;
                int numWaypoints = 0;
                WaypointGraph waypointGraph = graph = this.maker.mode() == OperationMode.kRulerCart ? map.cartGraph() : map.walkGraph();
                if (graph.waypointKDTree() == null) {
                    this.inputHandler.clearRegionStart();
                    return;
                }
                Waypoint fromWaypoint = graph.waypointKDTree().nearestNeighbour(from.getVector());
                List<Waypoint> path = graph.shortestPathBetween(fromWaypoint, toWaypoint = graph.waypointKDTree().nearestNeighbour(to.getVector()));
                if (path != null) {
                    g.setColor(Color.RED);
                    g.setFont(new Font("Arial", 1, 20));
                    Point prev = null;
                    for (Waypoint next : path) {
                        Point nextPoint = this.mapView().screenPointForWorld(next.coord());
                        Point p = this.mapView().screenPointForWorld(next.coord());
                        Draw.drawString(g, "" + next, p.x, p.y);
                        if (prev != null) {
                            Draw.drawCircle(g, prev, 3);
                            Draw.drawLine(g, prev, nextPoint);
                        }
                        prev = nextPoint;
                    }
                    Draw.drawCircle(g, prev, 5);
                    distPath = WaypointGraph.distForPath(path) / 1000.0;
                    numWaypoints = path.size();
                }
                String str = "line: " + String.format("%.02fm", distLine) + "\n" + "path: " + String.format("%.02fm", distPath) + "\n" + "num: " + numWaypoints;
                Rectangle rect = Draw.getStringBounds(g, str, mousePoint.x, mousePoint.y);
                g.setColor(Color.WHITE);
                g.fillRect(rect.x, rect.y, rect.width, rect.height);
                g.setColor(Color.RED);
                Draw.drawString(g, str, mousePoint.x, mousePoint.y);
            }
        }
    }

    public static class InputHandler
    extends MapInputHandler {
        public InputHandler(RulerPanel parent, MapView mapView) {
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

