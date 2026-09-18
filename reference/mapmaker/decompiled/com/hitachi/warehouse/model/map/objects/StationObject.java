/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.map.objects;

import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.AbstractRectangleObject;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Graphics2D;

public class StationObject
extends AbstractRectangleObject {
    private static final long serialVersionUID = -7150237888584959850L;
    public static final Color COL_STATION = new Color(225, 255, 228);

    @Override
    public boolean isObstructing() {
        return true;
    }

    @Override
    public void paint(Graphics2D g, MapView mapView) {
        int fromX = mapView.screenXForWorld(this.tl().x);
        int fromY = mapView.screenYForWorld(this.tl().y);
        int toX = mapView.screenXForWorld(this.br().x);
        int toY = mapView.screenYForWorld(this.br().y);
        g.setColor(COL_STATION);
        g.setStroke(new BasicStroke(1.0f));
        g.fillRect(fromX, fromY, toX - fromX, toY - fromY);
        g.setColor(Color.BLACK);
        g.drawRect(fromX, fromY, toX - fromX, toY - fromY);
        if (this.getEditLock()) {
            g.setColor(Color.BLACK);
            g.setStroke(new BasicStroke(1.0f));
            g.drawLine(fromX, fromY, toX, toY);
        }
    }

    public String toString() {
        return "Station";
    }

    @Override
    public AbstractObject hardClone() {
        StationObject newObj = new StationObject();
        newObj.setBounds(this.tl(), this.br());
        return newObj;
    }
}

