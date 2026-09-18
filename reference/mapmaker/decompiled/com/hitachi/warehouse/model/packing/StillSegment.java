/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.packing;

import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.packing.MoveSegment;
import com.hitachi.warehouse.model.packing.Segment;
import common.util.DateUtil;
import java.util.Date;

public class StillSegment
extends Segment<MoveSegment> {
    private Coord coord;
    private boolean atHome = false;

    public StillSegment(Date tStart, Coord coord) {
        super(tStart);
        this.coord = coord;
    }

    public Coord coord() {
        return this.coord;
    }

    @Override
    public boolean isStill() {
        return true;
    }

    public String toString() {
        return String.valueOf(DateUtil.time2Str(this.tStart())) + " ~ " + DateUtil.time2Str(this.tEnd()) + " " + "Still" + (this.atHome ? "(H)" : "") + " " + DateUtil.durationSeconds(this.tStart(), this.tEnd());
    }

    public boolean atHome() {
        return this.atHome;
    }

    public void setAtHome(boolean atHome) {
        this.atHome = atHome;
    }
}

