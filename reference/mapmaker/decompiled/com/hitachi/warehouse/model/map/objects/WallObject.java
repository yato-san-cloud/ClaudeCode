/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.map.objects;

import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.AbstractRectangleObject;
import common.util.ColorUtil;
import common.util.MathUtil;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Graphics2D;

public class WallObject
extends AbstractRectangleObject {
    private static final long serialVersionUID = 692756784809906143L;
    public static final Color COL_SHELF = new Color(226, 226, 226);
    private double height_mm = 0.0;

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
        g.setColor(COL_SHELF);
        g.setStroke(new BasicStroke(1.0f));
        g.setColor(ColorUtil.gradBW(MathUtil.map(this.height_mm, 0.0, 10000.0, 0.8, 0.1)));
        g.fillRect(fromX, fromY, toX - fromX, toY - fromY);
        if (this.getEditLock()) {
            g.setColor(Color.BLACK);
            g.setStroke(new BasicStroke(1.0f));
            g.drawLine(fromX, fromY, toX, toY);
        }
    }

    public double height_mm() {
        return this.height_mm;
    }

    public void setHeight(double height_mm) {
        this.height_mm = height_mm;
    }

    public String toString() {
        return "壁";
    }

    @Override
    public AbstractObject hardClone() {
        WallObject newObj = new WallObject();
        newObj.height_mm = this.height_mm;
        newObj.setBounds(this.tl(), this.br());
        return newObj;
    }
}

