/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.networkgenerator;

import com.hitachi.warehouse.mapmaker.debug.MemoryInfo;
import com.hitachi.warehouse.mapmaker.networkgenerator.GenerateInterruptException;
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
import com.hitachi.warehouse.model.map.objects.StationObject;
import common.ds.FixedArrayList;
import common.ds.KDTree;
import common.util.MathUtil;
import delaunay_triangulation.Delaunay_Triangulation;
import delaunay_triangulation.Point_dt;
import delaunay_triangulation.Triangle_dt;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Vector;

public class CartNetworkGenerator {
    private double offset_mm = 500.0;
    private final FixedArrayList<AbstractObject> allObjects = new FixedArrayList<AbstractObject>(AbstractObject.class);
    private final FixedArrayList<ConstrainedAreaObject> constrainedAreas = new FixedArrayList<ConstrainedAreaObject>(ConstrainedAreaObject.class);
    private final WorldMap map;
    private WaypointGraph graph;
    private int FloorNo;
    private int progress = 0;
    private boolean isRunning = false;
    private ArrayList<AbstractRectangleObject> targetObjects = new ArrayList();
    private Coord tl;
    private Coord br;
    private RectGrid<AbstractRectangleObject> obstaclesAndPassagesScanner;
    private RectGrid<AbstractRectangleObject> obstacleScanner;
    private FixedArrayList<Waypoint> freeWaypoints = new FixedArrayList<Waypoint>(Waypoint.class);
    private KDTree<Waypoint> freeWaypointScanner = null;
    private ArrayList<Waypoint> freeOrigins = new ArrayList();
    private FixedArrayList<Waypoint> freeDestinations = new FixedArrayList<Waypoint>(Waypoint.class);
    private boolean settings_needsAllShelvesToBeAccessible = true;
    private Waypoint[] allWaypoints;
    private Waypoint[] destArray;
    private byte[][] collidingPair;
    private boolean isCatchMemoryError = false;
    private ArrayList<String> warningErrorInfo = new ArrayList();
    transient List<NetworkGeneratorListener> listeners = new ArrayList<NetworkGeneratorListener>();
    final Comparator<Waypoint> waypointComparator_USERDATA_DOUBLE_0 = new Comparator<Waypoint>(){

        @Override
        public int compare(Waypoint o1, Waypoint o2) {
            if (o1._USERDATA_DOUBLE_0 < o2._USERDATA_DOUBLE_0) {
                return -1;
            }
            if (o2._USERDATA_DOUBLE_0 < o1._USERDATA_DOUBLE_0) {
                return 1;
            }
            return 0;
        }
    };

    public int getProgress() {
        return this.progress;
    }

    public CartNetworkGenerator(int FloorNo, WorldMap map) {
        try {
            map.startRead();
            this.allObjects.addAll((Collection<AbstractObject>)map.objects());
            this.constrainedAreas.addAll((Collection<ConstrainedAreaObject>)map.constrainedAreaObjects());
        }
        finally {
            map.endRead();
        }
        this.map = map;
        this.graph = new WaypointGraph(map);
        this.FloorNo = FloorNo;
    }

    public boolean isRunning() {
        return this.isRunning;
    }

