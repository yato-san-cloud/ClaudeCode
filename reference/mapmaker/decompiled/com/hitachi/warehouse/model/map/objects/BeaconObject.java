/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.map.objects;

import com.hitachi.warehouse.bms.model.Beacon;
import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.common.polygon.Bound;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.AbstractPointObject;
import common.gui.Draw;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Font;
import java.awt.Graphics2D;
import java.awt.Point;
import java.awt.Rectangle;
import java.io.Serializable;

public class BeaconObject
extends AbstractPointObject
implements Serializable {
    private static final long serialVersionUID = 8594891708753935696L;
    private Beacon beacon;
    static Font font = new Font("Arial", 0, 12);

    public void setBeacon(Beacon beacon) {
        this.beacon = beacon;
    }

    public Beacon beacon() {
        return this.beacon;
    }

    @Override
    public Coord point() {
        return this.beacon.coord();
    }

    @Override
    public boolean isObstructing() {
        return false;
    }

    @Override
    public Bound bound() {
        return new Bound(this.point(), this.point());
    }

    @Override
    public Coord boundTL() {
        return this.point();
    }

    @Override
    public Coord boundBR() {
        return this.point();
    }

    @Override
    public Coord boundTR() {
        return this.point();
    }

    @Override
    public Coord boundBL() {
        return this.point();
    }

    @Override
    public int screenLeft(MapView mapView) {
        return mapView.screenXForWorld(this.beacon.coord().x) - 2;
    }

    @Override
    public int screenRight(MapView mapView) {
        return mapView.screenXForWorld(this.beacon.coord().x) + 2;
    }

    @Override
    public int screenTop(MapView mapView) {
        return mapView.screenXForWorld(this.beacon.coord().y) - 2;
    }

    @Override
    public int screenBottom(MapView mapView) {
        return mapView.screenXForWorld(this.beacon.coord().y) + 2;
    }

    @Override
    public void nudge(double newLeft, double newTop) {
        this.beacon.setCoord(new Coord(newLeft, newTop));
    }

    @Override
    public void paint(Graphics2D g, MapView mapView) {
        g.setFont(font);
        Point p = mapView.screenPointForWorld(this.point());
        String str = String.valueOf(this.beacon.beaconID) + "\n" + this.beacon.beaconName;
        Rectangle bound = Draw.getStringBounds(g, str, p.x, p.y);
        int origX = bound.x - bound.width / 2;
        int origY = bound.y - bound.height / 2;
        g.setColor(Color.GREEN);
        g.fillRoundRect(origX, origY, bound.width, bound.height, 4, 4);
        g.setColor(Color.WHITE);
        Draw.drawString(g, str, origX, origY);
        g.setColor(Color.red);
        Draw.drawCross(g, p, 5);
        if (this.getEditLock()) {
            g.setColor(Color.BLACK);
            g.setStroke(new BasicStroke(1.0f));
            g.drawLine(bound.x - bound.width / 2, bound.y - bound.height / 2, bound.x + bound.width / 2, bound.y + bound.height / 2);
        }
    }

    @Override
    public void highlight(Graphics2D g, MapView mapView) {
        g.setFont(font);
        Point p = mapView.screenPointForWorld(this.point());
        String str = String.valueOf(this.beacon.beaconID) + "\n" + this.beacon.beaconName;
        Rectangle bound = Draw.getStringBounds(g, str, p.x, p.y);
        int origX = bound.x - bound.width / 2;
        int origY = bound.y - bound.height / 2;
        g.setColor(Color.red);
        g.fillRoundRect(origX, origY, bound.width, bound.height, 4, 4);
        g.setColor(Color.YELLOW);
        g.setStroke(new BasicStroke(3.0f));
        g.drawRoundRect(origX, origY, bound.width, bound.height, 4, 4);
        g.setStroke(new BasicStroke(1.0f));
        g.setColor(Color.WHITE);
        Draw.drawString(g, str, origX, origY);
        if (this.getEditLock()) {
            g.setColor(Color.BLACK);
            g.setStroke(new BasicStroke(1.0f));
            g.drawLine(bound.x - bound.width / 2, bound.y - bound.height / 2, bound.x + bound.width / 2, bound.y + bound.height / 2);
        }
    }

    public String toString() {
        return "Beacon[" + this.beacon.beaconID + "]";
    }

    @Override
    public AbstractObject hardClone() {
        BeaconObject newObj = new BeaconObject();
        Beacon newBeacon = new Beacon(this.beacon.beaconID, this.beacon.beaconName);
        newBeacon.setCoord(this.beacon.coord());
        newObj.setBeacon(newBeacon);
        return newObj;
    }
}

