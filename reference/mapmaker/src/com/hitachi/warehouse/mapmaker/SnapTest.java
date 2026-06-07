package com.hitachi.warehouse.mapmaker;

import com.hitachi.warehouse.model.map.WorldMap;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.ObjectOutputStream;

/** Headless integrity test for the undo snapshot/clone approach. */
public class SnapTest {
    public static void main(String[] args) throws Exception {
        File f = new File(args[0]);
        long t0 = System.currentTimeMillis();
        WorldMapMultiFloor m = WorldMapMultiFloor.loadFrom(f);
        System.out.println("loaded: " + f.getName());
        System.out.println("  floors(before) = " + m.getWorldMapExtensionList().size());
        System.out.println("  objs(before)   = " + count(m));

        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        ObjectOutputStream out = new ObjectOutputStream(new BufferedOutputStream(bos));
        out.writeObject(m);
        out.close();
        byte[] bytes = bos.toByteArray();
        long t1 = System.currentTimeMillis();
        System.out.println("  snapshot bytes = " + bytes.length + " (" + (t1 - t0) + " ms incl. load)");

        File tmp = File.createTempFile("snap", ".rmpm");
        java.nio.file.Files.write(tmp.toPath(), bytes);
        WorldMapMultiFloor m2 = WorldMapMultiFloor.loadFrom(tmp);
        tmp.delete();
        System.out.println("  floors(after)  = " + m2.getWorldMapExtensionList().size());
        System.out.println("  objs(after)    = " + count(m2));
        System.out.println("  RESULT = " + ((count(m) == count(m2) && m.getWorldMapExtensionList().size() == m2.getWorldMapExtensionList().size()) ? "OK (clone identical)" : "MISMATCH"));
    }

    static int count(WorldMapMultiFloor m) {
        int c = 0;
        for (WorldMapExtension e : m.getWorldMapExtensionList()) {
            WorldMap wm = e.getWorldMap();
            c += wm.freeShelfObjects().size() + wm.stairsObjects().size() + wm.constrainedAreaObjects().size();
        }
        return c;
    }
}
