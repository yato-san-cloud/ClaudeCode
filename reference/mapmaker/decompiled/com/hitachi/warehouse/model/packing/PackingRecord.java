/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.packing;

import com.hitachi.warehouse.model.packing.BatchGroup;
import common.ds.DateHash;
import common.io.ObjectEncoder;
import common.util.AbstractFactory;
import common.util.DateUtil;
import java.io.File;
import java.io.Serializable;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class PackingRecord
implements Serializable {
    private static final long serialVersionUID = -2337805712176404310L;
    public final String bucketID;
    public final String storeName;
    public final String workStatus;
    public final int numCheckItemTypes;
    public final int numOrderedItems;
    public final int numCheckedItems;
    public final Date tStart;
    public final Date tEnd;
    public final String workerID;
    public final String workerName;
    public final String workStation;
    public final String shopName;
    public final BatchGroup batchGroup;
    public final String shootNo;
    public final int packNo;
    public final String method;

    public PackingRecord(String bucketID, String storeName, String workStatus, int numCheckItemTypes, int numOrderedItems, int numCheckedItems, Date tStart, Date tEnd, String workerID, String workerName, String workStation, BatchGroup batchGroup, String shootNo, int packNo, String method, String shopName) {
        this.bucketID = bucketID;
        this.storeName = storeName;
        this.workStatus = workStatus;
        this.numCheckItemTypes = numCheckItemTypes;
        this.numOrderedItems = numOrderedItems;
        this.numCheckedItems = numCheckedItems;
        this.tStart = tStart;
        this.tEnd = tEnd;
        this.workerID = workerID;
        this.workerName = workerName;
        this.workStation = workStation;
        this.batchGroup = batchGroup;
        this.shootNo = shootNo;
        this.packNo = packNo;
        this.method = method;
        this.shopName = shopName;
    }

    public static PackingRecord recordFrom(Map<String, String> map) {
        String bucketID = map.get("Pカート作業No");
        if (bucketID == null || bucketID.length() == 0) {
            return null;
        }
        String storeName = map.get("出荷先");
        String workStatus = map.get("作業状態");
        int numCheckItemTypes = (int)(0.5 + Double.parseDouble(map.get("検品ｱｲﾃﾑ数")));
        int numOrderedItems = (int)(0.5 + Double.parseDouble(map.get("指示総数")));
        int numCheckedItems = (int)(0.5 + Double.parseDouble(map.get("検品済数")));
        Date tStart = DateUtil.str2ExcelDateTime(map.get("検品開始日時"));
        Date tEnd = DateUtil.str2ExcelDateTime(map.get("検品終了日時"));
        String workerID = map.get("検品作業者ID");
        String workerName = map.get("検品作業者名");
        String workStation = map.get("検品端末");
        BatchGroup batchGroup = BatchGroup.batchGroupForRecordValue(map.get("バッチグループ"));
        String shootNo = map.get("シュートNo");
        String packNo_str = map.get("梱No");
        int packNo = -1;
        String method = map.get("出荷検品手段");
        String shopName = map.get("出荷先");
        if (tStart != null && tEnd != null) {
            return new PackingRecord(bucketID, storeName, workStatus, numCheckItemTypes, numOrderedItems, numCheckedItems, tStart, tEnd, workerID, workerName, workStation, batchGroup, shootNo, packNo, method, shopName);
        }
        return null;
    }

    public String toString() {
        return String.valueOf(this.bucketID) + "\t" + this.numCheckedItems + "\t" + this.tStart + "\t" + this.tEnd + "\t" + this.workerID;
    }

    public static List<PackingRecord> getRecordsFromFile(File f2) {
        return (List)ObjectEncoder.readObject(f2);
    }

    public static DateHash<Map<String, List<PackingRecord>>> getRecsForWorkerForDate(List<PackingRecord> records) {
        DateHash<Map<String, List<PackingRecord>>> recsForWorkerForDate = new DateHash<Map<String, List<PackingRecord>>>();
        recsForWorkerForDate.setFactory(new AbstractFactory<Map<String, List<PackingRecord>>>(){

            @Override
            public Map<String, List<PackingRecord>> createNew() {
                return new HashMap<String, List<PackingRecord>>();
            }
        });
        for (PackingRecord rec : records) {
            Map recsForWorker = (Map)recsForWorkerForDate.get(rec.tStart);
            ArrayList<PackingRecord> recs = (ArrayList<PackingRecord>)recsForWorker.get(rec.workerID);
            if (recs == null) {
                recs = new ArrayList<PackingRecord>();
                recsForWorker.put(rec.workerID, recs);
            }
            recs.add(rec);
        }
        boolean bad = false;
        boolean total = false;
        for (Date date : recsForWorkerForDate.keySet()) {
            Map<String, List<PackingRecord>> recsForWorker = recsForWorkerForDate.get(date);
            ArrayList<String> purged = new ArrayList<String>();
            for (String worker : recsForWorker.keySet()) {
                List<PackingRecord> recs = recsForWorker.get(worker);
                Collections.sort(recs, new Comparator<PackingRecord>(){

                    @Override
                    public int compare(PackingRecord arg0, PackingRecord arg1) {
                        return arg0.tStart.compareTo(arg1.tStart);
                    }
                });
                boolean badBatch = false;
                PackingRecord prev = null;
                for (PackingRecord rec : recs) {
                    if (prev != null && prev.tEnd.after(rec.tStart)) {
                        badBatch = true;
                        break;
                    }
                    prev = rec;
                }
                if (!badBatch) continue;
                purged.add(worker);
            }
            for (String purgeWorker : purged) {
                recsForWorker.remove(purgeWorker);
            }
        }
        return recsForWorkerForDate;
    }

    public static void main(String[] args) {
        File outDir = new File("wmsData");
        if (!outDir.exists()) {
            outDir.mkdir();
        }
        File outFile = new File(outDir, "packing.bin");
        List<PackingRecord> recs = PackingRecord.getRecordsFromFile(outFile);
        System.out.println(recs.size());
    }
}

