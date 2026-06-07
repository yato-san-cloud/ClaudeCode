/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.model.map.objects;

import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.common.Segment;
import com.hitachi.warehouse.model.common.polygon.Bound;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import common.util.ColorUtil;
import common.util.MathUtil;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Graphics2D;
import java.io.Serializable;

public abstract class AbstractRectangleObject
extends AbstractObject
implements Serializable {
    private static final long serialVersionUID = 3944775249984626991L;
    private Coord tl;
    private Coord br;
    private transient Bound bound;
    private transient Coord center = null;

    @Override
    public Bound bound() {
        if (this.bound == null) {
            this.bound = new Bound(this.tl, this.br);
        }
        return this.bound;
    }

    public void setBounds(Coord tl, Coord br) {
        double left = Math.min(tl.x, br.x);
        double right = Math.max(tl.x, br.x);
        double top = Math.min(tl.y, br.y);
        double bottom = Math.max(tl.y, br.y);
        this.tl = new Coord(left, top);
        this.br = new Coord(right, bottom);
        this.bound = null;
    }

    public Coord tl() {
        return this.tl;
    }

    public Coord br() {
        return this.br;
    }

    @Override
    public boolean isInside(Coord coord) {
        return coord.isInside(this.tl, this.br);
    }

    public Coord tr() {
        return new Coord(this.br.x, this.tl.y);
    }

    public Coord bl() {
        return new Coord(this.tl.x, this.br.y);
    }

    @Override
    public Coord boundTL() {
        return this.tl;
    }

    @Override
    public Coord boundBR() {
        return this.br;
    }

    @Override
    public Coord boundTR() {
        return this.tr();
    }

    @Override
    public Coord boundBL() {
        return this.bl();
    }

    public double left() {
        return this.tl.x;
    }

    public double right() {
        return this.br.x;
    }

    public double top() {
        return this.tl.y;
    }

    public double bottom() {
        return this.br.y;
    }

    @Override
    public int screenLeft(MapView mapView) {
        return mapView.screenXForWorld(this.tl.x);
    }

    @Override
    public int screenRight(MapView mapView) {
        return mapView.screenXForWorld(this.br.x);
    }

    @Override
    public int screenTop(MapView mapView) {
        return mapView.screenYForWorld(this.tl.y);
    }

    @Override
    public int screenBottom(MapView mapView) {
        return mapView.screenYForWorld(this.br.y);
    }

    @Override
    public void nudge(double newLeft, double newTop) {
        double width = this.br.x - this.tl.x;
        double height = this.br.y - this.tl.y;
        this.setBounds(new Coord(newLeft, newTop), new Coord(newLeft + width, newTop + height));
    }

    @Override
    public void setLeft(double x) {
        if (x < this.br.x) {
            this.tl = new Coord(x, this.tl.y);
            this.bound = null;
        }
    }

    @Override
    public void setRight(double x) {
        if (x > this.tl.x) {
            this.br = new Coord(x, this.br.y);
            this.bound = null;
        }
    }

    @Override
    public void setTop(double y) {
        if (y < this.br.y) {
            this.tl = new Coord(this.tl.x, y);
            this.bound = null;
        }
    }

    @Override
    public void setBottom(double y) {
        if (y > this.tl.y) {
            this.br = new Coord(this.br.x, y);
            this.bound = null;
        }
    }

    public Coord center() {
        return new Coord((this.tl.x + this.br.x) / 2.0, (this.tl.y + this.br.y) / 2.0);
    }

    @Override
    public double distTo(Coord coord) {
        return MathUtil.min(new Segment(this.tl(), this.tr()).actualDist(coord), new Segment(this.tr(), this.br()).actualDist(coord), new Segment(this.tl(), this.bl()).actualDist(coord), new Segment(this.bl(), this.br()).actualDist(coord));
    }

    @Override
    public boolean clipsSegment(Coord from, Coord to) {
        if (this.isInside(from) || this.isInside(to)) {
            return true;
        }
        if (from.x == to.x) {
            if ((this.br.y - from.y) * (this.br.y - to.y) < 0.0 && this.tl.x <= from.x && from.x < this.br.x) {
                return true;
            }
            if ((this.tl.y - from.y) * (this.tl.y - to.y) < 0.0 && this.tl.x <= from.x && from.x < this.br.x) {
                return true;
            }
        } else {
            double a = (from.y - to.y) / (from.x - to.x);
            double b = from.y - a * from.x;
            double topX = (this.tl.y - b) / a;
            if ((this.tl.y - from.y) * (this.tl.y - to.y) <= 0.0 && this.tl.x <= topX && topX < this.br.x) {
                return true;
            }
            double botX = (this.br.y - b) / a;
            if ((this.br.y - from.y) * (this.br.y - to.y) <= 0.0 && this.tl.x <= botX && botX < this.br.x) {
                return true;
            }
            double rightY = a * this.br.x + b;
            if ((this.br.x - from.x) * (this.br.x - to.x) <= 0.0 && this.tl.y <= rightY && rightY < this.br.y) {
                return true;
            }
            double leftY = a * this.tl.x + b;
            if ((this.tl.x - from.x) * (this.tl.x - to.x) <= 0.0 && this.tl.y <= leftY && leftY < this.br.y) {
                return true;
            }
        }
        return false;
    }

    @Override
    public void highlight(Graphics2D g, MapView mapView) {
        int fromX = mapView.screenXForWorld(this.tl().x);
        int fromY = mapView.screenYForWorld(this.tl().y);
        int toX = mapView.screenXForWorld(this.br().x);
        int toY = mapView.screenYForWorld(this.br().y);
        g.setColor(Color.BLUE);
        g.setStroke(new BasicStroke(3.0f));
        g.drawRect(fromX, fromY, toX - fromX, toY - fromY);
        g.setColor(ColorUtil.setAlpha(Color.BLUE, 0.2));
        g.fillRect(fromX, fromY, toX - fromX, toY - fromY);
    }
}

