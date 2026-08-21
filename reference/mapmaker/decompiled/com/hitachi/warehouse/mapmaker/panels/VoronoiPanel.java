/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.panels;

import com.hitachi.warehouse.gui.mapframe.AbstractMapPanel;
import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.mapmaker.MapMaker;
import com.hitachi.warehouse.mapmaker.networkgenerator.NetworkCalculatorManager;
import com.hitachi.warehouse.mapmaker.networkgenerator.RectGrid;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.map.Waypoint;
import com.hitachi.warehouse.model.map.WaypointGraph;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.AbstractRectangleObject;
import com.hitachi.warehouse.model.map.objects.ConstrainedAreaObject;
import com.hitachi.warehouse.model.map.objects.FreeShelfObject;
import com.hitachi.warehouse.model.map.objects.StairsObject;
import common.gui.Draw;
import common.util.ColorUtil;
import common.util.MathUtil;
import delaunay_triangulation.Delaunay_Triangulation;
import delaunay_triangulation.Point_dt;
import delaunay_triangulation.Triangle_dt;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Cursor;
import java.awt.Dimension;
import java.awt.Font;
import java.awt.Graphics2D;
import java.awt.Point;
import java.awt.Rectangle;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.Vector;
import javax.swing.ButtonGroup;
import javax.swing.JButton;
import javax.swing.JLabel;
import javax.swing.JOptionPane;
import javax.swing.JPanel;
import javax.swing.JRadioButton;
import javax.swing.JScrollPane;
import javax.swing.JTextArea;

