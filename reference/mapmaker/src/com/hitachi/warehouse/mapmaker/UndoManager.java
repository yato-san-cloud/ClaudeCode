package com.hitachi.warehouse.mapmaker;

import com.hitachi.warehouse.model.map.WorldMap;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.ObjectOutputStream;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Deque;
import javax.swing.Timer;

/**
 * Snapshot-based undo/redo for MapMaker (custom add-on).
 *
 * The original MapMaker has no undo mechanism at all. This adds one without
 * refactoring every edit into a command: on each settled burst of edits it
 * serializes the whole WorldMapMultiFloor (same bytes the app's own save uses)
 * and on undo/redo restores a snapshot through the app's own loadFrom path.
 */
public class UndoManager {
    private final MapMaker maker;
    private final Deque<byte[]> undo = new ArrayDeque<byte[]>();
    private final Deque<byte[]> redo = new ArrayDeque<byte[]>();
    private byte[] committed;
    private boolean restoring = false;
    private static final int LIMIT = 25;
    private final Timer debounce;

    public UndoManager(MapMaker maker) {
        this.maker = maker;
        this.debounce = new Timer(500, new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                UndoManager.this.commitBurst();
            }
        });
        this.debounce.setRepeats(false);
        this.reset();
    }

    /** Capture the current state as the new baseline and clear history. Call after load/new. */
    public void reset() {
        this.undo.clear();
        this.redo.clear();
        this.committed = this.snapshot();
        this.report("reset");
    }

    /** Called from MapMaker.mapChanged on every model edit. Debounced so one gesture = one step. */
    public void onMapChanged() {
        if (this.restoring) {
            return;
        }
        this.debounce.restart();
    }

    private void commitBurst() {
        if (this.restoring) {
            return;
        }
        byte[] now = this.snapshot();
        if (now == null) {
            return;
        }
        if (this.committed == null) {
            this.committed = now;
            return;
        }
        if (Arrays.equals(now, this.committed)) {
            return;
        }
        this.undo.push(this.committed);
        while (this.undo.size() > LIMIT) {
            this.undo.removeLast();
        }
        this.redo.clear();
        this.committed = now;
        this.report("record");
    }

    public void undo() {
        if (this.debounce.isRunning()) {
            this.debounce.stop();
            this.commitBurst();
        }
        if (this.undo.isEmpty()) {
            this.message("これ以上戻せません");
            return;
        }
        this.redo.push(this.committed);
        this.committed = this.undo.pop();
        this.apply(this.committed);
        this.message("元に戻しました（残り " + this.undo.size() + "）");
    }

    public void redo() {
        if (this.redo.isEmpty()) {
            this.message("やり直す操作はありません");
            return;
        }
        this.undo.push(this.committed);
        this.committed = this.redo.pop();
        this.apply(this.committed);
        this.message("やり直しました");
    }

    private byte[] snapshot() {
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            ObjectOutputStream out = new ObjectOutputStream(new BufferedOutputStream(bos));
            out.writeObject(this.maker.worldMapMultiFloor);
            out.close();
            return bos.toByteArray();
        } catch (Throwable t) {
            t.printStackTrace();
            return null;
        }
    }

    private void apply(byte[] bytes) {
        if (bytes == null) {
            return;
        }
        this.restoring = true;
        try {
            File tmp = File.createTempFile("mm_undo", ".rmpm");
            java.nio.file.Files.write(tmp.toPath(), bytes);
            WorldMapMultiFloor restored = WorldMapMultiFloor.loadFrom(tmp);
            tmp.delete();
            if (restored == null) {
                return;
            }
            int idx = this.maker.floorToolBar.getCurrentFloorTabIndex();
            this.maker.floorToolBar.clear();
            for (WorldMapExtension ext : restored.getWorldMapExtensionList()) {
                FloorTab nt = this.maker.floorToolBar.getNewFloorTab();
                nt.setFloorName(ext.getName());
                this.maker.floorToolBar.addAfterTabOnly(nt);
                ext.getWorldMap().setCartGraph(null);
                nt.getNetworkCalculatorManagerInfo().setNetworkCalculatorManagerInfo(true, null, null, false);
            }
            this.maker.worldMapMultiFloor = restored;
            if (idx < 0 || idx >= restored.getWorldMapExtensionList().size()) {
                idx = 0;
            }
            this.maker.floorToolBar.setCurrentFloorTabIndex(idx);
            WorldMapExtension cur = restored.getWorldMapExtension(idx);
            this.maker.setMap(cur.getWorldMap(), false);
            this.maker.mapFrame.mapView.setOrientation(cur.getCenterX(), cur.getCenterY(), cur.getZoomLevel());
            this.maker.mapFrame.repaint();
        } catch (Throwable t) {
            t.printStackTrace();
        } finally {
            this.restoring = false;
        }
    }

    private void message(String s) {
        try {
            this.maker.mapFrame.mapView.setMessage(s);
        } catch (Throwable t) {
            // status message is best-effort
        }
        this.report("ui");
    }

    private void report(String tag) {
        System.out.println("[undo:" + tag + "] undo=" + this.undo.size() + " redo=" + this.redo.size());
    }
}
