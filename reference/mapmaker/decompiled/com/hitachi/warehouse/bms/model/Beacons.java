/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.bms.model;

import com.hitachi.warehouse.bms.model.Beacon;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;

public class Beacons {
    private List<Beacon> beacons = new ArrayList<Beacon>();
    private HashMap<String, Beacon> beaconForID = new HashMap();
    private HashMap<String, Beacon> beaconForName = new HashMap();

    public void addBeacon(Beacon beacon) {
        this.beacons.add(beacon);
        this.beaconForID.put(beacon.beaconID, beacon);
        this.beaconForName.put(beacon.beaconName, beacon);
    }

    public Beacon beaconForID(String id) {
        return this.beaconForID.get(id);
    }

    public Beacon beaconForName(String name) {
        return this.beaconForName.get(name);
    }

    public List<Beacon> beacons() {
        return this.beacons;
    }
}

