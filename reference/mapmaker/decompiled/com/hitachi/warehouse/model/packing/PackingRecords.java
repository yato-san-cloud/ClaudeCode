/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.packing;

import com.hitachi.warehouse.model.packing.PackingRecord;
import com.hitachi.warehouse.model.picking.PickingRecord;
import common.ds.DateHash;
import common.util.AbstractFactory;
import common.util.DateUtil;
import java.io.File;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

public class PackingRecords {
    private List<PackingRecord> records;
    private DateHash<Map<String, List<PackingRecord>>> recsForWorkerForDate;
    private List<String> workers = null;
    private DateHash<Map<String, List<List<PackingRecord>>>> recBatchesForWorkerForDate;
    private HashMap<String, List<Date>> datesForWorker = null;
    private HashMap<String, PackingRecord> packingRecForBucketID = null;
    private HashMap<PackingRecord, List<PickingRecord>> pickingRecordsForRec = new HashMap();

    public List<PackingRecord> records() {
        return this.records;
    }

    public DateHash<Map<String, List<PackingRecord>>> recsForWorkerForDate() {
        if (this.recsForWorkerForDate == null) {
            this.recsForWorkerForDate = PackingRecord.getRecsForWorkerForDate(this.records);
        }
        return this.recsForWorkerForDate;
    }

    public List<PackingRecord> recordsFor(Date date, String worker) {
        Map<String, List<PackingRecord>> recsForWorker = this.recsForWorkerForDate().get(date);
        List<PackingRecord> recs = recsForWorker.get(worker);
        if (recs == null) {
            recs = new ArrayList<PackingRecord>();
            recsForWorker.put(worker, recs);
        }
        return recs;
    }

    public Set<Date> dates() {
        return this.recsForWorkerForDate().keySet();
    }

    public List<String> workers() {
        if (this.workers == null) {
            HashSet<String> userSet = new HashSet<String>();
            for (PackingRecord rec : this.records) {
                userSet.add(rec.workerID);
            }
            this.workers = new ArrayList<String>();
            this.workers.addAll(userSet);
            Collections.sort(this.workers);
        }
        return this.workers;
    }

    public DateHash<Map<String, List<List<PackingRecord>>>> recBatchesForWorkerForDate() {
        if (this.recBatchesForWorkerForDate == null) {
            this.recBatchesForWorkerForDate = new DateHash();
            this.recBatchesForWorkerForDate.setFactory(new AbstractFactory<Map<String, List<List<PackingRecord>>>>(){

                @Override
                public Map<String, List<List<PackingRecord>>> createNew() {
                    return new HashMap<String, List<List<PackingRecord>>>();
                }
            });
            for (Date date : this.dates()) {
                HashMap recBatchesForWorker = new HashMap();
                Map<String, List<PackingRecord>> recsForWorker = this.recsForWorkerForDate().get(date);
                for (String worker : recsForWorker.keySet()) {
                    ArrayList recBatches = new ArrayList();
                    PackingRecord prev = null;
                    ArrayList<PackingRecord> batch = new ArrayList<PackingRecord>();
                    for (PackingRecord rec : recsForWorker.get(worker)) {
                        if (!(prev == null || DateUtil.durationMins(prev.tEnd, rec.tStart) <= 30 && prev.workStation.equals(rec.workStation))) {
                            recBatches.add(batch);
                            batch = new ArrayList();
                        }
                        prev = rec;
                        batch.add(rec);
                    }
                    if (batch.size() > 0) {
                        recBatches.add(batch);
                    }
                    recBatchesForWorker.put(worker, recBatches);
                }
                this.recBatchesForWorkerForDate.put(date, recBatchesForWorker);
            }
        }
        return this.recBatchesForWorkerForDate;
    }

    public List<List<PackingRecord>> batchesFor(Date date, String worker) {
        Map<String, List<List<PackingRecord>>> recBatchesForWorker = this.recBatchesForWorkerForDate().get(date);
        List<List<PackingRecord>> recBatches = recBatchesForWorker.get(worker);
        if (recBatches == null) {
            recBatches = new ArrayList<List<PackingRecord>>();
            recBatchesForWorker.put(worker, recBatches);
        }
        return recBatches;
    }

    public Set<String> workersForDate(Date date) {
        return this.recsForWorkerForDate().get(date).keySet();
    }

    public Collection<Date> datesForWorker(String worker) {
        if (this.datesForWorker == null) {
            this.datesForWorker = new HashMap();
            for (Date date : this.recBatchesForWorkerForDate().keySet()) {
                for (String w : this.recBatchesForWorkerForDate.get(date).keySet()) {
                    List<Date> dates = this.datesForWorker.get(w);
                    if (dates == null) {
                        dates = new ArrayList<Date>();
                        this.datesForWorker.put(w, dates);
                    }
                    dates.add(date);
                }
            }
        }
        return this.datesForWorker.get(worker);
    }

    public PackingRecord recForBucketID(String bucketID) {
        if (this.packingRecForBucketID == null) {
            this.packingRecForBucketID = new HashMap();
            for (PackingRecord rec : this.records) {
                this.packingRecForBucketID.put(rec.bucketID, rec);
            }
        }
        return this.packingRecForBucketID.get(bucketID);
    }

    public List<PickingRecord> picksForRec(PackingRecord rec) {
        return this.pickingRecordsForRec.get(rec);
    }

    public void addPickingRecordsForBucketID(String bucketID, PickingRecord pick) {
        PackingRecord rec = this.recForBucketID(bucketID);
        List<PickingRecord> pickingRecs = this.pickingRecordsForRec.get(rec);
        if (pickingRecs == null) {
            pickingRecs = new ArrayList<PickingRecord>();
            this.pickingRecordsForRec.put(rec, pickingRecs);
        }
        pickingRecs.add(pick);
    }

    public PackingRecords(File baseDir) {
        this.records = PackingRecord.getRecordsFromFile(baseDir);
    }
}

