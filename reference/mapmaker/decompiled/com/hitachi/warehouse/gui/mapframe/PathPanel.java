/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.gui.mapframe;

import com.hitachi.warehouse.gui.mapframe.AbstractMapPanel;
import com.hitachi.warehouse.gui.mapframe.MapFrame;
import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.gui.mapframe.panels.WorldMapPanel;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.map.Waypoint;
import com.hitachi.warehouse.model.map.WorldMap;
import common.ds.ListUtil;
import common.gui.Draw;
import common.util.ColorUtil;
import common.util.MathUtil;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.event.MouseEvent;
import java.awt.event.MouseMotionAdapter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class PathPanel
extends AbstractMapPanel {
    WorldMap worldMap;
    Object lock = new Object();
    List<Coord> internPaths = null;
    List<Coord> origWaypoints = null;
    Integer currentSelectedWaypoint = null;
    Map<Coord, Integer> idxForWaypoint = new HashMap<Coord, Integer>();
    Color fixedColor = null;
    boolean showWaypoints = true;
    BasicStroke strokeThin = new BasicStroke(3.0f);
    BasicStroke strokeThick = new BasicStroke(5.0f);

    public PathPanel(WorldMap worldMap) {
        this.worldMap = worldMap;
    }

    public static List<Waypoint> appendStartEndPoints(Waypoint startEndPoint, List<Waypoint> waypoints) {
        ArrayList<Waypoint> path = new ArrayList<Waypoint>();
        path.add(startEndPoint);
        path.addAll(waypoints);
        path.add(startEndPoint);
        return path;
    }

    public void setWaypoints(Waypoint startEndPoint, List<Waypoint> waypoints) {
        this.setWaypoints(PathPanel.appendStartEndPoints(startEndPoint, waypoints));
    }

    public void setWaypoints(Waypoint ... waypoints) {
        this.setWaypoints(ListUtil.arrayToList(waypoints));
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void setWaypoints(List<Waypoint> waypoints) {
        Object object = this.lock;
        synchronized (object) {
            this.internPaths = new ArrayList<Coord>();
            this.idxForWaypoint = new HashMap<Coord, Integer>();
            this.origWaypoints = new ArrayList<Coord>();
            for (Waypoint waypoint : waypoints) {
                this.origWaypoints.add(waypoint.coord());
            }
            Waypoint prev = null;
            for (Waypoint waypoint : waypoints) {
                if (prev != null) {
                    for (Waypoint p : this.worldMap.cartGraph().shortestPathBetween(prev, waypoint)) {
                        this.internPaths.add(p.coord());
                    }
                }
                prev = waypoint;
            }
            int i = 0;
            while (i < this.internPaths.size()) {
                this.idxForWaypoint.put(this.internPaths.get(i), i);
                ++i;
            }
        }
        this.repaint();
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void setCoords(List<Coord> coords) {
        Object object = this.lock;
        synchronized (object) {
            this.internPaths = new ArrayList<Coord>();
            this.idxForWaypoint = new HashMap<Coord, Integer>();
            this.origWaypoints = coords;
            for (Coord coord : coords) {
                this.internPaths.add(coord);
            }
            int i = 0;
            while (i < this.internPaths.size()) {
                this.idxForWaypoint.put(this.internPaths.get(i), i);
                ++i;
            }
        }
        this.repaint();
    }

    @Override
    protected void mapViewSet(final MapView mapView) {
        mapView.addMouseMotionListener(new MouseMotionAdapter(){

            /*
             * WARNING - Removed try catching itself - possible behaviour change.
             */
            @Override
            public void mouseMoved(MouseEvent e) {
                Object object = PathPanel.this.lock;
                synchronized (object) {
                    if (PathPanel.this.internPaths != null) {
                        Coord clickedCoord = mapView.coordForScreen(e.getX(), e.getY());
                        double minDist = Double.MAX_VALUE;
                        Coord nearest = null;
                        for (Coord coord : PathPanel.this.internPaths) {
                            double dist = coord.squaredDistTo(clickedCoord);
                            if (!(dist < minDist)) continue;
                            minDist = dist;
                            nearest = coord;
                        }
                        PathPanel.this.currentSelectedWaypoint = Math.sqrt(minDist) < 10000.0 ? PathPanel.this.idxForWaypoint.get(nearest) : null;
                    }
                }
                PathPanel.this.repaint();
            }
        });
    }

    public PathPanel setFixedColor(Color color) {
        this.fixedColor = color;
        return this;
    }

    public void setShowWaypoints(boolean show) {
        this.showWaypoints = show;
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    @Override
    public void draw(Graphics2D g) {
        Object object = this.lock;
        synchronized (object) {
            HashMap<Coord, Double> alphaForCoord = new HashMap<Coord, Double>();
            if (this.internPaths != null) {
                Integer selected = this.currentSelectedWaypoint;
                Coord prev = null;
                int idx = 0;
                for (Coord waypoint : this.internPaths) {
                    if (prev != null) {
                        if (selected != null) {
                            int dist = Math.abs(idx - selected);
                            g.setStroke(new BasicStroke((float)MathUtil.map(dist, 0.0, 30.0, 5.0, 1.0)));
                            g.setColor(ColorUtil.setAlpha(Color.BLACK, MathUtil.map(dist, 0.0, 30.0, 1.0, 0.1)));
                            alphaForCoord.put(waypoint, MathUtil.map(dist, 0.0, 30.0, 1.0, 0.1));
                        } else {
                            g.setStroke(this.strokeThin);
                            if (this.fixedColor != null) {
                                g.setColor(this.fixedColor);
                            } else {
                                g.setColor(ColorUtil.gradBR((double)idx / (double)this.internPaths.size()));
                            }
                        }
                        Draw.drawLine(g, super.mapView().screenPointForWorld(prev), super.mapView().screenPointForWorld(waypoint));
                    }
                    prev = waypoint;
                    ++idx;
                }
            }
            if (this.showWaypoints && this.origWaypoints != null) {
                g.setStroke(this.strokeThick);
                g.setColor(Color.RED);
                for (Coord waypoint : this.origWaypoints) {
                    Double alpha = (Double)alphaForCoord.get(waypoint);
                    if (alpha == null) {
                        alpha = 1.0;
                    }
                    g.setColor(ColorUtil.setAlpha(Color.RED, alpha));
                    Draw.drawCircle(g, super.mapView().screenPointForWorld(waypoint), 10);
                }
            }
        }
    }

    public static PathPanel open(WorldMap worldMap) {
        return PathPanel.open(worldMap, "");
    }

    public static PathPanel open(WorldMap worldMap, String title) {
        MapFrame mapFrame = new MapFrame(worldMap);
        mapFrame.setTitle(title);
        mapFrame.mapView.openChildView(new WorldMapPanel().setShowBackgroundImage(false).setShowNetworks(false).setShowBeacons(false).setShowShelfWaypoints(false));
        PathPanel pathPanel = new PathPanel(worldMap);
        mapFrame.mapView.openChildView(pathPanel);
        return pathPanel;
    }
}