    public String initialize() {
        for (AbstractObject obj : this.allObjects) {
            if (!FreeShelfObject.class.isInstance(obj) && !StationObject.class.isInstance(obj) && !StairsObject.class.isInstance(obj)) continue;
            this.targetObjects.add((AbstractRectangleObject)obj);
        }
        double left = Double.MAX_VALUE;
        double top = Double.MAX_VALUE;
        double bottom = 0.0;
        double right = 0.0;
        for (AbstractObject obj : this.allObjects) {
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
        this.tl = new Coord(left -= width * 0.05, top -= height * 0.05);
        this.br = new Coord(right += width * 0.05, bottom += height * 0.05);
        this.obstacleScanner = new RectGrid<AbstractRectangleObject>(this.tl, this.br, 5000.0, AbstractRectangleObject.class);
        this.obstaclesAndPassagesScanner = new RectGrid<AbstractRectangleObject>(this.tl, this.br, 5000.0, AbstractRectangleObject.class);
        for (AbstractObject obj : this.allObjects) {
            AbstractRectangleObject rect;
            if (!AbstractRectangleObject.class.isInstance(obj) || !Coord.clips((rect = (AbstractRectangleObject)obj).tl(), rect.br(), this.tl, this.br)) continue;
            if (rect.isObstructing()) {
                this.obstacleScanner.add(rect);
                this.obstaclesAndPassagesScanner.add(rect);
                continue;
            }
            if (!ConstrainedAreaObject.class.isInstance(rect)) continue;
            this.obstaclesAndPassagesScanner.add(rect);
        }
        this.obstacleScanner.commit();
        this.obstaclesAndPassagesScanner.commit();
        return null;
    }

    private String generateWaypoints() {
        Delaunay_Triangulation dt = new Delaunay_Triangulation();
        ArrayList<Coord[]> rects = new ArrayList<Coord[]>();
        rects.add(new Coord[]{this.tl, new Coord(this.br.x, this.tl.y), this.br, new Coord(this.tl.x, this.br.y)});
        for (AbstractObject object : this.map.objects()) {
            if (!AbstractRectangleObject.class.isInstance(object)) continue;
            Coord[] rect = (Coord[])object;
            rects.add(new Coord[]{rect.tl(), rect.tr(), rect.br(), rect.bl()});
        }
        try {
            double pointEvery_mm = 2500.0;
            for (Coord[] rect : rects) {
                Coord prev = rect[rect.length - 1];
                Coord[] coordArray = rect;
                int n = rect.length;
                int n2 = 0;
                while (n2 < n) {
                    Coord coord = coordArray[n2];
                    int numSplit = (int)Math.ceil(Math.max(Math.abs(coord.x - prev.x) / pointEvery_mm, Math.abs(coord.y - prev.y) / pointEvery_mm));
                    int i = 0;
                    while (i < numSplit) {
                        Coord c = new Coord(MathUtil.map(i, 0.0, numSplit, prev.x, coord.x), MathUtil.map(i, 0.0, numSplit, prev.y, coord.y));
                        dt.insertPoint(new Point_dt(c.x + Math.random() * 0.1, c.y + Math.random() * 0.1));
                        ++i;
                    }
                    prev = coord;
                    ++n2;
                }
            }
        }
        catch (Exception e) {
            e.printStackTrace();
            return "Error in generating wayppints";
        }
        HashMap<Triangle_dt, Waypoint> centerForTriangle = new HashMap<Triangle_dt, Waypoint>();
        HashMap<Point_dt, Triangle_dt> triForPoint = new HashMap<Point_dt, Triangle_dt>();
        Iterator<Triangle_dt> iterator = dt.trianglesIterator();
        while (iterator.hasNext()) {
            Triangle_dt triangle = iterator.next();
            if (triangle.isHalfplane()) continue;
            Point_dt center = triangle.circumcircle().Center();
            Coord coord = new Coord(center.x(), center.y());
            if (!this.obstaclesAndPassagesScanner.collidesAny(coord) && coord.isInside(this.tl, this.br)) {
                Waypoint waypoint = new Waypoint(coord);
                waypoint.setName(String.valueOf(waypoint.id));
                centerForTriangle.put(triangle, waypoint);
                this.freeWaypoints.add(waypoint);
                this.graph.addWaypoint(waypoint);
            }
            triForPoint.put(triangle.p1(), triangle);
            triForPoint.put(triangle.p2(), triangle);
            triForPoint.put(triangle.p3(), triangle);
        }
        for (Map.Entry entry : triForPoint.entrySet()) {
            Vector<Triangle_dt> triangles = dt.findTriangleNeighborhood((Triangle_dt)entry.getValue(), (Point_dt)entry.getKey());
            if (triangles == null) continue;
            Waypoint prevWaypoint = (Waypoint)centerForTriangle.get(triangles.get(triangles.size() - 1));
            for (Triangle_dt triangle : triangles) {
                Waypoint waypoint = (Waypoint)centerForTriangle.get(triangle);
                if (prevWaypoint != null && waypoint != null && !this.obstaclesAndPassagesScanner.clipsAny(prevWaypoint.coord(), waypoint.coord())) {
                    prevWaypoint.addNeighbour(waypoint);
                    waypoint.addNeighbour(prevWaypoint);
                }
                prevWaypoint = waypoint;
            }
        }
        if (this.freeWaypoints.size() == 0) {
            return "経路候補点を作成できません。";
        }
        HashMap<common.ds.Vector, Waypoint> waypointForVector = new HashMap<common.ds.Vector, Waypoint>();
        for (Waypoint waypoint : this.freeWaypoints) {
            waypointForVector.put(waypoint.coord().getVector(), waypoint);
        }
        this.freeWaypointScanner = new KDTree(2, waypointForVector, false);
        return null;
    }

    private String setWaypointsForTargets() {
        Object enclosingPassage;
        ArrayList<Waypoint> waypointsNeedingConnectingToFreeWaypoints = new ArrayList<Waypoint>();
        for (AbstractRectangleObject shelf : this.targetObjects) {
            Coord center = shelf.center();
            boolean picCreated = false;
            Coord[] coordArray = new Coord[]{new Coord(center.x, shelf.tl().y), new Coord(shelf.tl().x, center.y), new Coord(center.x, shelf.br().y), new Coord(shelf.br().x, center.y)};
            int n = coordArray.length;
            int n2 = 0;
            while (n2 < n) {
                Coord side = coordArray[n2];
                Coord coord = new Coord(side.x + this.offset_mm * Math.signum(side.x - center.x), side.y + this.offset_mm * Math.signum(side.y - center.y));
                if (!this.obstacleScanner.isClipping_ignore(coord, center, shelf)) {
                    picCreated = true;
                    enclosingPassage = AbstractObject.getEnclosingObject(coord, this.constrainedAreas);
                    if (enclosingPassage != null) {
                        Coord oppositeCoord;
                        Coord coord2 = ((ConstrainedAreaObject)enclosingPassage).internalCoordForPoint(side, this.offset_mm);
                        if (((ConstrainedAreaObject)enclosingPassage).canEnterA()) {
                            Waypoint fromAWaypoint = new Waypoint(shelf.toString(), coord2);
                            this.graph.addWaypoint(fromAWaypoint);
                            this.graph.setWaypointForRect(shelf, fromAWaypoint);
                            this.graph.putWaypointInConstrainedArea((ConstrainedAreaObject)enclosingPassage, fromAWaypoint);
                            fromAWaypoint._USERDATA_BOOLEAN_0 = true;
                            this.graph.setWaypointForFloorNo(this.FloorNo, fromAWaypoint);
                        }
                        if (((ConstrainedAreaObject)enclosingPassage).canEnterB()) {
                            Waypoint fromBWaypoint = new Waypoint(shelf.toString(), coord2);
                            this.graph.addWaypoint(fromBWaypoint);
                            this.graph.setWaypointForRect(shelf, fromBWaypoint);
                            this.graph.putWaypointInConstrainedArea((ConstrainedAreaObject)enclosingPassage, fromBWaypoint);
                            fromBWaypoint._USERDATA_BOOLEAN_0 = false;
                            this.graph.setWaypointForFloorNo(this.FloorNo, fromBWaypoint);
                        }
                        if ((oppositeCoord = ((ConstrainedAreaObject)enclosingPassage).oppositeInternalCoordForPoint(side, this.offset_mm)) != null) {
                            if (((ConstrainedAreaObject)enclosingPassage).canEnterA()) {
                                Waypoint fromAWaypoints = new Waypoint(String.valueOf(shelf.toString()) + "_accessor", oppositeCoord);
                                this.graph.addWaypoint(fromAWaypoints);
                                this.graph.putWaypointInConstrainedArea((ConstrainedAreaObject)enclosingPassage, fromAWaypoints);
                                fromAWaypoints._USERDATA_BOOLEAN_0 = true;
                            }
                            if (((ConstrainedAreaObject)enclosingPassage).canEnterB()) {
                                Waypoint fromBWaypoint = new Waypoint(String.valueOf(shelf.toString()) + "_accessor", oppositeCoord);
                                this.graph.addWaypoint(fromBWaypoint);
                                this.graph.putWaypointInConstrainedArea((ConstrainedAreaObject)enclosingPassage, fromBWaypoint);
                                fromBWaypoint._USERDATA_BOOLEAN_0 = false;
                            }
                        }
                    } else {
                        Waypoint waypoint = new Waypoint(String.valueOf(shelf.toString()) + "_free", coord);
                        this.graph.addWaypoint(waypoint);
                        this.graph.setWaypointForRect(shelf, waypoint);
                        waypointsNeedingConnectingToFreeWaypoints.add(waypoint);
                        this.freeOrigins.add(waypoint);
                        this.freeDestinations.add(waypoint);
                        this.graph.setWaypointForFloorNo(this.FloorNo, waypoint);
                    }
                }
                ++n2;
            }
            if (picCreated) continue;
            this.warningErrorInfo.add("全面が塞がれているオブジェクト（棚、階段、検品場）があります。");
        }
        for (ConstrainedAreaObject passage : this.constrainedAreas) {
            Waypoint entryA = null;
            Waypoint entryB = null;
            Waypoint exitA = null;
            Waypoint exitB = null;
            enclosingPassage = passage.getStartEndPoints();
            int n = ((Coord[])enclosingPassage).length;
            int n2 = 0;
            while (n2 < n) {
                Coord startEndCoord = enclosingPassage[n2];
                Waypoint waypoint = new Waypoint("startEnd_" + passage.id(), startEndCoord);
                Coord freeCoord = waypoint.coord().moveHeading(passage.center().heading(waypoint.coord()), 1.0);
                Waypoint freeWaypoint = new Waypoint(freeCoord);
                if (!this.obstaclesAndPassagesScanner.collidesAny(freeCoord)) {
                    boolean added = false;
                    if (passage.checkMoveDirectionConstraint(freeWaypoint, waypoint)) {
                        if (passage.canEnterA() && passage.isASideEntry(waypoint)) {
                            this.graph.setEntryExitPointForConstrainedObject(passage, waypoint, WaypointGraph.WaypointTag.kConstraintPassage_AEntry);
                            added = true;
                            entryA = waypoint;
                            freeWaypoint.addNeighbour(waypoint);
                            waypoint.setName(String.valueOf(waypoint.name()) + "_aEntry");
                            this.freeDestinations.add(waypoint);
                        }
                        if (passage.canEnterB() && passage.isBSideEntry(waypoint)) {
                            this.graph.setEntryExitPointForConstrainedObject(passage, waypoint, WaypointGraph.WaypointTag.kConstraintPassage_BEntry);
                            added = true;
                            entryB = waypoint;
                            freeWaypoint.addNeighbour(waypoint);
                            waypoint.setName(String.valueOf(waypoint.name()) + "_bEntry");
                            this.freeDestinations.add(waypoint);
                        }
                    }
                    if (passage.checkMoveDirectionConstraint(waypoint, freeWaypoint)) {
                        if (passage.canExitA() && passage.isASideExit(waypoint)) {
                            this.graph.setEntryExitPointForConstrainedObject(passage, waypoint, WaypointGraph.WaypointTag.kConstraintPassage_AExit);
                            added = true;
                            exitA = waypoint;
                            waypoint.addNeighbour(freeWaypoint);
                            waypoint.setName(String.valueOf(waypoint.name()) + "_aExit");
                            this.freeOrigins.add(waypoint);
                        }
                        if (passage.canExitB() && passage.isBSideExit(waypoint)) {
                            this.graph.setEntryExitPointForConstrainedObject(passage, waypoint, WaypointGraph.WaypointTag.kConstraintPassage_BExit);
                            added = true;
                            exitB = waypoint;
                            waypoint.addNeighbour(freeWaypoint);
                            waypoint.setName(String.valueOf(waypoint.name()) + "_bExit");
                            this.freeOrigins.add(waypoint);
                        }
                    }
                    if (added) {
                        this.graph.addWaypoint(waypoint);
                        this.graph.addWaypoint(freeWaypoint);
                        waypointsNeedingConnectingToFreeWaypoints.add(freeWaypoint);
                        this.freeWaypoints.add(waypoint);
                    }
                }
                ++n2;
            }
            if (entryA == null && entryB == null && exitA == null && exitB == null) {
                return "出入口が塞がれているか、出入口がない制約領域があります。";
            }
            if (passage.canEnterAExitA() && entryA == null) {
                return "Ａ入口から入れない制約領域があります。";
            }
            if (passage.canEnterBExitB() && entryB == null) {
                return "Ｂ入口から入れない制約領域があります。";
            }
            if (passage.canEnterAExitB()) {
                if (entryA == null) {
                    return "Ａ入口から入れない制約領域があります。";
                }
                if (exitB == null) {
                    return "Ｂ出口から出れない制約領域があります。";
                }
            }
            if (passage.canEnterBExitA()) {
                if (entryB == null) {
                    return "Ｂ入口から入れない制約領域があります。";
                }
                if (exitA == null) {
                    return "Ａ出口から出れない制約領域があります。";
                }
            }
            ArrayList<Waypoint> waypointsFromA = new ArrayList<Waypoint>();
            ArrayList<Waypoint> waypointsFromB = new ArrayList<Waypoint>();
            ArrayList<Waypoint> arrayList = new ArrayList<Waypoint>();
            for (Waypoint waypoint : this.graph.waypointsInConstrainedArea(passage)) {
                if (waypoint._USERDATA_BOOLEAN_0) {
                    if (entryA != null && passage.canConnectFromA(entryA, waypoint)) {
                        waypoint.setName(String.valueOf(waypoint.name()) + "_fromA");
                        waypointsFromA.add(waypoint);
                        continue;
                    }
                    arrayList.add(waypoint);
                    continue;
                }
                if (entryB != null && passage.canConnectFromB(entryB, waypoint)) {
                    waypoint.setName(String.valueOf(waypoint.name()) + "_fromB");
                    waypointsFromB.add(waypoint);
                    continue;
                }
                arrayList.add(waypoint);
            }
            for (Waypoint waypoint : arrayList) {
                this.graph.removeWaypoint(waypoint);
            }
            if (entryA != null) {
                waypointsFromA.add(entryA);
            }
            if (exitA != null && passage.canEnterAExitA()) {
                waypointsFromA.add(exitA);
            }
            if (exitB != null && passage.canEnterAExitB()) {
                waypointsFromA.add(exitB);
            }
            for (Waypoint waypoint : waypointsFromA) {
                for (Waypoint waypoint2 : waypointsFromA) {
                    if (waypoint == waypoint2 || !passage.checkMoveDirectionConstraint(waypoint, waypoint2) || !passage.canConnectFromA(waypoint, waypoint2)) continue;
                    waypoint.addNeighbourNoCheck(waypoint2);
                }
            }
            if (entryB != null) {
                waypointsFromB.add(entryB);
            }
            if (exitA != null && passage.canEnterBExitA()) {
                waypointsFromB.add(exitA);
            }
            if (exitB != null && passage.canEnterBExitB()) {
                waypointsFromB.add(exitB);
            }
            for (Waypoint waypoint : waypointsFromB) {
                for (Waypoint waypoint3 : waypointsFromB) {
                    if (waypoint == waypoint3 || !passage.checkMoveDirectionConstraint(waypoint, waypoint3) || !passage.canConnectFromB(waypoint, waypoint3)) continue;
                    waypoint.addNeighbourNoCheck(waypoint3);
                }
            }
        }
        for (Waypoint waypoint : waypointsNeedingConnectingToFreeWaypoints) {
            for (Waypoint neighbour : this.freeWaypointScanner.n_nearestNeighbour(waypoint.coord().getVector(), 30)) {
                if (this.obstaclesAndPassagesScanner.clipsAny(waypoint.coord(), neighbour.coord())) continue;
                waypoint.addNeighbourNoCheck(neighbour);
                neighbour.addNeighbourNoCheck(waypoint);
            }
            this.freeWaypoints.add(waypoint);
        }
        return null;
    }

    public void setNeedsAllShelvesToBeAccessible(boolean set) {
        this.settings_needsAllShelvesToBeAccessible = set;
    }

    private String cacheShortestPaths() throws GenerateInterruptException {
        Waypoint[] waypointArray = this.allWaypoints = this.graph.waypointsList().toArray(new Waypoint[this.graph.waypointsList().size()]);
        int n = this.allWaypoints.length;
        int n2 = 0;
        while (n2 < n) {
            Waypoint waypoint = waypointArray[n2];
            waypoint._USERDATA_BOOLEAN_0 = false;
            ++n2;
        }
        this.destArray = this.freeDestinations.rawArray();
        this.collidingPair = new byte[this.freeWaypoints.size()][this.freeWaypoints.size()];
        int i = 0;
        for (Waypoint w : this.freeWaypoints) {
            w._USERDATA_INT_1 = i++;
            w._USERDATA_BOOLEAN_1 = true;
        }
        int allcount = this.freeOrigins.size();
        int count = 0;
        boolean hadError = false;
        for (Waypoint from : this.freeOrigins) {
            this.dispatchCheckInterrupt();
            if (!this.shortestPathsFor_setAllUsedWaypointsFlags(from)) {
                hadError = true;
                if (this.settings_needsAllShelvesToBeAccessible) {
                    System.out.println("There are unreached destinations!! Abort!");
                    return "到達不可能なオブジェクトがあります。壁などで遮蔽されているオブジェクトが無いか？確認してください。";
                }
            }
            this.progress = (int)((double)(++count) / (double)allcount * 100.0);
        }
        if (!hadError) {
            for (Waypoint waypoint : this.freeWaypoints) {
                if (!waypoint._USERDATA_BOOLEAN_1) continue;
                this.graph.removeFreeWaypoint(waypoint);
            }
        }
        return null;
    }

    public boolean shortestPathsFor_setAllUsedWaypointsFlags(Waypoint from) {
        PriorityQueue<Waypoint> queue;
        Waypoint[] waypointArray = this.allWaypoints;
        int n = this.allWaypoints.length;
        int n2 = 0;
        while (n2 < n) {
            Waypoint waypoint = waypointArray[n2];
            waypoint._USERDATA_DOUBLE_0 = Double.MAX_VALUE;
            waypoint._USERDATA_INT_0 = 0;
            ++n2;
        }
        int numUnreachedDests = this.destArray.length;
        Waypoint[] waypointArray2 = this.destArray;
        int n3 = this.destArray.length;
        n = 0;
        while (n < n3) {
            Waypoint waypoint = waypointArray2[n];
            waypoint._USERDATA_BOOLEAN_0 = true;
            ++n;
        }
        try {
            queue = new PriorityQueue<Waypoint>(numUnreachedDests / 2, this.waypointComparator_USERDATA_DOUBLE_0);
        }
        catch (Exception e) {
            return false;
        }
        from._USERDATA_DOUBLE_0 = 0.0;
        queue.add(from);
        while (!queue.isEmpty()) {
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
                next._USERDATA_INT_0 = node._USERDATA_INT_0 + 1;
                queue.add(next);
            }
        }
        if (numUnreachedDests > 0) {
            ArrayList<Object> unreachedDests = new ArrayList<Object>();
            Waypoint[] waypointArray3 = this.destArray;
            int n4 = this.destArray.length;
            int n5 = 0;
            while (n5 < n4) {
                Object dest = waypointArray3[n5];
                if (((Waypoint)dest)._USERDATA_BOOLEAN_0) {
                    unreachedDests.add(dest);
                }
                ++n5;
            }
            System.out.println("unreacheable from " + from + ": " + unreachedDests);
            return false;
        }
        Waypoint[] waypointArray4 = this.destArray;
        int n6 = this.destArray.length;
        int n7 = 0;
        while (n7 < n6) {
            Waypoint dest = waypointArray4[n7];
            int pathLength = dest._USERDATA_INT_0 + 1;
            Waypoint current = dest;
            Waypoint[] path = new Waypoint[pathLength];
            int idx = pathLength - 1;
            while (idx >= 0) {
                path[idx] = current;
                current = current._USERDATA_WAYPOINT_0;
                --idx;
            }
            this.tagSimplifiedPath(path, pathLength);
            ++n7;
        }
        return true;
    }

