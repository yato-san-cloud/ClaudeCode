/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.editors;

import com.hitachi.warehouse.gui.mapframe.AbstractMapPanel;
import com.hitachi.warehouse.mapmaker.MapMaker;
import com.hitachi.warehouse.mapmaker.WorldMapExtension;
import com.hitachi.warehouse.mapmaker.common.ColorPicker;
import com.hitachi.warehouse.mapmaker.common.ComponentSearch;
import com.hitachi.warehouse.mapmaker.common.NumericCheck;
import com.hitachi.warehouse.mapmaker.editors.AbstractObjectEditor;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.common.polygon.Bound;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.AbstractObject;
import com.hitachi.warehouse.model.map.objects.ConstrainedAreaObject;
import com.hitachi.warehouse.model.map.objects.FreeShelfObject;
import com.hitachi.warehouse.model.map.objects.StairsObject;
import com.hitachi.warehouse.model.map.objects.StationObject;
import com.hitachi.warehouse.model.map.objects.WallObject;
import com.hitachi.warehouse.model.picking.FreeShelfArea;
import java.awt.Color;
import java.awt.Dimension;
import java.awt.Graphics2D;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import java.awt.event.FocusAdapter;
import java.awt.event.FocusEvent;
import java.awt.event.FocusListener;
import java.awt.event.KeyAdapter;
import java.awt.event.KeyEvent;
import java.awt.event.KeyListener;
import java.util.ArrayList;
import java.util.HashMap;
import javax.swing.ButtonGroup;
import javax.swing.JButton;
import javax.swing.JComboBox;
import javax.swing.JLabel;
import javax.swing.JOptionPane;
import javax.swing.JPanel;
import javax.swing.JRadioButton;
import javax.swing.JTextField;

