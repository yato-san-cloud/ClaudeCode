/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.packing;

import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.packing.Segment;
import com.hitachi.warehouse.model.packing.StillSegment;
import common.util.DateUtil;
import java.util.Date;

public class MoveSegment
extends Segment<StillSegment> {
    private double dist = 0.0;

    public MoveSegment(Date tStart, Coord coord) {
        super(tStart);
    }

    public void addDist(double dist) {
        this.dist = dist;
    }

    public double dist() {
        return this.dist;
    }

    @Override
    public boolean isStill() {
        return false;
    }

    public String toString() {
        return String.valueOf(DateUtil.time2Str(this.tStart())) + " ~ " + DateUtil.time2Str(this.tEnd()) + " " + "Move" + DateUtil.durationSeconds(this.tStart(), this.tEnd());
    }
}

