/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.gui.mapframe;

import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.gui.mapframe.panels.WorldMapPanel;
import com.hitachi.warehouse.model.map.WorldMap;
import common.util.ClipboardUtil;
import java.awt.BorderLayout;
import java.awt.Component;
import java.awt.Dimension;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.awt.image.BufferedImage;
import java.io.File;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import javax.swing.JFrame;
import javax.swing.JMenu;
import javax.swing.JMenuBar;
import javax.swing.JMenuItem;
import javax.swing.JPanel;
import javax.swing.KeyStroke;

public class MapFrame
extends JFrame {
    public final MapView mapView;
    public final JPanel pnlMain;
    public final JMenuBar menuBar;
    private Map<String, JMenu> menuForName = new HashMap<String, JMenu>();
    transient List<MapFrameListener> listeners = new ArrayList<MapFrameListener>();

    public JMenu menuForName(String name) {
        return this.menuForName.get(name);
    }

    public MapFrame(WorldMap map) {
        this();
        this.setMap(map);
    }

    public MapFrame(WorldMap map, int width, int height) {
        this(width, height);
        this.setMap(map);
    }

    public MapFrame() {
        this(900, 600);
    }

    public MapFrame(int width, int height) {
        this.pnlMain = new JPanel();
        this.pnlMain.setLayout(new BorderLayout());
        this.mapView = new MapView();
        this.pnlMain.add((Component)this.mapView, "Center");
        this.add(this.pnlMain);
        this.menuBar = new JMenuBar();
        JMenu menuFile = new JMenu("File");
        JMenuItem itemScreenshot = new JMenuItem("Capture Image to Clipboard");
        itemScreenshot.setAccelerator(KeyStroke.getKeyStroke(67, 128));
        menuFile.add(itemScreenshot).addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                BufferedImage img = MapFrame.this.mapView.getImage();
                ClipboardUtil.copy(img);
                System.out.println("saved to clipboard...");
            }
        });
        JMenuItem itemQuit = new JMenuItem("Quit");
        itemQuit.setAccelerator(KeyStroke.getKeyStroke(81, 128));
        menuFile.add(itemQuit).addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                MapFrame.this.quit();
            }
        });
        this.menuBar.add(menuFile);
        Component[] componentArray = this.menuBar.getComponents();
        int n = componentArray.length;
        int n2 = 0;
        while (n2 < n) {
            Component comp = componentArray[n2];
            if (JMenu.class.isInstance(comp)) {
                JMenu menu = (JMenu)comp;
                this.menuForName.put(menu.getText(), (JMenu)comp);
            }
            ++n2;
        }
        this.setJMenuBar(this.menuBar);
        this.menuBar.setFocusable(false);
        this.setDefaultCloseOperation(0);
        this.pnlMain.setPreferredSize(new Dimension(width, height));
        this.pack();
        this.setVisible(true);
        this.addWindowListener(new WindowAdapter(){

            @Override
            public void windowClosing(WindowEvent arg0) {
                MapFrame.this.quit();
            }
        });
    }

    public void setMap(WorldMap map) {
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
        WorldMap map = WorldMap.loadFrom(new File("../WarehouseAnalysis/data/kawajima_data/map.rmp"));
        MapFrame frame = new MapFrame(map);
        frame.mapView.openChildView(new WorldMapPanel().setShowBackgroundImage(true).setShowBeacons(false).setShowNetworks(false).setShowShelfWaypoints(false));
    }

    public static interface MapFrameListener {
        public boolean allowQuit();
    }
}

