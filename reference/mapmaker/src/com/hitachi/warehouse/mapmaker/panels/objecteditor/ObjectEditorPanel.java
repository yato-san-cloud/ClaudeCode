/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.panels.objecteditor;

import com.hitachi.warehouse.gui.mapframe.AbstractMapPanel;
import com.hitachi.warehouse.gui.mapframe.MapView;
import com.hitachi.warehouse.mapmaker.MapMaker;
import com.hitachi.warehouse.mapmaker.panels.objecteditor.ControlPoint;
import com.hitachi.warehouse.mapmaker.panels.objecteditor.InputHandler;
import com.hitachi.warehouse.mapmaker.panels.objecteditor.SelectionManager;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.common.polygon.Bound;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.AbstractRectangleObject;
import com.hitachi.warehouse.model.map.objects.ConstrainedAreaObject;
import com.hitachi.warehouse.model.map.objects.FreeShelfObject;
import com.hitachi.warehouse.model.map.objects.StairsObject;
import com.hitachi.warehouse.model.map.objects.StationObject;
import com.hitachi.warehouse.model.map.objects.WallObject;
import common.gui.Draw;
import common.util.ColorUtil;
import common.util.MathUtil;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.Point;
import java.awt.event.KeyAdapter;
import java.awt.event.KeyEvent;
import java.awt.event.KeyListener;
import java.awt.event.MouseEvent;
import javax.swing.JOptionPane;
import com.hitachi.warehouse.mapmaker.Prefs;
import com.hitachi.warehouse.model.picking.FreeShelfArea;
import java.awt.GridLayout;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import javax.swing.JComboBox;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JTextField;

