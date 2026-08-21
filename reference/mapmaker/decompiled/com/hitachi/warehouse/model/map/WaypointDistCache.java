/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.map;

import com.hitachi.warehouse.model.map.Waypoint;
import common.ds.BinaryHash;
import java.io.Serializable;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Set;

public class WaypointDistCache
implements Serializable {
    private static final long serialVersionUID = -4009279736462939361L;
    private HashMap<Waypoint, Integer> idxForWaypoint = new HashMap();
    private float[][] dists;

    public WaypointDistCache(BinaryHash<Waypoint, Waypoint, Float> map) {
        ArrayList<Waypoint> waypoints = new ArrayList<Waypoint>();
        waypoints.addAll(map.keySet());
        int i = 0;
        while (i < waypoints.size()) {
            this.idxForWaypoint.put((Waypoint)waypoints.get(i), i);
            ++i;
        }
        this.dists = new float[waypoints.size()][waypoints.size()];
        i = 0;
        while (i < waypoints.size()) {
            int j = 0;
            while (j < waypoints.size()) {
                Float dist = map.get((Waypoint)waypoints.get(i), (Waypoint)waypoints.get(j));
                if (i == j) {
                    dist = Float.valueOf(0.0f);
                }
                if (dist == null) {
                    System.out.println(waypoints.get(i) + " " + waypoints.get(j));
                }
                this.dists[i][j] = dist.floatValue();
                ++j;
            }
            ++i;
        }
    }

    public Set<Waypoint> waypoints() {
        return this.idxForWaypoint.keySet();
    }

    public float distBetween(Waypoint from, Waypoint to) {
        return this.dists[this.idxForWaypoint.get(from)][this.idxForWaypoint.get(to)];
    }

    public boolean isWaypointKnown(Waypoint waypoint) {
        return this.idxForWaypoint.containsKey(waypoint);
    }
}

