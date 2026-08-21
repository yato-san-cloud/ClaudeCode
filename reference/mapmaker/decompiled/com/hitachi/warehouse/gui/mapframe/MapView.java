/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.gui.mapframe;

import com.hitachi.warehouse.gui.mapframe.AbstractMapPanel;
import com.hitachi.warehouse.gui.mapframe.panels.MessagePanel;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.map.WorldMap;
import common.gui.Dragger;
import common.gui.OfflinePanel;
import common.util.MathUtil;
import java.awt.Color;
import java.awt.Font;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.Point;
import java.awt.Stroke;
import java.awt.event.MouseWheelEvent;
import java.awt.event.MouseWheelListener;
import java.awt.image.BufferedImage;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

public class MapView
extends OfflinePanel {
    private static final Font MSG_FONT = new Font("ＭＳ ゴシック", 0, 11);
    Object mapLock = new Object();
    private WorldMap map;
    MapRectAnimator animator;
    private boolean viewportInitialized = false;
    private double centerX;
    private double centerY;
    private double zoomLevel;
    private ArrayList<AbstractMapPanel> childViews = new ArrayList();
    private ArrayList<AbstractMapPanel> overlayViews = new ArrayList();
    private MessagePanel pnlMessage;
    Color bgColor = Color.WHITE;

    public WorldMap map() {
        return this.map;
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void setMap(WorldMap map) {
        Object object = this.mapLock;
        synchronized (object) {
            this.map = map;
        }
    }

    public MapView() {
        this.animator = new MapRectAnimator(this);
        this.animator.start();
        this.addMouseWheelListener(new MouseWheelListener(){

            @Override
            public void mouseWheelMoved(MouseWheelEvent arg0) {
                MapView.this.requestFocus();
                int dz = arg0.getWheelRotation();
                double dZoom = dz > 0 ? 1.05 : 0.9523809523809523;
                double newZoom = MapView.this.zoomLevel * dZoom;
                double mouseX = MapView.this.worldXForScreen(arg0.getX());
                double mouseY = MapView.this.worldYForScreen(arg0.getY());
                dZoom = -(dZoom - 1.0);
                double newCX = MapView.this.centerX + (mouseX - MapView.this.centerX) * dZoom;
                double newCY = MapView.this.centerY + (mouseY - MapView.this.centerY) * dZoom;
                MapView.this.setOrientation(newCX, newCY, newZoom, null);
            }
        });
        Dragger dragger = new Dragger();
        dragger.addListener(new Dragger.DraggerAdapter(){
            private Coord origClickedCoord;
            boolean isDragging = false;

            @Override
            public void mousedPressed(int x, int y) {
                MapView.this.requestFocus();
                this.origClickedCoord = MapView.this.coordForScreen(x, y);
            }

            @Override
            public void mouseReleased() {
                if (this.isDragging) {
                    for (AbstractMapPanel panel : MapView.this.childViews) {
                        panel.dragDone();
                    }
                    this.isDragging = false;
                }
            }

            @Override
            public void dragged(int origX, int origY, int newX, int newY) {
                this.isDragging = true;
                Coord currentCoord = MapView.this.coordForScreen(newX, newY);
                boolean allowMapDrag = true;
                for (AbstractMapPanel panel : MapView.this.childViews) {
                    if (panel.dragged(origX, origY, newX, newY)) continue;
                    allowMapDrag = false;
                }
                if (allowMapDrag) {
                    MapView.this.nudgeCenter(this.origClickedCoord.x - currentCoord.x, this.origClickedCoord.y - currentCoord.y, 200L);
                }
            }
        });
        this.addMouseListener(dragger);
        this.addMouseMotionListener(dragger);
        this.pnlMessage = new MessagePanel(MSG_FONT);
        this.overlayViews.add(this.pnlMessage);
        for (AbstractMapPanel panel : this.overlayViews) {
            panel.setMapView(this);
        }
    }

    public double centerX() {
        return this.centerX;
    }

    public double centerY() {
        return this.centerY;
    }

    public Coord center() {
        return new Coord(this.centerX, this.centerY);
    }

    public double zoomLevel() {
        return this.zoomLevel;
    }

    public Point screenPointForWorld(Coord coord) {
        return new Point(this.screenXForWorld(coord.x), this.screenYForWorld(coord.y));
    }

    public int screenXForWorld(double x) {
        return (int)((double)(this.getWidth() / 2) + (x - this.centerX) / this.zoomLevel);
    }

    public int screenYForWorld(double y) {
        return (int)((double)(this.getHeight() / 2) + (y - this.centerY) / this.zoomLevel);
    }

    public double worldXForScreen(int x) {
        return this.centerX + (double)(x - this.getWidth() / 2) * this.zoomLevel;
    }

    public double worldYForScreen(int y) {
        return this.centerY + (double)(y - this.getHeight() / 2) * this.zoomLevel;
    }

    public Coord coordForScreen(int x, int y) {
        return new Coord(this.worldXForScreen(x), this.worldYForScreen(y));
    }

    protected void forceSetOrientation(double centerX, double centerY, double zoomLevel) {
        this.centerX = centerX;
        this.centerY = centerY;
        this.zoomLevel = zoomLevel;
        this.repaint();
    }

    public void setOrientation(double centerX, double centerY, double zoomLevel) {
        this.setOrientation(centerX, centerY, zoomLevel, null);
    }

    public void setOrientation(double centerX, double centerY, double zoomLevel, Long animationDuration) {
        if (animationDuration != null && animationDuration > 0L) {
            this.animator.animateToSetting(centerX, centerY, zoomLevel, animationDuration);
        } else {
            this.animator.abortAnimation();
            this.forceSetOrientation(centerX, centerY, zoomLevel);
        }
    }

    public void showBounds(Coord tl, Coord br, double paddingRatio, double minZoom) {
        this.showBounds(tl, br, paddingRatio, minZoom, null);
    }

    public void showBounds(Coord tl, Coord br, double paddingRatio, double minZoom, Long animationDuration) {
        double zoom = Math.max((br.x - tl.x) / (double)this.getWidth(), (br.y - tl.y) / (double)this.getHeight());
        if ((zoom *= paddingRatio) < minZoom || Double.isInfinite(zoom) || Double.isNaN(zoom)) {
            zoom = minZoom;
        }
        this.setOrientation((tl.x + br.x) / 2.0, (tl.y + br.y) / 2.0, zoom, animationDuration);
    }

    public void showAllCoords(Collection<Coord> coords, double paddingRatio, double minZoom) {
        this.showAllCoords(coords, paddingRatio, minZoom, null);
    }

    public void showAllCoords(Collection<Coord> coords, double paddingRatio, double minZoom, Long animationDuration) {
        boolean first = true;
        double left = 0.0;
        double right = 0.0;
        double top = 0.0;
        double bot = 0.0;
        for (Coord coord : coords) {
            if (first) {
                left = right = coord.x;
                top = bot = coord.y;
                first = false;
            }
            left = Math.min(left, coord.x);
            right = Math.max(right, coord.x);
            top = Math.min(top, coord.y);
            bot = Math.max(bot, coord.y);
        }
        if (!first) {
            this.showBounds(new Coord(left, top), new Coord(right, bot), paddingRatio, minZoom, animationDuration);
        }
    }

    public void nudgeCenter(double dx, double dy) {
        this.nudgeCenter(dx, dy, null);
    }

    public void nudgeCenter(double dx, double dy, Long animationDuration) {
        this.setOrientation(this.centerX + dx, this.centerY + dy, this.zoomLevel, animationDuration);
    }

    public void setCenter(Coord coord) {
        this.setCenter(coord, null);
    }

    public void setCenter(Coord coord, Long animationDuration) {
        this.setOrientation(coord.x, coord.y, this.zoomLevel, animationDuration);
    }

    public void initializeZoomLevel() {
        double horizZoomLevel = (this.map.br().x - this.map.tl().x) / (double)this.getWidth();
        double vertZoomLevel = (this.map.br().y - this.map.tl().y) / (double)this.getHeight();
        this.zoomLevel = Math.max(horizZoomLevel, vertZoomLevel);
    }

    public void showRect(Coord tl, Coord br) {
        this.showRect(tl, br, null);
    }

    public void showRect(Coord tl, Coord br, Long animationDuration) {
        double horiz_zoomLevel = (br.x - tl.x) / (double)this.getWidth();
        double vert_zoomLevel = (br.y - tl.y) / (double)this.getHeight();
        this.setOrientation((br.x + tl.x) / 2.0, (br.y + tl.y) / 2.0, Math.max(horiz_zoomLevel, vert_zoomLevel), animationDuration);
    }

    protected void initializeViewportIfNotInitialized(WorldMap map) {
        if (!this.viewportInitialized) {
            this.centerX = (map.br().x + map.tl().x) / 2.0;
            this.centerY = (map.br().y + map.tl().y) / 2.0;
            double horizZoomLevel = (map.br().x - map.tl().x) / (double)this.getWidth();
            double vertZoomLevel = (map.br().y - map.tl().y) / (double)this.getHeight();
            this.zoomLevel = Math.max(horizZoomLevel, vertZoomLevel);
            this.viewportInitialized = true;
        }
    }

    public List<AbstractMapPanel> childViews() {
        return this.childViews;
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void openChildView(AbstractMapPanel view) {
        view.setMapView(this);
        ArrayList<AbstractMapPanel> arrayList = this.childViews;
        synchronized (arrayList) {
            this.childViews.add(view);
        }
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void closeChildview(AbstractMapPanel view) {
        view.removedFromMapView(this);
        ArrayList<AbstractMapPanel> arrayList = this.childViews;
        synchronized (arrayList) {
            this.childViews.remove(view);
        }
    }

    public void setMessage(String message) {
        this.pnlMessage.setMessage(message);
    }

    public void setBGColor(Color color) {
        this.bgColor = color;
        this.repaint();
    }

    /*
     * WARNING - Removed try catching itself - possible behaviour change.
     */
    public void internPaint(Graphics _g) {
        Object object = this.mapLock;
        synchronized (object) {
            if (this.map != null) {
                this.initializeViewportIfNotInitialized(this.map);
                Graphics2D g = (Graphics2D)_g;
                if (this.bgColor != null) {
                    g.setColor(this.bgColor);
                    g.fillRect(0, 0, this.getWidth(), this.getHeight());
                }
                Color origColor = g.getColor();
                Stroke origStroke = g.getStroke();
                ArrayList<AbstractMapPanel> arrayList = this.childViews;
                synchronized (arrayList) {
                    for (AbstractMapPanel view : this.childViews) {
                        g.setColor(origColor);
                        g.setStroke(origStroke);
                        view.draw(g);
                    }
                }
                arrayList = this.overlayViews;
                synchronized (arrayList) {
                    for (AbstractMapPanel view : this.overlayViews) {
                        g.setColor(origColor);
                        g.setStroke(origStroke);
                        view.draw(g);
                    }
                }
            }
            Graphics2D g = (Graphics2D)_g;
            g.setColor(this.bgColor);
            g.fillRect(0, 0, this.getWidth(), this.getHeight());
        }
    }

    public BufferedImage getImage() {
        BufferedImage img = new BufferedImage(this.getWidth(), this.getHeight(), 5);
        this.paint(img.getGraphics());
        return img;
    }

    @Override
    public void paint(Graphics _g) {
        Graphics2D gMap = (Graphics2D)_g;
        int width = this.getWidth();
        int height = this.getHeight();
        this.internPaint(gMap);
    }

    public void inputClear() {
    }

    public static class MapRectAnimator
    extends Thread {
        MapView parentView;
        boolean runLoop = false;
        double volatility = 100.0;
        double logVolatility = Math.log(this.volatility + 1.0);
        Object animationLock = new Object();
        boolean doAnimation = false;
        private double p = 0.0;
        private double origCenterX;
        private double origCenterY;
        private double origZoom;
        private double tgtCenterX;
        private double tgtCenterY;
        private double tgtZoom;
        private long tStart;
        private long tEnd;

        public MapRectAnimator(MapView parentView) {
            this.parentView = parentView;
        }

        /*
         * WARNING - Removed try catching itself - possible behaviour change.
         */
        @Override
        public void run() {
            this.runLoop = true;
            System.out.println("start animator");
            try {
                while (this.runLoop) {
                    Object object = this.animationLock;
                    synchronized (object) {
                        if (this.doAnimation) {
                            this.p += (1.0 - this.p) * 0.2;
                            double x = MathUtil.map(this.p, 0.0, 1.0, this.origCenterX, this.tgtCenterX);
                            double y = MathUtil.map(this.p, 0.0, 1.0, this.origCenterY, this.tgtCenterY);
                            double zoom = MathUtil.map(this.p, 0.0, 1.0, this.origZoom, this.tgtZoom);
                            this.parentView.forceSetOrientation(x, y, zoom);
                            if (this.p >= 0.999999) {
                                this.doAnimation = false;
                                this.parentView.forceSetOrientation(this.tgtCenterX, this.tgtCenterY, this.tgtZoom);
                            }
                        } else {
                            this.animationLock.wait();
                        }
                    }
                    Thread.sleep(30L);
                }
            }
            catch (InterruptedException interruptedException) {
                // empty catch block
            }
            System.out.println("finish animator");
        }

        /*
         * WARNING - Removed try catching itself - possible behaviour change.
         */
        public void animateToSetting(double centerX, double centerY, double zoom, long duration) {
            Object object = this.animationLock;
            synchronized (object) {
                this.p = 0.0;
                this.origCenterX = this.parentView.centerX;
                this.origCenterY = this.parentView.centerY;
                this.origZoom = this.parentView.zoomLevel;
                this.tgtCenterX = centerX;
                this.tgtCenterY = centerY;
                this.tgtZoom = zoom;
                this.doAnimation = true;
                this.tStart = System.currentTimeMillis();
                this.tEnd = this.tStart + duration;
                this.animationLock.notifyAll();
            }
        }

        /*
         * WARNING - Removed try catching itself - possible behaviour change.
         */
        public void abortAnimation() {
            if (this.doAnimation) {
                Object object = this.animationLock;
                synchronized (object) {
                    this.doAnimation = false;
                }
            }
        }

        /*
         * WARNING - Removed try catching itself - possible behaviour change.
         */
        public void kill() {
            this.runLoop = false;
            Object object = this.animationLock;
            synchronized (object) {
                this.animationLock.notifyAll();
            }
        }
    }
}

