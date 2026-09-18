/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.editors;

import com.hitachi.warehouse.mapmaker.MapMaker;
import com.hitachi.warehouse.mapmaker.editors.AbstractObjectEditor;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.WallObject;
import java.awt.Dimension;
import java.awt.event.FocusAdapter;
import java.awt.event.FocusEvent;
import java.awt.event.KeyAdapter;
import java.awt.event.KeyEvent;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JSlider;
import javax.swing.JTextField;
import javax.swing.event.ChangeEvent;
import javax.swing.event.ChangeListener;

public class WallEditor
extends AbstractObjectEditor<WallObject> {
    private static final long serialVersionUID = -6547907270105888551L;
    JTextField txtHeight;
    JSlider sliderHeight;

    public WallEditor(WallObject editingObject, WorldMap map, MapMaker mapMaker) {
        super(editingObject, map, mapMaker);
    }

    @Override
    public void fillFormGUI(JPanel pnlForm) {
        JPanel pnlHeight = new JPanel();
        pnlHeight.setLayout(null);
        pnlHeight.setPreferredSize(new Dimension(this.mapMaker.objectInfoFrame.getWidth(), 100));
        JLabel lblTitle = new JLabel("■壁の高さ設定");
        lblTitle.setBounds(20, 1, 200, 25);
        pnlHeight.add(lblTitle);
        JLabel lblHeight = new JLabel("壁の高さ(m)");
        lblHeight.setBounds(33, 30, 80, 25);
        pnlHeight.add(lblHeight);
        this.txtHeight = new JTextField();
        this.txtHeight.setBounds(110, 30, 170, 25);
        this.txtHeight.addFocusListener(new FocusAdapter(){

            @Override
            public void focusGained(FocusEvent arg0) {
                WallEditor.this.txtHeight.setSelectionStart(0);
                WallEditor.this.txtHeight.setSelectionEnd(WallEditor.this.txtHeight.getText().length());
            }

            @Override
            public void focusLost(FocusEvent e) {
                WallEditor.this.sliderHeight.setValue((int)(1000.0 * Double.parseDouble(WallEditor.this.txtHeight.getText())));
            }
        });
        this.txtHeight.addKeyListener(new KeyAdapter(){

            @Override
            public void keyPressed(KeyEvent e) {
                if (e.getKeyCode() == 9 || e.getKeyCode() == 10) {
                    WallEditor.this.sliderHeight.setValue((int)(1000.0 * Double.parseDouble(WallEditor.this.txtHeight.getText())));
                }
            }
        });
        pnlHeight.add(this.txtHeight);
        this.sliderHeight = new JSlider(0, 25000);
        this.sliderHeight.setBounds(110, 60, 170, 25);
        this.sliderHeight.addChangeListener(new ChangeListener(){

            @Override
            public void stateChanged(ChangeEvent e) {
                WallEditor.this.updateObjectFromGUI();
            }
        });
        pnlHeight.add(this.sliderHeight);
        pnlForm.add(pnlHeight);
    }

    @Override
    protected void _updateObjectFromGUI() {
        ((WallObject)this.editingObject).setHeight(this.sliderHeight.getValue());
    }

    @Override
    protected void _updateGUIFromObject() {
        this.txtHeight.setText(String.format("%.02f", ((WallObject)this.editingObject).height_mm() / 1000.0));
        this.sliderHeight.setValue((int)((WallObject)this.editingObject).height_mm());
    }
}