public class ObjectEditorPanel
extends AbstractMapPanel
implements WorldMap.WorldMapChangedListener {
    MapMaker maker;
    InputHandler inputHandler;
    SelectionManager selection = new SelectionManager(this);
    KeyListener keyListener;
    private Double snapLineX = null;
    private Double snapLineY = null;

    public ObjectEditorPanel(MapMaker maker) {
        this.maker = maker;
    }

    @Override
    public boolean dragged(int origX, int origY, int newX, int newY) {
        if (this.inputHandler.isSelectingRange) {
            Coord tl = new Coord(this.mapView().worldXForScreen(origX), this.mapView().worldYForScreen(origY));
            Coord br = new Coord(this.mapView().worldXForScreen(newX), this.mapView().worldYForScreen(newY));
            this.selection.setSelectionRange(tl, br);
            return false;
        }
        if (this.selection.isSelected()) {
            if (this.selection.selectedControlPoint != null) {
                if (this.selection.selectedControlPoint.dxMask != 0) {
                    double pR;
                    double pL;
                    this.snapLineX = this.inputHandler.snapX(newX);
                    double toX = this.snapLineX == null ? this.mapView().worldXForScreen(newX) : this.snapLineX.doubleValue();
                    if (this.selection.selectedControlPoint.dxMask < 0) {
                        for (AbstractObject selected : this.selection.selectedObjects) {
                            pL = this.selection.pLeftForObject.get(selected);
                            pR = this.selection.pRightForObject.get(selected);
                            if (this.IsSelectionObjectEditLock()) continue;
                            selected.setLeft(MathUtil.map(pL, 0.0, 1.0, toX, this.selection.br.x));
                            selected.setRight(MathUtil.map(pR, 0.0, 1.0, toX, this.selection.br.x));
                        }
                    } else if (this.selection.selectedControlPoint.dxMask > 0) {
                        for (AbstractObject selected : this.selection.selectedObjects) {
                            pL = this.selection.pLeftForObject.get(selected);
                            pR = this.selection.pRightForObject.get(selected);
                            if (this.IsSelectionObjectEditLock()) continue;
                            selected.setLeft(MathUtil.map(pL, 0.0, 1.0, this.selection.tl.x, toX));
                            selected.setRight(MathUtil.map(pR, 0.0, 1.0, this.selection.tl.x, toX));
                        }
                    }
                    this.selection.updateTLRB();
                }
                if (this.selection.selectedControlPoint.dyMask != 0) {
                    double pB;
                    double pT;
                    this.snapLineY = this.inputHandler.snapY(newY);
                    double toY = this.snapLineY == null ? this.mapView().worldYForScreen(newY) : this.snapLineY.doubleValue();
                    if (this.selection.selectedControlPoint.dyMask < 0) {
                        for (AbstractObject selected : this.selection.selectedObjects) {
                            pT = this.selection.pTopForObject.get(selected);
                            pB = this.selection.pBottomForObject.get(selected);
                            if (this.IsSelectionObjectEditLock()) continue;
                            selected.setTop(MathUtil.map(pT, 0.0, 1.0, toY, this.selection.br.y));
                            selected.setBottom(MathUtil.map(pB, 0.0, 1.0, toY, this.selection.br.y));
                        }
                    } else if (this.selection.selectedControlPoint.dyMask > 0) {
                        for (AbstractObject selected : this.selection.selectedObjects) {
                            pT = this.selection.pTopForObject.get(selected);
                            pB = this.selection.pBottomForObject.get(selected);
                            if (this.IsSelectionObjectEditLock()) continue;
                            selected.setTop(MathUtil.map(pT, 0.0, 1.0, this.selection.tl.y, toY));
                            selected.setBottom(MathUtil.map(pB, 0.0, 1.0, this.selection.tl.y, toY));
                        }
                    }
                }
                if (!this.IsSelectionObjectEditLock()) {
                    this.mapView().map().dispatchChangedEvent();
                }
            } else {
                Double scoreBottom;
                Double scoreRight;
                double origMouseX = this.mapView().worldXForScreen(newX);
                double origMouseY = this.mapView().worldYForScreen(newY);
                double origLeft = origMouseX - this.selection.selectionPoint_x;
                double origTop = origMouseY - this.selection.selectionPoint_y;
                double width = this.selection.br.x - this.selection.tl.x;
                double height = this.selection.br.y - this.selection.tl.y;
                double origRight = origLeft + width;
                double origBottom = origTop + height;
                int screenLeft = this.mapView().screenXForWorld(origLeft);
                int screenTop = this.mapView().screenYForWorld(origTop);
                int screenRight = this.mapView().screenXForWorld(origRight);
                int screenBottom = this.mapView().screenYForWorld(origBottom);
                this.snapLineY = null;
                this.snapLineX = null;
                double newLeft = origLeft;
                Double snapLeft = this.inputHandler.snapX(screenLeft);
                Double snapRight = this.inputHandler.snapX(screenRight);
                Double scoreLeft = snapLeft == null ? null : Double.valueOf(Math.abs(snapLeft - origLeft));
                Double d = scoreRight = snapRight == null ? null : Double.valueOf(Math.abs(snapRight - origRight));
                if (scoreLeft == null) {
                    if (scoreRight != null) {
                        this.snapLineX = snapRight;
                        newLeft = snapRight - width;
                    }
                } else if (scoreRight == null) {
                    if (scoreLeft != null) {
                        this.snapLineX = snapLeft;
                        newLeft = snapLeft;
                    }
                } else if (scoreLeft < scoreRight) {
                    this.snapLineX = snapLeft;
                    newLeft = snapLeft;
                } else {
                    this.snapLineX = snapRight;
                    newLeft = snapRight - width;
                }
                double newTop = origTop;
                Double snapTop = this.inputHandler.snapY(screenTop);
                Double snapBottom = this.inputHandler.snapY(screenBottom);
                Double scoreTop = snapTop == null ? null : Double.valueOf(Math.abs(snapTop - origTop));
                Double d2 = scoreBottom = snapBottom == null ? null : Double.valueOf(Math.abs(snapBottom - origBottom));
                if (scoreTop == null) {
                    if (scoreBottom != null) {
                        this.snapLineY = snapBottom;
                        newTop = snapBottom - height;
                    }
                } else if (scoreBottom == null) {
                    if (scoreTop != null) {
                        this.snapLineY = snapTop;
                        newTop = snapTop;
                    }
                } else if (scoreTop < scoreBottom) {
                    this.snapLineY = snapTop;
                    newTop = snapTop;
                } else {
                    this.snapLineY = snapBottom;
                    newTop = snapBottom - height;
                }
                this.selection.updateTLRB();
                double dLeft = newLeft - this.selection.tl.x;
                double dTop = newTop - this.selection.tl.y;
                for (AbstractObject selected : this.selection.selectedObjects) {
                    if (this.IsSelectionObjectEditLock()) continue;
                    selected.nudge(dLeft + selected.boundTL().x, dTop + selected.boundTL().y);
                }
                if (!this.IsSelectionObjectEditLock()) {
                    this.mapView().map().dispatchChangedEvent();
                }
            }
            return false;
        }
        return true;
    }

    @Override
    public void dragDone() {
        this.snapLineY = null;
        this.snapLineX = null;
        boolean OverlapObject = false;
        for (AbstractObject selectedObj : this.selection.selectedObjects) {
            for (AbstractObject obj : this.mapView().map().objects()) {
                if (selectedObj.equals(obj) || this.selection.selectedObjects.contains(obj)) continue;
                if ((FreeShelfObject.class.isInstance(selectedObj) || ConstrainedAreaObject.class.isInstance(selectedObj) || StationObject.class.isInstance(selectedObj) || StairsObject.class.isInstance(selectedObj)) && (FreeShelfObject.class.isInstance(obj) || WallObject.class.isInstance(obj) || ConstrainedAreaObject.class.isInstance(obj) || StationObject.class.isInstance(obj) || StairsObject.class.isInstance(obj)) && selectedObj.boundTL().x < obj.boundBR().x && selectedObj.boundTL().y < obj.boundBR().y && selectedObj.boundBR().x > obj.boundTL().x && selectedObj.boundBR().y > obj.boundTL().y) {
                    OverlapObject = true;
                }
                if (!WallObject.class.isInstance(selectedObj) || !FreeShelfObject.class.isInstance(obj) && !ConstrainedAreaObject.class.isInstance(obj) && !StationObject.class.isInstance(obj) && !StairsObject.class.isInstance(obj) || !(selectedObj.boundTL().x < obj.boundBR().x) || !(selectedObj.boundTL().y < obj.boundBR().y) || !(selectedObj.boundBR().x > obj.boundTL().x) || !(selectedObj.boundBR().y > obj.boundTL().y)) continue;
                OverlapObject = true;
            }
        }
        if (OverlapObject) {
            JOptionPane.showMessageDialog(this.maker.mapFrame, "オブジェクトが重なっています。", "エラー", 0);
            for (AbstractObject obj : this.selection.selectedObjects) {
                Bound bound = this.selection.selectedObjectsOriginalBound.get(obj).bounds();
                AbstractRectangleObject rectObj = (AbstractRectangleObject)obj;
                rectObj.setBounds(bound.tl, bound.br);
            }
            this.mapView().map().dispatchChangedEvent();
            return;
        }
        this.selection.selectedObjectsOriginalBound.clear();
        for (AbstractObject obj : this.selection.selectedObjects) {
            this.selection.selectedObjectsOriginalBound.put(obj, obj.bound());
        }
        this.selection.commitTemporarySelections();
        if (this.selection.selectedObjects.size() == 1) {
            for (AbstractObject obj : this.selection.selectedObjects) {
                if (!FreeShelfObject.class.isInstance(obj)) continue;
                this.selection.selectObject(obj);
            }
        }
    }

    @Override
    protected void mapViewSet(final MapView mapView) {
        this.inputHandler = new InputHandler(mapView, this){

            @Override
            public void pointClickedOther(Coord coord, MouseEvent event) {
                super.pointClicked(coord, event);
            }
        };
        this.inputHandler.updatePointHintsFromMap();
        this.maker.addMapChangedListener(this);
        this.keyListener = new KeyAdapter(){

            @Override
            public void keyPressed(KeyEvent e) {
                if (e.getKeyChar() == 'd') {
                    if (ObjectEditorPanel.this.selection.isSelected()) {
                        System.out.println("duplicate!");
                    }
                } else if (e.getKeyChar() == 'h') {
                    mapView.setMessage("[d] Duplicate Selection [Delete] Delete selection [Shift-Click] Select Range");
                }
            }
        };
        mapView.addKeyListener(this.keyListener);
    }

    @Override
    protected void mapViewRemoved(MapView mapView) {
        this.inputHandler.kill();
        this.maker.removeMapChangedListener(this);
        mapView.removeKeyListener(this.keyListener);
    }

    @Override
    public void draw(Graphics2D g) {
        g.setStroke(new BasicStroke(1.0f));
        if (this.selection.isSelected()) {
            g.setStroke(new BasicStroke(1.0f));
            g.setColor(Color.BLACK);
            this.selection.updateTLRB();
            g.setStroke(new BasicStroke(1.0f));
            g.setColor(ColorUtil.setAlpha(Color.BLACK, 0.1f));
            for (AbstractObject selected : this.selection.selectedObjects) {
                Draw.fillRect(g, this.mapView().screenPointForWorld(selected.boundTL()), this.mapView().screenPointForWorld(selected.boundBR()));
            }
            g.setStroke(new BasicStroke(2.0f));
            g.setColor(Color.BLACK);
            Draw.drawRect(g, this.mapView().screenPointForWorld(this.selection.tl), this.mapView().screenPointForWorld(this.selection.br));
            g.setStroke(new BasicStroke(1.0f));
            for (ControlPoint control : this.selection.controlPoints) {
                Point p = this.mapView().screenPointForWorld(control.drawCenter());
                g.setColor(Color.white);
                g.fillRect(p.x - control.cornerSize, p.y - control.cornerSize, control.cornerSize * 2, control.cornerSize * 2);
                g.setColor(Color.BLACK);
                g.drawRect(p.x - control.cornerSize, p.y - control.cornerSize, control.cornerSize * 2, control.cornerSize * 2);
            }
        }
        if (this.snapLineX != null) {
            g.setColor(Color.GREEN);
            int x = this.mapView().screenXForWorld(this.snapLineX);
            g.drawLine(x, 0, x, this.mapView().getHeight());
        }
        if (this.snapLineY != null) {
            g.setColor(Color.GREEN);
            int y = this.mapView().screenYForWorld(this.snapLineY);
            g.drawLine(0, y, this.mapView().getWidth(), y);
        }
        if (this.selection.selectionRangeTL != null) {
            g.setColor(ColorUtil.setAlpha(Color.BLACK, 0.1f));
            for (AbstractObject selected : this.selection.temporaryRangeSelectedObjects) {
                Draw.fillRect(g, this.mapView().screenPointForWorld(selected.boundTL()), this.mapView().screenPointForWorld(selected.boundBR()));
            }
            g.setColor(Color.GREEN);
            Draw.drawRect(g, this.mapView().screenPointForWorld(this.selection.selectionRangeTL), this.mapView().screenPointForWorld(this.selection.selectionRangeBR));
        }
    }

    @Override
    public void mapChanged(WorldMap map) {
        if (this.selection.isSelected()) {
            boolean hasBadObject = false;
            for (AbstractObject selected : this.selection.selectedObjects) {
                if (map.objects().contains(selected)) continue;
                hasBadObject = true;
                break;
            }
            if (hasBadObject) {
                this.selection.clear();
            }
        }
    }

    private boolean IsSelectionObjectEditLock() {
        boolean editLock = false;
        for (AbstractObject obj : this.selection.selectedObjects) {
            if (!obj.getEditLock()) continue;
            editLock = true;
        }
        return editLock;
    }

    /** Bulk-assign sequential location numbers to the currently selected shelves. */
    public void bulkLocationNumbering() {
        List<FreeShelfObject> shelves = new ArrayList<FreeShelfObject>();
        for (AbstractObject o : this.selection.selectedObjects) {
            if (o instanceof FreeShelfObject) {
                shelves.add((FreeShelfObject) o);
            }
        }
        if (shelves.isEmpty()) {
            JOptionPane.showMessageDialog(this.maker.mapFrame,
                "棚が選択されていません。\n「編集」モードでShift＋ドラッグの範囲選択で棚を選んでから実行してください。",
                "連番ロケ付与", 1);
            return;
        }
        JTextField tfStart = new JTextField(Prefs.get("locnum.start", "001-01-01"));
        JComboBox<String> cbOrder = new JComboBox<String>(new String[]{"自動", "左 → 右", "右 → 左", "上 → 下", "下 → 上"});
        cbOrder.setSelectedIndex(Prefs.getInt("locnum.order", 0));
        JTextField tfStep = new JTextField(Prefs.get("locnum.step", "1"));
        JPanel panel = new JPanel(new GridLayout(0, 2, 6, 6));
        panel.add(new JLabel("開始ロケ番号（例 001-01-01）")); panel.add(tfStart);
        panel.add(new JLabel("付与する順番")); panel.add(cbOrder);
        panel.add(new JLabel("増分")); panel.add(tfStep);
        panel.add(new JLabel("対象の棚")); panel.add(new JLabel(shelves.size() + " 個"));
        int res = JOptionPane.showConfirmDialog(this.maker.mapFrame, panel, "選択した棚に連番ロケを付与", 2, -1);
        if (res != 0) {
            return;
        }
        String start = tfStart.getText().trim();
        int step;
        try { step = Integer.parseInt(tfStep.getText().trim()); } catch (Exception ex) { step = 1; }
        int order = cbOrder.getSelectedIndex();

        int end = start.length();
        while (end > 0 && !Character.isDigit(start.charAt(end - 1))) end--;
        int begin = end;
        while (begin > 0 && Character.isDigit(start.charAt(begin - 1))) begin--;
        if (begin == end) {
            JOptionPane.showMessageDialog(this.maker.mapFrame,
                "開始ロケ番号の末尾に数字が必要です（例 001-01-01）。", "連番ロケ付与", 0);
            return;
        }
        String prefix = start.substring(0, begin);
        String suffix = start.substring(end);
        int width = end - begin;
        long base = Long.parseLong(start.substring(begin, end));

        this.sortShelves(shelves, order);

        HashSet<String> existing = new HashSet<String>();
        for (FreeShelfObject s : this.maker.map().freeShelfObjects()) {
            if (!shelves.contains(s)) {
                existing.add(s.shelf().name);
            }
        }
        List<String> names = new ArrayList<String>();
        int collide = 0;
        for (int i = 0; i < shelves.size(); i++) {
            long v = base + (long) i * (long) step;
            String num = Long.toString(Math.abs(v));
            while (num.length() < width) {
                num = "0" + num;
            }
            String nm = prefix + num + suffix;
            names.add(nm);
            if (existing.contains(nm)) collide++;
        }
        if (collide > 0) {
            int c = JOptionPane.showConfirmDialog(this.maker.mapFrame,
                collide + " 件が既存の棚名と重複します。続行しますか？", "重複の確認", 0);
            if (c != 0) {
                return;
            }
        }

        WorldMap map = this.maker.map();
        try {
            map.startWrite();
            for (int i = 0; i < shelves.size(); i++) {
                shelves.get(i).setShelf(new FreeShelfArea(names.get(i)));
            }
        } finally {
            map.endWrite();
        }
        map.dispatchChangedEvent();
        Prefs.put("locnum.start", start);
        Prefs.putInt("locnum.order", order);
        Prefs.put("locnum.step", tfStep.getText().trim());
        Prefs.save();
        this.mapView().setMessage(shelves.size() + " 個の棚に連番ロケを付与（" + names.get(0) + " 〜 " + names.get(names.size() - 1) + " ／ Ctrl+Zで取消）");
        this.mapView().repaint();
    }

    private void sortShelves(List<FreeShelfObject> shelves, int order) {
        int o = order;
        if (o == 0) {
            double minx = Double.MAX_VALUE, maxx = -Double.MAX_VALUE, miny = Double.MAX_VALUE, maxy = -Double.MAX_VALUE;
            for (FreeShelfObject s : shelves) {
                Coord t = s.boundTL();
                minx = Math.min(minx, t.x); maxx = Math.max(maxx, t.x);
                miny = Math.min(miny, t.y); maxy = Math.max(maxy, t.y);
            }
            o = (maxx - minx) >= (maxy - miny) ? 1 : 3;
        }
        final int ord = o;
        Collections.sort(shelves, new Comparator<FreeShelfObject>(){

            @Override
            public int compare(FreeShelfObject a, FreeShelfObject b) {
                Coord ta = a.boundTL(), tb = b.boundTL();
                switch (ord) {
                    case 1: { int c = Double.compare(ta.x, tb.x); return c != 0 ? c : Double.compare(ta.y, tb.y); }
                    case 2: { int c = Double.compare(tb.x, ta.x); return c != 0 ? c : Double.compare(ta.y, tb.y); }
                    case 3: { int c = Double.compare(ta.y, tb.y); return c != 0 ? c : Double.compare(ta.x, tb.x); }
                    case 4: { int c = Double.compare(tb.y, ta.y); return c != 0 ? c : Double.compare(ta.x, tb.x); }
                    default: return 0;
                }
            }
        });
    }
}

