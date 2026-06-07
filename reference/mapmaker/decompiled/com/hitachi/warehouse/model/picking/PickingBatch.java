/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.picking;

import com.hitachi.warehouse.model.picking.PickingRecord;
import com.hitachi.warehouse.model.picking.Shelf;
import java.util.Date;
import java.util.List;

public class PickingBatch {
    public final List<PickingRecord> picks;
    public int numCollectedProducts = 0;
    public int numCollectedBoxes = 0;
    public int numBuckets = 0;
    public final Shelf shelf;
    public final String productCode;
    public final Date tStart;
    public final Date tEnd;

    public PickingBatch(List<PickingRecord> picks) {
        this.picks = picks;
        Date tStart = null;
        Date tEnd = null;
        int numCollectedProducts = 0;
        int numCollectedBoxes = 0;
        int numBoxes = 0;
        for (PickingRecord pick : picks) {
            numCollectedProducts += pick.numCollectedProducts();
            numCollectedBoxes += pick.numOrderedBoxes();
            ++numBoxes;
            if (tStart == null || tStart.after(pick.tStart())) {
                tStart = pick.tStart();
            }
            if (tEnd != null && !tEnd.before(pick.tEnd())) continue;
            tEnd = pick.tEnd();
        }
        this.numCollectedProducts = numCollectedProducts;
        this.numCollectedBoxes = numCollectedBoxes;
        this.numBuckets = numBoxes;
        this.tStart = tStart;
        this.tEnd = tEnd;
        this.shelf = picks.get(0).shelf();
        this.productCode = picks.get(0).productCode();
    }
}

