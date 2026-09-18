/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.gui.mapframe.panels;

import com.hitachi.warehouse.gui.mapframe.AbstractMapPanel;
import com.hitachi.warehouse.gui.mapframe.MapView;
import common.gui.Draw;
import common.util.ColorUtil;
import common.util.MathUtil;
import java.awt.Color;
import java.awt.Font;
import java.awt.Graphics2D;

public class MessagePanel
extends AbstractMapPanel {
    MessageAnimator animator;
    Font font = new Font("Arial", 0, 12);

    @Override
    protected void mapViewSet(MapView mapView) {
        this.animator = new MessageAnimator(this);
        this.animator.start();
    }

    public void setMessage(String message) {
        this.animator.setMessage(message);
    }

    public MessagePanel(Font font) {
        this.font = font;
    }

    @Override
    public void draw(Graphics2D g) {
        String message = this.animator.message;
        double alpha = this.animator.alpha();
        if (message != null && alpha > 0.0) {
            g.setFont(this.font);
            g.setColor(ColorUtil.setAlpha(Color.red, alpha));
            Draw.drawString(g, message, 5, 5);
        }
    }

    public static class MessageAnimator
    extends Thread {
        private String message;
        private long tStartFade;
        private long tEndFade;
        private double alpha = 0.0;
        MessagePanel panel;
        boolean run = false;
        Object waitLock = new Object();

        public String message() {
            return this.message;
        }

        public double alpha() {
            return this.alpha;
        }

        public MessageAnimator(MessagePanel panel) {
            this.panel = panel;
        }

        /*
         * WARNING - Removed try catching itself - possible behaviour change.
         */
        public void setMessage(String message) {
            Object object = this.waitLock;
            synchronized (object) {
                this.message = message;
                this.tStartFade = System.currentTimeMillis() + 3000L;
                this.tEndFade = this.tStartFade + 500L;
                this.waitLock.notifyAll();
            }
        }

        /*
         * WARNING - Removed try catching itself - possible behaviour change.
         */
        @Override
        public void run() {
            this.run = true;
            while (this.run) {
                Object object = this.waitLock;
                synchronized (object) {
                    if (this.message != null) {
                        this.alpha = MathUtil.map(System.currentTimeMillis(), this.tStartFade, this.tEndFade, 1.0, 0.0);
                        if (this.alpha == 0.0) {
                            this.message = null;
                            this.alpha = 0.0;
                        }
                        this.panel.repaint();
                    }
                    try {
                        if (this.alpha > 0.0) {
                            this.waitLock.wait(50L);
                        } else {
                            this.waitLock.wait();
                        }
                    }
                    catch (InterruptedException e) {
                        e.printStackTrace();
                    }
                }
            }
        }

        /*
         * WARNING - Removed try catching itself - possible behaviour change.
         */
        public void kill() {
            this.run = false;
            Object object = this.waitLock;
            synchronized (object) {
                this.waitLock.notifyAll();
            }
        }
    }
}