    public void tagSimplifiedPath(Waypoint[] origPath, int pathLength) {
        if (pathLength <= 2) {
            int i = 0;
            while (i < pathLength) {
                origPath[i]._USERDATA_BOOLEAN_1 = false;
                ++i;
            }
            return;
        }
        Waypoint lastAdded = null;
        Waypoint startSeg = null;
        Waypoint prev = null;
        int i = 0;
        while (i < pathLength) {
            Waypoint waypoint = origPath[i];
            if (startSeg == null) {
                startSeg = waypoint;
            } else {
                int fromIdx = startSeg._USERDATA_INT_1;
                int toIdx = waypoint._USERDATA_INT_1;
                int colliding = this.collidingPair[fromIdx][toIdx];
                if (colliding == 0) {
                    int n = this.obstaclesAndPassagesScanner.clipsAny(startSeg.coord(), waypoint.coord()) ? 2 : 1;
                    this.collidingPair[toIdx][fromIdx] = n;
                    this.collidingPair[fromIdx][toIdx] = n;
                    colliding = n;
                }
                if (colliding == 2) {
                    startSeg._USERDATA_BOOLEAN_1 = false;
                    if (lastAdded != null) {
                        lastAdded.addNeighbour(startSeg);
                    }
                    lastAdded = startSeg;
                    startSeg = prev;
                }
            }
            prev = waypoint;
            ++i;
        }
        startSeg._USERDATA_BOOLEAN_1 = false;
        if (lastAdded != null) {
            lastAdded.addNeighbour(startSeg);
        }
        lastAdded = startSeg;
        if (startSeg != prev) {
            prev._USERDATA_BOOLEAN_1 = false;
            if (lastAdded != null) {
                lastAdded.addNeighbour(prev);
            }
        }
    }

