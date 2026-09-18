/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.panels.objecteditor;

import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.mapmaker.panels.inputs.MapInputHandler;
import com.hitachi.warehouse.mapmaker.panels.objecteditor.ControlPoint;
import com.hitachi.warehouse.mapmaker.panels.objecteditor.ObjectEditorPanel;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.AbstractRectangleObject;
import com.hitachi.warehouse.model.map.objects.FreeShelfObject;
import com.hitachi.warehouse.model.picking.FreeShelfArea;
import common.ds.DoubleKeyedArray;
import common.util.PrioritizedObject;
import java.awt.Cursor;
import java.awt.Point;
import java.awt.event.KeyEvent;
import java.awt.event.MouseEvent;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedList;
import java.util.PriorityQueue;

public class InputHandler
extends MapInputHandler
implements WorldMap.WorldMapChangedListener {
    ObjectEditorPanel parent;
    boolean isSelectingRange = false;
    Cursor CURS_CROSS = new Cursor(1);
    Cursor CURS_DEFAULT = new Cursor(0);

    public InputHandler(MapView mapView, ObjectEditorPanel parent) {
        super(parent.maker, mapView, false);
        super.setAllowSnap(false);
        this.parent = parent;
    }

    @Override
    public void keyPressed(KeyEvent e) {
        if (e.isShiftDown()) {
            super.setCanSelectRegion(true);
            this.isSelectingRange = true;
        } else {
            super.setCanSelectRegion(false);
            this.isSelectingRange = false;
        }
        this.parent.maker.mapFrame.setCursor(this.isSelectingRange ? this.CURS_CROSS : this.CURS_DEFAULT);
        if (e.getKeyCode() == 8 || e.getKeyCode() == 127) {
            ArrayList<AbstractObject> purged = new ArrayList<AbstractObject>();
            purged.addAll(this.parent.selection.selectedObjects);
            for (AbstractObject obj : purged) {
                if (!obj.getEditLock()) continue;
                return;
            }
            try {
                this.mapView.map().startWrite();
                for (AbstractObject obj : purged) {
                    this.mapView.map().remove(obj);
                }
                this.parent.selection.clear();
            }
            finally {
                this.mapView.map().endWrite();
                this.parent.maker.showInfoForObject(null, null);
            }
            return;
        }
        if (e.getKeyCode() == 68) {
            int mod = e.getModifiersEx();
            if (mod != 0) {
                return;
            }
            ArrayList<AbstractObject> selectedObjects = new ArrayList<AbstractObject>();
            selectedObjects.addAll(this.parent.selection.selectedObjects);
            try {
                this.mapView.map().startWrite();
                ArrayList<AbstractObject> clonedObjects = new ArrayList<AbstractObject>();
                for (AbstractObject obj : this.parent.selection.selectedObjects) {
                    AbstractObject cloned = obj.hardClone();
                    this.mapView.map().add(cloned);
                    clonedObjects.add(cloned);
                    cloned.nudge(cloned.boundTL().x + 1000.0, cloned.boundTL().y + 1000.0);
                }
                this.parent.selection.clear();
                for (AbstractObject obj : clonedObjects) {
                    this.parent.selection.selectObject(obj);
                }
                PriorityQueue<PrioritizedObject<FreeShelfObject>> reorderedShelves = new PriorityQueue<PrioritizedObject<FreeShelfObject>>();
                for (AbstractObject obj : clonedObjects) {
                    if (!FreeShelfObject.class.isInstance(obj)) continue;
                    FreeShelfObject shelf = (FreeShelfObject)obj;
                    int order = this.parent.mapView().map().shelfNameManager().idxForName(shelf.shelf().name);
                    if (order == -1) {
                        order = this.parent.mapView().map().shelfNameManager().names().size();
                    }
                    reorderedShelves.add(new PrioritizedObject<FreeShelfObject>(shelf, order));
                }
                LinkedList<String> unusedNamesInOrder = new LinkedList<String>();
                HashSet<String> shelfNamesAlreadyCreated = new HashSet<String>();
                for (FreeShelfObject shelf : this.parent.mapView().map().freeShelfObjects()) {
                    shelfNamesAlreadyCreated.add(shelf.shelf().name);
                }
                for (String cand : this.parent.mapView().map().shelfNameManager().names()) {
                    if (shelfNamesAlreadyCreated.contains(cand)) continue;
                    unusedNamesInOrder.add(cand);
                    if (unusedNamesInOrder.size() > reorderedShelves.size()) break;
                }
                int reorderedShelvesCnt = reorderedShelves.size();
                int i = 0;
                while (i < reorderedShelvesCnt) {
                    String name = unusedNamesInOrder.size() > 0 ? (String)unusedNamesInOrder.poll() : "";
                    PrioritizedObject shelf = (PrioritizedObject)reorderedShelves.poll();
                    ((FreeShelfObject)shelf.obj).setShelf(new FreeShelfArea(name));
                    ++i;
                }
            }
            finally {
                this.mapView.map().endWrite();
            }
        }
        super.keyPressed(e);
    }

    @Override
    public void keyReleased(KeyEvent e) {
        if (e.isShiftDown()) {
            super.setCanSelectRegion(true);
            this.isSelectingRange = true;
        } else {
            super.setCanSelectRegion(false);
            this.isSelectingRange = false;
        }
        this.parent.maker.mapFrame.setCursor(this.isSelectingRange ? this.CURS_CROSS : this.CURS_DEFAULT);
    }

    @Override
    public void mouseMoved(MouseEvent arg0) {
        super.mouseMoved(arg0);
        Point p = arg0.getPoint();
        if (this.parent.selection.isSelected()) {
            for (ControlPoint controlPoint : this.parent.selection.controlPoints) {
                if (!controlPoint.pointInControl(p, this.mapView)) continue;
                this.parent.maker.mapFrame.setCursor(controlPoint.cursor);
                return;
            }
        }
        for (AbstractObject obj : this.parent.selection.selectedObjects) {
            if (p.x < obj.screenLeft(this.mapView) || p.x > obj.screenRight(this.mapView) || p.y < obj.screenTop(this.mapView) || p.y > obj.screenBottom(this.mapView)) continue;
            this.parent.maker.mapFrame.setCursor(this.isSelectingRange ? this.CURS_CROSS : this.CURS_DEFAULT);
            return;
        }
        this.parent.maker.mapFrame.setCursor(this.isSelectingRange ? this.CURS_CROSS : this.CURS_DEFAULT);
    }

    @Override
    public void pointClicked(Coord currentCoord, MouseEvent event) {
        WorldMap map = this.mapView.map();
        this.mapView.requestFocus();
        if (map != null) {
            Point p = this.mapView.screenPointForWorld(currentCoord);
            if (event.getClickCount() == 1) {
                this.parent.selection.selectPoint(p, this.mapView, event.isShiftDown());
                this.updatePointHintsFromMap();
                this.mapView.repaint();
            }
        }
    }

    @Override
    public void mouseUp() {
        this.parent.selection.clearSelectedControlPoint();
    }

    @Override
    public void updatePointHintsFromMap() {
        WorldMap map = this.mapView.map();
        if (map != null) {
            try {
                map.startRead();
                DoubleKeyedArray<Coord> xs = new DoubleKeyedArray<Coord>();
                DoubleKeyedArray<Coord> ys = new DoubleKeyedArray<Coord>();
                xs.add(map.tl().x, map.tl());
                xs.add(map.br().x, map.br());
                ys.add(map.tl().y, map.tl());
                ys.add(map.br().y, map.br());
                for (AbstractObject obj : map.objects()) {
                    if (this.parent.selection.selectedObjects.contains(obj) || !AbstractRectangleObject.class.isInstance(obj)) continue;
                    AbstractRectangleObject rectObj = (AbstractRectangleObject)obj;
                    xs.add(rectObj.tl().x, rectObj.tl());
                    xs.add(rectObj.br().x, rectObj.br());
                    ys.add(rectObj.tl().y, rectObj.tl());
                    ys.add(rectObj.br().y, rectObj.br());
                }
                this.setPointHints(xs, ys);
            }
            finally {
                map.endRead();
            }
        }
    }
}

