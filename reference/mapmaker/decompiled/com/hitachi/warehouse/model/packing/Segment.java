/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.packing;

import com.hitachi.warehouse.bms.model.Paths;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.packing.MoveSegment;
import com.hitachi.warehouse.model.packing.PackingRecord;
import com.hitachi.warehouse.model.packing.StillSegment;
import common.ds.Timespan;
import common.ds.TimespanStack;
import common.util.DateUtil;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Map;

public abstract class Segment<U extends Segment> {
    private Date tStart;
    private Date tEnd;
    private U prev;
    private U next;

    public Segment(Date tStart) {
        this.tStart = tStart;
        this.tEnd = tStart;
    }

    public Date tStart() {
        return this.tStart;
    }

    public void setTStart(Date tStart) {
        this.tStart = tStart;
    }

    public Date tEnd() {
        return this.tEnd;
    }

    public void setTEnd(Date tEnd) {
        this.tEnd = tEnd;
    }

    public U prev() {
        return this.prev;
    }

    public void setPrev(U prev) {
        this.prev = prev;
    }

    public U next() {
        return this.next;
    }

    public void setNext(U next) {
        this.next = next;
    }

    public abstract boolean isStill();

    public static List<Segment> segmentsFrom(List<PackingRecord> batch, Map<String, Coord> coordForStation, Paths paths) {
        Date tStart = batch.get((int)0).tStart;
        Date tEnd = batch.get((int)(batch.size() - 1)).tEnd;
        int duration = DateUtil.durationSeconds(tStart, tEnd);
        Coord homeCoord = coordForStation.get(batch.get((int)0).workStation);
        if (homeCoord != null) {
            Coord[] coords = new Coord[duration];
            int i = 0;
            Date t2 = tStart;
            while (t2.before(tEnd)) {
                coords[i] = paths.coordAt(t2);
                ++i;
                t2 = DateUtil.addSeconds(t2, 1L);
            }
            ArrayList<Segment> segs = new ArrayList<Segment>();
            Segment prevSegment = null;
            Coord prev = null;
            int i2 = 0;
            while (i2 < coords.length) {
                Date t3 = DateUtil.addSeconds(tStart, i2);
                Coord coord = coords[i2];
                if (coord == null) {
                    if (prev != null) {
                        prevSegment.setTEnd(t3);
                        segs.add(prevSegment);
                        prevSegment = null;
                    }
                } else if (prev != null) {
                    boolean still = prev.equals(coord);
                    if (prevSegment != null) {
                        if (prevSegment.isStill() != still) {
                            if (still) {
                                segs.add(prevSegment);
                                StillSegment stillSeg = new StillSegment(prevSegment.tEnd(), coord);
                                MoveSegment prevMove = (MoveSegment)prevSegment;
                                prevMove.setNext(stillSeg);
                                stillSeg.setPrev(prevMove);
                                prevSegment = stillSeg;
                            } else {
                                segs.add(prevSegment);
                                MoveSegment moveSeg = new MoveSegment(prevSegment.tEnd(), coord);
                                StillSegment prevStill = (StillSegment)prevSegment;
                                prevStill.setNext(moveSeg);
                                moveSeg.setPrev(prevStill);
                                prevSegment = moveSeg;
                            }
                        }
                    } else {
                        prevSegment = still ? new StillSegment(DateUtil.addSeconds(t3, -1L), coord) : new MoveSegment(DateUtil.addSeconds(t3, -1L), coord);
                    }
                    if (!still) {
                        ((MoveSegment)prevSegment).addDist(prev.distTo(coord));
                    }
                    prevSegment.setTEnd(t3);
                }
                prev = coord;
                ++i2;
            }
            if (prevSegment != null) {
                segs.add(prevSegment);
            }
            TimespanStack<StillSegment> stills = new TimespanStack<StillSegment>();
            for (Segment seg : segs) {
                if (!seg.isStill()) continue;
                stills.put(new Timespan(seg.tStart(), seg.tEnd()), (StillSegment)seg);
            }
            for (PackingRecord rec : batch) {
                StillSegment seg = (StillSegment)stills.objAt(rec.tStart);
                if (seg != null) {
                    seg.setAtHome(true);
                }
                if ((seg = (StillSegment)stills.objAt(rec.tEnd)) == null) continue;
                seg.setAtHome(true);
            }
            for (Segment seg : segs) {
                StillSegment still;
                if (!seg.isStill() || !((still = (StillSegment)seg).coord().distTo(homeCoord) <= 8000.0)) continue;
                still.setAtHome(true);
            }
            ArrayList<Segment> filtered = new ArrayList<Segment>();
            int i3 = 0;
            while (i3 < segs.size()) {
                Segment seg = (Segment)segs.get(i3);
                if (!seg.isStill()) {
                    MoveSegment moveSeg = (MoveSegment)seg;
                    StillSegment prevStill = (StillSegment)moveSeg.prev();
                    StillSegment nextStill = (StillSegment)moveSeg.next();
                    if (prevStill != null && nextStill != null && prevStill.atHome() && nextStill.atHome()) {
                        prevStill.setTEnd(nextStill.tEnd());
                        if (nextStill.next() != null) {
                            ((MoveSegment)nextStill.next()).setPrev(prevStill);
                        }
                        prevStill.setNext((MoveSegment)nextStill.next());
                        ++i3;
                    } else {
                        filtered.add(seg);
                    }
                } else {
                    filtered.add(seg);
                }
                ++i3;
            }
            segs = filtered;
            return segs;
        }
        return null;
    }
}