    public boolean isCatchMemoryError() {
        return this.isCatchMemoryError;
    }

    public ArrayList<String> getWarningErrorInfo() {
        return this.warningErrorInfo;
    }

    public void setWarningErrorInfo(ArrayList<String> warningErrorInfo) {
        this.warningErrorInfo = warningErrorInfo;
    }

    protected String runProcess() {
        this.progress = 0;
        this.warningErrorInfo.clear();
        this.isCatchMemoryError = false;
        if (this.allObjects.size() == 0) {
            return null;
        }
        String errorInfo = null;
        try {
            MemoryInfo.viewMemoryInfo();
            errorInfo = this.initialize();
            if (errorInfo != null) {
                return errorInfo;
            }
            this.dispatchCheckInterrupt();
            MemoryInfo.viewMemoryInfo();
            errorInfo = this.generateWaypoints();
            if (errorInfo != null) {
                return errorInfo;
            }
            this.dispatchCheckInterrupt();
            MemoryInfo.viewMemoryInfo();
            errorInfo = this.setWaypointsForTargets();
            if (errorInfo != null) {
                return errorInfo;
            }
            this.dispatchCheckInterrupt();
            MemoryInfo.viewMemoryInfo();
            errorInfo = this.cacheShortestPaths();
            if (errorInfo != null) {
                return errorInfo;
            }
        }
        catch (OutOfMemoryError e) {
            e.printStackTrace();
            this.isCatchMemoryError = true;
            return "作業用のメモリ不足が発生しました。MapMaker.batの-Xmxのﾒﾓﾘｻｲｽﾞを増やして下さい。";
        }
        catch (GenerateInterruptException e) {
            return e.getMessage();
        }
        MemoryInfo.viewMemoryInfo();
        return null;
    }

    public boolean run() {
        if (this.isRunning) {
            return false;
        }
        this.isRunning = true;
        String errorInfo = this.runProcess();
        this.dispatchGeneratorFinished(this.graph, errorInfo);
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

    public void dispatchGeneratorUpdated(String message) {
        System.out.println(message);
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void dispatchGeneratorFinished(WaypointGraph graph, String errorMsg) {
        List<NetworkGeneratorListener> list = this.listeners;
        synchronized (list) {
            for (NetworkGeneratorListener listener : this.listeners) {
                listener.generateFinished(graph, errorMsg);
            }
        }
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void dispatchCheckInterrupt() throws GenerateInterruptException {
        List<NetworkGeneratorListener> list = this.listeners;
        synchronized (list) {
            for (NetworkGeneratorListener listener : this.listeners) {
                listener.checkInterrupt();
            }
        }
    }

    public static interface NetworkGeneratorListener {
        public void generateFinished(WaypointGraph var1, String var2);

        public void checkInterrupt() throws GenerateInterruptException;
    }
}

