/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.panels.objecteditor;

import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.mapmaker.panels.objecteditor.ControlPoint;
import com.hitachi.warehouse.mapmaker.panels.objecteditor.ObjectEditorPanel;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.common.polygon.Bound;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import common.util.MathUtil;
import java.awt.Cursor;
import java.awt.Point;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;

public class SelectionManager {
    HashSet<AbstractObject> selectedObjects = new HashSet();
    HashMap<AbstractObject, Double> pLeftForObject = new HashMap();
    HashMap<AbstractObject, Double> pRightForObject = new HashMap();
    HashMap<AbstractObject, Double> pTopForObject = new HashMap();
    HashMap<AbstractObject, Double> pBottomForObject = new HashMap();
    double selectionPoint_x = 0.0;
    double selectionPoint_y = 0.0;
    HashMap<AbstractObject, Bound> selectedObjectsOriginalBound = new HashMap();
    ControlPoint selectedControlPoint = null;
    List<ControlPoint> controlPoints = new ArrayList<ControlPoint>();
    ObjectEditorPanel parent;
    Coord tl = null;
    Coord br = null;
    Coord selectionRangeTL = null;
    Coord selectionRangeBR = null;
    HashSet<AbstractObject> temporaryRangeSelectedObjects = new HashSet();

    public void clearSelectedControlPoint() {
        this.selectedControlPoint = null;
    }

    public SelectionManager(ObjectEditorPanel parent) {
        this.parent = parent;
        this.controlPoints.add(new ControlPoint(this, -1, -1, new Cursor(6)));
        this.controlPoints.add(new ControlPoint(this, 0, -1, new Cursor(8)));
        this.controlPoints.add(new ControlPoint(this, 1, -1, new Cursor(7)));
        this.controlPoints.add(new ControlPoint(this, -1, 0, new Cursor(10)));
        this.controlPoints.add(new ControlPoint(this, 1, 0, new Cursor(11)));
        this.controlPoints.add(new ControlPoint(this, -1, 1, new Cursor(4)));
        this.controlPoints.add(new ControlPoint(this, 0, 1, new Cursor(9)));
        this.controlPoints.add(new ControlPoint(this, 1, 1, new Cursor(5)));
    }

    public void addObject(AbstractObject obj) {
        if (obj != null) {
            this.selectedObjectsOriginalBound.put(obj, obj.bound());
            this.selectedObjects.add(obj);
            this.updateTLRB();
            this.updateObjectRelativePositions();
        }
    }

    public void removeObject(AbstractObject obj) {
        if (obj != null) {
            this.selectedObjectsOriginalBound.remove(obj);
            this.selectedObjects.remove(obj);
            this.updateTLRB();
            this.updateObjectRelativePositions();
        }
    }

    public void addObjectWithoutUpdatingInternal(AbstractObject obj) {
        if (obj != null) {
            this.selectedObjectsOriginalBound.put(obj, obj.bound());
            this.selectedObjects.add(obj);
        }
    }

    public void addObjects(Collection<AbstractObject> objs) {
        for (AbstractObject obj : objs) {
            this.selectedObjectsOriginalBound.put(obj, obj.bound());
            this.selectedObjects.add(obj);
        }
        this.updateTLRB();
        this.updateObjectRelativePositions();
    }

    public void updateTLRB() {
        if (this.selectedObjects.size() == 0) {
            this.br = null;
            this.tl = null;
        } else {
            Double l = null;
            Double r = null;
            Double t2 = null;
            Double b = null;
            for (AbstractObject o : this.selectedObjects) {
                l = MathUtil.min_ignoreNull(l, o.boundTL().x);
                r = MathUtil.max_ignoreNull(r, o.boundBR().x);
                t2 = MathUtil.min_ignoreNull(t2, o.boundTL().y);
                b = MathUtil.max_ignoreNull(b, o.boundBR().y);
            }
            this.tl = new Coord(l, t2);
            this.br = new Coord(r, b);
        }
    }

    public void updateObjectRelativePositions() {
        for (AbstractObject o : this.selectedObjects) {
            this.pLeftForObject.put(o, MathUtil.map(o.boundTL().x, this.tl.x, this.br.x));
            this.pRightForObject.put(o, MathUtil.map(o.boundBR().x, this.tl.x, this.br.x));
            this.pTopForObject.put(o, MathUtil.map(o.boundTL().y, this.tl.y, this.br.y));
            this.pBottomForObject.put(o, MathUtil.map(o.boundBR().y, this.tl.y, this.br.y));
        }
    }

