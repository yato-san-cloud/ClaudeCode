/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.bms.model;

import com.hitachi.warehouse.bms.model.PositionRecord;
import com.hitachi.warehouse.model.common.Coord;
import common.util.DateUtil;
import common.util.MathUtil;
import java.io.Serializable;
import java.util.Date;

public class Path
implements Serializable {
    private static final long serialVersionUID = 8793188123285228377L;
    public final PositionRecord[] records;
    public final Date minTime;
    public final Date maxTime;
    public final long samplingrate_ms;

    public Path(PositionRecord[] records) {
        this.records = records;
        this.minTime = records[0].t;
        this.maxTime = records[records.length - 1].t;
        this.samplingrate_ms = records[1].t.getTime() - records[0].t.getTime();
    }

    public PositionRecord recordAtT(Date t2) {
        int idx = (int)(DateUtil.durationMillis(this.minTime, t2) / this.samplingrate_ms);
        if (idx >= 0 && idx < this.records.length) {
            return this.records[idx];
        }
        return null;
    }

    public Coord coordAt(Date t2) {
        double idx = (double)DateUtil.durationMillis(this.minTime, t2) / (double)this.samplingrate_ms;
        if (idx >= 0.0 && idx < (double)this.records.length) {
            int leftIdx = (int)Math.floor(idx);
            if ((double)leftIdx == idx) {
                return this.records[leftIdx].state.pos.center;
            }
            int rightIdx = (int)Math.ceil(idx);
            PositionRecord left = this.records[leftIdx];
            PositionRecord right = this.records[rightIdx];
            return new Coord(MathUtil.map(idx, leftIdx, rightIdx, left.state.pos.center.x, right.state.pos.center.x), MathUtil.map(idx, leftIdx, rightIdx, left.state.pos.center.y, right.state.pos.center.y));
        }
        return null;
    }

    public Double rotAt(Date t2) {
        double idx = (double)DateUtil.durationMillis(this.minTime, t2) / (double)this.samplingrate_ms;
        if (idx >= 0.0 && idx < (double)this.records.length) {
            int leftIdx = (int)Math.floor(idx);
            if ((double)leftIdx == idx) {
                return this.records[leftIdx].state.rot;
            }
            int rightIdx = (int)Math.ceil(idx);
            PositionRecord left = this.records[leftIdx];
            PositionRecord right = this.records[rightIdx];
            double rightRot = right.state.rot;
            double leftRot = left.state.rot;
            double rot = rightRot >= leftRot ? (rightRot - leftRot <= Math.PI ? MathUtil.map(idx, leftIdx, rightIdx, leftRot, rightRot) : MathUtil.map(idx, leftIdx, rightIdx, leftRot + Math.PI * 2, rightRot)) : (leftRot - rightRot <= Math.PI ? MathUtil.map(idx, leftIdx, rightIdx, leftRot, rightRot) : MathUtil.map(idx, leftIdx, rightIdx, leftRot, rightRot + Math.PI * 2));
            while (rot > Math.PI * 2) {
                rot -= Math.PI * 2;
            }
            return rot;
        }
        return null;
    }

    public boolean contains(Date t2) {
        return !t2.before(this.minTime) && !t2.after(this.maxTime);
    }

    public String toString() {
        return this.minTime + "~" + this.maxTime;
    }

    public PositionRecord[] recs() {
        return this.records;
    }
}