public class ShelfEditor
extends AbstractObjectEditor<FreeShelfObject> {
    private static final long serialVersionUID = 7381526386149269846L;
    HashMap<AbstractObject, Bound> selectedObjectsOriginalBound;
    JTextField txtName;
    JComboBox<String> cmbNameCandidates;
    JButton btnShelfColorPicker;
    JTextField txtHeight;
    JTextField txtWidth;
    ButtonGroup grpSizeBase;
    JRadioButton rbSizeLeftTop;
    JRadioButton rbSizeRightTop;
    JRadioButton rbSizeLeftBottom;
    JRadioButton rbSizeRightBottom;
    JPanel pnlRect;
    boolean showError = false;

    public ShelfEditor(FreeShelfObject editingObject, WorldMap map, MapMaker mapMaker, HashMap<AbstractObject, Bound> selectedObjectsOriginalBound) {
        super(editingObject, map, mapMaker);
        this.selectedObjectsOriginalBound = selectedObjectsOriginalBound;
    }

    @Override
    public void fillFormGUI(JPanel pnlForm) {
        JPanel pnlCol = new JPanel();
        pnlCol.setLayout(null);
        pnlCol.setPreferredSize(new Dimension(this.mapMaker.objectInfoFrame.getWidth(), 100));
        JLabel lblTitleName = new JLabel("■棚名設定");
        lblTitleName.setBounds(20, 1, 200, 25);
        pnlCol.add(lblTitleName);
        JLabel lblName = new JLabel("棚名");
        lblName.setBounds(33, 30, 80, 25);
        pnlCol.add(lblName);
        this.txtName = new JTextField();
        this.txtName.setBounds(90, 30, 200, 25);
        this.txtName.addFocusListener(new FocusAdapter(){

            @Override
            public void focusGained(FocusEvent arg0) {
                ShelfEditor.this.txtName.setSelectionStart(0);
                ShelfEditor.this.txtName.setSelectionEnd(ShelfEditor.this.txtName.getText().length());
            }

            @Override
            public void focusLost(FocusEvent e) {
                if (((FreeShelfObject)ShelfEditor.this.editingObject).shelf().name.equals(ShelfEditor.this.txtName.getText())) {
                    return;
                }
                ComponentSearch cs = new ComponentSearch();
                if (cs.Exist(ShelfEditor.this.mapMaker.objectInfoFrame, e.getOppositeComponent()) || cs.Exist(ShelfEditor.this.mapMaker.objectInfoFrameExtension, e.getOppositeComponent())) {
                    ShelfEditor.this.updateObjectFromGUI();
                }
            }
        });
        this.txtName.addKeyListener(new KeyAdapter(){

            @Override
            public void keyPressed(KeyEvent e) {
                if (e.getKeyCode() == 9 || e.getKeyCode() == 10) {
                    ShelfEditor.this.txtName.transferFocus();
                }
            }
        });
        pnlCol.add(this.txtName);
        this.cmbNameCandidates = new JComboBox();
        for (String name : this.map.shelfNameManager().names()) {
            this.cmbNameCandidates.addItem(name);
        }
        this.cmbNameCandidates.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                String tanaName = ShelfEditor.this.cmbNameCandidates.getSelectedItem().toString();
                ShelfEditor.this.txtName.setText(tanaName);
                ShelfEditor.this.txtName.requestFocus();
            }
        });
        JLabel lblNameCandidates = new JLabel("棚名選択");
        lblNameCandidates.setBounds(33, 60, 80, 25);
        pnlCol.add(lblNameCandidates);
        this.cmbNameCandidates.setBounds(90, 60, 200, 25);
        pnlCol.add(this.cmbNameCandidates);
        pnlForm.add(pnlCol);
        JPanel pnlColor = new JPanel();
        pnlColor.setLayout(null);
        pnlColor.setPreferredSize(new Dimension(this.mapMaker.objectInfoFrame.getWidth(), 75));
        JLabel lblTitleColor = new JLabel("■棚色設定");
        lblTitleColor.setBounds(20, 1, 200, 25);
        pnlColor.add(lblTitleColor);
        JLabel lblName2 = new JLabel("棚名");
        lblName2.setBounds(33, 30, 80, 25);
        pnlCol.add(lblName2);
        this.btnShelfColorPicker = new JButton("表示色設定");
        this.btnShelfColorPicker.setBounds(90, 30, 200, 25);
        this.btnShelfColorPicker.addActionListener(new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                if (ShelfEditor.this.showError) {
                    return;
                }
                FreeShelfObject cfr_ignored_0 = (FreeShelfObject)ShelfEditor.this.editingObject;
                ColorPicker ColorPicker2 = new ColorPicker(((FreeShelfObject)ShelfEditor.this.editingObject).getShelfColor(), FreeShelfObject.COL_SHELF);
                ColorPicker2.open(ShelfEditor.this.mapMaker.mapFrame);
                Color color = ColorPicker2.getColor();
                if (color != null) {
                    ((FreeShelfObject)ShelfEditor.this.editingObject).setShelfColor(color);
                    ShelfEditor.this.pnlRect.setBackground(color);
                }
            }
        });
        pnlColor.add(this.btnShelfColorPicker);
        pnlForm.add(pnlColor);
        JPanel pnlSize = new JPanel();
        pnlSize.setLayout(null);
        pnlSize.setPreferredSize(new Dimension(this.mapMaker.objectInfoFrame.getWidth(), 260));
        JLabel lblTitleSize = new JLabel("■棚サイズの変更");
        lblTitleSize.setBounds(20, 1, 200, 25);
        pnlSize.add(lblTitleSize);
        JLabel lblSizeBase = new JLabel("▪基準位置");
        lblSizeBase.setBounds(33, 25, 200, 25);
        pnlSize.add(lblSizeBase);
        this.rbSizeLeftTop = new JRadioButton("左上");
        this.rbSizeRightTop = new JRadioButton("右上");
        this.rbSizeLeftBottom = new JRadioButton("左下");
        this.rbSizeRightBottom = new JRadioButton("右下");
        this.rbSizeLeftTop.setBounds(70, 55, 60, 25);
        this.rbSizeRightTop.setBounds(170, 55, 60, 25);
        this.rbSizeLeftBottom.setBounds(70, 140, 60, 25);
        this.rbSizeRightBottom.setBounds(170, 140, 60, 25);
        this.rbSizeLeftTop.setSelected(true);
        this.grpSizeBase = new ButtonGroup();
        this.grpSizeBase.add(this.rbSizeLeftTop);
        this.grpSizeBase.add(this.rbSizeRightTop);
        this.grpSizeBase.add(this.rbSizeLeftBottom);
        this.grpSizeBase.add(this.rbSizeRightBottom);
        pnlSize.add(this.rbSizeLeftTop);
        pnlSize.add(this.rbSizeRightTop);
        pnlSize.add(this.rbSizeLeftBottom);
        pnlSize.add(this.rbSizeRightBottom);
        this.pnlRect = new JPanel();
        this.pnlRect.setLayout(null);
        this.pnlRect.setBounds(95, 80, 80, 60);
        this.pnlRect.setBackground(((FreeShelfObject)this.editingObject).shelfColor());
        JLabel lblTana = new JLabel("棚");
        lblTana.setBounds(34, 16, 30, 25);
        this.pnlRect.add(lblTana);
        pnlSize.add(this.pnlRect);
        JLabel lblSizeInput = new JLabel("▪棚サイズ");
        lblSizeInput.setBounds(33, 170, 200, 25);
        pnlSize.add(lblSizeInput);
        JLabel lblHeight = new JLabel("縦長(mm)");
        lblHeight.setBounds(45, 195, 200, 25);
        this.txtHeight = new JTextField();
        this.txtHeight.setBounds(110, 195, 170, 25);
        this.txtHeight.addFocusListener(new FocusListener(){

            @Override
            public void focusLost(FocusEvent e) {
                if (!ShelfEditor.this.txtHeight.isEditable()) {
                    return;
                }
                ComponentSearch cs = new ComponentSearch();
                if (cs.Exist(ShelfEditor.this.mapMaker.objectInfoFrame, e.getOppositeComponent())) {
                    ShelfEditor.this.updateObjectFromGUI();
                }
            }

            @Override
            public void focusGained(FocusEvent e) {
                if (ShelfEditor.this.txtHeight.isEditable()) {
                    ShelfEditor.this.txtHeight.setSelectionStart(0);
                    ShelfEditor.this.txtHeight.setSelectionEnd(ShelfEditor.this.txtHeight.getText().length());
                }
            }
        });
        this.txtHeight.addKeyListener(new KeyListener(){

            @Override
            public void keyTyped(KeyEvent e) {
            }

            @Override
            public void keyReleased(KeyEvent e) {
            }

            @Override
            public void keyPressed(KeyEvent e) {
                if (e.getKeyCode() == 9 || e.getKeyCode() == 10) {
                    ShelfEditor.this.txtHeight.transferFocus();
                }
            }
        });
        JLabel lblWidth = new JLabel("横長(mm)");
        lblWidth.setBounds(45, 225, 200, 25);
        this.txtWidth = new JTextField();
        this.txtWidth.setBounds(110, 225, 170, 25);
        this.txtWidth.addFocusListener(new FocusListener(){

            @Override
            public void focusLost(FocusEvent e) {
                if (!ShelfEditor.this.txtWidth.isEditable()) {
                    return;
                }
                ComponentSearch cs = new ComponentSearch();
                if (cs.Exist(ShelfEditor.this.mapMaker.objectInfoFrame, e.getOppositeComponent())) {
                    ShelfEditor.this.updateObjectFromGUI();
                }
            }

            @Override
            public void focusGained(FocusEvent e) {
                if (ShelfEditor.this.txtWidth.isEditable()) {
                    ShelfEditor.this.txtWidth.setSelectionStart(0);
                    ShelfEditor.this.txtWidth.setSelectionEnd(ShelfEditor.this.txtWidth.getText().length());
                }
            }
        });
        this.txtWidth.addKeyListener(new KeyListener(){

            @Override
            public void keyTyped(KeyEvent e) {
            }

            @Override
            public void keyReleased(KeyEvent e) {
            }

            @Override
            public void keyPressed(KeyEvent e) {
                if (e.getKeyCode() == 9 || e.getKeyCode() == 10) {
                    ShelfEditor.this.txtWidth.transferFocus();
                }
            }
        });
        if (((FreeShelfObject)this.editingObject).getEditLock()) {
            this.rbSizeLeftTop.setEnabled(false);
            this.rbSizeRightTop.setEnabled(false);
            this.rbSizeLeftBottom.setEnabled(false);
            this.rbSizeRightBottom.setEnabled(false);
            this.txtHeight.setEditable(false);
            this.txtWidth.setEditable(false);
        } else {
            this.rbSizeLeftTop.setEnabled(true);
            this.rbSizeRightTop.setEnabled(true);
            this.rbSizeLeftBottom.setEnabled(true);
            this.rbSizeRightBottom.setEnabled(true);
            this.txtHeight.setEditable(true);
            this.txtWidth.setEditable(true);
        }
        pnlSize.add(lblHeight);
        pnlSize.add(this.txtHeight);
        pnlSize.add(lblWidth);
        pnlSize.add(this.txtWidth);
        pnlForm.add(pnlSize);
    }

    @Override
    protected void _updateGUIFromObject() {
        if (this.showError) {
            return;
        }
        this.txtName.setText(((FreeShelfObject)this.editingObject).shelf().name);
        this.cmbNameCandidates.setSelectedItem(((FreeShelfObject)this.editingObject).shelf().name);
        double height = Math.abs(((FreeShelfObject)this.editingObject).tl().y - ((FreeShelfObject)this.editingObject).bl().y);
        double width = Math.abs(((FreeShelfObject)this.editingObject).tl().x - ((FreeShelfObject)this.editingObject).tr().x);
        this.txtHeight.setText(String.valueOf(height));
        this.txtWidth.setText(String.valueOf(width));
        this.pnlRect.setBackground(((FreeShelfObject)this.editingObject).shelfColor());
    }

    @Override
    protected void _updateObjectFromGUI() {
        try {
            Coord newbr;
            Coord newtl;
            if (this.showError) {
                return;
            }
            String name = this.txtName.getText();
            char[] errorChars = new char[]{','};
            Object object = errorChars;
            int n = errorChars.length;
            int n2 = 0;
            while (n2 < n) {
                char errorChar = object[n2];
                if (name.indexOf(errorChar) != -1) {
                    this.showError = true;
                    this.txtName.requestFocus();
                    JOptionPane.showMessageDialog(null, "棚名に「" + String.valueOf(errorChar) + "」は使用できません。 ", "エラー", 0);
                    this.showError = false;
                    return;
                }
                ++n2;
            }
            ArrayList<FreeShelfObject> targetShelf = new ArrayList<FreeShelfObject>();
            boolean targetShelfSameFloor = false;
            if (!name.isEmpty()) {
                object = this.mapMaker.worldMapMultiFloor.getWorldMapExtensionList().iterator();
                while (object.hasNext()) {
                    WorldMapExtension worldMapExtension = (WorldMapExtension)object.next();
                    WorldMap chkmap = worldMapExtension.getWorldMap();
                    for (FreeShelfObject obj : chkmap.freeShelfObjects()) {
                        if (obj.equals(this.editingObject) || obj.shelf().name.equals("START") || obj.shelf().name.equals("END") || !obj.shelf().name.equals(name)) continue;
                        targetShelf.add(obj);
                        if (!this.map.equals(chkmap)) continue;
                        targetShelfSameFloor = true;
                    }
                }
            }
            if (targetShelf.size() != 0) {
                if (targetShelfSameFloor) {
                    this.showError = true;
                    this.txtName.requestFocus();
                    double originalZoomLevel = this.mapMaker.mapFrame.mapView.zoomLevel();
                    double originalCenterX = this.mapMaker.mapFrame.mapView.centerX();
                    double originalCenterY = this.mapMaker.mapFrame.mapView.centerY();
                    this.mapMaker.mapFrame.mapView.setCenter(Coord.mean(this.map.tl(), this.map.br()));
                    this.mapMaker.mapFrame.mapView.initializeZoomLevel();
                    ShelfHighlightPanel panel = new ShelfHighlightPanel(targetShelf);
                    this.mapMaker.mapFrame.mapView.openChildView(panel);
                    JOptionPane.showMessageDialog(null, "棚名が重複しています。 ", "エラー", 0);
                    this.showError = false;
                    this.mapMaker.mapFrame.mapView.setOrientation(originalCenterX, originalCenterY, originalZoomLevel);
                    this.mapMaker.mapFrame.mapView.closeChildview(panel);
                    return;
                }
                this.showError = true;
                this.txtName.requestFocus();
                JOptionPane.showMessageDialog(null, "棚名が重複しています。 ", "エラー", 0);
                this.showError = false;
                return;
            }
            NumericCheck nc = new NumericCheck();
            if (!nc.isNumericDouble(this.txtHeight.getText())) {
                this.showError = true;
                this.txtHeight.requestFocus();
                JOptionPane.showMessageDialog(null, "縦長には、数値を入力してください。 ", "エラー", 0);
                this.showError = false;
                return;
            }
            if (!nc.isNumericDouble(this.txtWidth.getText())) {
                this.showError = true;
                this.txtWidth.requestFocus();
                JOptionPane.showMessageDialog(null, "横長には、数値を入力してください。 ", "エラー", 0);
                this.showError = false;
                return;
            }
            double height = Double.parseDouble(this.txtHeight.getText());
            double width = Double.parseDouble(this.txtWidth.getText());
            if (height < 100.0 || height > this.map.br().y - this.map.tl().y) {
                this.showError = true;
                this.txtHeight.requestFocus();
                JOptionPane.showMessageDialog(null, "縦長が、有効範囲外です。\n100.0～" + (this.map.br().y - this.map.tl().y) + "の値を入力してください。", "エラー", 0);
                this.showError = false;
                return;
            }
            if (width < 100.0 || width > this.map.br().x - this.map.tl().x) {
                this.showError = true;
                this.txtWidth.requestFocus();
                JOptionPane.showMessageDialog(null, "横長が、有効範囲外です。\n100.0～" + (this.map.br().x - this.map.tl().x) + "の値を入力してください。", "エラー", 0);
                this.showError = false;
                return;
            }
            Coord tl = ((FreeShelfObject)this.editingObject).tl();
            Coord br = ((FreeShelfObject)this.editingObject).br();
            if (this.rbSizeLeftTop.isSelected()) {
                newtl = new Coord(tl.x, tl.y);
                newbr = new Coord(((FreeShelfObject)this.editingObject).tl().x + width, ((FreeShelfObject)this.editingObject).tl().y + height);
            } else if (this.rbSizeRightTop.isSelected()) {
                newtl = new Coord(((FreeShelfObject)this.editingObject).tr().x - width, ((FreeShelfObject)this.editingObject).tl().y);
                newbr = new Coord(br.x, ((FreeShelfObject)this.editingObject).tr().y + height);
            } else if (this.rbSizeLeftBottom.isSelected()) {
                newbr = new Coord(((FreeShelfObject)this.editingObject).bl().x + width, br.y);
                newtl = new Coord(tl.x, ((FreeShelfObject)this.editingObject).bl().y - height);
            } else if (this.rbSizeRightBottom.isSelected()) {
                newtl = new Coord(((FreeShelfObject)this.editingObject).br().x - width, ((FreeShelfObject)this.editingObject).br().y - height);
                newbr = new Coord(br.x, br.y);
            } else {
                newtl = tl;
                newbr = br;
            }
            boolean OverlapObject = false;
            for (AbstractObject obj : this.map.objects()) {
                if (((FreeShelfObject)this.editingObject).equals(obj) || !FreeShelfObject.class.isInstance(obj) && !WallObject.class.isInstance(obj) && !ConstrainedAreaObject.class.isInstance(obj) && !StationObject.class.isInstance(obj) && !StairsObject.class.isInstance(obj) || !(newtl.x < obj.boundBR().x) || !(newtl.y < obj.boundBR().y) || !(newbr.x > obj.boundTL().x) || !(newbr.y > obj.boundTL().y)) continue;
                OverlapObject = true;
            }
            if (OverlapObject) {
                this.showError = true;
                this.txtHeight.requestFocus();
                JOptionPane.showMessageDialog(null, "入力した長さでは、オブジェクトが重なります。", "エラー", 0);
                this.showError = false;
                return;
            }
            ((FreeShelfObject)this.editingObject).setBounds(newtl, newbr);
            if (this.selectedObjectsOriginalBound != null) {
                this.selectedObjectsOriginalBound.put((AbstractObject)this.editingObject, ((FreeShelfObject)this.editingObject).bound());
            }
            ((FreeShelfObject)this.editingObject).setShelf(new FreeShelfArea(this.txtName.getText()));
            ((FreeShelfObject)this.editingObject).setShelfColor(this.pnlRect.getBackground());
        }
        catch (Exception ex) {
            ex.printStackTrace();
        }
    }

    public static class ShelfHighlightPanel
    extends AbstractMapPanel {
        ArrayList<FreeShelfObject> target = new ArrayList();

        public ShelfHighlightPanel(ArrayList<FreeShelfObject> target) {
            this.target.addAll(target);
        }

        @Override
        public void draw(Graphics2D g) {
            for (FreeShelfObject obj : this.target) {
                if (!this.mapView().map().freeShelfObjects().contains(obj)) continue;
                obj.highlight(g, this.mapView());
            }
        }
    }
}

