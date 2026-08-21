/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.gui.mapframe.panels;

import com.hitachi.warehouse.gui.mapframe.AbstractMapPanel;
import com.hitachi.warehouse.model.map.Waypoint;
import com.hitachi.warehouse.model.map.WaypointGraph;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.AbstractRectangleObject;
import com.hitachi.warehouse.model.map.objects.BeaconObject;
import com.hitachi.warehouse.model.map.objects.ConstrainedAreaObject;
import com.hitachi.warehouse.model.map.objects.FreeShelfObject;
import com.hitachi.warehouse.model.map.objects.OneWayPassageObject;
import com.hitachi.warehouse.model.map.objects.ShelfObject;
import com.hitachi.warehouse.model.map.objects.StairsObject;
import com.hitachi.warehouse.model.map.objects.StationObject;
import com.hitachi.warehouse.model.map.objects.WallObject;
import com.hitachi.warehouse.model.picking.FreeShelfArea;
import common.gui.Draw;
import common.util.ColorUtil;
import common.util.MathUtil;
import common.util.StringList;
import java.awt.Color;
import java.awt.Font;
import java.awt.FontMetrics;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.Point;
import java.awt.geom.GeneralPath;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Set;

public class WorldMapPanel
extends AbstractMapPanel {
    private boolean showBackgroundImage = true;
    private boolean showObjects = true;
    private boolean showWalls = true;
    private boolean showNetwork = true;
    private boolean showShelfWaypoints = true;
    private boolean showShelfLabels = true;
    private boolean showStartEndShelf = true;
    private boolean showBeacons = true;
    private boolean showPassage = true;
    private boolean showConstrainedAreas = true;
    private boolean showStairs = true;
    private boolean showStairsLabels = true;
    private boolean showOriginPosition = false;
    public static final Color COL_NETWORK_PATH = new Color(206, 255, 231);
    public static final Color COL_NETWORK_WAYPOINT = new Color(162, 255, 160);
    public static final Color COL_NETWORK_SHELF_WAYPOINT = new Color(255, 175, 179);
    public static final Color COL_POS_TRIANGLE = ColorUtil.setAlpha(new Color(0, 200, 0), 0.7);
    private HashMap<Integer, ShelfColumn> columnForStr = new HashMap();
    private WorldMap cachedForMap = null;
    private Color backgroundColor = Color.LIGHT_GRAY;
    private Color mapAreaColor = Color.white;

    public WorldMapPanel() {
        this(true, true, true);
    }

    public WorldMapPanel(boolean showBackgroundImage, boolean showObjects, boolean showNetwork) {
        this.showBackgroundImage = showBackgroundImage;
        this.showObjects = showObjects;
        this.showNetwork = showNetwork;
    }

    public WorldMapPanel setShowBackgroundImage(boolean show) {
        this.showBackgroundImage = show;
        this.repaint();
        return this;
    }

    public WorldMapPanel setShowObjects(boolean show) {
        this.showObjects = show;
        this.repaint();
        return this;
    }

    public WorldMapPanel setShowWalls(boolean show) {
        this.showWalls = show;
        this.repaint();
        return this;
    }

    public WorldMapPanel setShowNetworks(boolean show) {
        this.showNetwork = show;
        this.repaint();
        return this;
    }

    public WorldMapPanel setShowShelfWaypoints(boolean show) {
        this.showShelfWaypoints = show;
        this.repaint();
        return this;
    }

    public WorldMapPanel setShowShelfLabels(boolean show) {
        this.showShelfLabels = show;
        this.repaint();
        return this;
    }

    public WorldMapPanel setShowStartEndShelf(boolean show) {
        this.showStartEndShelf = show;
        this.repaint();
        return this;
    }

    public WorldMapPanel setShowBeacons(boolean show) {
        this.showBeacons = show;
        this.repaint();
        return this;
    }

    public WorldMapPanel setShowPassage(boolean show) {
        this.showPassage = show;
        this.repaint();
        return this;
    }

    public WorldMapPanel setShowConstrainedAreas(boolean show) {
        this.showConstrainedAreas = show;
        this.repaint();
        return this;
    }

    public WorldMapPanel setShowStairs(boolean show) {
        this.showStairs = show;
        this.repaint();
        return this;
    }

    public WorldMapPanel setshowStairsLabels(boolean show) {
        this.showStairsLabels = show;
        this.repaint();
        return this;
    }

    public WorldMapPanel setShowOriginPosition(boolean show) {
        this.showOriginPosition = show;
        this.repaint();
        return this;
    }

    public static Font fontToFit(Graphics g, String str, Font originalFont, int minSize, int maxSize, int width, int height) {
        int l = minSize;
        int r = maxSize + 1;
        int m = (l + r) / 2;
        while (l + 1 < r) {
            Font font = new Font(originalFont.getName(), originalFont.getStyle(), m);
            g.setFont(font);
            FontMetrics metrics = g.getFontMetrics();
            int strWidth = metrics.stringWidth(str);
            int strHeight = metrics.getHeight();
            if (strWidth > width || strHeight > height) {
                r = m;
            } else {
                if (strWidth == width || strHeight == height) {
                    return font;
                }
                l = m;
            }
            m = (l + r) / 2;
        }
        return new Font(originalFont.getName(), originalFont.getStyle(), l);
    }

    public void setBackgroundColor(Color backgroundColor) {
        this.backgroundColor = backgroundColor;
    }

    public void setMapAreaColor(Color mapAreaColor) {
        this.mapAreaColor = mapAreaColor;
    }

    @Override
    public void draw(Graphics2D g) {
        WorldMap map = this.mapView().map();
        if (this.cachedForMap != map) {
            this.cachedForMap = map;
            for (ShelfObject shelfObject : map.shelfObjects()) {
                Object col = this.columnForStr.get(shelfObject.shelf().column);
                if (col == null) {
                    col = new ShelfColumn(shelfObject.shelf().colStr());
                    this.columnForStr.put(shelfObject.shelf().column, (ShelfColumn)col);
                }
                ((ShelfColumn)col).addShelf(shelfObject);
            }
        }
        try {
            map.startRead();
            if (this.backgroundColor != null) {
                g.setColor(this.backgroundColor);
                g.fillRect(0, 0, this.mapView().getWidth(), this.mapView().getHeight());
            }
            if (this.mapAreaColor != null) {
                Point point = this.mapView().screenPointForWorld(map.tl());
                Iterator<AbstractObject> br = this.mapView().screenPointForWorld(map.br());
                g.setColor(this.mapAreaColor);
                Draw.fillRect(g, point, br);
            }
            if (this.showBackgroundImage && map.bgImg() != null) {
                map.bgImg().paint(g, this.mapView());
            }
            if (this.showObjects) {
                if (this.showPassage) {
                    for (OneWayPassageObject oneWayPassageObject : map.onewayPassageObjects()) {
                        oneWayPassageObject.paint(g, this.mapView());
                    }
                }
                if (this.showConstrainedAreas) {
                    for (ConstrainedAreaObject constrainedAreaObject : map.constrainedAreaObjects()) {
                        constrainedAreaObject.paint(g, this.mapView());
                    }
                }
                FreeShelfObject.paintShelfObjects(map.freeShelfObjects(), g, this.mapView(), this.showShelfLabels, this.showStartEndShelf);
                for (StationObject stationObject : map.stationObjects()) {
                    stationObject.paint(g, this.mapView());
                }
                if (this.showWalls) {
                    for (WallObject wallObject : map.wallObjects()) {
                        wallObject.paint(g, this.mapView());
                    }
                }
                if (this.showBeacons) {
                    for (BeaconObject beaconObject : map.beaconObjects()) {
                        beaconObject.paint(g, this.mapView());
                    }
                }
                if (this.showStairs) {
                    StairsObject.paintStairsObjects(map.stairsObjects(), g, this.mapView(), this.showStairsLabels);
                }
            }
            WaypointGraph waypointGraph = map.cartGraph();
            if (this.showNetwork && waypointGraph != null) {
                int fromY;
                int fromX;
                g.setFont(new Font("Arial", 0, 12));
                for (Waypoint waypoint : waypointGraph.waypointsList()) {
                    g.setColor(COL_NETWORK_WAYPOINT);
                    fromX = this.mapView().screenXForWorld(waypoint.coord().x);
                    fromY = this.mapView().screenYForWorld(waypoint.coord().y);
                    Draw.drawCross(g, fromX, fromY, 3);
                    if (!waypointGraph.hasTags(waypoint)) continue;
                    StringList list = new StringList(",");
                    list.add((Object)waypoint.name());
                    for (WaypointGraph.WaypointTag tag : waypointGraph.tagsForWaypoint(waypoint)) {
                        list.add((Object)tag);
                    }
                    g.setColor(Color.BLACK);
                    Draw.drawString(g, list.toString(), fromX + 5, fromY - 5);
                }
                if (this.mapView().zoomLevel() < 20.0) {
                    g.setColor(COL_NETWORK_PATH);
                    for (Waypoint waypoint : waypointGraph.waypointsList()) {
                        fromX = this.mapView().screenXForWorld(waypoint.coord().x);
                        fromY = this.mapView().screenYForWorld(waypoint.coord().y);
                        for (Waypoint other : waypoint.networkNeighbours()) {
                            int toX = this.mapView().screenXForWorld(other.coord().x);
                            int toY = this.mapView().screenYForWorld(other.coord().y);
                            if ((fromX < 0 || fromX >= this.mapView().getWidth()) && (fromY < 0 || fromY >= this.mapView().getHeight())) continue;
                            Draw.drawArrow(g, fromX, fromY, toX, toY, 3.0);
                        }
                    }
                }
            }
            if (this.showShelfWaypoints) {
                g.setFont(new Font("Arial", 0, 8));
                for (AbstractObject obj : map.objects()) {
                    Set<Waypoint> waypoints;
                    if (!AbstractRectangleObject.class.isInstance(obj)) continue;
                    AbstractRectangleObject rect = (AbstractRectangleObject)obj;
                    if (waypointGraph == null || (waypoints = waypointGraph.waypointsForRect(rect)) == null) continue;
                    for (Waypoint waypoint : waypoints) {
                        int fromX = this.mapView().screenXForWorld(waypoint.coord().x);
                        int fromY = this.mapView().screenYForWorld(waypoint.coord().y);
                        g.setColor(COL_NETWORK_SHELF_WAYPOINT);
                        Draw.fillCircle(g, fromX, fromY, 10);
                        g.setColor(Color.BLACK);
                        Draw.drawString(g, "" + waypoint, fromX + 5, fromY);
                    }
                }
            }
            if (this.showOriginPosition) {
                FreeShelfObject originShelf = map.shelfObjectForShelf(FreeShelfArea.pickingStartEndShelf);
                Point originPoint = new Point();
                if (originShelf != null) {
                    originPoint = this.mapView().screenPointForWorld(originShelf.center());
                }
                if (originPoint.x < 0 || originPoint.y < 0 || originPoint.x >= this.mapView().getWidth() || originPoint.y >= this.mapView().getHeight()) {
                    Point screenCenter = new Point(this.mapView().getWidth() / 2, this.mapView().getHeight() / 2);
                    Point mappedOriginPoint = null;
                    if (screenCenter.x == originPoint.x) {
                        mappedOriginPoint = originPoint.y > screenCenter.y ? new Point(screenCenter.x, this.mapView().getHeight()) : new Point(screenCenter.x, 0);
                    } else {
                        double a = (double)(screenCenter.y - originPoint.y) / (double)(screenCenter.x - originPoint.x);
                        double b = (double)screenCenter.y - a * (double)screenCenter.x;
                        if (mappedOriginPoint == null && a != 0.0) {
                            int x;
                            if (originPoint.y > screenCenter.y) {
                                x = (int)(((double)this.mapView().getHeight() - b) / a);
                                if (x >= 0 && x < this.mapView().getWidth()) {
                                    mappedOriginPoint = new Point(x, this.mapView().getHeight());
                                }
                            } else {
                                x = (int)((0.0 - b) / a);
                                if (x >= 0 && x < this.mapView().getWidth()) {
                                    mappedOriginPoint = new Point(x, 0);
                                }
                            }
                        }
                        if (mappedOriginPoint == null) {
                            int y;
                            if (originPoint.x > screenCenter.x) {
                                y = (int)(a * (double)this.mapView().getWidth() + b);
                                if (y >= 0 && y < this.mapView().getHeight()) {
                                    mappedOriginPoint = new Point(this.mapView().getWidth(), y);
                                }
                            } else {
                                y = (int)(a * 0.0 + b);
                                if (y >= 0 && y < this.mapView().getHeight()) {
                                    mappedOriginPoint = new Point(0, y);
                                }
                            }
                        }
                    }
                    if (mappedOriginPoint != null) {
                        double heading = Math.atan2(mappedOriginPoint.x - screenCenter.x, mappedOriginPoint.y - screenCenter.y);
                        if (heading < 0.0) {
                            heading += Math.PI * 2;
                        }
                        double triangleAngle = 0.07853981633974483;
                        double leftHeading = heading - triangleAngle;
                        double rightHeading = heading + triangleAngle;
                        int triangleHypLength = 100;
                        Point leftPoint = new Point((int)((double)mappedOriginPoint.x - (double)triangleHypLength * Math.sin(leftHeading)), (int)((double)mappedOriginPoint.y - (double)triangleHypLength * Math.cos(leftHeading)));
                        Point rightPoint = new Point((int)((double)mappedOriginPoint.x - (double)triangleHypLength * Math.sin(rightHeading)), (int)((double)mappedOriginPoint.y - (double)triangleHypLength * Math.cos(rightHeading)));
                        g.setColor(COL_POS_TRIANGLE);
                        GeneralPath path = new GeneralPath();
                        path.moveTo(mappedOriginPoint.x, mappedOriginPoint.y);
                        path.lineTo(leftPoint.x, leftPoint.y);
                        path.lineTo(rightPoint.x, rightPoint.y);
                        path.lineTo(mappedOriginPoint.x, mappedOriginPoint.y);
                        g.fill(path);
                    }
                }
            }
        }
        finally {
            map.endRead();
        }
    }

    public static class ShelfColumn {
        List<ShelfObject> shelves = new ArrayList<ShelfObject>();
        Double left = null;
        Double right = null;
        Double top = null;
        Double bot = null;
        public final String colStr;

        public ShelfColumn(String colStr) {
            this.colStr = colStr;
        }

        public void addShelf(ShelfObject shelf) {
            this.shelves.add(shelf);
            this.left = MathUtil.min_ignoreNull(this.left, shelf.tl().x);
            this.right = MathUtil.max_ignoreNull(this.right, shelf.br().x);
            this.top = MathUtil.min_ignoreNull(this.top, shelf.tl().y);
            this.bot = MathUtil.max_ignoreNull(this.bot, shelf.br().y);
        }
    }
}

