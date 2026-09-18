/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.picking;

import com.hitachi.warehouse.model.picking.PickingBatch;
import com.hitachi.warehouse.model.picking.PickingRecord;
import com.hitachi.warehouse.model.picking.shelffactory.AbstractShelfFactory;
import common.ds.DateHash;
import common.ds.SerialIterable;
import common.util.CSVReader;
import common.util.DateUtil;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.ObjectInputStream;
import java.io.ObjectOutputStream;
import java.io.Serializable;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

public class Session
implements Serializable,
Comparable<Session> {
    private static final long serialVersionUID = -4480469582363137667L;
    public final String sessionID;
    public final String workerID;
    public final String trollyNo;
    public final int numRest;
    public final int timeRest_sec;
    private List<PickingRecord> pickingRecords = new ArrayList<PickingRecord>();
    private transient HashMap<String, List<PickingRecord>> recsForBucketID = null;

    public Session(Map<String, String> map) {
        this.sessionID = map.get("指示No");
        this.workerID = map.get("作業者No");
        this.trollyNo = map.get("台車No");
        this.numRest = Integer.parseInt(map.get("休憩回数"));
        this.timeRest_sec = Integer.parseInt(map.get("休憩時間"));
    }

    public void finalize() {
        Collections.sort(this.pickingRecords);
    }

    public List<PickingRecord> pickingRecords() {
        return this.pickingRecords;
    }

    public void addPickingRecord(PickingRecord record) {
        this.pickingRecords.add(record);
    }

    public List<List<PickingRecord>> pickingRecordBatches() {
        ArrayList<List<PickingRecord>> batches = new ArrayList<List<PickingRecord>>();
        PickingRecord prevRec = null;
        ArrayList<PickingRecord> currentBatch = null;
        for (PickingRecord rec : this.pickingRecords()) {
            int durRec = DateUtil.durationSeconds(rec.tStart(), rec.tEnd());
            if (durRec <= 0) continue;
            if (prevRec == null || !prevRec.tStart().equals(rec.tStart())) {
                if (currentBatch != null) {
                    batches.add(currentBatch);
                }
                currentBatch = new ArrayList<PickingRecord>();
            }
            currentBatch.add(rec);
            prevRec = rec;
        }
        if (currentBatch != null) {
            batches.add(currentBatch);
        }
        return batches;
    }

    public List<List<PickingRecord>> pikingRecordBatches_sameShelf() {
        ArrayList<List<PickingRecord>> batches = new ArrayList<List<PickingRecord>>();
        PickingRecord prevRec = null;
        ArrayList<PickingRecord> currentBatch = null;
        for (PickingRecord rec : this.pickingRecords()) {
            int durRec = DateUtil.durationSeconds(rec.tStart(), rec.tEnd());
            if (durRec <= 0) continue;
            if (prevRec == null || !prevRec.shelf().shelfArea.equals(rec.shelf().shelfArea)) {
                if (currentBatch != null) {
                    batches.add(currentBatch);
                }
                currentBatch = new ArrayList<PickingRecord>();
            }
            currentBatch.add(rec);
            prevRec = rec;
        }
        if (currentBatch != null) {
            batches.add(currentBatch);
        }
        return batches;
    }

    /*
     * WARNING - void declaration
     */
    public List<PickingBatch> pickingRecordBatches_sameShelf() {
        void var3_4;
        ArrayList<void> picks = new ArrayList<void>();
        PickingRecord prevRec = null;
        Object var3_3 = null;
        for (PickingRecord rec : this.pickingRecords()) {
            int durRec = DateUtil.durationSeconds(rec.tStart(), rec.tEnd());
            if (durRec <= 0) continue;
            if (prevRec == null || !prevRec.shelf().shelfArea.equals(rec.shelf().shelfArea)) {
                if (var3_4 != null) {
                    picks.add(var3_4);
                }
                ArrayList arrayList = new ArrayList();
            }
            var3_4.add(rec);
            prevRec = rec;
        }
        if (var3_4 != null) {
            picks.add(var3_4);
        }
        ArrayList<PickingBatch> batches = new ArrayList<PickingBatch>();
        for (List list : picks) {
            batches.add(new PickingBatch(list));
        }
        return batches;
    }

    public Date tStart() {
        return this.pickingRecords.get(0).tStart();
    }

    public Date tEnd() {
        return this.pickingRecords.get(this.pickingRecords.size() - 1).tEnd();
    }

    public boolean haveUnpickedItems() {
        for (PickingRecord pick : this.pickingRecords) {
            if (!pick.hasUnPickedItems()) continue;
            return true;
        }
        return false;
    }

    public double workDuration_min() {
        return (double)(DateUtil.durationSeconds(this.tStart(), this.tEnd()) - this.timeRest_sec) / 60.0;
    }

    public int numRecords() {
        return this.pickingRecords.size();
    }

    public int numLots() {
        int numLots = 0;
        PickingRecord prev = null;
        for (PickingRecord record : this.pickingRecords()) {
            if (prev == null) {
                ++numLots;
            } else if (!prev.shelf().equals(record.shelf())) {
                ++numLots;
            }
            prev = record;
        }
        return numLots;
    }

    public int numProducts() {
        int numProducts = 0;
        for (PickingRecord record : this.pickingRecords()) {
            numProducts += record.numCollectedBoxes() + record.numCollectedProducts();
        }
        return numProducts;
    }

    public static List<Session> sessionsFromCSVs(File baseDir, AbstractShelfFactory shelfFactory) {
        ArrayList<Session> sessions = new ArrayList<Session>();
        File[] fileArray = baseDir.listFiles();
        int n = fileArray.length;
        int n2 = 0;
        while (n2 < n) {
            File f2 = fileArray[n2];
            if (f2.getName().startsWith("shrinked")) {
                System.out.println(f2 + "\t" + sessions.size());
                sessions.addAll(Session.sessionsFromCSV(f2, shelfFactory));
                System.gc();
            }
            ++n2;
        }
        return sessions;
    }

    public static List<Session> sessionsFromCSV(File f2, AbstractShelfFactory shelfFactory) {
        ArrayList<Session> sessions = new ArrayList<Session>();
        HashMap<String, Session> sessionForID = new HashMap<String, Session>();
        try {
            CSVReader reader = new CSVReader(f2, true, ",", "Windows-31J");
            for (Map<String, String> vals : reader.readAsKVMap()) {
                String sessionID = vals.get("指示No");
                Session session = (Session)sessionForID.get(sessionID);
                if (session == null) {
                    session = new Session(vals);
                    sessionForID.put(sessionID, session);
                    sessions.add(session);
                }
                PickingRecord record = new PickingRecord(session, vals, shelfFactory);
                session.addPickingRecord(record);
            }
        }
        catch (Exception e) {
            System.err.println(f2);
            e.printStackTrace();
        }
        for (Session session : sessions) {
            session.finalize();
        }
        return sessions;
    }

    public static void exportToFile(List<Session> sessions, File outFile) {
        try {
            ObjectOutputStream out = new ObjectOutputStream(new BufferedOutputStream(new FileOutputStream(outFile)));
            out.writeObject(sessions);
            out.close();
        }
        catch (Exception e) {
            e.printStackTrace();
        }
    }

    @Override
    public int compareTo(Session o) {
        return this.tStart().compareTo(o.tStart());
    }

    public Map<String, List<PickingRecord>> recsForBucketID() {
        if (this.recsForBucketID == null) {
            this.recsForBucketID = new HashMap();
            for (PickingRecord rec : this.pickingRecords) {
                String bucketID = String.valueOf(rec.session().sessionID) + "-" + rec.bucketNo();
                List<PickingRecord> recs = this.recsForBucketID.get(bucketID);
                if (recs == null) {
                    recs = new ArrayList<PickingRecord>();
                    this.recsForBucketID.put(bucketID, recs);
                }
                recs.add(rec);
            }
        }
        return this.recsForBucketID;
    }

    public List<PickingRecord> recsForBucketID(String bucketID) {
        return this.recsForBucketID().get(bucketID);
    }

    public static Map<String, List<PickingRecord>> recsForBucketID(List<Session> sessions) {
        if (sessions == null) {
            return new HashMap<String, List<PickingRecord>>();
        }
        HashMap<String, List<PickingRecord>> recsForBucketID = new HashMap<String, List<PickingRecord>>();
        for (Session session : sessions) {
            recsForBucketID.putAll(session.recsForBucketID());
        }
        return recsForBucketID;
    }

    public static List<Session> sessionsFromFile(File f2) {
        try {
            if (f2 == null || !f2.exists()) {
                return new ArrayList<Session>();
            }
            ObjectInputStream in = new ObjectInputStream(new BufferedInputStream(new FileInputStream(f2)));
            List sessions = (List)in.readObject();
            in.close();
            return sessions;
        }
        catch (Exception e) {
            System.err.println(f2);
            e.printStackTrace();
            return new ArrayList<Session>();
        }
    }

    public static Iterable<Session> sessionsFromWMSRepository(File baseDir) {
        SerialIterable<Session> sessionIterable = new SerialIterable<Session>(new Iterable[0]);
        File[] fileArray = baseDir.listFiles();
        int n = fileArray.length;
        int n2 = 0;
        while (n2 < n) {
            final File f2 = fileArray[n2];
            if (f2.getName().endsWith("bin")) {
                sessionIterable.addIterable(new Iterable<Session>(){

                    @Override
                    public Iterator<Session> iterator() {
                        return Session.sessionsFromFile(f2).iterator();
                    }
                });
            }
            ++n2;
        }
        return sessionIterable;
    }

    public static List<Session> sessionsForDate(File wmsRepository, Date date) {
        return Session.sessionsFromFile(new File(wmsRepository, String.valueOf(DateUtil.flatDate2Str(date)) + ".bin"));
    }

    public static DateHash<File> filesForDate(File wmsRepoFile) {
        DateHash<File> fs = new DateHash<File>();
        File[] fileArray = wmsRepoFile.listFiles();
        int n = fileArray.length;
        int n2 = 0;
        while (n2 < n) {
            File f2 = fileArray[n2];
            if (f2.getName().endsWith("bin")) {
                Date date = DateUtil.str2FlatDate(f2.getName().split("[_\\.]")[0]);
                fs.put(date, f2);
            }
            ++n2;
        }
        return fs;
    }

    public static Map<String, List<Session>> sessionsForWorkersForDate(File wmsRepository, Date date) {
        HashMap<String, List<Session>> sessionsForWorker = new HashMap<String, List<Session>>();
        List<Session> allSessions = Session.sessionsForDate(wmsRepository, date);
        if (allSessions != null) {
            for (Session session : allSessions) {
                List<Session> sessions = sessionsForWorker.get(session.workerID);
                if (sessions == null) {
                    sessions = new ArrayList<Session>();
                    sessionsForWorker.put(session.workerID, sessions);
                }
                sessions.add(session);
            }
        }
        return sessionsForWorker;
    }
}

