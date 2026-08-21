/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.bms.model;

import com.hitachi.warehouse.model.common.Coord;
import java.io.Serializable;

public class Beacon
implements Serializable {
    private static final long serialVersionUID = -335745260613864268L;
    public final String beaconID;
    public final String beaconName;
    private Coord coord;

    public Coord coord() {
        return this.coord;
    }

    public void setCoord(Coord coord) {
        this.coord = coord;
    }

    public Beacon(String beaconID, String beaconName) {
        this.beaconID = beaconID;
        this.beaconName = beaconName;
    }

    public String toString() {
        return this.beaconID;
    }

    public int hashCode() {
        return this.beaconID.hashCode() + this.beaconName.hashCode();
    }

    public boolean equals(Object _other) {
        Beacon other = (Beacon)_other;
        return this.beaconID.equals(other.beaconID);
    }
}

