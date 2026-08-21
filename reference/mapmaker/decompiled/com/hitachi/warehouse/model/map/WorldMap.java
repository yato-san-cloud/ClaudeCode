/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.map;

import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.common.polygon.Shape;
import com.hitachi.warehouse.model.map.MapProxy;
import com.hitachi.warehouse.model.map.ShelfNameManager;
import com.hitachi.warehouse.model.map.Waypoint;
import com.hitachi.warehouse.model.map.WaypointGraph;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.AbstractRectangleObject;
import com.hitachi.warehouse.model.map.objects.BeaconObject;
import com.hitachi.warehouse.model.map.objects.ConstrainedAreaObject;
import com.hitachi.warehouse.model.map.objects.FreeShelfObject;
import com.hitachi.warehouse.model.map.objects.ImageObject;
import com.hitachi.warehouse.model.map.objects.OneWayPassageObject;
import com.hitachi.warehouse.model.map.objects.ShelfObject;
import com.hitachi.warehouse.model.map.objects.StairsObject;
import com.hitachi.warehouse.model.map.objects.StationObject;
import com.hitachi.warehouse.model.map.objects.WallObject;
import com.hitachi.warehouse.model.picking.FreeShelfArea;
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
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.locks.ReadWriteLock;
import java.util.concurrent.locks.ReentrantReadWriteLock;

