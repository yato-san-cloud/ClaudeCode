/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker;

import com.hitachi.warehouse.mapmaker.StairsBetweenDistance;
import com.hitachi.warehouse.mapmaker.WorldMapExtension;
import com.hitachi.warehouse.mapmaker.networkgenerator.CartNetworkGenerator;
import com.hitachi.warehouse.mapmaker.networkgenerator.GenerateInterruptException;
import com.hitachi.warehouse.model.map.Waypoint;
import com.hitachi.warehouse.model.map.WaypointGraph;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.AbstractRectangleObject;
import com.hitachi.warehouse.model.map.objects.ConstrainedAreaObject;
import com.hitachi.warehouse.model.map.objects.FreeShelfObject;
import com.hitachi.warehouse.model.map.objects.StairsObject;
import common.gui.ProgressDialog;
import common.util.ProgressManager;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.ObjectInputStream;
import java.io.ObjectOutputStream;
import java.io.Serializable;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.locks.ReadWriteLock;
import java.util.concurrent.locks.ReentrantReadWriteLock;
import javax.swing.JOptionPane;

public class WorldMapMultiFloor
implements Serializable {
    private static final long serialVersionUID = -8168453201122970038L;
    public static final int CURRENT_VERSION = 1;
    private int INTERNAL_VERSION = 1;
    private WaypointGraph stairsWaypointGraph;
    private transient ReadWriteLock lock = new ReentrantReadWriteLock();
    private ArrayList<WorldMapExtension> WorldMapExtensionList = new ArrayList();
    public ArrayList<StairsBetweenDistance> StairsBetweenDistanceList = new ArrayList();
    public ArrayList<String> allFloorCalc_ErrorInfo;
    public ArrayList<Boolean> allFloorCalc_CatchMemoryError;

    public int internalVersion() {
        return this.INTERNAL_VERSION;
    }

    public void updateInternalVersion(int version) {
        this.INTERNAL_VERSION = version;
    }

    public void setStairsWaypointGraph(WaypointGraph waypointGraph) {
        this.stairsWaypointGraph = waypointGraph;
    }

    public WaypointGraph getStairsWaypointGraph() {
        return this.stairsWaypointGraph;
    }

    public void startRead() {
        this.lock.readLock().lock();
    }

    public void endRead() {
        this.lock.readLock().unlock();
    }

    public void startWrite() {
        this.lock.writeLock().lock();
    }

    public void endWrite() {
        this.lock.writeLock().unlock();
    }

    public void addMap(WorldMap worldMap, String name, double centerX, double centerY, double zoomLevel) {
        this.WorldMapExtensionList.add(new WorldMapExtension(worldMap, name, centerX, centerY, zoomLevel));
    }

    public void addMap(int index, WorldMap worldMap, String name, double centerX, double centerY, double zoomLevel) {
        this.WorldMapExtensionList.add(index, new WorldMapExtension(worldMap, name, centerX, centerY, zoomLevel));
    }

    public void removeWorldMapExtension(int index) {
        this.WorldMapExtensionList.remove(index);
    }

    public void clearWorldMapExtension() {
        this.WorldMapExtensionList.clear();
    }

    public WorldMapExtension getWorldMapExtension(int index) {
        return this.WorldMapExtensionList.get(index);
    }

    public void setWorldMapExtension(int index, WorldMapExtension worldMapExtension) {
        this.WorldMapExtensionList.set(index, worldMapExtension);
    }

    public ArrayList<WorldMapExtension> getWorldMapExtensionList() {
        return this.WorldMapExtensionList;
    }

    public boolean saveTo(File file) {
        File tmpFile = new File(file.getParent(), "tmp_" + file.getName());
        boolean ok = true;
        File outBinFile = tmpFile;
        try {
            ObjectOutputStream out = new ObjectOutputStream(new BufferedOutputStream(new FileOutputStream(outBinFile)));
            out.writeObject(this);
            out.close();
        }
        catch (IOException e) {
            e.printStackTrace();
            ok = false;
        }
        if (file.exists()) {
            file.delete();
        }
        if (tmpFile.renameTo(file)) {
            return ok;
        }
        System.out.println("failed on rename to " + file);
        return false;
    }

    /*
     * Enabled force condition propagation
     * Lifted jumps to return sites
     */
    public static WorldMapMultiFloor loadFrom(File file) {
        if (file.isDirectory()) {
            file = new File(file, "map.mrmp");
        }
        WorldMapMultiFloor map = null;
        File outBinFile = file;
        ObjectInputStream in = null;
        try {
            try {
                in = new ObjectInputStream(new BufferedInputStream(new FileInputStream(outBinFile)));
                map = (WorldMapMultiFloor)in.readObject();
                map.lock = new ReentrantReadWriteLock();
                return map;
            }
            catch (IOException e) {
                e.printStackTrace();
                if (in == null) return map;
                try {
                    in.close();
                    return map;
                }
                catch (IOException e2) {
                    e2.printStackTrace();
                }
                return map;
            }
            catch (ClassNotFoundException e) {
                e.printStackTrace();
                if (in == null) return map;
                try {
                    in.close();
                    return map;
                }
                catch (IOException e3) {
                    e3.printStackTrace();
                }
                return map;
            }
        }
        finally {
            if (in != null) {
                try {
                    in.close();
                }
                catch (IOException e) {
                    e.printStackTrace();
                }
            }
        }
    }

    public int getFloorNoforWorldMap(WorldMap worldMap) {
        int index = 0;
        while (index < this.WorldMapExtensionList.size()) {
            WorldMapExtension worldMapExtension = this.WorldMapExtensionList.get(index);
            if (worldMapExtension.getWorldMap().equals(worldMap)) {
                return index;
            }
            ++index;
        }
        return -1;
    }

    public void SetStairsBetweenDistanceList(WorldMapExtension FromFloor, StairsObject FromStairsObject, WorldMapExtension ToFloor, StairsObject ToStairsObject, double Distance) {
        boolean add = true;
        int cnt = 0;
        while (cnt < this.StairsBetweenDistanceList.size()) {
            if (this.StairsBetweenDistanceList.get((int)cnt).FromStairsObject.equals(FromStairsObject) && this.StairsBetweenDistanceList.get((int)cnt).ToStairsObject.equals(ToStairsObject)) {
                this.StairsBetweenDistanceList.get((int)cnt).FromFloor = FromFloor;
                this.StairsBetweenDistanceList.get((int)cnt).ToFloor = ToFloor;
                this.StairsBetweenDistanceList.get((int)cnt).Distance = Distance;
                add = false;
            }
            ++cnt;
        }
        if (add) {
            this.StairsBetweenDistanceList.add(new StairsBetweenDistance(FromFloor, FromStairsObject, ToFloor, ToStairsObject, Distance));
        }
    }

    public boolean ExistStairsBetweenDistanceList(StairsObject FromStairsObject, StairsObject ToStairsObject) {
        boolean exist = false;
        int cnt = 0;
        while (cnt < this.StairsBetweenDistanceList.size()) {
            if (this.StairsBetweenDistanceList.get((int)cnt).FromStairsObject.equals(FromStairsObject) && this.StairsBetweenDistanceList.get((int)cnt).ToStairsObject.equals(ToStairsObject)) {
                exist = true;
            }
            ++cnt;
        }
        return exist;
    }

    public void RemoveStairsBetweenDistanceList(StairsObject FromStairsObject, StairsObject ToStairsObject) {
        int cnt = 0;
        while (cnt < this.StairsBetweenDistanceList.size()) {
            if (this.StairsBetweenDistanceList.get((int)cnt).FromStairsObject.equals(FromStairsObject) && this.StairsBetweenDistanceList.get((int)cnt).ToStairsObject.equals(ToStairsObject)) {
                this.StairsBetweenDistanceList.remove(cnt);
            }
            ++cnt;
        }
    }

    public double GetStairsBetweenDistance(StairsObject FromStairsObject, StairsObject ToStairsObject) {
        int cnt = 0;
        while (cnt < this.StairsBetweenDistanceList.size()) {
            if (this.StairsBetweenDistanceList.get((int)cnt).FromStairsObject.equals(FromStairsObject) && this.StairsBetweenDistanceList.get((int)cnt).ToStairsObject.equals(ToStairsObject)) {
                return this.StairsBetweenDistanceList.get((int)cnt).Distance;
            }
            ++cnt;
        }
        return 0.0;
    }

    public ArrayList<String> CreateMultiFloorStairsCartGraph() {
        ArrayList<String> ErrorInfo = new ArrayList<String>();
        for (WorldMapExtension worldMapExtension1 : this.WorldMapExtensionList) {
            for (WorldMapExtension worldMapExtension2 : this.WorldMapExtensionList) {
                if (worldMapExtension1.equals(worldMapExtension2) || !worldMapExtension1.getName().equals(worldMapExtension2.getName())) continue;
                ErrorInfo.add("「" + worldMapExtension1.getName() + "」フロアーが複数あります。名前を変更してください。");
                return ErrorInfo;
            }
        }
        int FloorNo = 0;
        while (FloorNo < this.WorldMapExtensionList.size()) {
            WorldMapExtension worldMapExtension = this.WorldMapExtensionList.get(FloorNo);
            WorldMap map = worldMapExtension.getWorldMap();
            if (this.WorldMapExtensionList.size() != 1 && map.stairsObjects().size() == 0) {
                ErrorInfo.add("「" + worldMapExtension.getName() + "」フロアーに階段がありません。");
                return ErrorInfo;
            }
            for (StairsObject stairsObject1 : map.stairsObjects()) {
                for (StairsObject stairsObject2 : map.stairsObjects()) {
                    if (stairsObject1.equals(stairsObject2) || !stairsObject1.getName().equals(stairsObject2.getName())) continue;
                    ErrorInfo.add("「" + worldMapExtension.getName() + "」フロアーの" + "「" + stairsObject1.getName() + "」階段が複数存在します。名前を変更してください。");
                    return ErrorInfo;
                }
            }
            ++FloorNo;
        }
        Iterator<StairsBetweenDistance> itr = this.StairsBetweenDistanceList.iterator();
        while (itr.hasNext()) {
            StairsBetweenDistance stairsBetweenDistance = itr.next();
            boolean FromExist = false;
            boolean ToExist = false;
            boolean nameMismatch = false;
            int FloorNo2 = 0;
            while (FloorNo2 < this.WorldMapExtensionList.size()) {
                WorldMapExtension worldMapExtension = this.WorldMapExtensionList.get(FloorNo2);
                WorldMap map = worldMapExtension.getWorldMap();
                if (map.stairsObjects().contains(stairsBetweenDistance.FromStairsObject)) {
                    FromExist = true;
                }
                if (map.stairsObjects().contains(stairsBetweenDistance.ToStairsObject)) {
                    ToExist = true;
                }
                if (!stairsBetweenDistance.FromStairsObject.getName().equals(stairsBetweenDistance.ToStairsObject.getName())) {
                    nameMismatch = true;
                }
                ++FloorNo2;
            }
            if (FromExist && ToExist && !nameMismatch) continue;
            itr.remove();
        }
        this.stairsWaypointGraph = new WaypointGraph(null);
        int FloorNo3 = 0;
        while (FloorNo3 < this.WorldMapExtensionList.size()) {
            WorldMapExtension worldMapExtension = this.WorldMapExtensionList.get(FloorNo3);
            WorldMap map = worldMapExtension.getWorldMap();
            WaypointGraph graph = map.cartGraph();
            if (graph == null) {
                ErrorInfo.add("「" + worldMapExtension.getName() + "」フロアーの" + "経路情報がありません。");
                return ErrorInfo;
            }
            for (StairsObject stairsObject : map.stairsObjects()) {
                HashSet<Waypoint> counter = new HashSet<Waypoint>();
                for (Waypoint waypoint : graph.waypointsForRect(stairsObject)) {
                    boolean contains = false;
                    for (Waypoint w2 : counter) {
                        if (!waypoint.coord().equals(w2.coord())) continue;
                        contains = true;
                        break;
                    }
                    if (!contains) {
                        counter.add(waypoint);
                    }
                    for (Waypoint waypointOtuer : graph.waypointsForRect(stairsObject)) {
                        if (waypoint.equals(waypointOtuer) || waypoint.coord().x != waypointOtuer.coord().x) continue;
                        double cfr_ignored_0 = waypoint.coord().y;
                        double cfr_ignored_1 = waypointOtuer.coord().y;
                    }
                    this.stairsWaypointGraph.addWaypoint(waypoint);
                    this.stairsWaypointGraph.setWaypointForRect(stairsObject, waypoint);
                    this.stairsWaypointGraph.setWaypointForFloorNo(FloorNo3, waypoint);
                }
                if (counter.size() <= 1) continue;
                ErrorInfo.add("「" + worldMapExtension.getName() + "」フロアーの" + "「" + stairsObject.getName() + "」階段の出入口が１つではありません。");
            }
            ++FloorNo3;
        }
        for (WorldMapExtension worldMapExtension_1 : this.WorldMapExtensionList) {
            WorldMap map_1 = worldMapExtension_1.getWorldMap();
            WaypointGraph graph_1 = map_1.cartGraph();
            for (WorldMapExtension worldMapExtension_2 : this.WorldMapExtensionList) {
                WorldMap map_2 = worldMapExtension_2.getWorldMap();
                WaypointGraph graph_2 = map_2.cartGraph();
                if (worldMapExtension_1.equals(worldMapExtension_2)) continue;
                for (StairsObject stairsObject_1 : map_1.stairsObjects()) {
                    int ConnectionCount = 0;
                    for (StairsObject stairsObject_2 : map_2.stairsObjects()) {
                        if (!stairsObject_1.getName().equals(stairsObject_2.getName())) continue;
                        for (Waypoint waypoint_1 : graph_1.waypointsForRect(stairsObject_1)) {
                            for (Waypoint waypoint_2 : graph_2.waypointsForRect(stairsObject_2)) {
                                if (waypoint_2.parentNeighbours() != null) {
                                    ++ConnectionCount;
                                    if (this.ExistStairsBetweenDistanceList(stairsObject_1, stairsObject_2)) {
                                        waypoint_1.addNeighbour(waypoint_2);
                                        continue;
                                    }
                                    if (this.ExistStairsBetweenDistanceList(stairsObject_2, stairsObject_1)) {
                                        waypoint_2.addNeighbour(waypoint_1);
                                        continue;
                                    }
                                    waypoint_1.addNeighbour(waypoint_2);
                                    waypoint_2.addNeighbour(waypoint_1);
                                    double distance = 0.0;
                                    this.SetStairsBetweenDistanceList(worldMapExtension_1, stairsObject_1, worldMapExtension_2, stairsObject_2, distance);
                                    this.SetStairsBetweenDistanceList(worldMapExtension_2, stairsObject_2, worldMapExtension_1, stairsObject_1, distance);
                                    continue;
                                }
                                ErrorInfo.add("「" + worldMapExtension_2.getName() + "」フロアーの経路キャッシュ計算が行われていません。");
                            }
                        }
                    }
                }
            }
        }
        if (this.WorldMapExtensionList.size() > 1 && this.StairsBetweenDistanceList.size() == 0) {
            ErrorInfo.add("フロアー間が階段で接続されていません。");
        }
        return ErrorInfo;
    }

    public boolean CartNetworkGeneratorCalcEndCheck() {
        for (WorldMapExtension worldMapExtension : this.getWorldMapExtensionList()) {
            WorldMap map = worldMapExtension.getWorldMap();
            WaypointGraph graph = map.cartGraph();
            if (graph != null) continue;
            return false;
        }
        return true;
    }

    public WaypointGraph createAllWaypointGraph() {
        WaypointGraph graph_ALL = new WaypointGraph(null);
        graph_ALL.resetNetwork();
        for (WorldMapExtension worldMapExtension : this.WorldMapExtensionList) {
            WorldMap map = worldMapExtension.getWorldMap();
            WaypointGraph graph_map = map.cartGraph();
            graph_ALL.addWaypointGraph(graph_map);
        }
        graph_ALL.addWaypointGraph(this.stairsWaypointGraph);
        return graph_ALL;
    }

    public int getFloorNoforStairsObject(StairsObject obj) {
        int FloorNo = 0;
        while (FloorNo < this.WorldMapExtensionList.size()) {
            if (this.WorldMapExtensionList.get(FloorNo).getWorldMap().stairsObjects().contains(obj)) {
                return FloorNo;
            }
            ++FloorNo;
        }
        return -1;
    }

    public double distForPath(List<Waypoint> path) {
        double dist = 0.0;
        Waypoint prev = null;
        for (Waypoint p : path) {
            if (prev != null) {
                AbstractRectangleObject p_obj = this.stairsWaypointGraph.rectForWaypoint(p);
                AbstractRectangleObject prev_obj = this.stairsWaypointGraph.rectForWaypoint(prev);
                if (StairsObject.class.isInstance(p_obj) && StairsObject.class.isInstance(prev_obj)) {
                    int prev_obj_FloorNo;
                    int p_obj_FloorNo = this.getFloorNoforStairsObject((StairsObject)p_obj);
                    if (p_obj_FloorNo != (prev_obj_FloorNo = this.getFloorNoforStairsObject((StairsObject)prev_obj))) {
                        double StairsDistance = this.GetStairsBetweenDistance((StairsObject)prev_obj, (StairsObject)p_obj);
                        dist += StairsDistance;
                    } else {
                        dist += prev.coord().distTo(p.coord());
                    }
                } else {
                    dist += prev.coord().distTo(p.coord());
                }
            }
            prev = p;
        }
        return dist;
    }

    public boolean FloorLinkMPassCheck() {
        this.AllFloorCalc(true);
        String errorMessage = null;
        for (String str : this.allFloorCalc_ErrorInfo) {
            if (str == null) continue;
            if (errorMessage == null) {
                errorMessage = "経路キャッシュ計算でエラーが発生しました。\n\n";
            }
            errorMessage = String.valueOf(errorMessage) + str + "\n";
        }
        if (errorMessage != null) {
            JOptionPane.showMessageDialog(null, errorMessage, "エラー", 0);
            return false;
        }
        ArrayList<String> errorMessage_createCartGraph = this.CreateMultiFloorStairsCartGraph();
        errorMessage = null;
        for (String str : errorMessage_createCartGraph) {
            if (str == null) continue;
            if (errorMessage == null) {
                errorMessage = "フロアー間の階段の接続に問題があります。\n\n";
            }
            errorMessage = String.valueOf(errorMessage) + str + "\n";
        }
        if (errorMessage != null) {
            JOptionPane.showMessageDialog(null, errorMessage, "エラー", 0);
            return false;
        }
        HashMap<String, Waypoint> targetWaypoints = new HashMap<String, Waypoint>();
        int FloorNo = 0;
        while (FloorNo < this.WorldMapExtensionList.size()) {
            WorldMapExtension worldMapExtension = this.getWorldMapExtension(FloorNo);
            WorldMap map = worldMapExtension.getWorldMap();
            WaypointGraph graph = map.cartGraph();
            for (FreeShelfObject shelfObject : map.freeShelfObjects()) {
                for (Waypoint waypoint : graph.waypointsForRect(shelfObject)) {
                    targetWaypoints.put(String.valueOf(FloorNo) + "_" + waypoint.id, waypoint);
                }
            }
            for (ConstrainedAreaObject areas : map.constrainedAreaObjects()) {
                for (Waypoint waypoint : graph.waypointsForRect(areas)) {
                    targetWaypoints.put(String.valueOf(FloorNo) + "_" + waypoint.id, waypoint);
                }
            }
            for (StairsObject stairsObject : map.stairsObjects()) {
                for (Waypoint waypoint : graph.waypointsForRect(stairsObject)) {
                    targetWaypoints.put(String.valueOf(FloorNo) + "_" + waypoint.id, waypoint);
                }
            }
            ++FloorNo;
        }
        WaypointGraph graph_ALL = new WaypointGraph(null);
        graph_ALL = this.createAllWaypointGraph();
        HashMap<String, Waypoint> tos = new HashMap<String, Waypoint>();
        tos.putAll(targetWaypoints);
        for (Map.Entry from : targetWaypoints.entrySet()) {
            tos.remove(from.getKey());
            Map<Waypoint, List<Waypoint>> paths = graph_ALL.shortestPathsFor((Waypoint)from.getValue(), tos.values());
            if (paths == null) {
                int FloorNo2 = graph_ALL.FloorNoForWaypoint((Waypoint)from.getValue());
                String FloorName = this.WorldMapExtensionList.get(FloorNo2).getName();
                JOptionPane.showMessageDialog(null, "「" + FloorName + "」フロアーから到達できないフロアーがあります。", "エラー", 0);
                return false;
            }
            for (Map.Entry to : tos.entrySet()) {
                List<Waypoint> path = paths.get(to.getValue());
                if (path != null) continue;
                int FromFloorNo = graph_ALL.FloorNoForWaypoint((Waypoint)from.getValue());
                String FromFloorName = this.WorldMapExtensionList.get(FromFloorNo).getName();
                int ToFloorNo = graph_ALL.FloorNoForWaypoint((Waypoint)to.getValue());
                String ToFloorName = this.getWorldMapExtension(ToFloorNo).getName();
                JOptionPane.showMessageDialog(null, "「" + FromFloorName + "」から「" + ToFloorName + "」に到達できません。", "エラー", 0);
                return false;
            }
            tos.put((String)from.getKey(), (Waypoint)from.getValue());
        }
        return true;
    }

    public boolean AllFloorCalc(boolean ProgressdialogShow) {
        ProgressManager pMan = new ProgressManager();
        ProgressDialog dialog = null;
        if (ProgressdialogShow) {
            dialog = new ProgressDialog("処理中", "経路キャッシュ計算中です。");
            pMan.addProgressListener(dialog);
        }
        this.allFloorCalc_ErrorInfo = new ArrayList();
        this.allFloorCalc_CatchMemoryError = new ArrayList();
        ArrayList<CartNetworkGenerator> cartNetworkGeneratorList = new ArrayList<CartNetworkGenerator>();
        class ProgressGet
        implements Runnable {
            private boolean running = true;
            private final /* synthetic */ boolean val$ProgressdialogShow;
            private final /* synthetic */ ArrayList val$cartNetworkGeneratorList;
            private final /* synthetic */ ProgressManager val$pMan;

            ProgressGet(boolean bl, ArrayList arrayList, ProgressManager progressManager) {
                this.val$ProgressdialogShow = bl;
                this.val$cartNetworkGeneratorList = arrayList;
                this.val$pMan = progressManager;
            }

            public void stoprunning() {
                this.running = false;
            }

            @Override
            public void run() {
                while (this.running) {
                    if (this.val$ProgressdialogShow) {
                        int progress = 0;
                        for (CartNetworkGenerator cartNetworkGenerator : this.val$cartNetworkGeneratorList) {
                            progress += cartNetworkGenerator.getProgress();
                        }
                        double dprogress = progress;
                        double all = WorldMapMultiFloor.this.WorldMapExtensionList.size() * 100;
                        this.val$pMan.report(dprogress / all, "");
                    }
                    try {
                        Thread.sleep(200L);
                    }
                    catch (InterruptedException interruptedException) {
                        // empty catch block
                    }
                }
            }
        }
        ProgressGet progressGet = null;
        Thread th = null;
        if (ProgressdialogShow) {
            progressGet = new ProgressGet(ProgressdialogShow, cartNetworkGeneratorList, pMan);
            th = new Thread(progressGet);
            th.start();
        }
        int FloorNo = 0;
        while (FloorNo < this.WorldMapExtensionList.size()) {
            final WorldMapExtension worldMapExtension = this.WorldMapExtensionList.get(FloorNo);
            cartNetworkGeneratorList.add(new CartNetworkGenerator(this.getFloorNoforWorldMap(worldMapExtension.getWorldMap()), worldMapExtension.getWorldMap()));
            final CartNetworkGenerator cartNetworkGenerator = (CartNetworkGenerator)cartNetworkGeneratorList.get(FloorNo);
            cartNetworkGenerator.addListener(new CartNetworkGenerator.NetworkGeneratorListener(){

                @Override
                public void generateFinished(WaypointGraph graph, String errorInfo) {
                    boolean isCatchMemoryError = cartNetworkGenerator.isCatchMemoryError();
                    if (errorInfo == null) {
                        try {
                            worldMapExtension.getWorldMap().startWrite();
                            worldMapExtension.getWorldMap().setCartGraph(graph);
                        }
                        finally {
                            worldMapExtension.getWorldMap().endWrite();
                        }
                    }
                    try {
                        worldMapExtension.getWorldMap().startWrite();
                        worldMapExtension.getWorldMap().setCartGraph(null);
                    }
                    finally {
                        worldMapExtension.getWorldMap().endWrite();
                    }
                    WorldMapMultiFloor.this.allFloorCalc_ErrorInfo.add("「" + worldMapExtension.getName() + "」フロアー：" + errorInfo);
                    WorldMapMultiFloor.this.allFloorCalc_CatchMemoryError.add(isCatchMemoryError);
                }

                @Override
                public void checkInterrupt() throws GenerateInterruptException {
                }
            });
            cartNetworkGenerator.run();
            ++FloorNo;
        }
        if (ProgressdialogShow) {
            progressGet.stoprunning();
        }
        if (dialog != null) {
            dialog.dispose();
        }
        boolean ret = true;
        for (String str : this.allFloorCalc_ErrorInfo) {
            if (str == null) continue;
            ret = false;
        }
        return ret;
    }
}

