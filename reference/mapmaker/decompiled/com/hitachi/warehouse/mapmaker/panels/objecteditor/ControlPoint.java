/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.panels.objecteditor;

import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.mapmaker.panels.objecteditor.SelectionManager;
import com.hitachi.warehouse.model.common.Coord;
import common.util.MathUtil;
import java.awt.Cursor;
import java.awt.Point;

public class ControlPoint {
    private SelectionManager selection;
    Cursor cursor;
    int cornerSize = 4;
    int dxMask;
    int dyMask;

    public ControlPoint(SelectionManager selection, int dxMask, int dyMask, Cursor cursor) {
        this.selection = selection;
        this.dxMask = dxMask;
        this.dyMask = dyMask;
        this.cursor = cursor;
    }

    public String toString() {
        return String.valueOf(this.dxMask) + " " + this.dyMask;
    }

    public Coord drawCenter() {
        Coord tl = this.selection.tl;
        Coord br = this.selection.br;
        if (tl == null) {
            return null;
        }
        double x = MathUtil.map(this.dxMask, -1.0, 1.0, tl.x, br.x);
        double y = MathUtil.map(this.dyMask, -1.0, 1.0, tl.y, br.y);
        return new Coord(x, y);
    }

    public boolean pointInControl(Point p, MapView mapView) {
        Coord centerCoord = this.drawCenter();
        if (centerCoord == null) {
            return false;
        }
        Point center = mapView.screenPointForWorld(centerCoord);
        return center.x - this.cornerSize <= p.x && center.x + this.cornerSize >= p.x && center.y - this.cornerSize <= p.y && center.y + this.cornerSize >= p.y;
    }
}