    public void clear() {
        this.selectedObjectsOriginalBound.clear();
        this.selectedObjects.clear();
        this.pLeftForObject.clear();
        this.pRightForObject.clear();
        this.pTopForObject.clear();
        this.pBottomForObject.clear();
        this.br = null;
        this.tl = null;
    }

    public boolean isSelected() {
        return this.selectedObjects.size() > 0;
    }

    public void selectPoint(Point p, MapView mapView, boolean incrementalSelect) {
        if (this.isSelected()) {
            ControlPoint selected = null;
            for (ControlPoint controlPoint : this.controlPoints) {
                if (!controlPoint.pointInControl(p, mapView)) continue;
                selected = controlPoint;
                break;
            }
            this.selectedControlPoint = selected;
            if (selected != null) {
                return;
            }
        }
        AbstractObject pickedObject = null;
        List<AbstractObject> objs = mapView.map().objects();
        int i = objs.size() - 1;
        while (i >= 0) {
            AbstractObject obj = objs.get(i);
            if (p.x >= obj.screenLeft(mapView) && p.x <= obj.screenRight(mapView) && p.y >= obj.screenTop(mapView) && p.y <= obj.screenBottom(mapView)) {
                pickedObject = obj;
                break;
            }
            --i;
        }
        if (!this.selectedObjects.contains(pickedObject)) {
            if (!incrementalSelect) {
                this.clear();
            }
            this.addObject(pickedObject);
        } else if (incrementalSelect) {
            this.removeObject(pickedObject);
        }
        if (this.tl != null) {
            this.selectionPoint_x = mapView.worldXForScreen(p.x) - this.tl.x;
            this.selectionPoint_y = mapView.worldYForScreen(p.y) - this.tl.y;
        }
        if (this.selectedObjects.size() == 1) {
            this.parent.maker.showInfoForObject(this.selectedObjects.iterator().next(), this.selectedObjectsOriginalBound);
        } else if (this.selectedObjects.size() > 0) {
            this.parent.maker.showInfoForMultiObject(this.selectedObjects);
        } else {
            this.parent.maker.showInfoForObject(null, null);
        }
    }

    public void setSelectionRange(Coord tl, Coord br) {
        double l = Math.min(tl.x, br.x);
        double r = Math.max(tl.x, br.x);
        double t2 = Math.min(tl.y, br.y);
        double b = Math.max(tl.y, br.y);
        tl = new Coord(l, t2);
        br = new Coord(r, b);
        this.selectionRangeTL = tl;
        this.selectionRangeBR = br;
        this.temporaryRangeSelectedObjects.clear();
        for (AbstractObject obj : this.parent.maker.map().objects()) {
            if (!Coord.clips(obj.boundTL(), obj.boundBR(), tl, br)) continue;
            this.temporaryRangeSelectedObjects.add(obj);
        }
    }

    public void selectObject(AbstractObject obj) {
        if (!this.selectedObjects.contains(obj)) {
            this.addObject(obj);
        }
        if (this.selectedObjects.size() == 1) {
            this.parent.maker.showInfoForObject(this.selectedObjects.iterator().next(), this.selectedObjectsOriginalBound);
        } else if (this.selectedObjects.size() > 0) {
            this.parent.maker.showInfoForMultiObject(this.selectedObjects);
        } else {
            this.parent.maker.showInfoForObject(null, null);
        }
    }

    public void commitTemporarySelections() {
        if (this.selectionRangeTL != null) {
            for (AbstractObject obj : this.temporaryRangeSelectedObjects) {
                this.selectedObjectsOriginalBound.put(obj, obj.bound());
            }
            this.selectedObjects.addAll(this.temporaryRangeSelectedObjects);
            this.updateTLRB();
            this.updateObjectRelativePositions();
            this.clearTemporarySelections();
            if (this.selectedObjects.size() > 0) {
                this.parent.maker.showInfoForMultiObject(this.selectedObjects);
            } else {
                this.parent.maker.showInfoForObject(null, null);
            }
        }
    }

    public void clearTemporarySelections() {
        this.selectionRangeBR = null;
        this.selectionRangeTL = null;
        this.temporaryRangeSelectedObjects.clear();
    }
}