public class VoronoiPanel
extends AbstractMapPanel
implements NetworkCalculatorManager.NetworkCalculatorManagerListener {
    private MapMaker maker;
    private Delaunay_Triangulation dt = new Delaunay_Triangulation();
    private HashSet<Waypoint> allFreeWaypoints;
    private Coord objectsTr;
    private Coord objectsBr;
    private boolean needDrawing = false;
    private WaypointGraph graph;
    private DrawOption drawOptionForFreeWaypoints = DrawOption.INVISIBLE;
    private DrawOption drawOptionForWaypointsForRect = DrawOption.INVISIBLE;
    private DrawOption drawOptionForNetwork = DrawOption.INVISIBLE;
    private DrawOption drawOptionForDelaunay = DrawOption.INVISIBLE;
    private DrawOption drawOptionForAllRect = DrawOption.INVISIBLE;
    private DrawOption drawOptionForAllFreeWaypoints = DrawOption.INVISIBLE;
    private static final Color CIRCLE_COLOR_FOR_FREE_WAYPOINTS = Color.PINK;
    private static final Color CIRCLE_COLOR_FOR_WAYPOINTS_FOR_RECT = Color.ORANGE;
    private static final Color CIRCLE_COLOR_FOR_DELAUNAY_VERTEX = Color.RED;
    private static final Color LINE_COLOR_FOR_NETWORK = new Color(162, 255, 160);
    private static final Color LINE_COLOR_FOR_DELAUNAY = Color.GREEN;
    private static final Color LINE_COLOR_FOR_ALL_RECT = Color.CYAN;
    private static final BasicStroke STROKE_FOR_CIRCLE = new BasicStroke(0.5f);
    private static final BasicStroke STROKE_VISIBLE = new BasicStroke(1.0f);
    private static final BasicStroke STROKE_EMPHASIS = new BasicStroke(2.0f);
    private ArrayList<RouteData> RouteDatas = new ArrayList();
    private double RoutePathDistance = 0.0;

    public VoronoiPanel(MapMaker maker) {
        this.maker = maker;
    }

    @Override
    protected void mapViewSet(MapView mapView) {
        this.maker.mapFrame.setCursor(new Cursor(1));
        this.maker.getCalculatorManager().addListener(this);
        this.maker.getCalculatorManager().recalc();
        this.maker.showInfoForPanel(new VoronoiInfoPanel(mapView.map(), this));
    }

    @Override
    protected void mapViewRemoved(MapView mapView) {
        this.maker.getCalculatorManager().removeListener(this);
    }

    @Override
    public void draw(Graphics2D g) {
        if (!this.needDrawing) {
            return;
        }
        MapView mapView = super.mapView();
        if (this.drawOptionForAllRect != DrawOption.INVISIBLE) {
            if (this.objectsTr == null || this.objectsBr == null) {
                return;
            }
            Point ptl = mapView.screenPointForWorld(this.objectsTr);
            Point pbr = mapView.screenPointForWorld(this.objectsBr);
            this.drawLine(g, new Point(ptl.x, ptl.y), new Point(pbr.x, ptl.y), LINE_COLOR_FOR_ALL_RECT, this.drawOptionForAllRect);
            this.drawLine(g, new Point(ptl.x, ptl.y), new Point(ptl.x, pbr.y), LINE_COLOR_FOR_ALL_RECT, this.drawOptionForAllRect);
            this.drawLine(g, new Point(pbr.x, ptl.y), new Point(pbr.x, pbr.y), LINE_COLOR_FOR_ALL_RECT, this.drawOptionForAllRect);
            this.drawLine(g, new Point(ptl.x, pbr.y), new Point(pbr.x, pbr.y), LINE_COLOR_FOR_ALL_RECT, this.drawOptionForAllRect);
        }
        if (this.drawOptionForDelaunay != DrawOption.INVISIBLE) {
            Iterator<Triangle_dt> iterator = this.dt.trianglesIterator();
            while (iterator.hasNext()) {
                Triangle_dt triangle = iterator.next();
                if (triangle.isHalfplane()) continue;
                Coord c1 = new Coord(triangle.p1().x(), triangle.p1().y());
                Coord c2 = new Coord(triangle.p2().x(), triangle.p2().y());
                Coord c3 = new Coord(triangle.p3().x(), triangle.p3().y());
                Point wp1 = mapView.screenPointForWorld(c1);
                Point wp2 = mapView.screenPointForWorld(c2);
                Point wp3 = mapView.screenPointForWorld(c3);
                this.drawLine(g, wp1, wp2, LINE_COLOR_FOR_DELAUNAY, this.drawOptionForDelaunay);
                this.drawLine(g, wp1, wp3, LINE_COLOR_FOR_DELAUNAY, this.drawOptionForDelaunay);
                this.drawLine(g, wp2, wp3, LINE_COLOR_FOR_DELAUNAY, this.drawOptionForDelaunay);
            }
            Iterator<Object> points = this.dt.verticesIterator();
            while (points.hasNext()) {
                Point_dt point = (Point_dt)points.next();
                Point p = mapView.screenPointForWorld(new Coord(point.x(), point.y()));
                g.setColor(CIRCLE_COLOR_FOR_DELAUNAY_VERTEX);
                Draw.fillCircle(g, p, 4);
            }
        }
        if (this.drawOptionForAllFreeWaypoints != DrawOption.INVISIBLE) {
            for (Waypoint base : this.allFreeWaypoints) {
                Point fromP = mapView.screenPointForWorld(base.coord());
                this.drawCircle(g, fromP, Color.BLUE, this.drawOptionForAllFreeWaypoints);
                for (Waypoint other : base.networkNeighbours()) {
                    Point toP = mapView.screenPointForWorld(other.coord());
                    this.drawLine(g, fromP, toP, Color.RED, this.drawOptionForAllFreeWaypoints);
                }
            }
        }
        if (this.drawOptionForFreeWaypoints != DrawOption.INVISIBLE || this.drawOptionForWaypointsForRect != DrawOption.INVISIBLE || this.drawOptionForNetwork != DrawOption.INVISIBLE) {
            ArrayList<Waypoint> sortedWaypointsList = new ArrayList<Waypoint>(this.graph.waypointsList());
            Collections.sort(sortedWaypointsList, new Comparator<Waypoint>(){

                @Override
                public int compare(Waypoint o1, Waypoint o2) {
                    boolean b1 = VoronoiPanel.this.graph.rectForWaypoint(o1) != null;
                    boolean b2 = VoronoiPanel.this.graph.rectForWaypoint(o2) != null;
                    return Boolean.compare(b1, b2);
                }
            });
            for (Waypoint waypoint : sortedWaypointsList) {
                Point fromP = mapView.screenPointForWorld(waypoint.coord());
                AbstractRectangleObject object = this.graph.rectForWaypoint(waypoint);
                if (object == null) {
                    this.drawCircle(g, fromP, CIRCLE_COLOR_FOR_FREE_WAYPOINTS, this.drawOptionForFreeWaypoints);
                } else {
                    this.drawCircle(g, fromP, CIRCLE_COLOR_FOR_WAYPOINTS_FOR_RECT, this.drawOptionForWaypointsForRect);
                }
                if (this.drawOptionForNetwork == DrawOption.INVISIBLE) continue;
                for (Waypoint other : waypoint.networkNeighbours()) {
                    Point toP = mapView.screenPointForWorld(other.coord());
                    this.drawLine(g, fromP, toP, LINE_COLOR_FOR_NETWORK, this.drawOptionForNetwork);
                }
            }
        }
        if (this.RouteDatas.size() != 0 && this.maker.map().cartGraph() != null) {
            int routeCnt = 0;
            while (routeCnt < this.RouteDatas.size()) {
                RouteData sr = this.RouteDatas.get(routeCnt);
                int fromX = mapView.screenXForWorld(sr.objFrom.tl().x);
                int fromY = mapView.screenYForWorld(sr.objFrom.tl().y);
                int toX = mapView.screenXForWorld(sr.objFrom.br().x);
                int toY = mapView.screenYForWorld(sr.objFrom.br().y);
                g.setColor(Color.RED);
                g.setStroke(new BasicStroke(1.0f));
                g.drawRect(fromX, fromY, toX - fromX, toY - fromY);
                g.setColor(ColorUtil.setAlpha(Color.RED, 0.2));
                g.fillRect(fromX, fromY, toX - fromX, toY - fromY);
                Point point = this.mapView().screenPointForWorld(sr.waypointFrom.coord());
                g.setColor(Color.RED);
                Draw.fillCircle(g, point, 8);
                if (routeCnt != this.RouteDatas.size() - 1) {
                    point = this.mapView().screenPointForWorld(sr.waypointTo.coord());
                    g.setColor(Color.RED);
                    Draw.fillCircle(g, point, 8);
                }
                int x = mapView.screenXForWorld(sr.objFrom.tl().x);
                int y = mapView.screenYForWorld(sr.objFrom.tl().y);
                g.setColor(Color.RED);
                g.setFont(new Font("Arial", 0, 20));
                Draw.drawString(g, String.valueOf(routeCnt + 1), x, y);
                if (routeCnt == this.RouteDatas.size() - 1) {
                    x = mapView.screenXForWorld(sr.waypointFrom.coord().x) + 5;
                    y = mapView.screenYForWorld(sr.waypointFrom.coord().y) + 5;
                    String str = "Distance\n" + String.format("%.02fm", this.RoutePathDistance);
                    g.setFont(new Font("Arial", 0, 20));
                    Rectangle rect = Draw.getStringBounds(g, str, x, y);
                    g.setColor(Color.WHITE);
                    g.fillRect(rect.x, rect.y, rect.width, rect.height);
                    g.setColor(Color.RED);
                    Draw.drawString(g, str, x, y);
                }
                if (sr.path != null) {
                    Point prev = null;
                    int pathCnt = 0;
                    while (pathCnt < sr.path.size()) {
                        Waypoint next = sr.path.get(pathCnt);
                        Point nextPoint = this.mapView().screenPointForWorld(next.coord());
                        if (prev != null) {
                            g.setColor(Color.RED);
                            BasicStroke stroke = new BasicStroke(2.0f);
                            g.setStroke(stroke);
                            Draw.drawLine(g, prev, nextPoint);
                        }
                        prev = nextPoint;
                        ++pathCnt;
                    }
                }
                ++routeCnt;
            }
        }
    }

    private void drawCircle(Graphics2D g, Point p, Color fillColor, DrawOption drawOption) {
        switch (drawOption) {
            case VISIBLE: {
                g.setColor(fillColor);
                Draw.fillCircle(g, p, 8);
                break;
            }
            case EMPHASIS: {
                g.setColor(fillColor);
                Draw.fillCircle(g, p, 16);
                g.setColor(Color.BLACK);
                g.setStroke(STROKE_FOR_CIRCLE);
                Draw.drawCircle(g, p, 16);
                break;
            }
        }
    }

    private void drawLine(Graphics2D g, Point fromP, Point toP, Color color, DrawOption drawOption) {
        switch (drawOption) {
            case VISIBLE: {
                g.setColor(color);
                g.setStroke(STROKE_VISIBLE);
                Draw.drawLine(g, fromP, toP);
                break;
            }
            case EMPHASIS: {
                g.setColor(color);
                g.setStroke(STROKE_EMPHASIS);
                Draw.drawLine(g, fromP, toP);
                break;
            }
        }
    }

    private void doCalc() {
        WorldMap map = this.mapView().map();
        if (map != null) {
            this.dt = new Delaunay_Triangulation();
            this.allFreeWaypoints = new HashSet();
            Coord mapTl = map.tl();
            Coord mapBr = map.br();
            RectGrid<AbstractRectangleObject> obstacles = new RectGrid<AbstractRectangleObject>(mapTl, mapBr, 5000.0, AbstractRectangleObject.class);
            RectGrid<AbstractRectangleObject> obstaclesAndPassages = new RectGrid<AbstractRectangleObject>(mapTl, mapBr, 5000.0, AbstractRectangleObject.class);
            try {
                map.startRead();
                for (AbstractObject obj : map.objects()) {
                    AbstractRectangleObject rect;
                    if (!AbstractRectangleObject.class.isInstance(obj) || !Coord.clips((rect = (AbstractRectangleObject)obj).tl(), rect.br(), mapTl, mapBr)) continue;
                    if (rect.isObstructing()) {
                        obstacles.add(rect);
                        obstaclesAndPassages.add(rect);
                        continue;
                    }
                    if (!ConstrainedAreaObject.class.isInstance(rect)) continue;
                    obstaclesAndPassages.add(rect);
                }
                double left = Double.MAX_VALUE;
                double top = Double.MAX_VALUE;
                double bottom = 0.0;
                double right = 0.0;
                for (AbstractObject obj : map.objects()) {
                    if (left > obj.boundTL().x) {
                        left = obj.boundTL().x;
                    }
                    if (right < obj.boundBR().x) {
                        right = obj.boundBR().x;
                    }
                    if (top > obj.boundTL().y) {
                        top = obj.boundTL().y;
                    }
                    if (!(bottom < obj.boundBR().y)) continue;
                    bottom = obj.boundBR().y;
                }
                double width = right - left;
                double height = bottom - top;
                this.objectsTr = new Coord(left -= width * 0.05, top -= height * 0.05);
                this.objectsBr = new Coord(right += width * 0.05, bottom += height * 0.05);
                this.dt = new Delaunay_Triangulation();
                ArrayList<Coord[]> rects = new ArrayList<Coord[]>();
                rects.add(new Coord[]{mapTl, new Coord(mapBr.x, mapTl.y), mapBr, new Coord(mapTl.x, mapBr.y)});
                for (AbstractObject object : map.objects()) {
                    if (!AbstractRectangleObject.class.isInstance(object)) continue;
                    AbstractRectangleObject abstractRectangleObject = (AbstractRectangleObject)object;
                    rects.add(new Coord[]{abstractRectangleObject.tl(), abstractRectangleObject.tr(), abstractRectangleObject.br(), abstractRectangleObject.bl()});
                }
                try {
                    double pointEvery_mm = 2500.0;
                    for (Coord[] coordArray : rects) {
                        Coord prev = coordArray[coordArray.length - 1];
                        Coord[] coordArray2 = coordArray;
                        int n = coordArray.length;
                        int n2 = 0;
                        while (n2 < n) {
                            Coord coord = coordArray2[n2];
                            int numSplit = (int)Math.ceil(Math.max(Math.abs(coord.x - prev.x) / pointEvery_mm, Math.abs(coord.y - prev.y) / pointEvery_mm));
                            int i = 0;
                            while (i < numSplit) {
                                Coord c = new Coord(MathUtil.map(i, 0.0, numSplit, prev.x, coord.x), MathUtil.map(i, 0.0, numSplit, prev.y, coord.y));
                                if (c.isInside(this.objectsTr, this.objectsBr)) {
                                    Point_dt point_dt = new Point_dt(c.x + Math.random() * 0.1, c.y + Math.random() * 0.1);
                                    this.dt.insertPoint(point_dt);
                                }
                                ++i;
                            }
                            prev = coord;
                            ++n2;
                        }
                    }
                }
                catch (Exception e) {
                    e.printStackTrace();
                }
                this.allFreeWaypoints = new HashSet();
                HashMap<Triangle_dt, Waypoint> centerForTriangle = new HashMap<Triangle_dt, Waypoint>();
                HashMap<Point_dt, Triangle_dt> triForPoint = new HashMap<Point_dt, Triangle_dt>();
                Iterator<Triangle_dt> iterator = this.dt.trianglesIterator();
                while (iterator.hasNext()) {
                    Triangle_dt triangle_dt = iterator.next();
                    if (triangle_dt.isHalfplane()) continue;
                    Point_dt center = triangle_dt.circumcircle().Center();
                    Coord coord = new Coord(center.x(), center.y());
                    if (!obstaclesAndPassages.collidesAny(coord) && coord.isInside(this.objectsTr, this.objectsBr)) {
                        Waypoint waypoint = new Waypoint(coord);
                        waypoint.setName(String.valueOf(waypoint.id));
                        centerForTriangle.put(triangle_dt, waypoint);
                        this.allFreeWaypoints.add(waypoint);
                    }
                    triForPoint.put(triangle_dt.p1(), triangle_dt);
                    triForPoint.put(triangle_dt.p2(), triangle_dt);
                    triForPoint.put(triangle_dt.p3(), triangle_dt);
                }
                for (Map.Entry entry : triForPoint.entrySet()) {
                    Vector<Triangle_dt> triangles = this.dt.findTriangleNeighborhood((Triangle_dt)entry.getValue(), (Point_dt)entry.getKey());
                    if (triangles == null) continue;
                    Waypoint prevWaypoint = (Waypoint)centerForTriangle.get(triangles.get(triangles.size() - 1));
                    for (Triangle_dt triangle : triangles) {
                        Waypoint waypoint = (Waypoint)centerForTriangle.get(triangle);
                        if (prevWaypoint != null && waypoint != null && !obstaclesAndPassages.clipsAny(prevWaypoint.coord(), waypoint.coord())) {
                            prevWaypoint.addNeighbour(waypoint);
                            waypoint.addNeighbour(prevWaypoint);
                        }
                        prevWaypoint = waypoint;
                    }
                }
            }
            finally {
                map.endRead();
            }
        }
    }

    @Override
    public void generateFinished(WaypointGraph graph) {
        this.needDrawing = false;
        if (graph != null) {
            this.doCalc();
            this.graph = graph;
            this.needDrawing = true;
            this.RouteDatas.clear();
            this.RoutePathDistance = 0.0;
        }
    }

    private static enum DrawOption {
        INVISIBLE,
        VISIBLE,
        EMPHASIS;

    }

    private class RouteData {
        public AbstractRectangleObject objFrom = null;
        public AbstractRectangleObject objTo = null;
        public Waypoint waypointFrom = null;
        public Waypoint waypointTo = null;
        public List<Waypoint> path = new ArrayList<Waypoint>();
    }

    private class VoronoiInfoPanel
    extends JPanel {
        private WorldMap map;
        private VoronoiPanel parent;
        private JRadioButton waypointsForRectInvisible;
        private JRadioButton waypointsForRectVisible;
        private JRadioButton waypointsForRectEmphasis;
        private JRadioButton delaunayInvisible;
        private JRadioButton delaunayVisible;
        private JRadioButton delaunayEmphasis;
        private JRadioButton networkInvisible;
        private JRadioButton networkVisible;
        private JRadioButton networkEmphasis;
        private JRadioButton allRectInvisible;
        private JRadioButton allRectVisible;
        private JRadioButton allRectEmphasis;
        private JRadioButton freeWaypointsInvisible;
        private JRadioButton freeWaypointsVisible;
        private JRadioButton freeWaypointsEmphasis;
        private JRadioButton allFreeWaypointsInvisible;
        private JRadioButton allFreeWaypointsVisible;
        private JRadioButton allFreeWaypointsEmphasis;
        private JButton btnRouteShow;
        private JTextArea txtShelfNames;

        public VoronoiInfoPanel(WorldMap map, VoronoiPanel parent) {
            this.map = map;
            this.parent = parent;
            this.setLayout(null);
            this.setPreferredSize(new Dimension(((VoronoiPanel)VoronoiPanel.this).maker.objectInfoFrame.getWidth(), 325));
            ActionListener actionListener = new ActionListener(){

                @Override
                public void actionPerformed(ActionEvent e) {
                    VoronoiInfoPanel.this.updateGUI();
                }
            };
            this.allRectInvisible = new JRadioButton("OFF");
            this.allRectVisible = new JRadioButton("ON");
            this.allRectEmphasis = new JRadioButton("Emphasis");
            this.addRadioButtons("経路計算領域", this.allRectInvisible, this.allRectVisible, this.allRectEmphasis, actionListener);
            this.delaunayInvisible = new JRadioButton("OFF");
            this.delaunayVisible = new JRadioButton("ON");
            this.delaunayEmphasis = new JRadioButton("Emphasis");
            this.addRadioButtons("ドロネー図", this.delaunayInvisible, this.delaunayVisible, this.delaunayEmphasis, actionListener);
            this.allFreeWaypointsInvisible = new JRadioButton("OFF");
            this.allFreeWaypointsVisible = new JRadioButton("ON");
            this.allFreeWaypointsEmphasis = new JRadioButton("Emphasis");
            this.addRadioButtons("FreeWaypoints(未完)", this.allFreeWaypointsInvisible, this.allFreeWaypointsVisible, this.allFreeWaypointsEmphasis, actionListener);
            this.waypointsForRectInvisible = new JRadioButton("OFF");
            this.waypointsForRectVisible = new JRadioButton("ON");
            this.waypointsForRectEmphasis = new JRadioButton("Emphasis");
            this.addRadioButtons("作業点", this.waypointsForRectInvisible, this.waypointsForRectVisible, this.waypointsForRectEmphasis, actionListener);
            this.freeWaypointsInvisible = new JRadioButton("OFF");
            this.freeWaypointsVisible = new JRadioButton("ON");
            this.freeWaypointsEmphasis = new JRadioButton("Emphasis");
            this.addRadioButtons("FreeWaypoints(完成)", this.freeWaypointsInvisible, this.freeWaypointsVisible, this.freeWaypointsEmphasis, actionListener);
            this.networkInvisible = new JRadioButton("OFF");
            this.networkVisible = new JRadioButton("ON");
            this.networkEmphasis = new JRadioButton("Emphasis");
            this.addRadioButtons("経路キャッシュ", this.networkInvisible, this.networkVisible, this.networkEmphasis, actionListener);
            JLabel lblTitle = new JLabel("経路検索（棚名）");
            final JTextArea txtNames = new JTextArea(5, 10);
            JScrollPane pnlNames = new JScrollPane(txtNames, 22, 31);
            this.btnRouteShow = new JButton("表示");
            lblTitle.setBounds(3, 160, 105, 25);
            this.btnRouteShow.setBounds(122, 160, 60, 25);
            pnlNames.setBounds(122, 190, 170, 135);
            this.add(lblTitle);
            this.add(pnlNames);
            this.add(this.btnRouteShow);
            this.btnRouteShow.addActionListener(new ActionListener(){

                @Override
                public void actionPerformed(ActionEvent paramActionEvent) {
                    ArrayList<String> nameList = new ArrayList<String>();
                    VoronoiPanel.this.RouteDatas.clear();
                    VoronoiPanel.this.RoutePathDistance = 0.0;
                    String before = "";
                    String[] stringArray = txtNames.getText().split("\n");
                    int n = stringArray.length;
                    int n2 = 0;
                    while (n2 < n) {
                        Object name = stringArray[n2];
                        if (((String)(name = ((String)name).trim())).length() > 0) {
                            if (!before.equals(name)) {
                                nameList.add((String)name);
                            }
                            before = name;
                        }
                        ++n2;
                    }
                    if (VoronoiPanel.this.maker.map().cartGraph() == null) {
                        VoronoiPanel.this.RouteDatas.clear();
                        VoronoiPanel.this.RoutePathDistance = 0.0;
                        JOptionPane.showMessageDialog(null, "経路キャッシュ計算が完了していません。", "エラー", 0);
                        return;
                    }
                    if (nameList.size() == 0) {
                        VoronoiPanel.this.RouteDatas.clear();
                        VoronoiPanel.this.RoutePathDistance = 0.0;
                        JOptionPane.showMessageDialog(null, "経路検索する棚名を入力して下さい。", "エラー", 0);
                        return;
                    }
                    if (nameList.size() == 1) {
                        VoronoiPanel.this.RouteDatas.clear();
                        VoronoiPanel.this.RoutePathDistance = 0.0;
                        JOptionPane.showMessageDialog(null, "経路検索は、２件以上の棚名を入力して下さい。", "エラー", 0);
                        return;
                    }
                    for (String name : nameList) {
                        if (this.getAbstractRectangleObject(name) != null) continue;
                        VoronoiPanel.this.RouteDatas.clear();
                        VoronoiPanel.this.RoutePathDistance = 0.0;
                        JOptionPane.showMessageDialog(null, String.valueOf(name) + "棚が、存在しません。", "エラー", 0);
                        return;
                    }
                    int cnt = 0;
                    while (cnt < nameList.size() - 1) {
                        RouteData rd;
                        String nameFrom = (String)nameList.get(cnt);
                        String nameTo = (String)nameList.get(cnt + 1);
                        AbstractRectangleObject objFrom = null;
                        AbstractRectangleObject objTo = null;
                        objFrom = this.getAbstractRectangleObject(nameFrom);
                        objTo = this.getAbstractRectangleObject(nameTo);
                        List<Waypoint> waypointFroms = this.getWaypoint(objFrom);
                        if (waypointFroms.size() == 0) {
                            VoronoiPanel.this.RouteDatas.clear();
                            VoronoiPanel.this.RoutePathDistance = 0.0;
                            JOptionPane.showMessageDialog(null, String.valueOf(nameFrom) + "棚にピック点がありません。", "エラー", 0);
                            return;
                        }
                        List<Waypoint> waypointTos = this.getWaypoint(objTo);
                        if (waypointTos.size() == 0) {
                            VoronoiPanel.this.RouteDatas.clear();
                            VoronoiPanel.this.RoutePathDistance = 0.0;
                            JOptionPane.showMessageDialog(null, String.valueOf(nameTo) + "棚にピック点がありません。", "エラー", 0);
                            return;
                        }
                        Waypoint waypointFrom = null;
                        Waypoint waypointTo = null;
                        List<Waypoint> path = null;
                        double dist = Double.MAX_VALUE;
                        for (Waypoint tmp_waypointFrom : waypointFroms) {
                            for (Waypoint tmp_waypointTo : waypointTos) {
                                List<Waypoint> tmp_path = VoronoiPanel.this.maker.map().cartGraph().shortestPathBetween(tmp_waypointFrom, tmp_waypointTo);
                                double tmp_dist = WaypointGraph.distForPath(tmp_path);
                                if (!(dist > tmp_dist)) continue;
                                waypointFrom = tmp_waypointFrom;
                                waypointTo = tmp_waypointTo;
                                path = tmp_path;
                                dist = tmp_dist;
                            }
                        }
                        VoronoiPanel voronoiPanel = VoronoiPanel.this;
                        voronoiPanel.RoutePathDistance = voronoiPanel.RoutePathDistance + WaypointGraph.distForPath(path) / 1000.0;
                        if (path != null) {
                            rd = new RouteData();
                            rd.objFrom = objFrom;
                            rd.waypointFrom = waypointFrom;
                            rd.objTo = objTo;
                            rd.waypointTo = waypointTo;
                            rd.path = path;
                            VoronoiPanel.this.RouteDatas.add(rd);
                        }
                        if (cnt == nameList.size() - 2) {
                            rd = new RouteData();
                            rd.objFrom = objTo;
                            rd.waypointFrom = waypointTo;
                            rd.objTo = null;
                            rd.waypointTo = null;
                            rd.path = null;
                            VoronoiPanel.this.RouteDatas.add(rd);
                        }
                        ++cnt;
                    }
                }

                private AbstractRectangleObject getAbstractRectangleObject(String name) {
                    for (FreeShelfObject freeShelfObject : VoronoiPanel.this.maker.map().freeShelfObjects()) {
                        if (!name.equals(freeShelfObject.shelf().name)) continue;
                        return freeShelfObject;
                    }
                    for (StairsObject stairsObject : VoronoiPanel.this.maker.map().stairsObjects()) {
                        if (!name.equals(stairsObject.getName())) continue;
                        return stairsObject;
                    }
                    return null;
                }

                private List<Waypoint> getWaypoint(AbstractRectangleObject obj) {
                    ArrayList<Waypoint> waypointList = new ArrayList<Waypoint>();
                    if (obj == null) {
                        return waypointList;
                    }
                    Set<Waypoint> waypointSet = VoronoiPanel.this.maker.map().cartGraph().waypointsForRect(obj);
                    if (waypointSet == null) {
                        return waypointList;
                    }
                    if (waypointSet.size() == 0) {
                        return waypointList;
                    }
                    Iterator<Waypoint> it = waypointSet.iterator();
                    while (it.hasNext()) {
                        waypointList.add(it.next());
                    }
                    return waypointList;
                }
            });
        }

        public void addRadioButtons(String title, JRadioButton invisible, JRadioButton visible, JRadioButton emphasis, ActionListener actionListener) {
            JLabel lbl_title = new JLabel(title);
            invisible.addActionListener(actionListener);
            visible.addActionListener(actionListener);
            emphasis.addActionListener(actionListener);
            ButtonGroup group = new ButtonGroup();
            group.add(invisible);
            group.add(visible);
            group.add(emphasis);
            int y = 0;
            if (title.equals("経路計算領域")) {
                y = 10;
            }
            if (title.equals("ドロネー図")) {
                y = 35;
            }
            if (title.equals("FreeWaypoints(未完)")) {
                y = 60;
            }
            if (title.equals("作業点")) {
                y = 85;
            }
            if (title.equals("FreeWaypoints(完成)")) {
                y = 110;
            }
            if (title.equals("経路キャッシュ")) {
                y = 135;
            }
            int height = 25;
            lbl_title.setBounds(3, y, 122, height);
            invisible.setBounds(122, y, 50, height);
            visible.setBounds(170, y, 45, height);
            emphasis.setBounds(215, y, 81, height);
            this.add(lbl_title);
            this.add(invisible);
            this.add(visible);
            this.add(emphasis);
            invisible.setSelected(true);
        }

        public void updateGUI() {
            if (this.allFreeWaypointsInvisible.isSelected()) {
                this.parent.drawOptionForAllFreeWaypoints = DrawOption.INVISIBLE;
            }
            if (this.allFreeWaypointsVisible.isSelected()) {
                this.parent.drawOptionForAllFreeWaypoints = DrawOption.VISIBLE;
            }
            if (this.allFreeWaypointsEmphasis.isSelected()) {
                this.parent.drawOptionForAllFreeWaypoints = DrawOption.EMPHASIS;
            }
            if (this.freeWaypointsInvisible.isSelected()) {
                this.parent.drawOptionForFreeWaypoints = DrawOption.INVISIBLE;
            }
            if (this.freeWaypointsVisible.isSelected()) {
                this.parent.drawOptionForFreeWaypoints = DrawOption.VISIBLE;
            }
            if (this.freeWaypointsEmphasis.isSelected()) {
                this.parent.drawOptionForFreeWaypoints = DrawOption.EMPHASIS;
            }
            if (this.waypointsForRectInvisible.isSelected()) {
                this.parent.drawOptionForWaypointsForRect = DrawOption.INVISIBLE;
            }
            if (this.waypointsForRectVisible.isSelected()) {
                this.parent.drawOptionForWaypointsForRect = DrawOption.VISIBLE;
            }
            if (this.waypointsForRectEmphasis.isSelected()) {
                this.parent.drawOptionForWaypointsForRect = DrawOption.EMPHASIS;
            }
            if (this.delaunayInvisible.isSelected()) {
                this.parent.drawOptionForDelaunay = DrawOption.INVISIBLE;
            }
            if (this.delaunayVisible.isSelected()) {
                this.parent.drawOptionForDelaunay = DrawOption.VISIBLE;
            }
            if (this.delaunayEmphasis.isSelected()) {
                this.parent.drawOptionForDelaunay = DrawOption.EMPHASIS;
            }
            if (this.networkInvisible.isSelected()) {
                this.parent.drawOptionForNetwork = DrawOption.INVISIBLE;
            }
            if (this.networkVisible.isSelected()) {
                this.parent.drawOptionForNetwork = DrawOption.VISIBLE;
            }
            if (this.networkEmphasis.isSelected()) {
                this.parent.drawOptionForNetwork = DrawOption.EMPHASIS;
            }
            if (this.allRectInvisible.isSelected()) {
                this.parent.drawOptionForAllRect = DrawOption.INVISIBLE;
            }
            if (this.allRectVisible.isSelected()) {
                this.parent.drawOptionForAllRect = DrawOption.VISIBLE;
            }
            if (this.allRectEmphasis.isSelected()) {
                this.parent.drawOptionForAllRect = DrawOption.EMPHASIS;
            }
            this.parent.needDrawing = this.parent.graph != null;
        }
    }
}