public class WorldMap
implements Serializable,
MapProxy {
    private static final long serialVersionUID = -8068453201122970038L;
    public static final int CURRENT_VERSION = 3;
    private int INTERNAL_VERSION = 3;
    private transient ReadWriteLock lock = new ReentrantReadWriteLock();
    private transient List<StairsObject> stairsObjects = new ArrayList<StairsObject>();
    private transient List<ShelfObject> shelfObjects = new ArrayList<ShelfObject>();
    private transient List<FreeShelfObject> freeShelfObjects = new ArrayList<FreeShelfObject>();
    private transient List<StationObject> stationObjects = new ArrayList<StationObject>();
    private transient List<BeaconObject> beaconObjects = new ArrayList<BeaconObject>();
    private transient List<WallObject> wallObjects = new ArrayList<WallObject>();
    private transient List<OneWayPassageObject> onewayPassages = new ArrayList<OneWayPassageObject>();
    private transient List<ConstrainedAreaObject> constrainedAreas = new ArrayList<ConstrainedAreaObject>();
    private transient List<AbstractObject> obstacles = new ArrayList<AbstractObject>();
    private Coord tl;
    private Coord br;
    private ImageObject objImage_bg = null;
    private List<AbstractObject> objects = new ArrayList<AbstractObject>();
    private WaypointGraph cartGraph = null;
    private WaypointGraph walkGraph = null;
    private transient Map<FreeShelfArea, FreeShelfObject> shelfObjectForShelf = null;
    private ShelfNameManager shelfNameManager = null;
    transient List<WorldMapChangedListener> changeListeners = new ArrayList<WorldMapChangedListener>();

    public int internalVersion() {
        return this.INTERNAL_VERSION;
    }

    public void updateInternalVersion(int version) {
        this.INTERNAL_VERSION = version;
    }

    public WorldMap() {
        this(new Coord(0.0, 0.0), new Coord(43502.0, 89987.0));
    }

    public WorldMap(Coord tl, Coord br) {
        this.tl = tl;
        this.br = br;
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

    public List<StairsObject> stairsObjects() {
        return this.stairsObjects;
    }

    public List<ShelfObject> shelfObjects() {
        return this.shelfObjects;
    }

    public List<FreeShelfObject> freeShelfObjects() {
        return this.freeShelfObjects;
    }

    public List<StationObject> stationObjects() {
        return this.stationObjects;
    }

    public List<BeaconObject> beaconObjects() {
        return this.beaconObjects;
    }

    public List<WallObject> wallObjects() {
        return this.wallObjects;
    }

    public List<OneWayPassageObject> onewayPassageObjects() {
        return this.onewayPassages;
    }

    public List<ConstrainedAreaObject> constrainedAreaObjects() {
        return this.constrainedAreas;
    }

    public List<AbstractObject> obstacleObjects() {
        return this.obstacles;
    }

    public Coord tl() {
        return this.tl;
    }

    public Coord tr() {
        return new Coord(this.br.x, this.tl.y);
    }

    public Coord br() {
        return this.br;
    }

    public Coord bl() {
        return new Coord(this.tl.x, this.br.y);
    }

    public void setBounds(Coord tl, Coord br) {
        try {
            this.startWrite();
            this.tl = tl;
            this.br = br;
        }
        finally {
            this.endWrite();
        }
        this.dispatchChangedEvent();
    }

    public ImageObject bgImg() {
        return this.objImage_bg;
    }

    public void setBGImg(ImageObject bgImg) {
        try {
            this.startWrite();
            this.objImage_bg = bgImg;
        }
        finally {
            this.endWrite();
        }
        this.dispatchChangedEvent();
    }

    public void add(AbstractObject object) {
        try {
            this.startWrite();
            if (!this.objects.contains(object)) {
                this.objects.add(object);
                if (ShelfObject.class.isInstance(object)) {
                    this.shelfObjects.add((ShelfObject)object);
                } else if (FreeShelfObject.class.isInstance(object)) {
                    this.shelfObjectForShelf = null;
                    this.freeShelfObjects.add((FreeShelfObject)object);
                } else if (StationObject.class.isInstance(object)) {
                    this.stationObjects.add((StationObject)object);
                } else if (BeaconObject.class.isInstance(object)) {
                    this.beaconObjects.add((BeaconObject)object);
                } else if (WallObject.class.isInstance(object)) {
                    this.wallObjects.add((WallObject)object);
                } else if (OneWayPassageObject.class.isInstance(object)) {
                    this.onewayPassages.add((OneWayPassageObject)object);
                } else if (ConstrainedAreaObject.class.isInstance(object)) {
                    this.constrainedAreas.add((ConstrainedAreaObject)object);
                } else if (StairsObject.class.isInstance(object)) {
                    this.stairsObjects.add((StairsObject)object);
                }
                if (object.isObstructing()) {
                    this.obstacles.add(object);
                }
            }
        }
        finally {
            this.endWrite();
        }
        this.dispatchChangedEvent();
    }

    public void remove(AbstractObject object) {
        try {
            this.startWrite();
            this.objects.remove(object);
            if (ShelfObject.class.isInstance(object)) {
                this.shelfObjects.remove((ShelfObject)object);
            } else if (FreeShelfObject.class.isInstance(object)) {
                this.shelfObjectForShelf = null;
                this.freeShelfObjects.remove((FreeShelfObject)object);
            } else if (StationObject.class.isInstance(object)) {
                this.stationObjects.remove((StationObject)object);
            } else if (BeaconObject.class.isInstance(object)) {
                this.beaconObjects.remove((BeaconObject)object);
            } else if (WallObject.class.isInstance(object)) {
                this.wallObjects.remove((WallObject)object);
            } else if (OneWayPassageObject.class.isInstance(object)) {
                this.onewayPassages.remove((OneWayPassageObject)object);
            } else if (ConstrainedAreaObject.class.isInstance(object)) {
                this.constrainedAreas.remove((ConstrainedAreaObject)object);
            } else if (StairsObject.class.isInstance(object)) {
                this.stairsObjects.remove((StairsObject)object);
            }
            if (object.isObstructing()) {
                this.obstacles.remove(object);
            }
        }
        finally {
            this.endWrite();
        }
        this.dispatchChangedEvent();
    }

    public List<AbstractObject> objects() {
        return this.objects;
    }

    public WaypointGraph cartGraph() {
        return this.cartGraph;
    }

    public void setCartGraph(WaypointGraph graph) {
        try {
            this.startWrite();
            this.cartGraph = graph;
        }
        finally {
            this.endWrite();
        }
    }

    public WaypointGraph walkGraph() {
        return this.walkGraph;
    }

    public void setWalkGraph(WaypointGraph graph) {
        try {
            this.startWrite();
            this.walkGraph = graph;
        }
        finally {
            this.endWrite();
        }
    }

    public void resetNetwork() {
        try {
            this.startWrite();
            this.cartGraph = new WaypointGraph(this);
        }
        finally {
            this.endWrite();
        }
    }

    public FreeShelfObject shelfObjectForShelf(FreeShelfArea shelf) {
        if (this.shelfObjectForShelf == null) {
            this.shelfObjectForShelf = new HashMap<FreeShelfArea, FreeShelfObject>();
            for (AbstractObject object : this.objects) {
                if (!FreeShelfObject.class.isInstance(object)) continue;
                FreeShelfObject shelfObj = (FreeShelfObject)object;
                this.shelfObjectForShelf.put(shelfObj.shelf(), shelfObj);
            }
        }
        return this.shelfObjectForShelf.get(shelf);
    }

    public ShelfNameManager shelfNameManager() {
        if (this.shelfNameManager == null) {
            try {
                this.startWrite();
                this.shelfNameManager = new ShelfNameManager();
            }
            finally {
                this.endWrite();
            }
        }
        return this.shelfNameManager;
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
    public static WorldMap loadFrom(File file) {
        if (file.isDirectory()) {
            file = new File(file, "map.rmp");
        }
        WorldMap map = null;
        File outBinFile = file;
        ObjectInputStream in = null;
        try {
            try {
                in = new ObjectInputStream(new BufferedInputStream(new FileInputStream(outBinFile)));
                map = (WorldMap)in.readObject();
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

    public List<WorldMapChangedListener> changeListeners() {
        return this.changeListeners;
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    @Override
    public void addMapChangedListener(WorldMapChangedListener listener) {
        List<WorldMapChangedListener> list = this.changeListeners;
        synchronized (list) {
            this.changeListeners.add(listener);
        }
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    @Override
    public void removeMapChangedListener(WorldMapChangedListener listener) {
        List<WorldMapChangedListener> list = this.changeListeners;
        synchronized (list) {
            this.changeListeners.remove(listener);
        }
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void dispatchChangedEvent() {
        List<WorldMapChangedListener> list = this.changeListeners;
        synchronized (list) {
            for (WorldMapChangedListener listener : this.changeListeners) {
                listener.mapChanged(this);
            }
        }
    }

    private void readObject(ObjectInputStream in) throws IOException, ClassNotFoundException {
        in.defaultReadObject();
        ArrayList<AbstractObject> purged = new ArrayList<AbstractObject>();
        for (AbstractObject object : this.objects) {
            AbstractRectangleObject rect;
            if (!AbstractRectangleObject.class.isInstance(object) || !(rect = (AbstractRectangleObject)object).tl().equals(rect.br())) continue;
            purged.add(object);
        }
        purged.add(null);
        for (AbstractObject obj : purged) {
            this.objects.remove(obj);
        }
        int id = 0;
        for (AbstractObject obj : this.objects) {
            id = Math.max(id, obj.id());
        }
        AbstractObject._setIDAccumMaxCheck(id + 1);
        this.changeListeners = new ArrayList<WorldMapChangedListener>();
        this.lock = new ReentrantReadWriteLock();
        this.shelfObjects = new ArrayList<ShelfObject>();
        this.freeShelfObjects = new ArrayList<FreeShelfObject>();
        this.stationObjects = new ArrayList<StationObject>();
        this.beaconObjects = new ArrayList<BeaconObject>();
        this.wallObjects = new ArrayList<WallObject>();
        this.onewayPassages = new ArrayList<OneWayPassageObject>();
        this.obstacles = new ArrayList<AbstractObject>();
        this.constrainedAreas = new ArrayList<ConstrainedAreaObject>();
        this.stairsObjects = new ArrayList<StairsObject>();
        for (AbstractObject obj : this.objects) {
            if (ShelfObject.class.isInstance(obj)) {
                this.shelfObjects.add((ShelfObject)obj);
            } else if (FreeShelfObject.class.isInstance(obj)) {
                this.freeShelfObjects.add((FreeShelfObject)obj);
            } else if (StationObject.class.isInstance(obj)) {
                this.stationObjects.add((StationObject)obj);
            } else if (BeaconObject.class.isInstance(obj)) {
                this.beaconObjects.add((BeaconObject)obj);
            } else if (WallObject.class.isInstance(obj)) {
                this.wallObjects.add((WallObject)obj);
            } else if (OneWayPassageObject.class.isInstance(obj)) {
                this.onewayPassages.add((OneWayPassageObject)obj);
            } else if (ConstrainedAreaObject.class.isInstance(obj)) {
                this.constrainedAreas.add((ConstrainedAreaObject)obj);
            } else if (StairsObject.class.isInstance(obj)) {
                this.stairsObjects.add((StairsObject)obj);
            }
            if (!obj.isObstructing()) continue;
            this.obstacles.add(obj);
        }
    }

    public boolean segmentClipsEnvironment(Coord from, Coord to) {
        for (AbstractObject object : this.obstacleObjects()) {
            if (!object.clipsSegment(from, to)) continue;
            return true;
        }
        return false;
    }

    public boolean polygonClipsEnvironment(Shape shape) {
        for (AbstractObject object : this.obstacleObjects()) {
            if (!shape.intersects(object.bound())) continue;
            return true;
        }
        return false;
    }

    public boolean polygonClipsEnvironment(Set<AbstractObject> ignoreObstacles, Coord ... coords) {
        Coord prev = coords[coords.length - 1];
        Coord[] coordArray = coords;
        int n = coords.length;
        int n2 = 0;
        while (n2 < n) {
            Coord coord = coordArray[n2];
            for (AbstractObject object : this.obstacleObjects()) {
                if (ignoreObstacles.contains(object) || !object.clipsSegment(prev, coord)) continue;
                return true;
            }
            prev = coord;
            ++n2;
        }
        return false;
    }

    public Set<AbstractObject> obstaclesClippingPolygon(Coord ... coords) {
        HashSet<AbstractObject> objs = new HashSet<AbstractObject>();
        Coord prev = coords[coords.length - 1];
        Coord[] coordArray = coords;
        int n = coords.length;
        int n2 = 0;
        while (n2 < n) {
            Coord coord = coordArray[n2];
            for (AbstractObject object : this.obstacleObjects()) {
                if (!object.clipsSegment(prev, coord)) continue;
                objs.add(object);
            }
            prev = coord;
            ++n2;
        }
        return objs;
    }

    public Waypoint[] waypointsForRect(ShelfObject shelf) {
        return new Waypoint[0];
    }

    public static interface WorldMapChangedListener {
        public void mapChanged(WorldMap var1);
    }
}

