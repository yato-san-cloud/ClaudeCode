/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.networkgenerator;

import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.map.Waypoint;
import com.hitachi.warehouse.model.map.WaypointGraph;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.AbstractRectangleObject;
import com.hitachi.warehouse.model.map.objects.ShelfObject;
import com.hitachi.warehouse.model.map.objects.StationObject;
import common.gui.ProgressDialog;
import common.util.MathUtil;
import common.util.ProgressManager;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import javax.swing.JOptionPane;

public class WalkNetworkGenerator {
    final double offset_mm = 800.0;
    WorldMap map;
    WaypointGraph graph;
    boolean isRunning = false;
    ArrayList<Waypoint> waypoints = new ArrayList();
    ArrayList<AbstractRectangleObject> targetObjects = new ArrayList();
    ArrayList<AbstractObject> obstacles = new ArrayList();
    Coord tl;
    Coord br;
    HashSet<Waypoint> cartWaypoints = new HashSet();
    transient List<NetworkGeneratorListener> listeners = new ArrayList<NetworkGeneratorListener>();

    public WalkNetworkGenerator(WorldMap map) {
        this.map = map;
        this.graph = new WaypointGraph(map);
        map.setWalkGraph(this.graph);
    }

    public boolean isRunning() {
        return this.isRunning;
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public String initialize() {
        WorldMap worldMap = this.map;
        synchronized (worldMap) {
            for (AbstractObject obj : this.map.objects()) {
                if (ShelfObject.class.isInstance(obj) || StationObject.class.isInstance(obj)) {
                    this.targetObjects.add((AbstractRectangleObject)obj);
                }
                if (!obj.isObstructing()) continue;
                this.obstacles.add(obj);
            }
        }
        this.tl = this.map.tl();
        this.br = this.map.br();
        double left = 0.0;
        double top = 0.0;
        double bottom = 0.0;
        double right = 0.0;
        WorldMap worldMap2 = this.map;
        synchronized (worldMap2) {
            for (AbstractRectangleObject rect : this.targetObjects) {
                if (left > rect.tl().x) {
                    left = rect.tl().x;
                }
                if (right < rect.br().x) {
                    right = rect.br().x;
                }
                if (top > rect.tl().y) {
                    top = rect.tl().y;
                }
                if (!(bottom < rect.br().y)) continue;
                bottom = rect.br().y;
            }
        }
        double width = right - left;
        double height = bottom - top;
        this.tl = new Coord(left -= width * 0.1, top -= height * 0.1);
        this.br = new Coord(right += width * 0.1, bottom += height * 0.1);
        return null;
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    private String generateWaypoints(double pointPerSqMetre) {
        int num = (int)((this.br.x / 1000.0 - this.tl.x / 1000.0) * (this.br.y / 1000.0 - this.tl.y / 1000.0) * pointPerSqMetre);
        for (Waypoint waypoint : this.map.cartGraph().waypoints()) {
            Waypoint newWaypoint = new Waypoint(waypoint.coord());
            this.graph.addWaypoint(newWaypoint);
            this.waypoints.add(newWaypoint);
            this.cartWaypoints.add(newWaypoint);
            --num;
        }
        int notifyEvery = 10000;
        int i = 0;
        while (i < num) {
            Coord coord = new Coord(MathUtil.map(Math.random(), 0.0, 1.0, this.tl.x, this.br.x), MathUtil.map(Math.random(), 0.0, 1.0, this.tl.y, this.br.y));
            boolean valid = true;
            for (AbstractObject obj : this.obstacles) {
                if ((!obj.isObstructing() || !obj.isInside(coord)) && !(obj.distTo(coord) <= 250.0)) continue;
                valid = false;
                break;
            }
            if (valid) {
                Waypoint waypoint = new Waypoint(coord);
                WorldMap worldMap = this.map;
                synchronized (worldMap) {
                    this.graph.addWaypoint(waypoint);
                }
                this.waypoints.add(waypoint);
            }
            if (i % notifyEvery == 0) {
                this.dispatchGeneratorUpdated("Adding waypoints (" + i + "/" + notifyEvery + ")");
            }
            ++i;
        }
        return null;
    }

    public String setWaypointsFromCartWaypoints() {
        return null;
    }

    private String setWorkPointsForTargets() {
        return null;
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    private String connectNearestNeighbours() {
        int updateEvery = 10000;
        int updateIt = 0;
        for (Waypoint waypoint : this.waypoints) {
            WorldMap worldMap = this.map;
            synchronized (worldMap) {
                for (Waypoint neighbour : this.graph.waypointKDTree().n_nearestNeighbour(waypoint.coord().getVector(), 20)) {
                    if (neighbour == null || waypoint == neighbour || this.segmentClipsObstacles(waypoint.coord(), neighbour.coord())) continue;
                    waypoint.addNeighbour(neighbour);
                }
            }
            if (updateIt++ != updateEvery) continue;
            this.dispatchGeneratorUpdated("Connecting nearest neighbours...");
            updateIt = 0;
        }
        return null;
    }

    public boolean segmentClipsObstacles(Coord from, Coord to) {
        for (AbstractObject obj : this.map.objects()) {
            if (!obj.isObstructing() || !obj.clipsSegment(from, to)) continue;
            return true;
        }
        return false;
    }

    private String cacheShortestPaths() {
        return null;
    }

    public List<Waypoint> simplifyPath(List<Waypoint> origPath) {
        if (origPath.size() <= 2) {
            return origPath;
        }
        ArrayList<Waypoint> simplified = new ArrayList<Waypoint>();
        int idxStart = 0;
        Waypoint startSeg = origPath.get(0);
        int i = 1;
        while (i < origPath.size()) {
            Waypoint waypoint = origPath.get(i);
            if (this.segmentClipsObstacles(startSeg.coord(), waypoint.coord())) {
                simplified.add(startSeg);
                idxStart = idxStart == i - 1 ? i : i - 1;
                startSeg = origPath.get(idxStart);
                i = idxStart;
            }
            ++i;
        }
        simplified.add(startSeg);
        Waypoint lastWaypoint = origPath.get(origPath.size() - 1);
        if (simplified.get(simplified.size() - 1) != lastWaypoint) {
            simplified.add(lastWaypoint);
        }
        Waypoint prev = (Waypoint)simplified.get(0);
        int i2 = 1;
        while (i2 < simplified.size()) {
            Waypoint waypoint = (Waypoint)simplified.get(i2);
            prev.addNeighbour(waypoint);
            prev = waypoint;
            ++i2;
        }
        return simplified;
    }

    public boolean run() {
        this.isRunning = true;
        String errorInfo = null;
        ProgressDialog dialog = new ProgressDialog("経路更新中・・・", "経路情報を更新しています。しばらくお待ちください。");
        ProgressManager<String> pMan = new ProgressManager<String>();
        pMan.addProgressListener(dialog);
        errorInfo = this.initialize();
        if (errorInfo == null) {
            this.dispatchGeneratorUpdated("Generating waypoints...");
            pMan.report(0.0, "通過点追加中・・・");
            errorInfo = this.generateWaypoints(5.0);
        }
        if (errorInfo == null) {
            pMan.report(0.1, "オブジェクトに通過点設定中・・・");
            errorInfo = this.setWaypointsFromCartWaypoints();
        }
        if (errorInfo == null) {
            pMan.report(0.2, "オブジェクトに作業点設定中・・・");
            errorInfo = this.setWorkPointsForTargets();
        }
        if (errorInfo == null) {
            this.dispatchGeneratorUpdated("Connecting nearest neighbours...");
            pMan.report(0.3, "近傍点を接続中・・・");
            errorInfo = this.connectNearestNeighbours();
        }
        if (errorInfo == null) {
            this.dispatchGeneratorUpdated("Caching shortest paths...");
            pMan.report(0.8, "最短パスキャッシュ中・・・");
            errorInfo = this.cacheShortestPaths();
        }
        this.dispatchGeneratorUpdated("Finished generating network");
        pMan.report(1.0, "完了");
        dialog.close();
        if (errorInfo != null) {
            JOptionPane.showMessageDialog(null, errorInfo, "経路探索エラー", 0);
        }
        this.dispatchGeneratorFinished();
        this.isRunning = false;
        return errorInfo == null;
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void addListener(NetworkGeneratorListener listener) {
        List<NetworkGeneratorListener> list = this.listeners;
        synchronized (list) {
            this.listeners.add(listener);
        }
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void dispatchGeneratorUpdated(String message) {
        System.out.println(message);
        List<NetworkGeneratorListener> list = this.listeners;
        synchronized (list) {
            for (NetworkGeneratorListener listener : this.listeners) {
                listener.generatorUpdated(message, this);
            }
        }
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void dispatchGeneratorFinished() {
        List<NetworkGeneratorListener> list = this.listeners;
        synchronized (list) {
            for (NetworkGeneratorListener listener : this.listeners) {
                listener.generateFinished(this);
            }
        }
    }

    public static interface NetworkGeneratorListener {
        public void generatorUpdated(String var1, WalkNetworkGenerator var2);

        public void generateFinished(WalkNetworkGenerator var1);
    }

    public static enum PickSide {
        kLeft(false),
        kRight(false),
        kTop(true),
        kBottom(true);

        public boolean vertical;

        private PickSide(boolean vertical) {
            this.vertical = vertical;
        }

        public Coord coordForRect(AbstractRectangleObject shelf) {
            if (this == kTop) {
                return new Coord(shelf.center().x, shelf.tl().y);
            }
            if (this == kLeft) {
                return new Coord(shelf.tl().x, shelf.center().y);
            }
            if (this == kBottom) {
                return new Coord(shelf.center().x, shelf.br().y);
            }
            if (this == kRight) {
                return new Coord(shelf.br().x, shelf.center().y);
            }
            return null;
        }

        public PickSide opposite() {
            if (this == kTop) {
                return kBottom;
            }
            if (this == kBottom) {
                return kTop;
            }
            if (this == kLeft) {
                return kRight;
            }
            if (this == kRight) {
                return kLeft;
            }
            return null;
        }
    }
}

