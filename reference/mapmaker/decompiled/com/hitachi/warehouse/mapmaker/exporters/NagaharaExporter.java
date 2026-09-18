/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.exporters;

import com.hitachi.warehouse.mapmaker.WorldMapExtension;
import com.hitachi.warehouse.mapmaker.WorldMapMultiFloor;
import com.hitachi.warehouse.model.map.Waypoint;
import com.hitachi.warehouse.model.map.WaypointGraph;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.AbstractRectangleObject;
import com.hitachi.warehouse.model.map.objects.ConstrainedAreaObject;
import com.hitachi.warehouse.model.map.objects.FreeShelfObject;
import com.hitachi.warehouse.model.map.objects.StairsObject;
import com.hitachi.warehouse.model.map.objects.StationObject;
import com.hitachi.warehouse.model.map.objects.WallObject;
import common.file.FileChooser;
import common.gui.ErrorDialog;
import common.gui.ProgressDialog;
import common.mutable.Mutable;
import common.util.ProgressManager;
import common.util.StringList;
import java.io.File;
import java.io.PrintWriter;
import java.lang.reflect.InvocationTargetException;
import java.text.DecimalFormat;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.swing.JOptionPane;
import javax.swing.SwingUtilities;

public class NagaharaExporter {
    FileChooser chooser = new FileChooser();
    DecimalFormat decimalFormat = new DecimalFormat("#.##########");

