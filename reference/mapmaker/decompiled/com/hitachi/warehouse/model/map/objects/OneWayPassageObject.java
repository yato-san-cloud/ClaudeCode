/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.map.objects;

import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.AbstractRectangleObject;
import common.util.ColorUtil;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Graphics2D;

public class OneWayPassageObject
extends AbstractRectangleObject {
    private static final long serialVersionUID = 1870670696562290954L;
    public static final Color COL_PASSAGE = ColorUtil.setAlpha(Color.yellow, 0.4f);

    @Override
    public boolean isObstructing() {
        return false;
    }

    @Override
    public void paint(Graphics2D g, MapView mapView) {
        int fromX = mapView.screenXForWorld(this.tl().x);
        int fromY = mapView.screenYForWorld(this.tl().y);
        int toX = mapView.screenXForWorld(this.br().x);
        int toY = mapView.screenYForWorld(this.br().y);
        g.setColor(COL_PASSAGE);
        g.setStroke(new BasicStroke(1.0f));
        g.fillRect(fromX, fromY, toX - fromX, toY - fromY);
    }

    @Override
    public AbstractObject hardClone() {
        OneWayPassageObject newObj = new OneWayPassageObject();
        newObj.setBounds(this.tl(), this.br());
        return newObj;
    }
}

