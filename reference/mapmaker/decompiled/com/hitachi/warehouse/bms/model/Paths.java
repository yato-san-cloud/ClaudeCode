/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.bms.model;

import com.hitachi.warehouse.bms.model.Path;
import com.hitachi.warehouse.bms.model.PositionRecord;
import com.hitachi.warehouse.model.common.Coord;
import common.ds.DateHash;
import common.io.ObjectEncoder;
import common.util.DateUtil;
import java.io.File;
import java.io.IOException;
import java.io.ObjectInputStream;
import java.io.Serializable;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class Paths
implements Serializable {
    private static final long serialVersionUID = -7196059316432497084L;
    private final List<Path> paths = new ArrayList<Path>();
    private Date minT;
    private Date maxT;
    private transient Object lock = new Object();
    private Path prevFoundPath = null;

    public Date minT() {
        return this.minT;
    }

    public Date maxT() {
        return this.maxT;
    }

    public int numPaths() {
        return this.paths.size();
    }

    public void addPath(Path path) {
        this.paths.add(path);
        if (this.minT == null || this.minT.after(path.minTime)) {
            this.minT = path.minTime;
        }
        if (this.maxT == null || this.maxT.before(path.maxTime)) {
            this.maxT = path.maxTime;
        }
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public Path pathForTime(Date t2) {
        Path _prevFoundPath = this.prevFoundPath;
        if (_prevFoundPath != null && _prevFoundPath.contains(t2)) {
            return _prevFoundPath;
        }
        if (this.paths.size() == 0) {
            return null;
        }
        Object object = this.lock;
        synchronized (object) {
            int left = 0;
            int right = this.paths.size();
            int mid = (left + right) / 2;
            Path midPath = this.paths.get(mid);
            while (right - left > 1) {
                if (midPath.contains(t2)) break;
                if (midPath.minTime.after(t2)) {
                    right = mid;
                } else if (midPath.maxTime.before(t2)) {
                    left = mid;
                }
                mid = (left + right) / 2;
                midPath = this.paths.get(mid);
            }
            if (midPath.contains(t2)) {
                this.prevFoundPath = midPath;
                return midPath;
            }
            return null;
        }
    }

    public PositionRecord recordAtT(Date t2) {
        Path path = this.pathForTime(t2);
        if (path != null) {
            return path.recordAtT(t2);
        }
        return null;
    }

    public Coord coordAt(Date t2) {
        Path path = this.pathForTime(t2);
        if (path != null) {
            return path.coordAt(t2);
        }
        return null;
    }

    public Double rotAt(Date t2) {
        Path path = this.pathForTime(t2);
        if (path != null) {
            return path.rotAt(t2);
        }
        return null;
    }

    public List<Path> paths() {
        return this.paths;
    }

    private void readObject(ObjectInputStream in) throws IOException, ClassNotFoundException {
        in.defaultReadObject();
        this.lock = new Object();
    }

    public static Paths getPathsFromFile(File binFile) {
        Paths paths = new Paths();
        for (PositionRecord[] recs : (List)ObjectEncoder.readObject(binFile)) {
            paths.addPath(new Path(recs));
        }
        return paths;
    }

    public static DateHash<File> getDirForDates(File baseDir) {
        DateHash<File> fileForDate = new DateHash<File>();
        File[] fileArray = baseDir.listFiles();
        int n = fileArray.length;
        int n2 = 0;
        while (n2 < n) {
            File dir = fileArray[n2];
            Date date = DateUtil.str2FlatDate(dir.getName());
            if (date != null) {
                fileForDate.put(date, dir);
            }
            ++n2;
        }
        return fileForDate;
    }

    public static Map<String, File> getFileForUsers(File dateDir) {
        HashMap<String, File> filesForUsers = new HashMap<String, File>();
        if (dateDir != null && dateDir.exists()) {
            File[] fileArray = dateDir.listFiles();
            int n = fileArray.length;
            int n2 = 0;
            while (n2 < n) {
                File f2 = fileArray[n2];
                if (f2.getName().endsWith("bin")) {
                    filesForUsers.put(f2.getName().split("\\.")[0], f2);
                }
                ++n2;
            }
        }
        return filesForUsers;
    }

    public static Paths loadPathsForUserDate(File baseDir, String user, Date date) {
        File userFile;
        File dateDir = new File(baseDir, DateUtil.flatDate2Str(date));
        if (dateDir.exists() && (userFile = new File(dateDir, String.valueOf(user) + ".bin")).exists()) {
            return Paths.getPathsFromFile(userFile);
        }
        return null;
    }
}

