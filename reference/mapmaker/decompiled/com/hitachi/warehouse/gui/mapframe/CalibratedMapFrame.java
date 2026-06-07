/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.gui.mapframe;

import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.gui.mapframe.panels.WorldMapPanel;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.map.WorldMap;
import common.gui.CalibratedPanel;
import common.gui.Calibration;
import common.gui.FullScreenFrame;
import java.awt.BorderLayout;
import java.awt.event.KeyEvent;
import java.awt.event.KeyListener;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.io.File;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

public class CalibratedMapFrame
extends FullScreenFrame {
    private Object mapLock = new Object();
    private WorldMap map;
    public final MapView mapView;
    public final CalibratedPanel pnlMain;
    transient List<MapFrameListener> listeners = new ArrayList<MapFrameListener>();

    public CalibratedMapFrame(Calibration calibration, int drawWidth, int drawHeight, int screen) {
        super(screen);
        this.pnlMain = new CalibratedPanel(calibration, drawWidth, drawHeight);
        this.pnlMain.setLayout(new BorderLayout());
        this.mapView = new MapView();
        this.pnlMain.setSubPanel(this.mapView);
        this.add(this.pnlMain);
        this.setVisible(true);
        this.addWindowListener(new WindowAdapter(){

            @Override
            public void windowClosing(WindowEvent arg0) {
                CalibratedMapFrame.this.quit();
            }
        });
        this.pnlMain.requestFocus();
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void setMap(WorldMap map) {
        Object object = this.mapLock;
        synchronized (object) {
            this.map = map;
        }
        this.mapView.setMap(map);
        this.repaint();
    }

    public void quit() {
        if (this.requestQuit()) {
            System.exit(0);
        }
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void addListener(MapFrameListener listener) {
        List<MapFrameListener> list = this.listeners;
        synchronized (list) {
            this.listeners.add(listener);
        }
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     * Enabled aggressive block sorting
     * Enabled unnecessary exception pruning
     * Enabled aggressive exception aggregation
     */
    public boolean requestQuit() {
        List<MapFrameListener> list = this.listeners;
        synchronized (list) {
            MapFrameListener listener;
            Iterator<MapFrameListener> iterator = this.listeners.iterator();
            do {
                if (iterator.hasNext()) continue;
                return true;
            } while ((listener = iterator.next()).allowQuit());
            return false;
        }
    }

    public static void main(String[] args) {
        Calibration calibration = Calibration.calibrationFrom(new File("calibration.info"));
        WorldMap map = WorldMap.loadFrom(new File("../WarehouseAnalysis/data/kawajima_data/map.rmp"));
        final Coord tl = new Coord(-43971.22223205074, -31873.939084377584);
        final Coord br = new Coord(-12611.476881707193, 27049.24859131199);
        int drawWidth = 960;
        int drawHeight = (int)((double)drawWidth / (br.x - tl.x) * (br.y - tl.y));
        CalibratedMapFrame frame = new CalibratedMapFrame(calibration, drawWidth, drawHeight, 0);
        frame.setMap(map);
        frame.mapView.openChildView(new WorldMapPanel().setShowBackgroundImage(true).setShowBeacons(false).setShowNetworks(false).setShowShelfWaypoints(false));
        frame.pnlMain.addKeyListener(new KeyListener(){

            @Override
            public void keyTyped(KeyEvent e) {
                System.out.println(e);
            }

            @Override
            public void keyReleased(KeyEvent e) {
                System.out.println(e);
            }

            @Override
            public void keyPressed(KeyEvent e) {
                System.out.println(e);
            }
        });
        frame.pnlMain.requestFocus();
        System.out.println("here");
        frame.addWindowListener(new WindowAdapter(){

            @Override
            public void windowOpened(WindowEvent e) {
                CalibratedMapFrame.this.mapView.showRect(tl, br);
            }
        });
    }

    public static interface MapFrameListener {
        public boolean allowQuit();
    }
}

