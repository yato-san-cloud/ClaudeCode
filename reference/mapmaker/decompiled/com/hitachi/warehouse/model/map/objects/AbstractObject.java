/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.map.objects;

import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.common.polygon.Bound;
import java.awt.Graphics2D;
import java.io.Serializable;
import java.util.Collection;

public abstract class AbstractObject
implements Serializable {
    private static final long serialVersionUID = -4055425716716854477L;
    private static int accum_id = 0;
    private static Object accum_id_lock = new Object();
    private Integer id = null;
    private boolean editLock = false;

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public static void _setIDAccum(int id) {
        Object object = accum_id_lock;
        synchronized (object) {
            accum_id = id;
        }
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public static void _setIDAccumMaxCheck(int id) {
        Object object = accum_id_lock;
        synchronized (object) {
            if (accum_id < id) {
                accum_id = id;
            }
        }
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public static int getNewID() {
        Object object = accum_id_lock;
        synchronized (object) {
            return accum_id++;
        }
    }

    public AbstractObject() {
        this.id();
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public int id() {
        if (this.id == null) {
            AbstractObject abstractObject = this;
            synchronized (abstractObject) {
                if (this.id == null) {
                    this.id = AbstractObject.getNewID();
                }
                return this.id;
            }
        }
        return this.id;
    }

    public void _setID(int id) {
        this.id = id;
    }

    public abstract boolean isObstructing();

    public abstract boolean isInside(Coord var1);

    public abstract boolean clipsSegment(Coord var1, Coord var2);

    public abstract double distTo(Coord var1);

    public abstract void paint(Graphics2D var1, MapView var2);

    public abstract void highlight(Graphics2D var1, MapView var2);

    public static <T extends AbstractObject> T getEnclosingObject(Coord coord, Collection<T> objects) {
        for (AbstractObject obj : objects) {
            if (!obj.isInside(coord)) continue;
            return (T)obj;
        }
        return null;
    }

    public int hashCode() {
        return this.id();
    }

    public boolean equals(Object _other) {
        return ((AbstractObject)_other).id() == this.id();
    }

    public abstract Coord boundTL();

    public abstract Coord boundTR();

    public abstract Coord boundBL();

    public abstract Coord boundBR();

    public abstract Bound bound();

    public abstract int screenLeft(MapView var1);

    public abstract int screenRight(MapView var1);

    public abstract int screenTop(MapView var1);

    public abstract int screenBottom(MapView var1);

    public abstract void nudge(double var1, double var3);

    public void setLeft(double x) {
    }

    public void setRight(double x) {
    }

    public void setTop(double y) {
    }

    public void setBottom(double y) {
    }

    public abstract AbstractObject hardClone();

    public void setEditLock(boolean editLock) {
        this.editLock = editLock;
    }

    public boolean getEditLock() {
        return this.editLock;
    }
}