    /*
     * WARNING - void declaration
     */
    public void export(WorldMapMultiFloor worldMapMultiFloor) {
        for (WorldMapExtension worldMapExtension : worldMapMultiFloor.getWorldMapExtensionList()) {
            WorldMap map = worldMapExtension.getWorldMap();
            WaypointGraph graph = map.cartGraph();
            if (graph != null) continue;
            System.out.println("「" + worldMapExtension.getName() + "」 graph not created yet");
            JOptionPane.showMessageDialog(null, "「" + worldMapExtension.getName() + "」フロアーの経路キャッシュ計算が行われていません。", "エラー", 0);
            return;
        }
        System.out.println("exporter started");
        File outDir = null;
        final Mutable box = new Mutable();
        try {
            SwingUtilities.invokeAndWait(new Runnable(){

                @Override
                public void run() {
                    box.set(NagaharaExporter.this.chooser.requestSaveDirLocation());
                }
            });
        }
        catch (InvocationTargetException e) {
            e.printStackTrace();
        }
        catch (InterruptedException e) {
            e.printStackTrace();
        }
        outDir = (File)box.get();
        if (outDir == null) {
            return;
        }
        outDir.mkdirs();
        try {
            WorldMap map;
            Object worldMapExtension;
            Object list;
            String floorDirPath;
            File outDirBase = outDir;
            int FloorNo = 0;
            while (FloorNo < worldMapMultiFloor.getWorldMapExtensionList().size()) {
                WorldMapExtension worldMapExtension2 = worldMapMultiFloor.getWorldMapExtension(FloorNo);
                WorldMap map2 = worldMapExtension2.getWorldMap();
                WaypointGraph graph = map2.cartGraph();
                floorDirPath = outDirBase.getPath().endsWith("\\") ? String.valueOf(outDirBase.getPath()) + worldMapExtension2.getName() : String.valueOf(outDirBase.getPath()) + "\\" + worldMapExtension2.getName();
                outDir = new File(floorDirPath);
                outDir.mkdirs();
                File outFile = new File(outDir, "waypoints.txt");
                PrintWriter out = new PrintWriter(outFile);
                for (Waypoint waypoint : graph.waypointsList()) {
                    list = new StringList(",");
                    ((StringList)list).add((Object)(String.valueOf(FloorNo) + "_" + waypoint.id));
                    ((StringList)list).add((Object)this.decimalFormat.format(waypoint.coord().x));
                    ((StringList)list).add((Object)this.decimalFormat.format(waypoint.coord().y));
                    ((StringList)list).add((Object)waypoint.networkNeighbours().size());
                    for (Waypoint other : waypoint.networkNeighbours()) {
                        if (StairsObject.class.isInstance(worldMapMultiFloor.getStairsWaypointGraph().rectForWaypoint(other))) {
                            int otherFloorNo = worldMapMultiFloor.getStairsWaypointGraph().FloorNoForWaypoint(other);
                            if (otherFloorNo != FloorNo) continue;
                            ((StringList)list).add((Object)(String.valueOf(FloorNo) + "_" + other.id + ":" + this.decimalFormat.format(waypoint.coord().distTo(other.coord()))));
                            continue;
                        }
                        ((StringList)list).add((Object)(String.valueOf(FloorNo) + "_" + other.id + ":" + this.decimalFormat.format(waypoint.coord().distTo(other.coord()))));
                    }
                    out.println(list);
                }
                out.close();
                outFile = new File(outDir, "shelves.txt");
                out = new PrintWriter(outFile);
                for (FreeShelfObject freeShelfObject : map2.freeShelfObjects()) {
                    list = new StringList(",");
                    ((StringList)list).add((Object)freeShelfObject.shelf());
                    ((StringList)list).add((Object)this.decimalFormat.format(freeShelfObject.left()));
                    ((StringList)list).add((Object)this.decimalFormat.format(freeShelfObject.top()));
                    ((StringList)list).add((Object)this.decimalFormat.format(freeShelfObject.right()));
                    ((StringList)list).add((Object)this.decimalFormat.format(freeShelfObject.bottom()));
                    Set<Waypoint> waypoints2 = graph.waypointsForRect(freeShelfObject);
                    ((StringList)list).add((Object)waypoints2.size());
                    for (Waypoint waypoint : waypoints2) {
                        ((StringList)list).add((Object)(String.valueOf(FloorNo) + "_" + waypoint.id));
                    }
                    out.println(list);
                }
                out.close();
                outFile = new File(outDir, "constrainedAreas.txt");
                out = new PrintWriter(outFile);
                for (ConstrainedAreaObject constrainedAreaObject : map2.constrainedAreaObjects()) {
                    list = new StringList(",");
                    ((StringList)list).add((Object)(String.valueOf(FloorNo) + "_" + constrainedAreaObject.id()));
                    ((StringList)list).add((Object)constrainedAreaObject.orientation());
                    ((StringList)list).add((Object)this.decimalFormat.format(constrainedAreaObject.width()));
                    ((StringList)list).add((Object)this.decimalFormat.format(constrainedAreaObject.tl().x));
                    ((StringList)list).add((Object)this.decimalFormat.format(constrainedAreaObject.tl().y));
                    ((StringList)list).add((Object)this.decimalFormat.format(constrainedAreaObject.br().x));
                    ((StringList)list).add((Object)this.decimalFormat.format(constrainedAreaObject.br().y));
                    ((StringList)list).add((Object)constrainedAreaObject.canEnterAExitA());
                    ((StringList)list).add((Object)constrainedAreaObject.canEnterAExitB());
                    ((StringList)list).add((Object)constrainedAreaObject.canEnterBExitA());
                    ((StringList)list).add((Object)constrainedAreaObject.canEnterBExitB());
                    Waypoint aExit = null;
                    Waypoint bExit = null;
                    Waypoint aEntry = null;
                    Object bEntry = null;
                    for (Waypoint waypoint : graph.entryExitWaypointsForConstrainedArea(constrainedAreaObject)) {
                        Set<WaypointGraph.WaypointTag> tags = graph.tagsForWaypoint(waypoint);
                        if (tags.contains((Object)WaypointGraph.WaypointTag.kConstraintPassage_AEntry)) {
                            aEntry = waypoint;
                        }
                        if (tags.contains((Object)WaypointGraph.WaypointTag.kConstraintPassage_BEntry)) {
                            bEntry = waypoint;
                        }
                        if (tags.contains((Object)WaypointGraph.WaypointTag.kConstraintPassage_AExit)) {
                            aExit = waypoint;
                        }
                        if (!tags.contains((Object)WaypointGraph.WaypointTag.kConstraintPassage_BExit)) continue;
                        bExit = waypoint;
                    }
                    ((StringList)list).add((Object)(aEntry == null ? "" : String.valueOf(FloorNo) + "_" + aEntry.id));
                    ((StringList)list).add((Object)(bEntry == null ? "" : String.valueOf(FloorNo) + "_" + ((Waypoint)bEntry).id));
                    ((StringList)list).add((Object)(aExit == null ? "" : String.valueOf(FloorNo) + "_" + aExit.id));
                    ((StringList)list).add((Object)(bExit == null ? "" : String.valueOf(FloorNo) + "_" + bExit.id));
                    Set<Waypoint> waypoints3 = graph.waypointsInConstrainedArea(constrainedAreaObject);
                    ((StringList)list).add((Object)waypoints3.size());
                    for (Waypoint waypoint : waypoints3) {
                        ((StringList)list).add((Object)(String.valueOf(FloorNo) + "_" + waypoint.id));
                    }
                    out.println(list);
                }
                out.close();
                ArrayList<Waypoint> targetWaypoints = new ArrayList<Waypoint>();
                for (FreeShelfObject shelfObject : map2.freeShelfObjects()) {
                    Set<Waypoint> set = graph.waypointsForRect(shelfObject);
                    targetWaypoints.addAll(set);
                }
                for (ConstrainedAreaObject areas3 : map2.constrainedAreaObjects()) {
                    Set<Waypoint> set = graph.entryExitWaypointsForConstrainedArea(areas3);
                    targetWaypoints.addAll(set);
                }
                for (StairsObject stairsObject : map2.stairsObjects()) {
                    Set<Waypoint> set = graph.waypointsForRect(stairsObject);
                    targetWaypoints.addAll(set);
                }
                File outFile2 = new File(outDir, "interWaypointDistance.txt");
                PrintWriter printWriter = new PrintWriter(outFile2);
                ProgressManager<String> progressManager = new ProgressManager<String>();
                ProgressDialog dialog = new ProgressDialog("Exporting...", "to: " + outDir);
                progressManager.addProgressListener(dialog);
                int i = 0;
                HashSet<Waypoint> tos = new HashSet<Waypoint>();
                tos.addAll(targetWaypoints);
                block17: for (Waypoint from : targetWaypoints) {
                    progressManager.report((double)i / (double)targetWaypoints.size(), from.toString());
                    tos.remove(from);
                    Map<Waypoint, List<Waypoint>> paths = graph.shortestPathsFor(from, tos);
                    for (Waypoint to : tos) {
                        List<Waypoint> path = paths.get(to);
                        if (path != null) {
                            if (StairsObject.class.isInstance(graph.rectForWaypoint(from)) || StairsObject.class.isInstance(graph.rectForWaypoint(to))) continue;
                            double dist = WaypointGraph.distForPath(path);
                            printWriter.println(String.valueOf(FloorNo) + "_" + from.id + "," + FloorNo + "_" + to.id + "," + this.decimalFormat.format(dist));
                            continue;
                        }
                        dialog.dispose();
                        System.out.println("unreacheable from " + from + ": " + tos);
                        ErrorDialog box2 = new ErrorDialog(null, "Path not found", "Can't connect from " + from + " to " + to + " !!! Aborting export.", false);
                        box2.setVisible(true);
                        box2.dispose();
                        break block17;
                    }
                    tos.add(from);
                    ++i;
                }
                dialog.dispose();
                printWriter.close();
                outFile = new File(outDir, "walls.txt");
                out = new PrintWriter(outFile);
                for (WallObject wallObject : map2.wallObjects()) {
                    list = new StringList(",");
                    ((StringList)list).add((Object)(String.valueOf(FloorNo) + "_" + wallObject.id()));
                    ((StringList)list).add((Object)this.decimalFormat.format(wallObject.left()));
                    ((StringList)list).add((Object)this.decimalFormat.format(wallObject.top()));
                    ((StringList)list).add((Object)this.decimalFormat.format(wallObject.right()));
                    ((StringList)list).add((Object)this.decimalFormat.format(wallObject.bottom()));
                    ((StringList)list).add((Object)this.decimalFormat.format(wallObject.height_mm()));
                    out.println(list);
                }
                out.close();
                outFile = new File(outDir, "stations.txt");
                out = new PrintWriter(outFile);
                for (StationObject stationObject : map2.stationObjects()) {
                    list = new StringList(",");
                    ((StringList)list).add((Object)(String.valueOf(FloorNo) + "_" + stationObject.id()));
                    ((StringList)list).add((Object)this.decimalFormat.format(stationObject.left()));
                    ((StringList)list).add((Object)this.decimalFormat.format(stationObject.top()));
                    ((StringList)list).add((Object)this.decimalFormat.format(stationObject.right()));
                    ((StringList)list).add((Object)this.decimalFormat.format(stationObject.bottom()));
                    Set<Waypoint> waypoints4 = graph.waypointsForRect(stationObject);
                    ((StringList)list).add((Object)waypoints4.size());
                    for (Waypoint waypoint : waypoints4) {
                        ((StringList)list).add((Object)(String.valueOf(FloorNo) + "_" + waypoint.id));
                    }
                    out.println(list);
                }
                out.close();
                ++FloorNo;
            }
            String MultiFloorDirName = "MultiFloor";
            floorDirPath = outDirBase.getPath().endsWith("\\") ? String.valueOf(outDirBase.getPath()) + MultiFloorDirName : String.valueOf(outDirBase.getPath()) + "\\" + MultiFloorDirName;
            outDir = new File(floorDirPath);
            outDir.mkdirs();
            File outFile = new File(outDir, "floor.txt");
            PrintWriter out = new PrintWriter(outFile);
            int FloorNo2 = 0;
            while (FloorNo2 < worldMapMultiFloor.getWorldMapExtensionList().size()) {
                StringList list2 = new StringList(",");
                list2.add((Object)FloorNo2);
                list2.add((Object)worldMapMultiFloor.getWorldMapExtension(FloorNo2).getName());
                out.println(list2);
                ++FloorNo2;
            }
            out.close();
            outFile = new File(outDir, "stairs.txt");
            out = new PrintWriter(outFile);
            int FloorNo3 = 0;
            while (FloorNo3 < worldMapMultiFloor.getWorldMapExtensionList().size()) {
                worldMapExtension = worldMapMultiFloor.getWorldMapExtension(FloorNo3);
                map = ((WorldMapExtension)worldMapExtension).getWorldMap();
                WaypointGraph waypointGraph = map.cartGraph();
                for (StairsObject stairsObject : map.stairsObjects()) {
                    StringList list3 = new StringList(",");
                    list3.add((Object)FloorNo3);
                    list3.add((Object)worldMapMultiFloor.getWorldMapExtension(FloorNo3).getName());
                    list3.add((Object)stairsObject.getName());
                    list3.add((Object)this.decimalFormat.format(stairsObject.left()));
                    list3.add((Object)this.decimalFormat.format(stairsObject.top()));
                    list3.add((Object)this.decimalFormat.format(stairsObject.right()));
                    list3.add((Object)this.decimalFormat.format(stairsObject.bottom()));
                    Set<Waypoint> waypoints = waypointGraph.waypointsForRect(stairsObject);
                    for (Waypoint waypoint : waypoints) {
                        list3.add((Object)(String.valueOf(FloorNo3) + "_" + waypoint.id));
                    }
                    out.println(list3);
                }
                ++FloorNo3;
            }
            out.close();
            outFile = new File(outDir, "floorLink.txt");
            out = new PrintWriter(outFile);
            for (Waypoint waypoint : worldMapMultiFloor.getStairsWaypointGraph().waypointsList()) {
                AbstractRectangleObject obj = worldMapMultiFloor.getStairsWaypointGraph().rectForWaypoint(waypoint);
                if (!StairsObject.class.isInstance(obj)) continue;
                int n = worldMapMultiFloor.getStairsWaypointGraph().FloorNoForWaypoint(waypoint);
                for (Waypoint waypoint2 : waypoint.networkNeighbours()) {
                    int neighboursFloorNo;
                    AbstractRectangleObject neighboursObj = worldMapMultiFloor.getStairsWaypointGraph().rectForWaypoint(waypoint2);
                    if (!StairsObject.class.isInstance(neighboursObj) || n == (neighboursFloorNo = worldMapMultiFloor.getStairsWaypointGraph().FloorNoForWaypoint(waypoint2))) continue;
                    StringList list4 = new StringList(",");
                    list4.add((Object)n);
                    list4.add((Object)worldMapMultiFloor.getWorldMapExtensionList().get(n).getName());
                    list4.add((Object)((StairsObject)obj).getName());
                    list4.add((Object)(String.valueOf(n) + "_" + waypoint.id));
                    list4.add((Object)neighboursFloorNo);
                    list4.add((Object)worldMapMultiFloor.getWorldMapExtensionList().get(neighboursFloorNo).getName());
                    list4.add((Object)((StairsObject)neighboursObj).getName());
                    list4.add((Object)(String.valueOf(neighboursFloorNo) + "_" + waypoint2.id));
                    double distance = worldMapMultiFloor.GetStairsBetweenDistance((StairsObject)obj, (StairsObject)neighboursObj);
                    list4.add((Object)this.decimalFormat.format(distance));
                    out.println(list4);
                }
            }
            out.close();
            outFile = new File(outDir, "waypoints.txt");
            out = new PrintWriter(outFile);
            FloorNo = 0;
            while (FloorNo < worldMapMultiFloor.getWorldMapExtensionList().size()) {
                worldMapExtension = worldMapMultiFloor.getWorldMapExtension(FloorNo);
                map = ((WorldMapExtension)worldMapExtension).getWorldMap();
                WaypointGraph waypointGraph = map.cartGraph();
                for (Waypoint waypoint : waypointGraph.waypointsList()) {
                    StringList list5 = new StringList(",");
                    list5.add((Object)(String.valueOf(FloorNo) + "_" + waypoint.id));
                    list5.add((Object)this.decimalFormat.format(waypoint.coord().x));
                    list5.add((Object)this.decimalFormat.format(waypoint.coord().y));
                    list5.add((Object)waypoint.networkNeighbours().size());
                    for (Waypoint other : waypoint.networkNeighbours()) {
                        int otherFloorNo = worldMapMultiFloor.getStairsWaypointGraph().FloorNoForWaypoint(other);
                        double dist = 0.0;
                        if (StairsObject.class.isInstance(worldMapMultiFloor.getStairsWaypointGraph().rectForWaypoint(waypoint)) && StairsObject.class.isInstance(worldMapMultiFloor.getStairsWaypointGraph().rectForWaypoint(other)) && FloorNo != otherFloorNo) {
                            dist = worldMapMultiFloor.GetStairsBetweenDistance((StairsObject)worldMapMultiFloor.getStairsWaypointGraph().rectForWaypoint(waypoint), (StairsObject)worldMapMultiFloor.getStairsWaypointGraph().rectForWaypoint(other));
                            list5.add((Object)(String.valueOf(otherFloorNo) + "_" + other.id + ":" + this.decimalFormat.format(dist)));
                            continue;
                        }
                        dist = waypoint.coord().distTo(other.coord());
                        list5.add((Object)(String.valueOf(FloorNo) + "_" + other.id + ":" + this.decimalFormat.format(dist)));
                    }
                    out.println(list5);
                }
                ++FloorNo;
            }
            out.close();
            outFile = new File(outDir, "shelves.txt");
            out = new PrintWriter(outFile);
            FloorNo = 0;
            while (FloorNo < worldMapMultiFloor.getWorldMapExtensionList().size()) {
                worldMapExtension = worldMapMultiFloor.getWorldMapExtension(FloorNo);
                map = ((WorldMapExtension)worldMapExtension).getWorldMap();
                WaypointGraph waypointGraph = map.cartGraph();
                for (FreeShelfObject freeShelfObject : map.freeShelfObjects()) {
                    StringList list6 = new StringList(",");
                    list6.add((Object)freeShelfObject.shelf());
                    list6.add((Object)this.decimalFormat.format(freeShelfObject.left()));
                    list6.add((Object)this.decimalFormat.format(freeShelfObject.top()));
                    list6.add((Object)this.decimalFormat.format(freeShelfObject.right()));
                    list6.add((Object)this.decimalFormat.format(freeShelfObject.bottom()));
                    Set<Waypoint> waypoints = waypointGraph.waypointsForRect(freeShelfObject);
                    list6.add((Object)waypoints.size());
                    for (Waypoint waypoint : waypoints) {
                        list6.add((Object)(String.valueOf(FloorNo) + "_" + waypoint.id));
                    }
                    out.println(list6);
                }
                ++FloorNo;
            }
            out.close();
            outFile = new File(outDir, "constrainedAreas.txt");
            out = new PrintWriter(outFile);
            FloorNo = 0;
            while (FloorNo < worldMapMultiFloor.getWorldMapExtensionList().size()) {
                worldMapExtension = worldMapMultiFloor.getWorldMapExtension(FloorNo);
                map = ((WorldMapExtension)worldMapExtension).getWorldMap();
                WaypointGraph waypointGraph = map.cartGraph();
                for (ConstrainedAreaObject constrainedAreaObject : map.constrainedAreaObjects()) {
                    StringList list7 = new StringList(",");
                    list7.add((Object)(String.valueOf(FloorNo) + "_" + constrainedAreaObject.id()));
                    list7.add((Object)constrainedAreaObject.orientation());
                    list7.add((Object)this.decimalFormat.format(constrainedAreaObject.width()));
                    list7.add((Object)this.decimalFormat.format(constrainedAreaObject.tl().x));
                    list7.add((Object)this.decimalFormat.format(constrainedAreaObject.tl().y));
                    list7.add((Object)this.decimalFormat.format(constrainedAreaObject.br().x));
                    list7.add((Object)this.decimalFormat.format(constrainedAreaObject.br().y));
                    list7.add((Object)constrainedAreaObject.canEnterAExitA());
                    list7.add((Object)constrainedAreaObject.canEnterAExitB());
                    list7.add((Object)constrainedAreaObject.canEnterBExitA());
                    list7.add((Object)constrainedAreaObject.canEnterBExitB());
                    Waypoint aExit = null;
                    Waypoint bExit = null;
                    Waypoint aEntry = null;
                    Waypoint bEntry = null;
                    for (Waypoint waypoint : waypointGraph.entryExitWaypointsForConstrainedArea(constrainedAreaObject)) {
                        Set<WaypointGraph.WaypointTag> tags = waypointGraph.tagsForWaypoint(waypoint);
                        if (tags.contains((Object)WaypointGraph.WaypointTag.kConstraintPassage_AEntry)) {
                            aEntry = waypoint;
                        }
                        if (tags.contains((Object)WaypointGraph.WaypointTag.kConstraintPassage_BEntry)) {
                            bEntry = waypoint;
                        }
                        if (tags.contains((Object)WaypointGraph.WaypointTag.kConstraintPassage_AExit)) {
                            aExit = waypoint;
                        }
                        if (!tags.contains((Object)WaypointGraph.WaypointTag.kConstraintPassage_BExit)) continue;
                        bExit = waypoint;
                    }
                    list7.add((Object)(aEntry == null ? "" : String.valueOf(FloorNo) + "_" + aEntry.id));
                    list7.add((Object)(bEntry == null ? "" : String.valueOf(FloorNo) + "_" + bEntry.id));
                    list7.add((Object)(aExit == null ? "" : String.valueOf(FloorNo) + "_" + aExit.id));
                    list7.add((Object)(bExit == null ? "" : String.valueOf(FloorNo) + "_" + bExit.id));
                    Set<Waypoint> waypoints = waypointGraph.waypointsInConstrainedArea(constrainedAreaObject);
                    list7.add((Object)waypoints.size());
                    for (Waypoint waypoint : waypoints) {
                        list7.add((Object)(String.valueOf(FloorNo) + "_" + waypoint.id));
                    }
                    out.println(list7);
                }
                ++FloorNo;
            }
            out.close();
            HashMap<String, Waypoint> targetWaypoints = new HashMap<String, Waypoint>();
            int FloorNo4 = 0;
            while (FloorNo4 < worldMapMultiFloor.getWorldMapExtensionList().size()) {
                WorldMapExtension worldMapExtension3 = worldMapMultiFloor.getWorldMapExtension(FloorNo4);
                WorldMap map3 = worldMapExtension3.getWorldMap();
                WaypointGraph graph = map3.cartGraph();
                for (FreeShelfObject freeShelfObject : map3.freeShelfObjects()) {
                    for (Waypoint waypoint : graph.waypointsForRect(freeShelfObject)) {
                        targetWaypoints.put(String.valueOf(FloorNo4) + "_" + waypoint.id, waypoint);
                    }
                }
                for (ConstrainedAreaObject constrainedAreaObject : map3.constrainedAreaObjects()) {
                    for (Waypoint waypoint : graph.entryExitWaypointsForConstrainedArea(constrainedAreaObject)) {
                        targetWaypoints.put(String.valueOf(FloorNo4) + "_" + waypoint.id, waypoint);
                    }
                }
                for (StairsObject stairsObject : map3.stairsObjects()) {
                    for (Waypoint waypoint : graph.waypointsForRect(stairsObject)) {
                        targetWaypoints.put(String.valueOf(FloorNo4) + "_" + waypoint.id, waypoint);
                    }
                }
                ++FloorNo4;
            }
            WaypointGraph graph_ALL = new WaypointGraph(null);
            graph_ALL = worldMapMultiFloor.createAllWaypointGraph();
            File outFile3 = new File(outDir, "interWaypointDistance.txt");
            PrintWriter out3 = new PrintWriter(outFile3);
            ProgressManager<String> pMan = new ProgressManager<String>();
            ProgressDialog progressDialog = new ProgressDialog("Exporting...", "to: " + outDir);
            pMan.addProgressListener(progressDialog);
            boolean bl = false;
            HashMap<String, Waypoint> tos = new HashMap<String, Waypoint>();
            tos.putAll(targetWaypoints);
            block45: for (Map.Entry from : targetWaypoints.entrySet()) {
                void var12_79;
                pMan.report((double)var12_79 / (double)targetWaypoints.size(), ((Waypoint)from.getValue()).name());
                tos.remove(from.getKey());
                Map<Waypoint, List<Waypoint>> paths = graph_ALL.shortestPathsFor((Waypoint)from.getValue(), tos.values());
                if (paths != null) {
                    for (Map.Entry to : tos.entrySet()) {
                        List<Waypoint> path = paths.get(to.getValue());
                        if (path != null) {
                            if (StairsObject.class.isInstance(graph_ALL.rectForWaypoint((Waypoint)from.getValue())) || StairsObject.class.isInstance(graph_ALL.rectForWaypoint((Waypoint)to.getValue()))) continue;
                            double dist = worldMapMultiFloor.distForPath(path);
                            out3.println(String.valueOf((String)from.getKey()) + "," + (String)to.getKey() + "," + this.decimalFormat.format(dist));
                            continue;
                        }
                        progressDialog.dispose();
                        System.out.println("unreacheable from " + from + ": " + tos);
                        ErrorDialog box3 = new ErrorDialog(null, "Path not found", "Can't connect from " + (String)from.getKey() + " to " + (String)to.getKey() + " !!! Aborting export.", false);
                        box3.setVisible(true);
                        box3.dispose();
                        break block45;
                    }
                } else {
                    progressDialog.dispose();
                    System.out.println("unreacheable from " + from + ": " + tos);
                    ErrorDialog box4 = new ErrorDialog(null, "Path not found", "Can't connect from " + (String)from.getKey() + " to " + tos + " !!! Aborting export.", false);
                    box4.setVisible(true);
                    box4.dispose();
                    break;
                }
                tos.put((String)from.getKey(), (Waypoint)from.getValue());
                ++var12_79;
            }
            progressDialog.dispose();
            out3.close();
            outFile = new File(outDir, "walls.txt");
            out = new PrintWriter(outFile);
            FloorNo = 0;
            while (FloorNo < worldMapMultiFloor.getWorldMapExtensionList().size()) {
                worldMapExtension = worldMapMultiFloor.getWorldMapExtension(FloorNo);
                map = ((WorldMapExtension)worldMapExtension).getWorldMap();
                for (WallObject wallObject : map.wallObjects()) {
                    list = new StringList(",");
                    ((StringList)list).add((Object)(String.valueOf(FloorNo) + "_" + wallObject.id()));
                    ((StringList)list).add((Object)this.decimalFormat.format(wallObject.left()));
                    ((StringList)list).add((Object)this.decimalFormat.format(wallObject.top()));
                    ((StringList)list).add((Object)this.decimalFormat.format(wallObject.right()));
                    ((StringList)list).add((Object)this.decimalFormat.format(wallObject.bottom()));
                    ((StringList)list).add((Object)this.decimalFormat.format(wallObject.height_mm()));
                    out.println(list);
                }
                ++FloorNo;
            }
            out.close();
            outFile = new File(outDir, "stations.txt");
            out = new PrintWriter(outFile);
            FloorNo = 0;
            while (FloorNo < worldMapMultiFloor.getWorldMapExtensionList().size()) {
                worldMapExtension = worldMapMultiFloor.getWorldMapExtension(FloorNo);
                map = ((WorldMapExtension)worldMapExtension).getWorldMap();
                WaypointGraph waypointGraph = map.cartGraph();
                for (StationObject stationObject : map.stationObjects()) {
                    StringList list8 = new StringList(",");
                    list8.add((Object)(String.valueOf(FloorNo) + "_" + stationObject.id()));
                    list8.add((Object)this.decimalFormat.format(stationObject.left()));
                    list8.add((Object)this.decimalFormat.format(stationObject.top()));
                    list8.add((Object)this.decimalFormat.format(stationObject.right()));
                    list8.add((Object)this.decimalFormat.format(stationObject.bottom()));
                    Set<Waypoint> waypoints = waypointGraph.waypointsForRect(stationObject);
                    list8.add((Object)waypoints.size());
                    for (Waypoint waypoint : waypoints) {
                        list8.add((Object)(String.valueOf(FloorNo) + "_" + waypoint.id));
                    }
                    out.println(list8);
                }
                ++FloorNo;
            }
            out.close();
        }
        catch (Exception e) {
            System.out.println(e.getMessage());
        }
        System.out.println("export!!");
    }
}

