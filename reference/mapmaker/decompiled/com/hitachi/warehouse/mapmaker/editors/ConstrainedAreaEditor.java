/*
 * Decompiled with CFR 0.152.
 */
package com.hitachi.warehouse.mapmaker.editors;

import com.hitachi.warehouse.mapmaker.MapMaker;
import com.hitachi.warehouse.mapmaker.editors.AbstractObjectEditor;
import com.hitachi.warehouse.model.map.WorldMap;
import com.hitachi.warehouse.model.map.objects.ConstrainedAreaObject;
import java.awt.Dimension;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import java.util.Dictionary;
import java.util.Hashtable;
import javax.swing.ButtonGroup;
import javax.swing.JCheckBox;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JRadioButton;
import javax.swing.JSlider;
import javax.swing.event.ChangeEvent;
import javax.swing.event.ChangeListener;

public class ConstrainedAreaEditor
extends AbstractObjectEditor<ConstrainedAreaObject> {
    private static final long serialVersionUID = -6026510545335968979L;
    JRadioButton btnVertical;
    JRadioButton btnHorizontal;
    JRadioButton btnDirectionRight;
    JRadioButton btnDirectionLeft;
    JRadioButton btnDirectionBoth;
    JSlider sliderPosition;
    JCheckBox chkEnterAExitA;
    JCheckBox chkEnterAExitB;
    JCheckBox chkEnterBExitA;
    JCheckBox chkEnterBExitB;
    boolean updatingObject = false;

    public ConstrainedAreaEditor(ConstrainedAreaObject editingObject, WorldMap map, MapMaker mapMaker) {
        super(editingObject, map, mapMaker);
    }

    @Override
    public void fillFormGUI(JPanel pnlForm) {
        ActionListener listener = new ActionListener(){

            @Override
            public void actionPerformed(ActionEvent e) {
                ConstrainedAreaEditor.this.updateObjectFromGUI();
            }
        };
        pnlForm.setLayout(null);
        pnlForm.setPreferredSize(new Dimension(this.mapMaker.objectInfoFrame.getWidth(), 350));
        JLabel lbl = new JLabel("■方向");
        lbl.setBounds(20, 1, 200, 25);
        pnlForm.add(lbl);
        this.btnVertical = new JRadioButton("縦");
        this.btnVertical.addActionListener(listener);
        this.btnVertical.setBounds(33, 30, 80, 25);
        this.btnHorizontal = new JRadioButton("横");
        this.btnHorizontal.addActionListener(listener);
        this.btnHorizontal.setBounds(120, 30, 80, 25);
        ButtonGroup grpOrientation = new ButtonGroup();
        grpOrientation.add(this.btnVertical);
        grpOrientation.add(this.btnHorizontal);
        this.btnVertical.setSelected(true);
        pnlForm.add(this.btnVertical);
        pnlForm.add(this.btnHorizontal);
        lbl = new JLabel("■移動向き制約");
        lbl.setBounds(20, 60, 100, 25);
        pnlForm.add(lbl);
        this.btnDirectionRight = new JRadioButton("右回り");
        this.btnDirectionRight.addActionListener(listener);
        this.btnDirectionRight.setBounds(33, 90, 80, 25);
        this.btnDirectionLeft = new JRadioButton("左回り");
        this.btnDirectionLeft.addActionListener(listener);
        this.btnDirectionLeft.setBounds(120, 90, 80, 25);
        this.btnDirectionBoth = new JRadioButton("両方");
        this.btnDirectionBoth.addActionListener(listener);
        this.btnDirectionBoth.setBounds(207, 90, 80, 25);
        ButtonGroup grp = new ButtonGroup();
        grp.add(this.btnDirectionRight);
        grp.add(this.btnDirectionLeft);
        grp.add(this.btnDirectionBoth);
        this.btnDirectionRight.setSelected(true);
        pnlForm.add(this.btnDirectionRight);
        pnlForm.add(this.btnDirectionLeft);
        pnlForm.add(this.btnDirectionBoth);
        JLabel lblCenterLine = new JLabel("■中心線");
        lblCenterLine.setBounds(20, 120, 100, 25);
        pnlForm.add(lblCenterLine);
        this.sliderPosition = new JSlider(0, 1000);
        Hashtable<Integer, JLabel> labels = new Hashtable<Integer, JLabel>();
        int i = 0;
        while (i <= 4) {
            ((Dictionary)labels).put(1000 * i / 4, new JLabel(String.format("%d%%", 100 * i / 4)));
            ++i;
        }
        this.sliderPosition.setLabelTable(labels);
        this.sliderPosition.setMajorTickSpacing(200);
        this.sliderPosition.setPaintLabels(true);
        this.sliderPosition.addChangeListener(new ChangeListener(){

            @Override
            public void stateChanged(ChangeEvent e) {
                ConstrainedAreaEditor.this.updateObjectFromGUI();
            }
        });
        this.sliderPosition.setBounds(33, 150, 250, 40);
        pnlForm.add(this.sliderPosition);
        lbl = new JLabel("■入口/出口制約");
        lbl.setBounds(20, 190, 100, 25);
        pnlForm.add(lbl);
        this.chkEnterAExitA = new JCheckBox("A→A");
        this.chkEnterAExitA.addActionListener(listener);
        this.chkEnterAExitA.setBounds(33, 220, 100, 25);
        this.chkEnterAExitB = new JCheckBox("A→B");
        this.chkEnterAExitB.addActionListener(listener);
        this.chkEnterAExitB.setBounds(33, 250, 100, 25);
        this.chkEnterBExitA = new JCheckBox("B→A");
        this.chkEnterBExitA.addActionListener(listener);
        this.chkEnterBExitA.setBounds(33, 280, 100, 25);
        this.chkEnterBExitB = new JCheckBox("B→B");
        this.chkEnterBExitB.addActionListener(listener);
        this.chkEnterBExitB.setBounds(33, 310, 100, 25);
        pnlForm.add(this.chkEnterAExitA);
        pnlForm.add(this.chkEnterAExitB);
        pnlForm.add(this.chkEnterBExitA);
        pnlForm.add(this.chkEnterBExitB);
    }

    @Override
    protected void _updateObjectFromGUI() {
        ((ConstrainedAreaObject)this.editingObject).setOrientation(this.btnVertical.isSelected() ? 0 : 1);
        if (this.btnDirectionRight.isSelected()) {
            ((ConstrainedAreaObject)this.editingObject).setTrafficDirection(1);
        } else if (this.btnDirectionLeft.isSelected()) {
            ((ConstrainedAreaObject)this.editingObject).setTrafficDirection(2);
        } else if (this.btnDirectionBoth.isSelected()) {
            ((ConstrainedAreaObject)this.editingObject).setTrafficDirection(0);
        }
        ((ConstrainedAreaObject)this.editingObject).setSplitPosition((double)this.sliderPosition.getValue() / 1000.0);
        ((ConstrainedAreaObject)this.editingObject).setEnterAExitA(this.chkEnterAExitA.isSelected());
        ((ConstrainedAreaObject)this.editingObject).setEnterAExitB(this.chkEnterAExitB.isSelected());
        ((ConstrainedAreaObject)this.editingObject).setEnterBExitA(this.chkEnterBExitA.isSelected());
        ((ConstrainedAreaObject)this.editingObject).setEnterBExitB(this.chkEnterBExitB.isSelected());
    }

    @Override
    protected void _updateGUIFromObject() {
        this.btnVertical.setSelected(((ConstrainedAreaObject)this.editingObject).orientation() == 0);
        this.btnHorizontal.setSelected(((ConstrainedAreaObject)this.editingObject).orientation() == 1);
        this.btnDirectionRight.setSelected(((ConstrainedAreaObject)this.editingObject).isRightHanded());
        this.btnDirectionLeft.setSelected(((ConstrainedAreaObject)this.editingObject).isLeftHanded());
        this.btnDirectionBoth.setSelected(((ConstrainedAreaObject)this.editingObject).canMoveBothWays());
        this.sliderPosition.setEnabled(((ConstrainedAreaObject)this.editingObject).hasDirectionConstraint());
        this.sliderPosition.setValue((int)(1000.0 * ((ConstrainedAreaObject)this.editingObject).splitPosition()));
        this.chkEnterAExitA.setSelected(((ConstrainedAreaObject)this.editingObject).canEnterAExitA());
        this.chkEnterAExitB.setSelected(((ConstrainedAreaObject)this.editingObject).canEnterAExitB());
        this.chkEnterBExitA.setSelected(((ConstrainedAreaObject)this.editingObject).canEnterBExitA());
        this.chkEnterBExitB.setSelected(((ConstrainedAreaObject)this.editingObject).canEnterBExitB());
    }
}

