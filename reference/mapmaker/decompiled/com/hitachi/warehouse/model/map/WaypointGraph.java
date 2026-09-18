/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.map;

import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.gui.mapframe.QuickMap;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.map.Waypoint;
import com.hitachi.warehouse.model.map.WaypointDistCache;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.AbstractRectangleObject;
import com.hitachi.warehouse.model.map.objects.ConstrainedAreaObject;
import com.hitachi.warehouse.model.map.objects.FreeShelfObject;
import common.ds.BinaryHash;
import common.ds.KDTree;
import common.ds.Vector;
import common.gui.Draw;
import common.gui.ErrorDialog;
import common.util.HashMapSet;
import common.util.LoopTimeKeeper;
import common.util.Pfor;
import common.util.PrioritizedObject;
import java.awt.Color;
import java.awt.Font;
import java.awt.Graphics2D;
import java.awt.Point;
import java.awt.event.MouseEvent;
import java.awt.event.MouseMotionAdapter;
import java.io.IOException;
import java.io.ObjectInputStream;
import java.io.ObjectOutputStream;
import java.io.Serializable;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;

public class WaypointGraph
implements Serializable {
    private static final long serialVersionUID = 4250313564261483404L;
    public final WorldMap map;
    private HashMap<Waypoint, Integer> FloorNoForWaypoint = new HashMap();
    private HashMapSet<Integer, Waypoint> waypointsForFloorNo = new HashMapSet();
    private HashMap<Waypoint, AbstractRectangleObject> rectForWaypoint = new HashMap();
    private HashMapSet<AbstractRectangleObject, Waypoint> waypointsForRect = new HashMapSet();
    private HashMapSet<Waypoint, WaypointTag> tagForWaypoint = new HashMapSet();
    private HashMapSet<ConstrainedAreaObject, Waypoint> entryExitWaypointForConstrainedArea = new HashMapSet();
    private HashMapSet<ConstrainedAreaObject, Waypoint> waypointsInsideConstrainedArea = new HashMapSet();
    private HashMap<Waypoint, ConstrainedAreaObject> constrainedAreaForWaypoint = new HashMap();
    @Deprecated
    private Set<Waypoint> waypoints;
    private List<Waypoint> waypointsList = new ArrayList<Waypoint>();
    private transient KDTree<Waypoint> waypointKDTree;
    private WaypointDistCache distCache = null;

    public WaypointGraph(WorldMap map) {
        this.map = map;
    }

    public HashMapSet<Integer, Waypoint> waypointsForFloorNo() {
        return this.waypointsForFloorNo;
    }

    public Set<Waypoint> waypointsForFloorNo(int floorNo) {
        return this.waypointsForFloorNo.get(floorNo);
    }

    public int FloorNoForWaypoint(Waypoint waypoint) {
        if (this.FloorNoForWaypoint.get(waypoint) == null) {
            return -1;
        }
        return this.FloorNoForWaypoint.get(waypoint);
    }

    public void setWaypointForFloorNo(int FloorNo, Waypoint waypoint) {
        this.waypointsForFloorNo.put((Integer)FloorNo, waypoint);
        this.FloorNoForWaypoint.put(waypoint, FloorNo);
    }

    public void resetWaypointsForFloorNo() {
        this.waypointsForFloorNo.clear();
        this.FloorNoForWaypoint.clear();
    }

    public HashMapSet<AbstractRectangleObject, Waypoint> waypointsForRect() {
        return this.waypointsForRect;
    }

    public Set<Waypoint> waypointsForRect(AbstractRectangleObject rect) {
        return this.waypointsForRect.get(rect);
    }

    public AbstractRectangleObject rectForWaypoint(Waypoint waypoint) {
        return this.rectForWaypoint.get(waypoint);
    }

    public void setWaypointForRect(AbstractRectangleObject rect, Waypoint waypoint) {
        this.waypointsForRect.put(rect, waypoint);
        this.rectForWaypoint.put(waypoint, rect);
    }

    public void resetWaypointsForRect() {
        this.waypointsForRect.clear();
        this.rectForWaypoint.clear();
    }

    public boolean hasTags(Waypoint waypoint) {
        return this.tagForWaypoint.containsKey(waypoint);
    }

    public Set<WaypointTag> tagsForWaypoint(Waypoint waypoint) {
        return this.tagForWaypoint.get(waypoint);
    }

    public void setEntryExitPointForConstrainedObject(ConstrainedAreaObject passage, Waypoint waypoint, WaypointTag tag) {
        this.entryExitWaypointForConstrainedArea.put(passage, waypoint);
        this.tagForWaypoint.put(waypoint, tag);
        this.constrainedAreaForWaypoint.put(waypoint, passage);
    }

    public Set<Waypoint> entryExitWaypointsForConstrainedArea(ConstrainedAreaObject area) {
        return this.entryExitWaypointForConstrainedArea.get(area);
    }

    public void putWaypointInConstrainedArea(ConstrainedAreaObject passage, Waypoint waypoint) {
        this.waypointsInsideConstrainedArea.put(passage, waypoint);
        this.constrainedAreaForWaypoint.put(waypoint, passage);
    }

    public Set<Waypoint> waypointsInConstrainedArea(ConstrainedAreaObject area) {
        return this.waypointsInsideConstrainedArea.get(area);
    }

    public ConstrainedAreaObject constrainedAreaForWaypoint(Waypoint waypoint) {
        return this.constrainedAreaForWaypoint.get(waypoint);
    }

    public void resetNetwork() {
        this.waypointsList.clear();
        this.waypointKDTree = null;
        this.waypointsForRect = new HashMapSet();
        this.rectForWaypoint = new HashMap();
        this.tagForWaypoint = new HashMapSet();
        this.entryExitWaypointForConstrainedArea = new HashMapSet();
        this.FloorNoForWaypoint = new HashMap();
        this.waypointsForFloorNo = new HashMapSet();
    }

    @Deprecated
    public Set<Waypoint> waypoints() {
        return this.waypoints;
    }

    public List<Waypoint> waypointsList() {
        return this.waypointsList;
    }

    public void addWaypoint(Waypoint waypoint) {
        this.waypointsList.add(waypoint);
    }

    public void removeWaypoint(Waypoint waypoint) {
        this.waypointsList.remove(waypoint);
        waypoint.kill();
        this.waypointKDTree = null;
        AbstractRectangleObject rect = this.rectForWaypoint.get(waypoint);
        if (rect != null) {
            this.rectForWaypoint.remove(waypoint);
            this.waypointsForRect.remove(rect, waypoint);
        }
        this.tagForWaypoint.remove(waypoint);
        ConstrainedAreaObject area = this.constrainedAreaForWaypoint.get(waypoint);
        if (area != null) {
            this.constrainedAreaForWaypoint.remove(waypoint);
            this.waypointsInsideConstrainedArea.remove(area, waypoint);
            this.entryExitWaypointForConstrainedArea.remove(area, waypoint);
        }
    }

    public void removeFreeWaypoint(Waypoint waypoint) {
        this.waypointsList.remove(waypoint);
        waypoint.kill();
        this.waypointKDTree = null;
    }

    public KDTree<Waypoint> waypointKDTree() {
        if (this.waypointKDTree == null) {
            HashMap<Vector, Waypoint> vectorForWaypoint = new HashMap<Vector, Waypoint>();
            for (Waypoint waypoint : this.waypointsList) {
                vectorForWaypoint.put(waypoint.coord().getVector(), waypoint);
            }
            if (vectorForWaypoint.size() > 0) {
                this.waypointKDTree = new KDTree(2, vectorForWaypoint);
            }
        }
        return this.waypointKDTree;
    }

    public List<Waypoint> shortestPathBetween(Waypoint from, Waypoint dest) {
        LinkedList<Waypoint> shortestPath = null;
        if (shortestPath == null) {
            PriorityQueue<PrioritizedObject<Waypoint>> queue = new PriorityQueue<PrioritizedObject<Waypoint>>();
            HashMap<Waypoint, Double> shortestDistFor = new HashMap<Waypoint, Double>();
            HashMap<Waypoint, Double> fsFor = new HashMap<Waypoint, Double>();
            HashMap<Waypoint, Waypoint> prevNodeFor = new HashMap<Waypoint, Waypoint>();
            double f2 = from.coord().distTo(dest.coord());
            queue.add(new PrioritizedObject<Waypoint>(from, f2));
            shortestDistFor.put(from, 0.0);
            fsFor.put(from, f2);
            while (queue.size() > 0) {
                Waypoint node = (Waypoint)((PrioritizedObject)queue.poll()).obj;
                double currentDist = (Double)shortestDistFor.get(node);
                if (node == dest) break;
                for (Waypoint next : node.networkNeighbours()) {
                    Double currentF = (Double)fsFor.get(next);
                    double dist = currentDist + node.coord().distTo(next.coord());
                    double f3 = dist + next.coord().distTo(dest.coord());
                    if (currentF != null && !(f3 < currentF)) continue;
                    shortestDistFor.put(next, dist);
                    fsFor.put(next, f3);
                    prevNodeFor.put(next, node);
                    queue.add(new PrioritizedObject<Waypoint>(next, f3));
                }
            }
            if (shortestDistFor.get(dest) == null) {
                System.out.println("no path found for: " + from + " " + dest + " " + shortestDistFor.size());
                return null;
            }
            LinkedList<Waypoint> edgeList = new LinkedList<Waypoint>();
            Waypoint current = dest;
            while (current != from) {
                edgeList.push(current);
                current = (Waypoint)prevNodeFor.get(current);
            }
            edgeList.push(from);
            shortestPath = edgeList;
        }
        return shortestPath;
    }

    public List<Waypoint> shortestPathBetween_greedy(Waypoint from, Waypoint dest) {
        LinkedList<Waypoint> shortestPath = null;
        if (shortestPath == null) {
            HashSet<Waypoint> saturated = new HashSet<Waypoint>();
            HashSet<Waypoint> visited = new HashSet<Waypoint>();
            shortestPath = new LinkedList<Waypoint>();
            while (from != dest) {
                visited.add(from);
                shortestPath.add(from);
                if (from == dest) break;
                double minDist = Double.MAX_VALUE;
                Waypoint nextCand = null;
                for (Waypoint next : from.networkNeighbours) {
                    double dist;
                    if (visited.contains(next) || !((dist = next.coord().distTo(dest.coord())) < minDist)) continue;
                    minDist = dist;
                    nextCand = next;
                }
                if (nextCand != null) {
                    from = nextCand;
                    continue;
                }
                saturated.add(from);
                while (saturated.contains(shortestPath.peekLast())) {
                    shortestPath.pollLast();
                }
                from = (Waypoint)shortestPath.peekLast();
            }
        }
        return shortestPath;
    }

    public double distBetween(Waypoint from, Waypoint dest) {
        if (from.equals(dest)) {
            return 0.0;
        }
        PriorityQueue<PrioritizedObject<Waypoint>> queue = new PriorityQueue<PrioritizedObject<Waypoint>>();
        HashMap<Waypoint, Double> shortestDistFor = new HashMap<Waypoint, Double>();
        HashMap<Waypoint, Double> fsFor = new HashMap<Waypoint, Double>();
        HashMap<Waypoint, Waypoint> prevNodeFor = new HashMap<Waypoint, Waypoint>();
        double f2 = from.coord().distTo(dest.coord());
        queue.add(new PrioritizedObject<Waypoint>(from, f2));
        shortestDistFor.put(from, 0.0);
        fsFor.put(from, f2);
        while (queue.size() > 0) {
            Waypoint node = (Waypoint)((PrioritizedObject)queue.poll()).obj;
            double currentDist = (Double)shortestDistFor.get(node);
            if (node == dest) {
                return currentDist;
            }
            for (Waypoint next : node.networkNeighbours()) {
                Double currentF = (Double)fsFor.get(next);
                double dist = currentDist + node.coord().distTo(next.coord());
                double f3 = dist + next.coord().distTo(dest.coord());
                if (currentF != null && !(f3 < currentF)) continue;
                shortestDistFor.put(next, dist);
                fsFor.put(next, f3);
                prevNodeFor.put(next, node);
                queue.add(new PrioritizedObject<Waypoint>(next, f3));
            }
        }
        if (queue.size() == 0) {
            System.out.println("no path found for: " + from + " " + dest + " " + shortestDistFor.size());
            throw new IllegalArgumentException("no path found");
        }
        return Double.MAX_VALUE;
    }

    public static double distForPath(List<Waypoint> path) {
        double dist = 0.0;
        Waypoint prev = null;
        for (Waypoint p : path) {
            if (prev != null) {
                dist += prev.coord().distTo(p.coord());
            }
            prev = p;
        }
        return dist;
    }

    public Map<Waypoint, List<Waypoint>> shortestPathsFor(Waypoint from, Collection<Waypoint> dests) {
        for (Waypoint waypoint : this.waypointsList) {
            waypoint._USERDATA_DOUBLE_0 = Double.MAX_VALUE;
            waypoint._USERDATA_BOOLEAN_0 = false;
        }
        PriorityQueue<Waypoint> queue = new PriorityQueue<Waypoint>(dests.size(), new Comparator<Waypoint>(){

            @Override
            public int compare(Waypoint o1, Waypoint o2) {
                return Double.compare(o1._USERDATA_DOUBLE_0, o2._USERDATA_DOUBLE_0);
            }
        });
        for (Waypoint waypoint : dests) {
            waypoint._USERDATA_BOOLEAN_0 = true;
        }
        int numUnreachedDests = dests.size();
        from._USERDATA_DOUBLE_0 = 0.0;
        queue.add(from);
        while (queue.size() > 0) {
            Waypoint node = queue.poll();
            double currentDist = node._USERDATA_DOUBLE_0;
            if (node._USERDATA_BOOLEAN_0) {
                node._USERDATA_BOOLEAN_0 = false;
                if (--numUnreachedDests == 0) break;
            }
            for (Waypoint next : node.networkNeighbours()) {
                double dist = currentDist + node.coord().distTo(next.coord());
                if (!(next._USERDATA_DOUBLE_0 > dist)) continue;
                next._USERDATA_DOUBLE_0 = dist;
                next._USERDATA_WAYPOINT_0 = node;
                queue.add(next);
            }
        }
        if (numUnreachedDests > 0) {
            HashSet<Waypoint> unreachedDests = new HashSet<Waypoint>();
            for (Waypoint dest : dests) {
                if (!dest._USERDATA_BOOLEAN_0) continue;
                unreachedDests.add(dest);
            }
            System.out.println("unreacheable from " + from + ": " + unreachedDests);
            final Waypoint orig = from;
            final HashSet<Waypoint> unreachable = unreachedDests;
            if (this.map != null) {
                new QuickMap(this.map){
                    Waypoint currentClosest;
                    List<Waypoint> path;
                    {
                        super($anonymous0);
                        this.currentClosest = null;
                    }

                    @Override
                    protected void mapViewSet(MapView mapView) {
                        mapView.addMouseMotionListener(new MouseMotionAdapter(){

                            @Override
                            public void mouseMoved(MouseEvent e) {
                                Coord coord = this.mapView().coordForScreen(e.getX(), e.getY());
                                double closestDist = Double.MAX_VALUE;
                                Waypoint closest = null;
                                for (Waypoint other : WaypointGraph.this.waypointsList) {
                                    double dist = other.coord().distTo(coord);
                                    if (!(dist < closestDist)) continue;
                                    closestDist = dist;
                                    closest = other;
                                }
                                if (currentClosest != closest) {
                                    currentClosest = closest;
                                    path = WaypointGraph.this.shortestPathBetween(orig, currentClosest);
                                    this.repaint();
                                }
                            }
                        });
                    }

                    @Override
                    public void draw(Graphics2D g) {
                        g.setFont(new Font("Arial", 1, 20));
                        g.setColor(Color.GRAY);
                        for (Waypoint waypoint : WaypointGraph.this.waypointsList) {
                            for (Waypoint other : waypoint.networkNeighbours) {
                                Draw.drawLine(g, this.mapView().screenPointForWorld(waypoint.coord()), this.mapView().screenPointForWorld(other.coord()));
                            }
                        }
                        g.setColor(Color.RED);
                        Draw.fillCircle(g, this.mapView().screenPointForWorld(orig.coord()), 10);
                        if (this.path != null) {
                            Waypoint prev = null;
                            g.setColor(Color.RED);
                            for (Waypoint waypoint : this.path) {
                                if (prev != null) {
                                    Point p = this.mapView().screenPointForWorld(waypoint.coord());
                                    Draw.drawString(g, "" + waypoint, p.x, p.y);
                                    Draw.drawLine(g, this.mapView().screenPointForWorld(prev.coord()), this.mapView().screenPointForWorld(waypoint.coord()));
                                }
                                prev = waypoint;
                            }
                        }
                        g.setColor(Color.GREEN);
                        for (Waypoint waypoint : unreachable) {
                            Draw.drawCircle(g, this.mapView().screenPointForWorld(waypoint.coord()), 3);
                        }
                    }
                };
                System.out.println("finished open");
            }
            return null;
        }
        HashMap<Waypoint, List<Waypoint>> pathForDest = new HashMap<Waypoint, List<Waypoint>>();
        for (Waypoint dest : dests) {
            if (dest._USERDATA_BOOLEAN_0) continue;
            LinkedList<Waypoint> edgeList = new LinkedList<Waypoint>();
            Waypoint current = dest;
            while (current != from) {
                edgeList.push(current);
                current = current._USERDATA_WAYPOINT_0;
            }
            edgeList.push(from);
            pathForDest.put(dest, edgeList);
        }
        return pathForDest;
    }

    public BinaryHash<Waypoint, Waypoint, List<Waypoint>> shortestPathsBetweenWarshalFloyd(Collection<Waypoint> origins, Collection<Waypoint> dests) {
        HashMap<Waypoint, Integer> idxFor = new HashMap<Waypoint, Integer>();
        int numWaypoints = this.waypointsList.size();
        Waypoint[] waypoints = new Waypoint[numWaypoints];
        for (Waypoint waypoint : this.waypointsList) {
            int idx = idxFor.size();
            idxFor.put(waypoint, idx);
            waypoints[idx] = waypoint;
        }
        int[][] prevWaypointBetween = new int[numWaypoints][numWaypoints];
        double[][] minDists = new double[numWaypoints][numWaypoints];
        int i = 0;
        while (i < numWaypoints) {
            int j = 0;
            while (j < numWaypoints) {
                minDists[i][j] = -1.0;
                prevWaypointBetween[i][j] = -1;
                ++j;
            }
            ++i;
        }
        int fromIdx = 0;
        while (fromIdx < numWaypoints) {
            Waypoint waypoint = waypoints[fromIdx];
            minDists[fromIdx][fromIdx] = 0.0;
            prevWaypointBetween[fromIdx][fromIdx] = fromIdx;
            for (Waypoint connected : waypoint.networkNeighbours()) {
                int toIdx = (Integer)idxFor.get(connected);
                minDists[fromIdx][toIdx] = waypoint.coord().distTo(connected.coord());
                prevWaypointBetween[fromIdx][toIdx] = fromIdx;
            }
            ++fromIdx;
        }
        int c = 0;
        while (c < numWaypoints) {
            System.out.println(c);
            int a = 0;
            while (a < numWaypoints) {
                double a_c = minDists[a][c];
                if (a_c != -1.0) {
                    int b = 0;
                    while (b < numWaypoints) {
                        double c_b = minDists[c][b];
                        if (c_b != -1.0) {
                            double a_b = minDists[a][b];
                            double a_c_b = a_c + c_b;
                            if (a_b == -1.0 || a_b > a_c_b) {
                                minDists[a][b] = a_c_b;
                                prevWaypointBetween[a][b] = prevWaypointBetween[c][b];
                            }
                        }
                        ++b;
                    }
                }
                ++a;
            }
            ++c;
        }
        BinaryHash<Waypoint, Waypoint, List<Waypoint>> paths = new BinaryHash<Waypoint, Waypoint, List<Waypoint>>();
        for (Waypoint from : origins) {
            for (Waypoint to : dests) {
                if (from == to) continue;
                LinkedList<Waypoint> path = new LinkedList<Waypoint>();
                int idxFrom = (Integer)idxFor.get(from);
                path.push(to);
                int current = (Integer)idxFor.get(to);
                while (idxFrom != current) {
                    path.push(waypoints[current]);
                    current = prevWaypointBetween[idxFrom][current];
                    if (current != -1) continue;
                    return null;
                }
                paths.put(from, to, path);
            }
        }
        return paths;
    }

    public BinaryHash<Waypoint, Waypoint, Double> shortestDistsBetween(Set<Waypoint> dests) {
        int j;
        HashMap<Waypoint, Integer> idxFor = new HashMap<Waypoint, Integer>();
        final int numWaypoints = this.waypointsList.size();
        Waypoint[] waypoints = new Waypoint[numWaypoints];
        for (Waypoint waypoint : this.waypointsList) {
            int idx = idxFor.size();
            idxFor.put(waypoint, idx);
            waypoints[idx] = waypoint;
        }
        final int[][] minDists = new int[numWaypoints][numWaypoints];
        int i = 0;
        while (i < numWaypoints) {
            j = 0;
            while (j < numWaypoints) {
                minDists[i][j] = -1;
                ++j;
            }
            ++i;
        }
        Waypoint[] waypointArray = waypoints;
        int n = waypoints.length;
        j = 0;
        while (j < n) {
            Waypoint waypoint = waypointArray[j];
            int fromIdx = (Integer)idxFor.get(waypoint);
            minDists[fromIdx][fromIdx] = 0;
            for (Waypoint connected : waypoint.networkNeighbours()) {
                int toIdx = (Integer)idxFor.get(connected);
                minDists[fromIdx][toIdx] = (int)waypoint.coord().distTo(connected.coord());
            }
            ++j;
        }
        ArrayList<int[]> asList = new ArrayList<int[]>();
        int numThreads = 12;
        int i2 = 0;
        while (i2 < numThreads) {
            int from = i2 * numWaypoints / numThreads;
            int to = (i2 + 1) * numWaypoints / numThreads;
            int[] as = new int[to - from];
            int j2 = 0;
            while (j2 < as.length) {
                as[j2] = from + j2;
                ++j2;
            }
            asList.add(as);
            ++i2;
        }
        LoopTimeKeeper tk = new LoopTimeKeeper(numWaypoints);
        int c = 0;
        while (c < numWaypoints) {
            tk.increment();
            if (c % 100 == 0) {
                System.out.println(String.valueOf(c) + " " + tk);
            }
            final int _c = c++;
            new Pfor<int[]>(asList){

                @Override
                public void call(int[] as) {
                    int[] nArray = as;
                    int n = as.length;
                    int n2 = 0;
                    while (n2 < n) {
                        int a = nArray[n2];
                        int a_c = minDists[a][_c];
                        if (a_c != -1) {
                            int b = 0;
                            while (b < numWaypoints) {
                                int a_b;
                                int c_b = minDists[_c][b];
                                if (c_b != -1 && ((a_b = minDists[a][b]) == -1 || a_b > a_c + c_b)) {
                                    minDists[a][b] = a_c + c_b;
                                }
                                ++b;
                            }
                        }
                        ++n2;
                    }
                }
            };
        }
        System.out.println("here");
        BinaryHash<Waypoint, Waypoint, Double> dists = new BinaryHash<Waypoint, Waypoint, Double>();
        for (Waypoint from : dests) {
            int fromIdx = (Integer)idxFor.get(from);
            for (Waypoint to : dests) {
                int toIdx = (Integer)idxFor.get(to);
                System.out.println(from + " " + to + " " + minDists[fromIdx][toIdx]);
                dists.put(from, to, Double.valueOf(minDists[fromIdx][toIdx]));
            }
        }
        return dists;
    }

    public WaypointDistCache distCache() {
        if (this.distCache == null) {
            this.generateDistCache();
        }
        return this.distCache;
    }

    public void setWaypointDistCache(WaypointDistCache distCache) {
        this.distCache = distCache;
    }

    public void generateDistCache() {
        Set<Waypoint> waypoints;
        BinaryHash<Waypoint, Waypoint, Float> distMap = new BinaryHash<Waypoint, Waypoint, Float>();
        ArrayList<Waypoint> targetWaypoints = new ArrayList<Waypoint>();
        for (FreeShelfObject shelfObject : this.map.freeShelfObjects()) {
            waypoints = this.waypointsForRect(shelfObject);
            targetWaypoints.addAll(waypoints);
        }
        for (ConstrainedAreaObject areas : this.map.constrainedAreaObjects()) {
            waypoints = this.entryExitWaypointsForConstrainedArea(areas);
            targetWaypoints.addAll(waypoints);
        }
        HashSet<Waypoint> tos = new HashSet<Waypoint>();
        tos.addAll(targetWaypoints);
        for (Waypoint from : targetWaypoints) {
            tos.remove(from);
            Map<Waypoint, List<Waypoint>> paths = this.shortestPathsFor(from, tos);
            for (Waypoint to : tos) {
                List<Waypoint> path = paths.get(to);
                if (path != null) {
                    float dist = (float)WaypointGraph.distForPath(path);
                    distMap.put(from, to, Float.valueOf(dist));
                    continue;
                }
                ErrorDialog box = new ErrorDialog(null, "Path not found", "Can't connect from " + from + " to " + to + " !!! Aborting export.", false);
                box.setVisible(true);
                box.dispose();
                return;
            }
            tos.add(from);
        }
        this.distCache = new WaypointDistCache(distMap);
    }

    private void writeObject(ObjectOutputStream out) throws IOException {
        HashMapSet<Integer, Integer> edgeGraph = new HashMapSet<Integer, Integer>();
        HashMap<Integer, Waypoint> waypointForID = new HashMap<Integer, Waypoint>();
        for (Waypoint base : this.waypointsList) {
            if (waypointForID.containsKey(base.id)) {
                System.out.println("error! already contains " + base.id);
            }
            waypointForID.put(base.id, base);
            for (Waypoint other : base.networkNeighbours()) {
                edgeGraph.put(Integer.valueOf(base.id), other.id);
            }
        }
        out.defaultWriteObject();
        out.writeInt(this.waypointsList.size());
        for (Waypoint base : this.waypointsList) {
            out.writeInt(base.id);
            Set others = edgeGraph.get(base.id);
            out.writeInt(others.size());
            for (Integer other : others) {
                out.writeInt(other);
            }
        }
    }

    private void readObject(ObjectInputStream in) throws IOException, ClassNotFoundException {
        try {
            in.defaultReadObject();
            if (this.waypointsList == null) {
                this.waypointsList = new ArrayList<Waypoint>();
            }
            HashMap<Integer, Waypoint> waypointForID = new HashMap<Integer, Waypoint>();
            for (Waypoint waypoint : this.waypointsList) {
                waypointForID.put(waypoint.id, waypoint);
            }
            int numWaypoints = in.readInt();
            int i = 0;
            while (i < numWaypoints) {
                Waypoint base = (Waypoint)waypointForID.get(in.readInt());
                int num = in.readInt();
                int j = 0;
                while (j < num) {
                    int other_no = in.readInt();
                    Waypoint other = (Waypoint)waypointForID.get(other_no);
                    if (other != null) {
                        base.networkNeighbours.add(other);
                    }
                    ++j;
                }
                ++i;
            }
            if (this.waypointsForRect == null) {
                this.waypointsForRect = new HashMapSet();
            }
            if (this.rectForWaypoint == null) {
                this.rectForWaypoint = new HashMap();
            }
            if (this.tagForWaypoint == null) {
                this.tagForWaypoint = new HashMapSet();
            }
            if (this.entryExitWaypointForConstrainedArea == null) {
                this.entryExitWaypointForConstrainedArea = new HashMapSet();
            }
        }
        catch (Exception e) {
            e.printStackTrace();
            this.waypointsList = new ArrayList<Waypoint>();
        }
    }

    public void addWaypointGraph(WaypointGraph graph) {
        if (graph.rectForWaypoint != null) {
            this.rectForWaypoint.putAll(graph.rectForWaypoint);
        }
        if (graph.waypointsForRect != null) {
            this.waypointsForRect.putAll(graph.waypointsForRect);
        }
        if (graph.tagForWaypoint != null) {
            this.tagForWaypoint.putAll(graph.tagForWaypoint);
        }
        if (graph.entryExitWaypointForConstrainedArea != null) {
            this.entryExitWaypointForConstrainedArea.putAll(graph.entryExitWaypointForConstrainedArea);
        }
        if (graph.waypointsInsideConstrainedArea != null) {
            this.waypointsInsideConstrainedArea.putAll(graph.waypointsInsideConstrainedArea);
        }
        if (graph.constrainedAreaForWaypoint != null) {
            this.constrainedAreaForWaypoint.putAll(graph.constrainedAreaForWaypoint);
        }
        if (graph.waypoints != null) {
            this.waypoints.addAll(graph.waypoints);
        }
        if (graph.waypointsList != null) {
            this.waypointsList.addAll(graph.waypointsList);
        }
        if (graph.FloorNoForWaypoint != null) {
            this.FloorNoForWaypoint.putAll(graph.FloorNoForWaypoint);
        }
        if (graph.waypointsForFloorNo != null) {
            this.waypointsForFloorNo.putAll(graph.waypointsForFloorNo);
        }
    }

    public static enum WaypointTag {
        kConstraintPassage_AEntry,
        kConstraintPassage_BEntry,
        kConstraintPassage_AExit,
        kConstraintPassage_BExit;

    }
}

