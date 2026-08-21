/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.panels;

import com.hitachi.warehouse.gui.mapframe.AbstractMapPanel;
import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.mapmaker.MapMaker;
import com.hitachi.warehouse.mapmaker.networkgenerator.RectGrid;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.map.Waypoint;
import com.hitachi.warehouse.model.map.WaypointGraph;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.AbstractRectangleObject;
import com.hitachi.warehouse.model.map.objects.FreeShelfObject;
import com.hitachi.warehouse.model.map.objects.StairsObject;
import common.ds.WindowedQueue;
import common.gui.Draw;
import common.util.ColorUtil;
import common.util.MathUtil;
import common.util.Sleeper;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Cursor;
import java.awt.Graphics2D;
import java.awt.Point;
import java.util.ArrayList;
import java.util.LinkedList;
import java.util.List;
import java.util.Set;

public class PeopleAnimation
extends AbstractMapPanel
implements WorldMap.WorldMapChangedListener {
    private WorldMap knownMap = null;
    MapMaker maker;
    List<AbstractRectangleObject> targetObjects = null;
    RectGrid<AbstractRectangleObject> grid;
    private boolean drawingAnimation = true;
    private boolean keepRunning = true;
    Agent[] agents;

    public void updateInternal() {
        if (this.knownMap != null) {
            ArrayList<AbstractRectangleObject> targetObjects = new ArrayList<AbstractRectangleObject>();
            for (AbstractObject obj : this.knownMap.objects()) {
                if (!AbstractRectangleObject.class.isInstance(obj)) continue;
                AbstractRectangleObject rect = (AbstractRectangleObject)obj;
                if (FreeShelfObject.class.isInstance(rect)) {
                    targetObjects.add(rect);
                }
                if (!StairsObject.class.isInstance(rect)) continue;
                targetObjects.add(rect);
            }
            this.targetObjects = targetObjects;
        }
    }

    public PeopleAnimation(MapMaker maker) {
        this.maker = maker;
        this.agents = new Agent[50];
        int i = 0;
        while (i < this.agents.length) {
            this.agents[i] = new Agent(this);
            ++i;
        }
        Thread thread = new Thread(){

            @Override
            public void run() {
                Sleeper sleeper = new Sleeper(30.0);
                long prevT = System.currentTimeMillis();
                while (PeopleAnimation.this.keepRunning) {
                    int n;
                    long t2 = System.currentTimeMillis();
                    long dt = t2 - prevT;
                    WorldMap currentMap = PeopleAnimation.this.mapView().map();
                    if (PeopleAnimation.this.knownMap != currentMap) {
                        PeopleAnimation.this.knownMap = currentMap;
                        PeopleAnimation.this.updateInternal();
                        if (PeopleAnimation.this.knownMap != null) {
                            Agent[] agentArray = PeopleAnimation.this.agents;
                            n = PeopleAnimation.this.agents.length;
                            int n2 = 0;
                            while (n2 < n) {
                                Agent agent = agentArray[n2];
                                agent.initializeFromMap(PeopleAnimation.this.knownMap);
                                ++n2;
                            }
                        }
                    }
                    if (PeopleAnimation.this.knownMap != null) {
                        WaypointGraph graph = PeopleAnimation.this.knownMap.cartGraph();
                        Agent[] agentArray = PeopleAnimation.this.agents;
                        int n3 = PeopleAnimation.this.agents.length;
                        n = 0;
                        while (n < n3) {
                            Agent agent = agentArray[n];
                            if (agent.isFinished() || agent.currentGraph != graph) {
                                agent.initializeFromMap(PeopleAnimation.this.knownMap);
                            }
                            agent.move(dt);
                            ++n;
                        }
                    }
                    PeopleAnimation.this.repaint();
                    sleeper.sleep();
                    prevT = t2;
                }
            }
        };
        thread.start();
    }

    public void changeDrawingAnimation() {
        this.drawingAnimation = !this.drawingAnimation;
    }

    @Override
    protected void mapViewRemoved(MapView mapView) {
        this.keepRunning = false;
        this.maker.removeMapChangedListener(this);
    }

    @Override
    protected void mapViewSet(MapView mapView) {
        this.maker.mapFrame.setCursor(new Cursor(1));
        this.maker.addMapChangedListener(this);
    }

    @Override
    public void draw(Graphics2D g) {
        WorldMap map = this.mapView().map();
        if (map != null && map.cartGraph() != null && this.drawingAnimation) {
            if (map.cartGraph().waypointsList().size() == 0) {
                return;
            }
            g.setColor(Color.RED);
            Agent[] agentArray = this.agents;
            int n = this.agents.length;
            int n2 = 0;
            while (n2 < n) {
                Agent agent = agentArray[n2];
                Coord coord = agent.coord();
                if (coord != null) {
                    Draw.fillCircle(g, this.mapView().screenPointForWorld(coord), 2);
                }
                g.setStroke(new BasicStroke(2.0f));
                int window = agent.log.size();
                int i = 0;
                Point prev = null;
                for (Coord c : agent.log) {
                    double v = (double)i / (double)window;
                    g.setColor(ColorUtil.COLORSCHEME_LIGHTBLUE.cForV(v));
                    Point point = this.mapView().screenPointForWorld(c);
                    if (prev != null) {
                        Draw.drawLine(g, prev, point);
                    }
                    prev = point;
                    ++i;
                }
                ++n2;
            }
        }
    }

    @Override
    public void mapChanged(WorldMap map) {
        this.updateInternal();
    }

    public static class Agent {
        private WindowedQueue<Coord> log = new WindowedQueue(10);
        private Coord currentCoord;
        private WaypointGraph currentGraph = null;
        PeopleAnimation parent;
        private Waypoint prevWaypoint = null;
        LinkedList<Waypoint> waypointList = new LinkedList();
        private double v_mm_ms = 5.0;
        private double times = 2.0;

        public Coord coord() {
            return this.currentCoord;
        }

        public Agent(PeopleAnimation parent) {
            this.parent = parent;
        }

        public synchronized void move(long t_ms) {
            double moveDist_mm = (double)t_ms * this.v_mm_ms * this.times;
            while (moveDist_mm > 0.0 && this.waypointList.size() > 0) {
                Coord toCoord = this.waypointList.peek().coord();
                double dist = this.currentCoord.distTo(toCoord);
                if (moveDist_mm < dist) {
                    double x = MathUtil.map(moveDist_mm, 0.0, dist, this.currentCoord.x, toCoord.x);
                    double y = MathUtil.map(moveDist_mm, 0.0, dist, this.currentCoord.y, toCoord.y);
                    this.currentCoord = new Coord(x, y);
                    moveDist_mm = 0.0;
                    continue;
                }
                this.currentCoord = toCoord;
                moveDist_mm -= dist;
                this.prevWaypoint = this.waypointList.poll();
            }
            if (this.currentCoord != null) {
                this.log.add(this.currentCoord);
            }
        }

        public synchronized void initializeFromMap(WorldMap map) {
            WaypointGraph graph = map.cartGraph();
            if (graph == null) {
                return;
            }
            if (graph.waypointsList().size() == 0) {
                return;
            }
            Waypoint fromWaypoint = null;
            if (this.currentGraph == graph) {
                fromWaypoint = this.prevWaypoint;
            } else if (this.currentCoord != null) {
                fromWaypoint = graph.waypointKDTree().nearestNeighbour(this.currentCoord.getVector());
            }
            if (fromWaypoint == null) {
                fromWaypoint = this.getTargetWaypoint();
                this.log = new WindowedQueue(10);
            }
            Waypoint toWaypoint = this.getTargetWaypoint();
            List<Waypoint> path = null;
            int countdown = 100;
            while (path == null && countdown-- > 0 && fromWaypoint != null && toWaypoint != null) {
                path = graph.shortestPathBetween(fromWaypoint, toWaypoint);
                if (path != null) continue;
                fromWaypoint = this.getTargetWaypoint();
                toWaypoint = this.getTargetWaypoint();
            }
            this.waypointList.clear();
            if (path != null) {
                this.waypointList.addAll(path);
                this.currentCoord = this.waypointList.poll().coord();
            } else {
                this.currentCoord = null;
            }
            this.currentGraph = graph;
        }

        public boolean isFinished() {
            return this.waypointList.size() == 0;
        }

        public Waypoint getTargetWaypoint() {
            AbstractRectangleObject target;
            if (this.parent.targetObjects != null && this.parent.targetObjects.size() > 0 && (target = this.parent.targetObjects.get(MathUtil.randInt(this.parent.targetObjects.size()))) != null && this.parent.knownMap.cartGraph() != null) {
                Set<Waypoint> waypoints = this.parent.knownMap.cartGraph().waypointsForRect(target);
                ArrayList<Waypoint> waypointsList = new ArrayList<Waypoint>();
                waypointsList.addAll(waypoints);
                if (waypointsList.size() > 0) {
                    return (Waypoint)waypointsList.get(MathUtil.randInt(waypointsList.size()));
                }
            }
            return null;
        }
    }
}

