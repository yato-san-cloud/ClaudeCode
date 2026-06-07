/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.map;

import com.hitachi.warehouse.model.common.Coord;
import java.io.IOException;
import java.io.ObjectInputStream;
import java.io.Serializable;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public class Waypoint
implements Serializable {
    private static int accum_id = 0;
    public final int id;
    private static final long serialVersionUID = 747750592727202845L;
    private Coord coord;
    private String name = null;
    transient Set<Waypoint> networkNeighboursSet = new HashSet<Waypoint>();
    transient List<Waypoint> networkNeighbours = new ArrayList<Waypoint>();
    transient List<Waypoint> parentNeighbours = new ArrayList<Waypoint>();
    public transient double _USERDATA_DOUBLE_0;
    public transient int _USERDATA_INT_0;
    public transient int _USERDATA_INT_1;
    public transient Waypoint _USERDATA_WAYPOINT_0;
    public transient boolean _USERDATA_BOOLEAN_0;
    public transient boolean _USERDATA_BOOLEAN_1;
    public transient boolean _USERDATA_BOOLEAN_2;
    public transient double[] _USERDATA_DOUBLES_0;
    public transient int[] _USERDATA_INTS_0;
    public transient int[] _USERDATA_INTS_1;
    public transient Waypoint[] _USERDATA_WAYPOINTS_0;
    public transient boolean[] _USERDATA_BOOLEANS_0;
    public transient boolean[] _USERDATA_BOOLEANS_2;

    public Coord coord() {
        return this.coord;
    }

    public void setCoord(Coord coord) {
        this.coord = coord;
    }

    public Waypoint(String name, Coord coord) {
        this(accum_id++, coord);
        this.setName(name);
    }

    public Waypoint(Coord coord) {
        this(accum_id++, coord);
    }

    public Waypoint(int id, Coord coord) {
        this.id = id;
        if (accum_id <= id) {
            accum_id = id + 1;
        }
        this.coord = coord;
    }

    public String name() {
        return this.name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public List<Waypoint> networkNeighbours() {
        return this.networkNeighbours;
    }

    public void addNeighbour(Waypoint waypoint) {
        if (!this.networkNeighboursSet.contains(waypoint)) {
            this.networkNeighbours.add(waypoint);
            waypoint.parentNeighbours.add(this);
            this.networkNeighboursSet.add(waypoint);
        }
    }

    public void addNeighbourNoCheck(Waypoint waypoint) {
        this.networkNeighbours.add(waypoint);
        waypoint.parentNeighbours.add(this);
        this.networkNeighboursSet.add(waypoint);
    }

    public List<Waypoint> parentNeighbours() {
        return this.parentNeighbours;
    }

    public void kill() {
        for (Waypoint other : this.parentNeighbours) {
            other.networkNeighbours.remove(this);
        }
    }

    private void readObject(ObjectInputStream in) throws IOException, ClassNotFoundException {
        in.defaultReadObject();
        this.networkNeighbours = new ArrayList<Waypoint>();
    }

    public boolean equals(Object _other) {
        return this.id == ((Waypoint)_other).id;
    }

    public int hashCode() {
        return this.id;
    }

    public String toString() {
        return this.name;
    }
}

