/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.editors;

import com.hitachi.warehouse.gui.mapframe.AbstractMapPanel;
import com.hitachi.warehouse.gui.mapframe.MapFrame;
import com.hitachi.warehouse.mapmaker.MapMaker;
import com.hitachi.warehouse.mapmaker.common.ComponentSearch;
import com.hitachi.warehouse.mapmaker.editors.AbstractObjectEditor;
import com.hitachi.warehouse.model.common.Coord;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.StairsObject;
import java.awt.Dimension;
import java.awt.Graphics2D;
import java.awt.event.FocusAdapter;
import java.awt.event.FocusEvent;
import java.awt.event.KeyAdapter;
import java.awt.event.KeyEvent;
import java.util.ArrayList;
import javax.swing.JLabel;
import javax.swing.JOptionPane;
import javax.swing.JPanel;
import javax.swing.JTextField;

public class StairsEditor
extends AbstractObjectEditor<StairsObject> {
    private static final long serialVersionUID = 7381526386149269846L;
    MapFrame mapFrame;
    JTextField txtName;
    boolean showError = false;

    public StairsEditor(StairsObject editingObject, WorldMap map, MapMaker mapMaker) {
        super(editingObject, map, mapMaker);
    }

    @Override
    public void fillFormGUI(JPanel pnlForm) {
        JPanel pnlStairs = new JPanel();
        pnlStairs.setLayout(null);
        pnlStairs.setPreferredSize(new Dimension(this.mapMaker.objectInfoFrame.getWidth(), 100));
        JLabel lblTitle = new JLabel("■階段名設定");
        lblTitle.setBounds(20, 1, 200, 25);
        pnlStairs.add(lblTitle);
        JLabel lblName = new JLabel("階段名");
        lblName.setBounds(33, 30, 80, 25);
        pnlStairs.add(lblName);
        this.txtName = new JTextField();
        this.txtName.setBounds(90, 30, 200, 25);
        this.txtName.addFocusListener(new FocusAdapter(){

            @Override
            public void focusGained(FocusEvent arg0) {
                StairsEditor.this.txtName.setSelectionStart(0);
                StairsEditor.this.txtName.setSelectionEnd(StairsEditor.this.txtName.getText().length());
            }

            @Override
            public void focusLost(FocusEvent e) {
                if (((StairsObject)StairsEditor.this.editingObject).getName().equals(StairsEditor.this.txtName.getText())) {
                    return;
                }
                ComponentSearch cs = new ComponentSearch();
                if (cs.Exist(StairsEditor.this.mapMaker.objectInfoFrame, e.getOppositeComponent()) || cs.Exist(StairsEditor.this.mapMaker.objectInfoFrameExtension, e.getOppositeComponent())) {
                    StairsEditor.this.updateObjectFromGUI();
                }
            }
        });
        this.txtName.addKeyListener(new KeyAdapter(){

            @Override
            public void keyPressed(KeyEvent e) {
                if (e.getKeyCode() == 9 || e.getKeyCode() == 10) {
                    StairsEditor.this.txtName.transferFocus();
                }
            }
        });
        pnlStairs.add(this.txtName);
        pnlForm.add(pnlStairs);
    }

    @Override
    protected void _updateGUIFromObject() {
        this.txtName.setText(((StairsObject)this.editingObject).getName());
    }

    @Override
    protected void _updateObjectFromGUI() {
        try {
            if (this.showError) {
                return;
            }
            ArrayList<StairsObject> targetStairs = new ArrayList<StairsObject>();
            if (!this.txtName.getText().isEmpty()) {
                for (StairsObject stairsObject : this.map.stairsObjects()) {
                    if (((StairsObject)this.editingObject).equals(stairsObject) || !this.txtName.getText().equals(stairsObject.getName())) continue;
                    targetStairs.add(stairsObject);
                }
            }
            if (targetStairs.size() != 0) {
                this.showError = true;
                this.txtName.requestFocus();
                double originalZoomLevel = this.mapMaker.mapFrame.mapView.zoomLevel();
                double originalCenterX = this.mapMaker.mapFrame.mapView.centerX();
                double originalCenterY = this.mapMaker.mapFrame.mapView.centerY();
                this.mapMaker.mapFrame.mapView.setCenter(Coord.mean(this.map.tl(), this.map.br()));
                this.mapMaker.mapFrame.mapView.initializeZoomLevel();
                StairsHighlightPanel panel = new StairsHighlightPanel(targetStairs);
                this.mapMaker.mapFrame.mapView.openChildView(panel);
                JOptionPane.showMessageDialog(null, "階段名が重複しています。 ", "エラー", 0);
                this.showError = false;
                this.mapMaker.mapFrame.mapView.setOrientation(originalCenterX, originalCenterY, originalZoomLevel);
                this.mapMaker.mapFrame.mapView.closeChildview(panel);
                return;
            }
            ((StairsObject)this.editingObject).setName(this.txtName.getText());
        }
        catch (Exception ex) {
            ex.printStackTrace();
        }
    }

    public static class StairsHighlightPanel
    extends AbstractMapPanel {
        ArrayList<StairsObject> target = new ArrayList();

        public StairsHighlightPanel(ArrayList<StairsObject> target) {
            this.target.addAll(target);
        }

        @Override
        public void draw(Graphics2D g) {
            for (StairsObject obj : this.target) {
                obj.highlight(g, this.mapView());
            }
        }
    }
}

